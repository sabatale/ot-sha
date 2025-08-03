import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs/promises";

puppeteer.use(StealthPlugin());

const OUTPUT_DIR = "secrets";
const OUTPUT_FILE = `${OUTPUT_DIR}/secrets.json`;

interface ShaResult {
  availabilitySha: string | null;
  multiSha: string | null;
  errors: string[];
}

async function fetchOpenTablePage(): Promise<string> {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.CHROMIUM_PATH || undefined
  });

  try {
    const page = await browser.newPage();
    console.log("Opening OpenTable search page...");
    await page.goto("https://www.opentable.com/s", { waitUntil: "domcontentloaded" });

    const htmlContent = await page.content();
    const headContent = htmlContent.split('</head>')[0] || htmlContent;

    return headContent;
  } finally {
    await browser.close();
  }
}

interface ExtractResult {
  allLinks: string[];
  fetchedContent: Map<string, string>;
}

async function extractJsLinks(htmlContent: string): Promise<ExtractResult> {
  // First, look for multi-search JS links in modulepreload links
  const modulePreloadRegex = /href="([^"]*\/js\/multi-search-[^"]*\.js)"/g;
  const scriptRegex = /script src="([^"]*\/js\/multi-search-[^"]*\.js)"/g;

  const multiSearchLinks: string[] = [];
  let match;

  // Extract modulepreload links
  while ((match = modulePreloadRegex.exec(htmlContent)) !== null) {
    if (match[1]) {
      multiSearchLinks.push(match[1]);
    }
  }

  // Extract script src links
  while ((match = scriptRegex.exec(htmlContent)) !== null) {
    if (match[1]) {
      multiSearchLinks.push(match[1]);
    }
  }

  if (multiSearchLinks.length === 0) {
    console.error("No multi-search JS files found in HTML!");
    return { allLinks: [], fetchedContent: new Map() };
  }

  // Convert to full URLs
  const fullMultiSearchLinks = multiSearchLinks.map(link =>
    link.startsWith("http") ? link : `https://www.opentable.com${link}`
  );

  console.log(`Found ${fullMultiSearchLinks.length} multi-search JS files`);

  // Fetch the multi-search files to extract chunk references
  const allLinks: string[] = [...fullMultiSearchLinks];
  const fetchedContent = new Map<string, string>();

  for (const multiSearchUrl of fullMultiSearchLinks) {
    console.log(`Fetching multi-search file: ${multiSearchUrl.split('/').pop()}`);

    try {
      const response = await fetchJsContent(multiSearchUrl);
      if (response.text) {
        // Store the fetched content
        fetchedContent.set(multiSearchUrl, response.text);

        // Extract chunk file references from multi-search JS content
        const chunkRegex = /["']([^"']*\/js\/chunk-[^"']*\.js)["']/g;
        let chunkMatch;

        while ((chunkMatch = chunkRegex.exec(response.text)) !== null) {
          if (chunkMatch[1]) {
            const chunkUrl = chunkMatch[1].startsWith("http")
              ? chunkMatch[1]
              : `https://www.opentable.com${chunkMatch[1]}`;

            if (!allLinks.includes(chunkUrl)) {
              allLinks.push(chunkUrl);
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to fetch multi-search file: ${multiSearchUrl.split('/').pop()}`);
    }
  }

  console.log(`Found ${allLinks.length} total JS files to analyze (${fullMultiSearchLinks.length} multi-search + ${allLinks.length - fullMultiSearchLinks.length} chunk files)`);
  return { allLinks, fetchedContent };
}

async function fetchJsContent(url: string): Promise<{ url: string; text: string | null; error: string | null }> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Fetching: ${url.split('/').pop()} (attempt ${attempt}/${maxRetries})`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // Increased timeout

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'accept-language': 'en-CA,en;q=0.9,fr;q=0.8,en-US;q=0.7',
          'cache-control': 'no-cache',
          'dnt': '1',
          'pragma': 'no-cache',
          'priority': 'u=0, i',
          'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
          'sec-fetch-user': '?1',
          'upgrade-insecure-requests': '1',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0'
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      console.log(`✓ Fetched ${url.split('/').pop()} (${Math.round(text.length / 1024)}KB)`);
      return { url, text, error: null };

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`✗ Attempt ${attempt} failed for ${url.split('/').pop()}: ${errorMsg}`);

      if (attempt < maxRetries) {
        // Exponential backoff: wait longer between retries
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`  Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        return { url, text: null, error: errorMsg };
      }
    }
  }

  return { url, text: null, error: "Max retries exceeded" };
}

async function getShaValues(extractResult: ExtractResult): Promise<ShaResult> {
  const { allLinks, fetchedContent } = extractResult;

  // Separate already fetched files from ones we still need to fetch
  const alreadyFetched = Array.from(fetchedContent.keys());
  const stillNeedToFetch = allLinks.filter(url => !fetchedContent.has(url));

  console.log(`Already fetched: ${alreadyFetched.length} files`);
  console.log(`Still need to fetch: ${stillNeedToFetch.length} files`);

  const responses: Awaited<ReturnType<typeof fetchJsContent>>[] = [];

  // Add already fetched content
  for (const [url, text] of fetchedContent) {
    responses.push({ url, text, error: null });
  }

  // Fetch remaining files
  for (let i = 0; i < stillNeedToFetch.length; i++) {
    const url = stillNeedToFetch[i];
    if (!url) {
      console.warn(`Skipping empty URL at index ${i}`);
      continue;
    }
    console.log(`Processing remaining file ${i + 1}/${stillNeedToFetch.length}: ${url.split('/').pop()}`);

    const response = await fetchJsContent(url);
    responses.push(response);

    if (i < stillNeedToFetch.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Delay
    }
  }

  // Filter out failed requests
  const errors = responses.filter(res => res.error).map(res => res.error!);
  const validResponses = responses.filter(res => !res.error && res.text);

  console.log(`Successfully processed ${validResponses.length}/${responses.length} JS files`);

  let availabilitySha: string | null = null;
  let multiSha: string | null = null;
  const remainingResponses: typeof validResponses = [];

  // 1. Search for "RestaurantsAvailability" first
  for (const response of validResponses) {
    if (response.text!.includes('"RestaurantsAvailability"')) {
      console.log(`Found "RestaurantsAvailability" in ${response.url.split('/').pop()}`);
      const docIdMatch = response.text!.match(/\.documentId\s*=\s*['"]([^'"]+)['"]/);
      if (docIdMatch) {
        availabilitySha = docIdMatch[1] ?? null;
        console.log(`Availability SHA: ${availabilitySha}`);
      }
    } else {
      remainingResponses.push(response);
    }
  }

  // 2. Search for "MultiSearchResults" in remaining files
  for (const response of remainingResponses) {
    if (response.text!.includes('"MultiSearchResults"')) {
      console.log(`Found "MultiSearchResults" in ${response.url.split('/').pop()}`);
      const docIdMatch = response.text!.match(/\.documentId\s*=\s*['"]([^'"]+)['"]/);
      if (docIdMatch) {
        multiSha = docIdMatch[1] ?? null;
        console.log(`Multi Search SHA: ${multiSha}`);
        break; // Only take the first match
      }
    }
  }

  return { availabilitySha, multiSha, errors };
}


async function main(): Promise<void> {
  try {
    // 1. Fetch the OpenTable search page
    const htmlContent = await fetchOpenTablePage();

    // 2. Extract JS file links and fetch multi-search files
    const extractResult = await extractJsLinks(htmlContent);

    if (extractResult.allLinks.length === 0) {
      console.error("No JS files found!");
      process.exit(1);
    }

    // 3. Analyze JS files for SHA values (using cached content when available)
    const shaResult = await getShaValues(extractResult);

    // 4. Validate results
    if (!shaResult.availabilitySha && !shaResult.multiSha) {
      console.error("Missing tokens.");
      process.exit(1);
    }

    // 5. Prepare output data
    const outputData = {
      timestamp: Date.now(),
      availabilitySha: shaResult.availabilitySha,
      multiSha: shaResult.multiSha,
      errors: shaResult.errors,
      // Legacy format for compatibility
      //documentIds: [shaResult.availabilitySha, shaResult.multiSha].filter(Boolean)
    };

    // 6. Write to file
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(outputData, null, 2));

    console.log("\n=== RESULTS ===");
    console.log(`Availability SHA: ${shaResult.availabilitySha || 'NOT FOUND'}`);
    console.log(`Multi Search SHA: ${shaResult.multiSha || 'NOT FOUND'}`);
    console.log(`Results written to: ${OUTPUT_FILE}`);

    if (shaResult.errors.length > 0) {
      console.log(`\nErrors encountered: ${shaResult.errors.length}`);
    }

  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();