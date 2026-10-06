# ot-sha

Extract the public persisted-query hashes for OpenTable availability, multi-search, and autocomplete. Runs hourly through GitHub Actions and can also be dispatched manually.

## Run locally

Use Node.js 22+ and an installed Chrome/Chromium browser:

```powershell
npm ci
$env:CHROMIUM_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
npm start
```

On Linux/macOS, set `CHROMIUM_PATH` to the browser executable. `OUTPUT_FILE` optionally overrides `secrets/secrets.json` (for example `temp/live-secrets.json` during verification).

The scraper captures loaded JavaScript and downloads missing chunks within the same browser session. It resolves relative imports recursively and parses document definitions to associate each operation with its own SHA. It never executes downloaded bundles to extract hashes.

## Interpreting a run

- Success means all three valid hashes were freshly observed, even if their values did not change. The timestamp records that successful extraction.
- Failure exits nonzero and leaves the prior output file and timestamp untouched. Old values are never presented as a fresh success.
- `temp/run-report.json` contains status, sources, counts, and errors. `temp/debug-page.html` contains the page for troubleshooting; HTML is not dumped into console logs.
- GitHub Actions tests first, publishes a run summary and seven-day diagnostics artifact, and commits only after successful extraction. Failed jobs use normal GitHub Actions notifications according to your notification settings.
- Successful extraction does not prove that a downstream GraphQL request accepts the hashes. That requires a separate request-level check.

## Verification

`npm test` starts a local HTTP fixture server and launches headless Chrome. It covers query/hash association, imported chunks, browser-session cookies, timeouts/retries, blocked pages, CLI exit status, and preservation/publication of output. It makes no OpenTable requests. `CHROMIUM_PATH` is required; browser tests are not silently skipped.

Implementation references: [Puppeteer](https://github.com/puppeteer/puppeteer), [response body capture](https://pptr.dev/api/puppeteer.httpresponse.text), and [GitHub artifact download scope](https://github.com/actions/download-artifact).
