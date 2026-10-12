# Purpose

Maintain the three public OpenTable GraphQL persisted-query document IDs used by downstream integrations. These hashes identify queries; they are not authentication credentials. Consumers need fresh, correctly associated values and visible failures when extraction stops working.

# Data dictionary

`secrets/secrets.json` is the consumer contract:

| Field | Meaning |
| --- | --- |
| timestamp | Unix milliseconds when all three hashes were freshly extracted; unchanged on failure |
| availabilitySha | 64 lowercase hexadecimal characters for RestaurantsAvailability |
| multiSha | 64 lowercase hexadecimal characters for MultiSearchResults |
| autoSha | 64 lowercase hexadecimal characters for the Autocomplete operation (whose result field is autocompleteResults) |
| errors | Nonfatal asset download/parse errors encountered during the successful extraction |

`temp/run-report.json` records the attempt time, status, source URL for each hash, asset count and errors. Failed attempts preserve the entire previous consumer file. Extraction proves presence in current JavaScript, not acceptance by the GraphQL API.

This is a scheduled CLI, with no HTTP service, database, or API requiring an OpenAPI spec.

Notification policy: scheduled/manual refresh failures notify from the third consecutive failed run onward. Successful refreshes reset the streak. The first two failures retain their diagnostic evidence while the overall workflow is tolerated. GitHub job/step history is the source of truth; no separate counter or data store is needed. PR failures and failures of the history lookup remain immediately visible as failed workflows.
