# Active tasks

- Complete: Repair extraction, stale-success handling, and GitHub Actions diagnostics.
- Complete: Full bundled suite passed with the final installed dependencies: 10 tests, 10 passed, 0 failed, 0 skipped. Includes a running local HTTP fixture server and real headless Chrome. Raw output: `temp/test-run.log`.
- Complete: Live CLI extraction succeeded on 2026-10-06: 258 assets analyzed, zero download/parse errors, all three hashes freshly found. Output: `temp/live-secrets.json`; provenance: `temp/run-report.json`; raw output: `temp/live-run.log`. The tracked consumer file was left untouched during verification.
- In Progress: Push the repair, manually dispatch the workflow, and verify the GitHub-hosted test, extraction, and publication logs.

# Decision log

- 2026-10-06: The supplied run downloaded no assets but reused all old hashes and advanced the timestamp. Require all three fresh values before publishing; leave old data untouched and fail the job otherwise.
- 2026-10-06: Use the existing browser session for asset capture/downloads. Closing Chrome and then fetching with a separate HTTP client loses the browser request context; the supplied abort logs do not establish the precise network cause.
- 2026-10-06: Match GraphQL documents through a static JavaScript parser, never by taking the first documentId in a bundle and never by executing downloaded code.
- 2026-10-06: Use Node.js and vanilla JavaScript per repository instructions, retain the current browser libraries, and commit an npm lockfile.
- 2026-10-06: Replace ineffective failure-streak artifacts and placeholder alerts with ordinary failed jobs, a run summary, and downloadable diagnostics. The old download-artifact step only looked in the current run, so it did not restore the previous run's streak.
- 2026-10-06: Live inspection confirms autoSha belongs to the Autocomplete operation, not the autocompleteResults field. Match the operation name explicitly.
- 2026-10-06: The live multi-search hash differs from the user's supplied fallback; availability and autocomplete match. No downstream GraphQL request was made. User authorized pushing the repair and triggering GitHub Actions for hosted verification.
