# @rbw/search

Tavily searches for one candidate bug: public reports of a bug shape, a grounding extract from the app's user documentation, and exact-phrase checks that flag issue text which already exists publicly.

Every call goes through `@rbw/spend`: it is reserved against the spend pool before it starts and settled from the credits Tavily reports. Every query and result is frozen with the time it ran. A failed search is incomplete evidence, never "no public match".

This package makes no live API calls in tests or in CI. Tests run against a local replay server that serves recorded responses. A live set of recordings is **planned**: the owner records it later through the `record` command below.

## Contents

- [Call plan](#call-plan)
- [Client and options](#client-and-options)
- [Spend envelope](#spend-envelope)
- [Settlement](#settlement)
- [Outcomes](#outcomes)
- [Input](#input)
- [Frozen records](#frozen-records)
- [Recordings and the replay server](#recordings-and-the-replay-server)
- [The `record` command](#the-record-command)
- [Tests](#tests)
- [Not in this package](#not-in-this-package)

## Call plan

At most 6 calls and 12 credits per candidate. The six names are a closed list. A seventh call, an unknown name, a name of the wrong kind for the function, or a repeat of a used name is refused locally with `call_limit_reached` before anything is reserved.

| Call | Name | Function | Tavily call | Notes |
| --- | --- | --- | --- | --- |
| 1 | `source-1` | `searchSource` | `search` | Query: shape keywords, then symptom words |
| 2 | `source-2` | `searchSource` | `search` | Query: symptom words, then shape keywords |
| 3 | `docs-1` | `extractDocs` | `extract` | Exactly one URL on the app user-docs domain |
| 4–6 | `phrase-1` … `phrase-3` | `checkPhrase` | `search` | One quoted phrase from the frozen issue text each |

The caller sequences the calls: source searches, then the extract, then (after the issue text is written and frozen) the phrase checks.

The frozen issue text and its phrases stay out of this public repository until the phrase checks have run. Once the text is public here, the checks can match it (blocking the candidate) or run before it is indexed and wrongly report no public match. They are kept in the private repository, and the private `record` workflow reads them from there.

The call name is part of the operation identity. A restarted process that runs a used name again gets the existing operation back from the spend database (`replay`) or `operation_conflict`, and makes no request: the result is an `incomplete` record with reason `spend_refused:operation_replay` or `spend_refused:operation_conflict`.

## Client and options

- The client is built in one module (`src/client.ts`) with `@tavily/core`, an explicit `apiKey` and an explicit `apiBaseURL`. A missing, empty or whitespace key throws `missing_api_key` before any network use, so the SDK's unauthenticated keyless mode is never reached. A missing base URL throws `missing_base_url`. A Tavily host is refused (`live_endpoint_refused`) unless the caller passes `allowLive: true`, which only the `record` command does.
- Library functions take the client as an injected dependency and read no environment variables. `TAVILY_API_KEY` is read only by the `record` command. The key is never logged, printed, recorded or hashed.
- There are no retries. The SDK has none and this package adds none: a rate limit or any other error is one failed call.

Options per call:

| Call | Options |
| --- | --- |
| Every call | `includeUsage: true`, `timeout` (seconds, from the settings) |
| Every search | `searchDepth: "basic"`, `autoParameters: false`, `maxResults` (from the settings) |
| Source searches | `includeDomains` (GitHub, Stack Overflow and the configured project-docs domains), `includeDomainsMode: "restrict"`, `startDate`, `endDate` (`YYYY-MM-DD`) |
| Docs extract | `extractDepth: "basic"`, `query` from the symptom, one URL |
| Phrase checks | `exactMatch: true`, the query is the quoted phrase, no domain restriction |

Crawl, Map, Research and `feedback` are not used.

**Local checks before reserving** (a refusal here makes no call and creates no record):

| Code | Cause |
| --- | --- |
| `invalid_input` | The input does not match the strict schema |
| `call_limit_reached` | See the call plan |
| `excluded_identifier` | A query contains a term from the caller's excluded-identifier list (case-insensitive). Queries hold only public, symptom-level words. |
| `docs_domain_excluded` | The docs URL is on a domain in `docs_policy.excluded_domains` (the date library's documentation, which names the API where a fix lives) |
| `docs_domain_not_allowed` | The docs URL is not an `https` URL on a domain in `docs_policy.allowed_domains` |
| `source_domain_not_allowed` | `include_domains` names a host other than GitHub, Stack Overflow or a configured project-docs domain, or an excluded docs domain |

## Spend envelope

Each call reserves 2 credits, the worst case for a call made at advanced depth. A basic search costs 1 credit and a basic extract 1 credit per 5 successful URLs, but the reservation stays conservative. The envelope is one line:

```json
{ "service": "tavily", "unit": "credit", "limit": 2, "enforced_by": "request_parameter", "price": { "microusd": 8000, "per_units": 1 } }
```

The price comes from a rate sheet file (below). A missing Tavily credit price refuses with `unknown_price` before reserving. At $0.008 per credit the worst case is 16,000 micro-USD per call.

Protocol per call, following `@rbw/spend`:

1. `slotStatus` must show the root execution as the holder, otherwise `slot_not_held`.
2. `reserve`. On any refusal, stop: no call, no retry.
3. `transition` `prepared → launching`, then the request.
4. `transition` to `terminal` (`completed`, or `failed` for a provider error). A lost response (timeout or a reset connection after sending) becomes `uncertain` with `lost_response`, and the call stops.
5. `settle` once.

Identity fields:

- `project_id`, `project_policy_sha256`, `batch_id`, `task_revision`, `root_execution_id`, `execution_id` and `parent_execution_id` come from the run context, which is validated strictly.
- `kind` is `search.source`, `search.docs` or `search.phrase`. `call_name` is `<kind>:<candidate>:<name>`, for example `search.source:my-candidate:source-1`, built by `callName` of `@rbw/schema`.
- `provider` is `tavily`, `provider_replay_key` is `null` and `attempt_ordinal` is 1.
- `runtime_profile_sha256` is the SHA-256 of the canonical sorted-key JSON of the frozen search profile (options, limits, domain lists and settings).
- `payload_hash` is the SHA-256 of the canonical request (endpoint, query or URL, options).
- `operation_id` is `operationId` of `@rbw/schema` over the call's `OperationIdentity`: `schema_version` 1, project, policy hash, root, batch, task revision, kind, profile digest, call name and attempt ordinal.
- `rate_sheet_sha256` is the SHA-256 of the rate sheet file's bytes.

These live in `src/spend-identity.ts`. The shared schema package will supply them later.

## Settlement

`UsageSettlement` has `schema_version` 1 and one line for `tavily` / `credit`.

| Response | Settlement |
| --- | --- |
| `usage.credits` is a non-negative integer | `actual_quantity` = credits and `actual_microusd` = `ceil(credits × microusd ÷ per_units)`. The rest of the reservation is released and the operation becomes `reconciled`. |
| `usage` is absent or malformed | Unknown. The line keeps its full worst case (16,000 micro-USD at the example price) and the operation stays `terminal`. |
| **Extract** reports `usage.credits` of 0 | Unknown, the same as a missing usage. Tavily's per-response extract count can read 0 until 5 URLs accrue, so 0 is not proof of no charge. The worst case is retained for later reconciliation against Tavily's usage endpoint. |
| Provider error (non-2xx status) | The operation is `terminal` with status `failed`, and its usage is settled as unknown. |
| `usage.credits` above 2 | Recorded as reported. `@rbw/spend` then raises its over-envelope halt, and the result's `spend.over_envelope` is `true`. |
| Timeout or reset connection | No settlement. The operation is `uncertain` and stays that way until a manual reconciliation. |

Reconciliation against Tavily's usage endpoint is not part of this package.

## Outcomes

Each call returns either a refusal (a local check above) or a `SearchRecord`, plus the spend result and a `stop` reason (`spend_refused` or `uncertain`, otherwise `null`).

| Kind | Outcomes |
| --- | --- |
| Source search | `complete`, `incomplete`. `results` is the ordered list of `{ url, title, published_date, score, excerpt }`. The excerpt is Tavily's content cut to `excerpt_max_chars` (default 300) characters. |
| Docs extract | `complete`, `incomplete`. `results` is `[{ url, passages }]`: Tavily's relevant passages (split at `[...]`, at most `max_passages` of `passage_max_chars` characters each). These become the issue writer's `doc_excerpts` later. A URL in the response's failed list is `incomplete`. |
| Phrase check | `public_match` (one or more results, listing the URLs), `no_public_match` (a successful response with zero results), `incomplete`. A `no_public_match` record carries a `statement` with the completion time and says it holds as of that time only. |

**Error rule.** Any thrown error, timeout, non-2xx status, missing or malformed body, refusal from spend or uncertain state gives `incomplete` with one of these reasons. It never gives `no_public_match` or an empty `complete`.

| Reason | Cause |
| --- | --- |
| `provider_error` | An error status (429, 500, …) or a failed extract URL |
| `timeout` | No response within the timeout (the operation becomes `uncertain`) |
| `provider_uncertain` | The connection failed after the request may have been sent (the operation becomes `uncertain`) |
| `malformed_response` | The body is missing, or its results do not have the documented shape |
| `spend_refused:<code>` | `@rbw/spend` refused: `insufficient_funds`, `pool_halted`, `slot_not_held`, `unknown_price`, `operation_conflict`, `operation_replay`, … |

The SDK folds every failure into a plain `Error` and drops the cause, so the reason is read from the error message.

**Novelty summary.** `summarizeNovelty(records)` takes a candidate's three phrase records and returns `clear`, `blocked` or `incomplete`. Any `public_match` gives `blocked`, which blocks release. Otherwise any `incomplete` or missing record gives `incomplete`. It returns `clear` only when all three records are `no_public_match`.

## Input

`src/search-input.ts` holds a strict Zod type for one candidate, with `schema_version` 1 and these required fields. The symptom words and docs query will later come from the shared schema's `ObservedSymptom`, and the phrases from the frozen issue revision.

```json
{
  "schema_version": 1,
  "candidate": "synthetic-candidate-1",
  "source": {
    "shape_keywords": ["synthetic", "report", "filter"],
    "symptom_words": ["empty", "table"],
    "include_domains": ["github.com", "stackoverflow.com"],
    "start_date": "2020-01-01",
    "end_date": "2026-10-01"
  },
  "docs": { "url": "https://docs.example.invalid/guide/reports", "query": "report filter shows empty table" },
  "phrases": ["synthetic phrase one", "synthetic phrase two", "synthetic phrase three"],
  "docs_policy": { "allowed_domains": ["docs.example.invalid"], "excluded_domains": ["datelib.example.invalid"] }
}
```

`candidate` is lowercase letters, digits, `_` and `-`, at most 40 characters, because it is part of the spend call name. A phrase may not contain a double quote, because the query quotes it.

The **run context** has the strict fields `project_id`, `project_policy_sha256`, `batch_id` (required, because the schema's `OperationIdentity` requires a batch ID), `task_revision`, `root_execution_id`, `execution_id` and `parent_execution_id` (nullable). IDs are lowercase UUIDs and hashes are 64 lowercase hex characters:

```json
{
  "project_id": "00000000-0000-4000-8000-000000000064",
  "project_policy_sha256": "0000000000000000000000000000000000000000000000000000000000000003",
  "batch_id": "00000000-0000-4000-8000-000000000065",
  "task_revision": "0000000000000000000000000000000000000000000000000000000000000004",
  "root_execution_id": "00000000-0000-4000-8000-000000000001",
  "execution_id": "00000000-0000-4000-8000-000000000001",
  "parent_execution_id": null
}
```

The **rate sheet** is a JSON array until the shared rate-sheet package exists. Tavily's published pay-as-you-go price is $0.008 per credit:

```json
[{ "service": "tavily", "unit": "credit", "price": { "microusd": 8000, "per_units": 1 }, "source_url": "https://example.invalid/pricing" }]
```

## Frozen records

A `SearchRecord` has `schema_version` 1, `candidate`, `call_name`, `kind`, `request` (endpoint, query, URLs and the exact options: no key and no headers), `requested_at` and `completed_at` (UTC RFC 3339 ending in `Z`), `outcome`, `reason`, `results`, `reported_credits` (nullable), `operation_id`, `statement` and `sha256`, the SHA-256 of the record's canonical bytes (sorted-key JSON without `sha256`).

Records are written once, under the key `<candidate>.<call name>`, through a `RecordStore`. A second write of identical bytes is accepted. A second write of different bytes throws `record_conflict`. A call whose key already holds a record is refused with `call_limit_reached`. Readers such as a judge replay read the store and make no new call. `createDirectoryRecordStore(dir)` writes `<key>.record.json`; `createMemoryRecordStore()` is for tests.

## Recordings and the replay server

A recording file holds `schema_version`, `provenance` (`synthetic` or `live`), `endpoint`, `recorded_at`, `request_body` (without `api_key`, and with no header) and `response` (`status` and `body`).

Tests start an HTTP server on `127.0.0.1` on a random port and pass it as `apiBaseURL`. It matches a request by endpoint plus the SHA-256 of the canonical request body. A request that matches nothing gets an error response, is listed in `unmatched`, and fails the test. It is never forwarded.

`recordings/synthetic/` holds synthetic recordings shaped like Tavily's documented responses, with `example.invalid` URLs: a source search with results, an extract with passages, an extract with a failed URL, a phrase check with a match and one with zero results, a 429, a 500, a response with no `usage`, and an extract reporting 0 credits. `node test/support/generate-recordings.ts` regenerates them, and a test fails if the committed files differ from the generator.

Live recordings are **planned**: the owner's first live set will be committed in a follow-up change.

## The `record` command

The owner runs this later, from a private workflow. It cannot run in the development container, which has no Tavily key.

```
pnpm --filter @rbw/search run record -- --context <run-context.json> --rate-sheet <rates.json> --input <search-input.json> --out <dir> --slot-key <key> --pool <pool-key>
```

- **Environment:** `DATABASE_URL` and `TAVILY_API_KEY`. If either is unset, it exits non-zero naming the variable, before reserving.
- **Optional flags:** `--allocation <key>` (a pool with allocations), `--settings <file>` (JSON overriding the defaults: `timeout_seconds` 30, `max_results` 5, `excerpt_max_chars` 300, `passage_max_chars` 2000, `max_passages` 6, `project_docs_domains` empty), `--excluded-identifiers <file>` (a JSON array of strings for the query check) and `--api-base-url <url>` (default `https://api.tavily.com`).
- It acquires the slot for the context's root, then runs the six calls in plan order, each reserved before and settled after.
- It writes `<call>.recording.json` (provenance `live`) and `<candidate>.<call>.record.json` into `--out`, and prints one line per call: name, outcome, operation ID, reserved, settled and retained micro-USD and reported credits.
- It then releases the slot when nothing blocks it.
- It stops at the first spend refusal or uncertain state, exits non-zero and leaves the slot held. A provider error on one call records `incomplete` for that call and continues with the next, because each call is reserved on its own.
- It never prints the key, the connection string or a header. Errors print a code only.

## Tests

| Script | What it does |
| --- | --- |
| `pnpm --filter @rbw/search test` | Unit tests: PGlite with the `@rbw/spend` migrations in a fresh schema per test, the replay server and synthetic values. No network service. |
| `pnpm --filter @rbw/search run test:integration` | Reads `DATABASE_URL`, and prints a skip message and exits 0 when it is unset. Otherwise it creates a random schema with the migrations, runs one replayed search, one forced 500 and one `insufficient_funds`, and drops the schema afterwards, also on failure. |

## Not in this package

The issue writer, the shared rate-sheet and envelope package, the shared schema types, the private workflow file, Tavily usage-endpoint reconciliation and caching across candidates are all planned elsewhere.
