import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { extractHashes, chunkLinks } from '../connectors/opentable/extract.js';
import { collectHashes, fetchScript, scrape } from '../connectors/opentable/index.js';
import { run } from '../index.js';

const hashes = { availabilitySha: 'a'.repeat(64), multiSha: 'b'.repeat(64), autoSha: 'c'.repeat(64) };
function documentCode(variable, operation, hash) {
  return 'var ' + variable + '={kind:"Document",definitions:[{kind:"OperationDefinition",' +
    'operation:"query",name:{kind:"Name",value:"' + operation + '"}}]};' +
    variable + '.documentId="' + hash + '";';
}
const availability = documentCode('a', 'RestaurantsAvailability', hashes.availabilitySha);
const multi = documentCode('b', 'MultiSearchResults', hashes.multiSha);
const auto = documentCode('c', 'Autocomplete', hashes.autoSha);
let server, origin, directory;
const counts = new Map();

before(async () => {
  await fs.mkdir('temp', { recursive: true });
  directory = await fs.mkdtemp(path.join('temp', 'test-'));
  server = http.createServer((request, response) => {
    const url = request.url;
    counts.set(url, (counts.get(url) || 0) + 1);
    if (url === '/page') {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Set-Cookie', 'fixture=allowed; Path=/; HttpOnly');
      response.end('<html><head></head><body><script type="module" src="/js/multi-search-fixture.js"></script></body></html>');
    } else if (url === '/js/multi-search-fixture.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end('import "./chunk-availability.js";' + multi + 'const lazy="./chunk-nested.js";');
    } else if (url === '/js/chunk-availability.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(availability);
    } else if (url === '/js/chunk-nested.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end('const lazy="./chunk-auto.js";');
    } else if (url === '/js/chunk-auto.js') {
      if (!request.headers.cookie?.includes('fixture=allowed')) {
        response.writeHead(403).end('Missing session cookie');
      } else {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(auto);
      }
    } else if (url === '/js/chunk-retry.js') {
      if (counts.get(url) < 3) response.writeHead(503).end('Retry');
      else response.end(auto);
    } else if (url === '/js/chunk-slow.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.write('var x=');
    } else if (url === '/js/chunk-html.js') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<html>Challenge</html>');
    } else if (url === '/blocked') {
      response.writeHead(403).end('<html>Blocked</html>');
    } else if (url === '/empty') {
      response.end('<html>No search scripts</html>');
    } else response.writeHead(404).end('Missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test('associates each operation with its own hash in a shared bundle', () => {
  const unrelated = documentCode('z', 'MultiSearchResultsFacets', 'd'.repeat(64));
  assert.deepEqual(extractHashes(unrelated + availability + multi + auto), hashes);
});

test('handles aliases, quoted properties, and separate function scopes', () => {
  const code = availability.replace('a.documentId', 'var alias=a;alias["documentId"]') +
    '(function(){' + documentCode('a', 'MultiSearchResults', hashes.multiSha) + '})();';
  assert.deepEqual(extractHashes(code), { availabilitySha: hashes.availabilitySha, multiSha: hashes.multiSha });
  assert.deepEqual(extractHashes(availability.replace('kind:"Document"', '"kind":"Document"')), { availabilitySha: hashes.availabilitySha });
});

test('ignores operation-like field strings and invalid hashes; fails conflicting definitions', () => {
  assert.deepEqual(extractHashes('var x={field:"MultiSearchResults",other:"autocompleteResults"};x.documentId="' + hashes.multiSha + '";'), {});
  assert.deepEqual(extractHashes(availability.replace(hashes.availabilitySha, 'invalid')), {});
  assert.throws(() => extractHashes(availability + documentCode('d', 'RestaurantsAvailability', hashes.autoSha)), /Conflicting/);
});

test('resolves relative, root-relative and protocol-relative chunks without duplicates', () => {
  assert.deepEqual(chunkLinks('import "./chunk-a.js";import "/js/chunk-b.js";import "./chunk-a.js";import "//cdn.example/js/chunk-c.js?v=1";', 'https://example.com/js/multi-search-a.js'), [
    'https://example.com/js/chunk-a.js', 'https://example.com/js/chunk-b.js', 'https://cdn.example/js/chunk-c.js?v=1'
  ]);
});

test('recurses through chunks once, including cycles, and rejects incomplete extraction', async () => {
  const calls = [];
  const root = origin + '/js/multi-search-fixture.js';
  const chunk = origin + '/js/chunk-a.js';
  const sources = new Map([[root, multi + 'import "./chunk-a.js";'], [chunk, availability + auto + 'import "./multi-search-fixture.js";']]);
  const result = await collectHashes({ links: [root, root], fetchText: async (url) => { calls.push(url); return sources.get(url); } });
  assert.deepEqual(result.hashes, hashes);
  assert.deepEqual(calls, [root, chunk]);
  await assert.rejects(collectHashes({ links: [root], fetchText: async () => multi }), /Missing: availabilitySha, autoSha/);
  let failedCalls = 0;
  await assert.rejects(collectHashes({ links: [root, root], fetchText: async () => { failedCalls++; throw new Error('timeout'); } }), /Missing:.*timeout/s);
  assert.equal(failedCalls, 1);
});

test('starts a fixture server and extracts all hashes using the browser session', async () => {
  assert.ok(process.env.CHROMIUM_PATH, 'Set CHROMIUM_PATH to run browser integration tests');
  const result = await scrape({ url: origin + '/page', debugDir: directory });
  assert.deepEqual(result.hashes, hashes);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sources.autoSha, origin + '/js/chunk-auto.js');
});

test('browser downloads retry HTTP failures, reject HTML, and bound stalled response bodies', async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(origin + '/empty');
    assert.equal(await fetchScript(page, origin + '/js/chunk-retry.js', { retryDelay: 1 }), auto);
    assert.equal(counts.get('/js/chunk-retry.js'), 3);
    await assert.rejects(fetchScript(page, origin + '/js/chunk-html.js', { attempts: 1 }), /HTML/);
    await assert.rejects(fetchScript(page, origin + '/js/chunk-slow.js', { attempts: 2, timeout: 100, retryDelay: 1 }), /Timed out/);
    assert.equal(counts.get('/js/chunk-slow.js'), 2);
  } finally { await browser.close(); }
});

