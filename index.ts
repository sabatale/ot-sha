import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs/promises";

puppeteer.use(StealthPlugin());

const OUTPUT_DIR = "secrets";
const OUTPUT_FILE = `${OUTPUT_DIR}/secrets.json`;
const DEBUG = true;

interface ShaResult {
  availabilitySha: string | null;
  multiSha: string | null;
  autoSha: string | null;
  errors: string[];
}

async function fetchOpenTablePage(): Promise<string> {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage"
    ],
    executablePath: process.env.CHROMIUM_PATH || undefined
  });

  try {
    const page = await browser.newPage();
    
    // More realistic viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set realistic headers and UA
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
    );
    
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    // Remove webdriver property
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    console.log("Opening OpenTable search page...");
    await page.goto("https://www.opentable.com/landmark/restaurants-near-times-square-manhattan", { 
      waitUntil: "networkidle2",
      timeout: 30000 
    });

    if (DEBUG) {
      console.log(`Current URL: ${page.url()}`);
    }

    // Wait a bit for any dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

    const htmlContent = await page.content();
    const headContent = htmlContent.split('</head>')[0] || htmlContent;

    // Check if we got blocked
    if (headContent.length < 1000) {
      console.warn("⚠️  Received very short HTML response - possible bot detection");
      console.log("First 500 chars:", headContent.substring(0, 500));
    }

    if (DEBUG) {
      console.log("\n=== DEBUG: Full HTML Content ===");
      console.log(htmlContent);
      console.log("=== END DEBUG ===\n");
      
      // Save to file for inspection
      await fs.writeFile("debug-page.html", htmlContent, "utf-8");
      console.log("Full page saved to debug-page.html");
      console.log(`Final URL: ${page.url()}`);
    }

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
    if (DEBUG) {
      console.log("\n=== DEBUG: HTML Head Content ===");
      console.log(htmlContent);
      console.log("=== END DEBUG ===\n");
    } else {
      console.log(htmlContent);
    }
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
      const timeoutId = setTimeout(() => (controller as any).abort(), 15000); // Increased timeout

      const response = await fetch(url, {
        method: 'GET',
        signal: (controller as any).signal,
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

  let availabilitySha: string | null = null;
  let multiSha: string | null = null;
  let autoSha: string | null = null;
  const errors: string[] = [];

  // First, search through already cached content
  for (const [url, text] of fetchedContent) {
    if (!availabilitySha && text.includes('"RestaurantsAvailability"')) {
      console.log(`Found "RestaurantsAvailability" in ${url.split('/').pop()}`);
      const docIdMatch = text.match(/\.documentId\s*=\s*['"]([^'"]+)['"]/);
      if (docIdMatch) {
        availabilitySha = docIdMatch[1] ?? null;
        console.log(`Availability SHA: ${availabilitySha}`);
      }
    }

    if (!multiSha && text.includes('"MultiSearchResults"')) {
      console.log(`Found "MultiSearchResults" in ${url.split('/').pop()}`);
      const docIdMatch = text.match(/\.documentId\s*=\s*['"]([^'"]+)['"]/);
      if (docIdMatch) {
        multiSha = docIdMatch[1] ?? null;
        console.log(`Multi Search SHA: ${multiSha}`);
      }
    }

    if (!autoSha && text.includes('"autocompleteResults"')) {
      console.log(`Found "autocompleteResults" in ${url.split('/').pop()}`);
      const docIdMatch = text.match(/\.documentId\s*=\s*['"]([^'"]+)['"]/);
      if (docIdMatch) {
        autoSha = docIdMatch[1] ?? null;
        console.log(`Auto SHA: ${autoSha}`);
      }
    }

    // Early exit if all found
    if (availabilitySha && multiSha && autoSha) {
      console.log(`✅ All SHAs found in cached files! Skipping remaining downloads.`);
      return { availabilitySha, multiSha, autoSha, errors };
    }
  }

  // Fetch remaining files one by one, searching each immediately
  for (let i = 0; i < stillNeedToFetch.length; i++) {
    // Early exit if all found
    if (availabilitySha && multiSha && autoSha) {
      console.log(`✅ All SHAs found! Skipping remaining ${stillNeedToFetch.length - i} files.`);
      break;
    }

    const url = stillNeedToFetch[i];
    if (!url) {
      console.warn(`Skipping empty URL at index ${i}`);
      continue;
    }

    console.log(`Processing file ${i + 1}/${stillNeedToFetch.length}: ${url.split('/').pop()}`);

    const response = await fetchJsContent(url);

    if (response.error) {
      errors.push(response.error);
      continue;
    }

    if (response.text) {
      // Search immediately after fetching
      if (!availabilitySha && response.text.includes('"RestaurantsAvailability"')) {
        console.log(`Found "RestaurantsAvailability" in ${response.url.split('/').pop()}`);
        const docIdMatch = response.text.match(/\.documentId\s*=\s*['"]([^'"]+)['"]/);
        if (docIdMatch) {
          availabilitySha = docIdMatch[1] ?? null;
          console.log(`Availability SHA: ${availabilitySha}`);
        }
      }

      if (!multiSha && response.text.includes('"MultiSearchResults"')) {
        console.log(`Found "MultiSearchResults" in ${response.url.split('/').pop()}`);
        const docIdMatch = response.text.match(/\.documentId\s*=\s*['"]([^'"]+)['"]/);
        if (docIdMatch) {
          multiSha = docIdMatch[1] ?? null;
          console.log(`Multi Search SHA: ${multiSha}`);
        }
      }

      if (!autoSha && response.text.includes('"autocompleteResults"')) {
        console.log(`Found "autocompleteResults" in ${response.url.split('/').pop()}`);
        const docIdMatch = response.text.match(/\.documentId\s*=\s*['"]([^'"]+)['"]/);
        if (docIdMatch) {
          autoSha = docIdMatch[1] ?? null;
          console.log(`Auto SHA: ${autoSha}`);
        }
      }
    }

    // Add delay only if we need to continue
    if (i < stillNeedToFetch.length - 1 && !(availabilitySha && multiSha && autoSha)) {
      const delay = 2000 + Math.random() * 2000; // 2-4 seconds
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const totalProcessed = alreadyFetched.length + stillNeedToFetch.length;
  console.log(`Successfully processed files with ${errors.length} errors`);

  return { availabilitySha, multiSha, autoSha, errors };
}

async function main(): Promise<void> {
  try {
    // Load existing values if file exists
    let existingData = { availabilitySha: null, multiSha: null, autoSha: null };
    try {
      const existingFile = await fs.readFile(OUTPUT_FILE, 'utf-8');
      existingData = JSON.parse(existingFile);
      console.log("Loaded existing SHA values as fallback");
    } catch {
      console.log("No existing secrets file found");
    }

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

    // 4. Prepare output data with fallbacks
    const outputData = {
      timestamp: Date.now(),
      availabilitySha: shaResult.availabilitySha || existingData.availabilitySha,
      multiSha: shaResult.multiSha || existingData.multiSha,
      autoSha: shaResult.autoSha || existingData.autoSha,
      errors: shaResult.errors,
    };

    // 5. Validate results - only fail if we have no valid SHAs at all
    if (!outputData.availabilitySha && !outputData.multiSha && !outputData.autoSha) {
      console.error("No valid SHAs found and no existing values to preserve!");
      process.exit(1);
    }

    // 6. Write to file
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(outputData, null, 2));

    console.log("\n=== RESULTS ===");
    console.log(`Availability SHA: ${outputData.availabilitySha || 'NOT FOUND'}`);
    console.log(`Multi Search SHA: ${outputData.multiSha || 'NOT FOUND'}`);
    console.log(`Auto SHA: ${outputData.autoSha || 'NOT FOUND'}`);
    console.log(`Results written to: ${OUTPUT_FILE}`);

    // Show which values were preserved from existing file
    if (shaResult.availabilitySha !== outputData.availabilitySha && outputData.availabilitySha) {
      console.log("⚠️  Using existing availability SHA (new value not found)");
    }
    if (shaResult.multiSha !== outputData.multiSha && outputData.multiSha) {
      console.log("⚠️  Using existing multi SHA (new value not found)");
    }
    if (shaResult.autoSha !== outputData.autoSha && outputData.autoSha) {
      console.log("⚠️  Using existing auto SHA (new value not found)");
    }

    if (shaResult.errors.length > 0) {
      console.log(`\nErrors encountered: ${shaResult.errors.length}`);
    }

  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();