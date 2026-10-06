import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scrape } from './connectors/opentable/index.js';
import { missingHashes } from './connectors/opentable/extract.js';

export async function run({ scraper = scrape, outputFile = 'secrets/secrets.json', debugDir = 'temp' } = {}) {
  await fs.mkdir(debugDir, { recursive: true });
  const report = { attemptedAt: new Date().toISOString(), status: 'failed' };
  try {
    const result = await scraper({ debugDir });
    const missing = missingHashes(result.hashes);
    if (missing.length) throw new Error('Missing fresh hashes: ' + missing.join(', '));
    const output = { timestamp: Date.now(), ...result.hashes, errors: result.errors };
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    const temporaryFile = outputFile + '.tmp';
    try {
      await fs.writeFile(temporaryFile, JSON.stringify(output, null, 2) + '\n');
      await fs.rename(temporaryFile, outputFile);
    } finally { await fs.rm(temporaryFile, { force: true }); }
    Object.assign(report, { status: 'success', ...result });
    console.log('Freshly extracted all 3 hashes. Results written to ' + outputFile);
    return output;
  } catch (error) {
    Object.assign(report, error.diagnostics);
    report.error = error.message;
    console.error('Scrape failed; existing output preserved. ' + error.message);
    throw error;
  } finally {
    await fs.writeFile(path.join(debugDir, 'run-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run({ outputFile: process.env.OUTPUT_FILE || 'secrets/secrets.json' }).catch(() => { process.exitCode = 1; });
}
