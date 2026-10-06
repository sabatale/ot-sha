# Roadmap

1. Complete: reliable extraction and honest GitHub Actions status, browser-session downloads, operation-specific matching, all-or-nothing publication, bundled tests and diagnostics. Verified with 10 passing tests and successful live extraction on 2026-10-06.
2. Complete: pushed the repair and verified [manual GitHub Actions run 37531452666](https://github.com/sabatale/ot-sha/actions/runs/37531452666). Hosted tests passed, all three hashes were freshly extracted without asset errors, and the workflow committed the refreshed output. The hourly schedule remains enabled.

Future API-level validation is separate work, requiring a defined downstream request contract. No additional infrastructure is needed for this repair.
