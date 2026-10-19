# Fixtures for `bug-request/1`

These are representative bodies for the contract in [`../../bug-request-v1.md`](../../bug-request-v1.md). Each JSON file is one response body, except `start-request.json`, which is a request body. The endpoints are planned. The fixtures show shapes and states, not measured results.

All values are synthetic. Request IDs follow the pattern `00000000-0000-4000-8000-0000000001nn`, and validation IDs follow `00000000-0000-4000-8000-0000000002nn`. Hashes are a repeated two-character pattern, catalog and suite IDs start with `synthetic-`, and amounts are invented. Message text is illustrative, because clients branch on codes and never on messages.

How the files relate:

- `start-request.json`, `status-queued.json`, `status-running.json`, `status-fulfilled.json` and `status-validated.json` follow one request (`…000000000101`) from start to finish and then through three validation runs. They all carry the body of `interpretation-supported.json`, and the earlier event lists are prefixes of the later ones.
- `status-cancelled.json` sends the same input as a separate request, so it carries the same interpretation and hash. The other status files are separate requests with their own inputs.
- The validation files refer to the two cases in `status-fulfilled.json`. `status-validated.json` shows their reservations and costs in the request's budget and events.
- `example.json` shows the task-report case under its published-example provenance. It has the same `case_id` as the live case because both are the same case.
- Each supported combination has a one-entry catalog, so several scenarios try the same entry. Its check outcomes differ between scenarios on purpose. The exception is `status-duplicate-defect.json`, from the test-mode `duplicate-defect` scenario, whose task-report catalog has a second entry that plants the first entry's defect.
- Candidate IDs (`e1…` task-report entry 01, `e2…` Umami entry 01, `e3…` task-report entry 02) differ from defect IDs (`da…`, `db…`).
- Amounts follow section 8.5 of the contract: in every `budget_updated` event and status `budget`, committed = reserved + spent and remaining = budget − committed. Worst cases: the worker $0.20; a candidate $0.60 on Umami and $0.30 on task-report; a validation run $0.30 on Umami and $0.20 on task-report. The worker settles at its full worst case just before `request_finished`.

