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

async function extractJsLinks(htmlContent: string): Promise<string[]> {
  // Look for multi-search JS links in modulepreload links
  const modulePreloadRegex = /href="([^"]*\/js\/multi-search-[^"]*\.js)"/g;
  const chunkRegex = /["']([^"']*\/js\/chunk-[^"']*\.js)["']/g;
  
  const links: string[] = [];
  let match;
  
  // Extract modulepreload links
  while ((match = modulePreloadRegex.exec(htmlContent)) !== null) {
    if (match[1]) {
      links.push(match[1]);
    }
  }
  
  // Extract chunk links
  while ((match = chunkRegex.exec(htmlContent)) !== null) {
    if (match[1]) {
      links.push(match[1]);
    }
  }
  
  // Convert to full URLs
  const fullLinks = links.map(link => 
    link.startsWith("http") ? link : `https://www.opentable.com${link}`
  );
  
  console.log(`Found ${fullLinks.length} JS files to analyze`);
  return fullLinks;
}

async function fetchJsContent(url: string): Promise<{ url: string; text: string | null; error: string | null }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const text = await response.text();
    return { url, text, error: null };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to fetch ${url}: ${errorMsg}`);
    return { url, text: null, error: errorMsg };
  }
}

async function getShaValues(jsLinks: string[]): Promise<ShaResult> {
  console.log("Fetching JS files in parallel...");
  
  // Fetch all JS files in parallel
  const responses = await Promise.all(jsLinks.map(fetchJsContent));
  
  // Filter out failed requests
  const errors = responses.filter(res => res.error).map(res => res.error!);
  const validResponses = responses.filter(res => !res.error && res.text);
  
  console.log(`Successfully fetched ${validResponses.length}/${responses.length} JS files`);
  
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
    
    // 2. Extract JS file links
    const jsLinks = await extractJsLinks(htmlContent);
    
    if (jsLinks.length === 0) {
      console.error("No JS files found! Contact support: request new SHA.");
      process.exit(1);
    }
    
    // 3. Analyze JS files for SHA values
    const shaResult = await getShaValues(jsLinks);
    
    // 4. Validate results
    if (!shaResult.availabilitySha && !shaResult.multiSha) {
      console.error("Contact support: request new SHA (no values found).");
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