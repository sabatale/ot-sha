import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chunkLinks, extractHashes, missingHashes, scriptUrl } from './extract.js';

puppeteer.use(StealthPlugin());
export const DEFAULT_URL = 'https://www.opentable.com/landmark/restaurants-near-times-square-manhattan';

export async function fetchScript(page, url, { attempts = 3, timeout = 20000, retryDelay = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await page.evaluate(async (target, timeoutMs) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(target, { credentials: 'include', signal: controller.signal });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const text = await response.text();
          if (/^\s*</.test(text)) throw new Error('Received HTML instead of JavaScript');
          return { text };
        } catch (error) {
          return { error: error.name === 'AbortError' ? 'Timed out after ' + timeoutMs + 'ms' : error.message };
        } finally { clearTimeout(timer); }
      }, url, timeout);
      if (result.error) throw new Error(result.error);
      return result.text;
    } catch (error) {
      console.warn('Download attempt ' + attempt + '/' + attempts + ': ' + url + ': ' + error.message);
      if (attempt === attempts) throw error;
      await delay(retryDelay * attempt);
    }
  }
}

export async function collectHashes({ links, cached = new Map(), fetchText, maxFiles = 400 }) {
  const queue = [...new Set(links)];
  const seen = new Set(queue);
  const hashes = {};
  const sources = {};
  const errors = [];
  let processed = 0;
  for (let offset = 0; offset < queue.length && missingHashes(hashes).length;) {
    if (processed >= maxFiles) break;
    const batch = queue.slice(offset, Math.min(offset + 6, maxFiles));
    offset += batch.length;
    const results = await Promise.all(batch.map(async (url) => {
      try {
        const text = cached.get(url) ?? await fetchText(url);
        return { url, text, found: extractHashes(text) };
      } catch (error) { return { url, error: error.message }; }
    }));
    for (const result of results) {
      processed++;
      if (result.error) {
        errors.push(result.url + ': ' + result.error);
        continue;
      }
      for (const [key, value] of Object.entries(result.found)) {
        if (hashes[key] && hashes[key] !== value) throw new Error('Conflicting hashes for ' + key);
        hashes[key] = value;
        sources[key] = result.url;
      }
      for (const url of chunkLinks(result.text, result.url)) {
        if (!seen.has(url)) { seen.add(url); queue.push(url); }
      }
    }
  }
  console.log('Analyzed ' + processed + ' assets; ' + errors.length + ' download/parse errors.');
  const missing = missingHashes(hashes);
  if (missing.length) {
    const error = new Error('Fresh extraction incomplete. Missing: ' + missing.join(', ') +
      (processed >= maxFiles ? '. Asset limit reached' : '') +
      (errors.length ? '. ' + errors.join('\n') : ''));
    error.diagnostics = { hashes, sources, errors, processed, missing };
    throw error;
  }
  return { hashes, sources, errors, processed };
}

export async function scrape({ url = DEFAULT_URL, executablePath = process.env.CHROMIUM_PATH,
  debugDir = 'temp', timeout = 30000 } = {}) {
  const browser = await puppeteer.launch({
    headless: true, executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    const cached = new Map();
    const pending = new Set();
    const capture = (response) => {
      const url = scriptUrl(response.url(), page.url());
      if (!url || !response.ok()) return;
      const task = response.text().then((text) => {
        if (text && !/^\s*</.test(text)) cached.set(url, text);
      }).catch(() => {}).finally(() => pending.delete(task));
      pending.add(task);
    };
    page.on('response', capture);
    console.log('Opening ' + url);
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout });
    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(path.join(debugDir, 'debug-page.html'), await page.content());
    console.log('Final URL: ' + page.url());
    if (!response?.ok()) throw new Error('Page returned HTTP ' + response?.status());
    const references = await page.evaluate(() => Array.from(
      document.querySelectorAll('script[src], link[href]'),
      (element) => element.src || element.href
    ));
    page.off('response', capture);
    await Promise.all(pending);
    const links = [...new Set([...references.map((value) => scriptUrl(value, page.url())).filter(Boolean), ...cached.keys()])];
    links.sort((a, b) => Number(b.includes('/multi-search-')) - Number(a.includes('/multi-search-')));
    if (!links.length) throw new Error('No search JavaScript found; page may be blocked or its layout changed');
    console.log('Discovered ' + links.length + ' assets; ' + cached.size + ' already captured in browser.');
    return await collectHashes({ links, cached, fetchText: (target) => fetchScript(page, target) });
  } finally { await browser.close(); }
}