test('blocked and scriptless pages fail clearly', async () => {
  await assert.rejects(scrape({ url: origin + '/blocked', debugDir: directory }), /HTTP 403/);
  await assert.rejects(scrape({ url: origin + '/empty', debugDir: directory }), /No search JavaScript/);
});

test('publishes fresh hashes and preserves existing bytes and timestamp on partial or total failure', async () => {
  const outputFile = path.join(directory, 'secrets.json');
  const original = JSON.stringify({ timestamp: 1, ...hashes, errors: [] });
  await fs.writeFile(outputFile, original);
  const options = { outputFile, debugDir: directory };
  await assert.rejects(run({ ...options, scraper: async () => { throw new Error('network failed'); } }), /network failed/);
  assert.equal(await fs.readFile(outputFile, 'utf8'), original);
  await assert.rejects(run({ ...options, scraper: async () => ({ hashes: { multiSha: hashes.multiSha } }) }), /Missing fresh hashes/);
  assert.equal(await fs.readFile(outputFile, 'utf8'), original);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'run-report.json'))).status, 'failed');
  const output = await run({ ...options, scraper: async () => ({ hashes, errors: [], sources: {}, processed: 3 }) });
  assert.ok(output.timestamp > 1);
  assert.deepEqual(JSON.parse(await fs.readFile(outputFile)), output);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'run-report.json'))).status, 'success');
});

test('CLI returns nonzero and preserves old output when browser launch fails', async () => {
  const outputFile = path.resolve(directory, 'cli-secrets.json');
  await fs.writeFile(outputFile, 'existing output');
  const entrypoint = path.resolve('index.js');
  const child = spawn(process.execPath, [entrypoint], {
    cwd: directory, env: { ...process.env, CHROMIUM_PATH: path.resolve(directory, 'missing-chrome'), OUTPUT_FILE: outputFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1, logs);
  assert.match(logs, /existing output preserved/);
  assert.equal(await fs.readFile(outputFile, 'utf8'), 'existing output');
});