| File | Endpoint | HTTP | Scenario |
|---|---|---|---|
| `capabilities.json` | `GET /api/factory/capabilities` | 200 | The service is available. Umami × `date_time` and task-report × `concurrency` are supported, each with a one-entry catalog. The other two pairs are unsupported, and source-only difficulty is listed as unavailable. The interpreter declares its filler phrases. |
| `interpretation-supported.json` | `POST /api/factory/interpretations` | 200 | Both hosts. One `concurrency` item has a description matched to `concurrency.lost-acknowledged-change`, and one `date_time` item has no description. Startable. |
| `interpretation-unsupported.json` | `POST /api/factory/interpretations` | 200 | One host, not startable. Shows `no_matching_source`, `unrecognized_description` with `unmatched_text`, `unsupported_difficulty` and `unsupported_combination`, plus a `quantity_exceeds_source` warning on its only supported concurrency item. |
| `interpretation-budget-below-minimum.json` | `POST /api/factory/interpretations` | 200 | Umami only, budget $0.70. The request-level blocking problem `budget_below_minimum`: the worker's $0.20 plus one Umami candidate's $0.60 does not fit. Not startable, so a start answers `422 unsupported_request`. |
| `start-request.json` | `POST /api/factory/requests` | request body | Starts the supported interpretation. |
| `status-queued.json` | `POST /api/factory/requests` | 202 (200 when the same body is sent again) | Just accepted. The worker's worst case is reserved (event 2). |
| `status-running.json` | `GET /api/factory/requests/{request_id}` | 200 | The same request with both hosts ready. The task-report candidate is checking after three `check_finished` events, and the worker's and the candidate's worst cases are reserved. |
| `status-fulfilled.json` | `GET /api/factory/requests/{request_id}` | 200 | The same request has finished `fulfilled` with `delivery: "complete"`: one case per item, on both hosts, with both package parts ready. |
| `status-validated.json` | `GET /api/factory/requests/{request_id}` | 200 | The same request after validation runs `…201` (passed), `…202` (failed) and `…203` (error). Each run's worst case was reserved and its cost settled after `request_finished`, and each case shows its latest run. |
| `status-partial-budget.json` | `GET /api/factory/requests/{request_id}` | 200 | Same items, smaller budget. The concurrency case is delivered. The Umami candidate is `skipped` (`no_budget_for_candidate`: $0.29 remains against its $0.60 worst case), then the request finishes `stopped_at_limit` / `budget_exhausted` with `delivery: "partial"`. |
| `status-exhausted.json` | `GET /api/factory/requests/{request_id}` | 200 | Task-report only. Two concurrency items of quantity 1 share the one eligible entry, so both carry the type-level `quantity_exceeds_source` warning. The case goes to `concurrency-1`, which has more criteria than `concurrency-any` although it comes second, and the request finishes `sources_exhausted` with `delivery: "partial"`. |
| `status-duplicate-defect.json` | `GET /api/factory/requests/{request_id}` | 200 | Test-mode `duplicate-defect` scenario: task-report only, quantity 2, two catalog entries that plant one defect. Entry 01 is delivered. Entry 02 is `skipped` (`duplicate_defect`) under its own `candidate_id` with the same `defect_id`, and the request finishes `sources_exhausted` with `delivery: "partial"`. |
| `status-cancelled.json` | `GET /api/factory/requests/{request_id}`, or a repeated `POST …/stop` | 200 | A stop arrives while the second candidate is checking. The check in flight finishes, the candidate becomes `incomplete` (`stopped`), and the earlier case stays delivered. Outcome `cancelled`. |
| `status-operational-error.json` | `GET /api/factory/requests/{request_id}` | 200 | The worker stops sending heartbeats during a check. After 60 s `attention` becomes `worker_unresponsive`; after 180 s the candidate becomes `incomplete` (`incomplete_run`) and is not retried. The worker's and the candidate's reservations stay held under `attention: needs_reconciliation`, and the request finishes `operational_error` / `worker_lost` with `delivery: "none"`. Until an operator reconciles, new starts answer `error-busy-needs-reconciliation.json`. |
| `status-zero-result.json` | `GET /api/factory/requests/{request_id}` | 200 | Umami only. The original suite catches the bug on the buggy copy (`original_suite_caught_bug`), the source is exhausted, and the request finishes `sources_exhausted` with `delivery: "none"`. |
| `validation-running.json` | `GET /api/factory/requests/{request_id}/cases/{case_id}/validations/{validation_id}` | 200 (the starting `POST` answers 202 with this shape) | A run on the task-report case is in progress. |
| `validation-passed.json` | same | 200 | The same run has finished, and all six cells match. |
| `validation-failed.json` | same | 200 | A run on the Umami case completed with one mismatched cell: the verification checks passed on the buggy copy. That is a behavioral result. |
| `validation-error.json` | same | 200 | The harness could not prepare the clean copy, so its two cells observed `error` and the result is `error`, not `failed`. That is not a behavioral result. |
| `session.json` | `GET /api/factory/session` | 200 | Signed in. |
| `session-signed-out.json` | `GET /api/factory/session` | 200 | No valid session: `signed_in: false`. |
| `example.json` | `GET /api/factory/example` | 200 | A completed example with `published_example` provenance and public download URLs. |
| `error-invalid-request.json` | `POST /api/factory/interpretations` or `POST /api/factory/requests` (any endpoint with a body or query) | 400 | A field is out of range (contract section 4.3). |
| `error-unauthorized.json` | any session-required endpoint | 401 | No valid factory session. |
| `error-passcode-incorrect.json` | `POST /api/factory/session` | 401 | Wrong passcode. |
| `error-not-found.json` | `GET /api/factory/requests/{request_id}` (also cases and validation runs) | 404 | Unknown ID, including one refused as `busy`. |
| `error-idempotency-conflict.json` | `POST /api/factory/requests` (also `POST …/validations`) | 409 | The ID already exists with a different body. |
| `error-interpretation-stale.json` | `POST /api/factory/requests` | 409 | `details.interpretation` holds the current interpretation (the body of `interpretation-supported.json`). |
| `error-busy.json` | `POST /api/factory/requests` (also `POST …/validations`) | 409 | Another request or validation run is active: `details.reason: "active"`, `retryable: true`. |
| `error-busy-needs-reconciliation.json` | `POST /api/factory/requests` (also `POST …/validations`) | 409 | A finished request's uncertain spend awaits an operator: `details.reason: "needs_reconciliation"`, `retryable: false`. |
| `error-budget-unavailable.json` | `POST /api/factory/requests` (also `POST …/validations`) | 409 | The pool or the request budget cannot cover it. |
| `error-not-ready.json` | `GET {download_path}` | 409 | The package part is not ready. |
| `error-unsupported-request.json` | `POST /api/factory/requests` | 422 | `details.interpretation` holds the blocking interpretation (the body of `interpretation-unsupported.json`). |
| `error-unavailable.json` | `POST /api/factory/requests` (any endpoint) | 503 | The spend ledger is halted. `retryable: true`. |
