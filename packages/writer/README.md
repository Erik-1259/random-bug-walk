# @rbw/writer

Asks one model to write (a) a pattern card from public source-fix information and (b) a user-style bug report ("issue") from a typed, symptom-only observation.

- Every model call is bounded, counted and priced before it starts, reserved against the spend pool through `@rbw/spend`, and settled after it ends.
- Code checks every issue before any person sees it: its structure, every number in it, and a scan for internal identifiers.
- Nothing in this package marks an issue approved. The best outcome is `ready_for_review`.

The package makes no live call in its tests or in public CI. A replay `fetch` answers from committed recordings. The live recording, made by the owner with the `record` command in a private workflow, is **planned**; every committed recording today is labelled `synthetic`.

## Contents

- [Scripts](#scripts)
- [API](#api)
- [Model and request settings](#model-and-request-settings)
- [Limits and how each is enforced](#limits-and-how-each-is-enforced)
- [Prompt counting](#prompt-counting)
- [Call order: reserve, launch, settle](#call-order-reserve-launch-settle)
- [Identity fields and the rate record](#identity-fields-and-the-rate-record)
- [Outcomes](#outcomes)
- [Issue input: ObservedSymptom](#issue-input-observedsymptom)
- [Issue checks and the check report](#issue-checks-and-the-check-report)
- [Pattern card](#pattern-card)
- [Recordings and the replay fetch](#recordings-and-the-replay-fetch)
- [The record command](#the-record-command)
- [Tests](#tests)
- [Not in this package (planned elsewhere)](#not-in-this-package-planned-elsewhere)

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm --filter @rbw/writer run test` | Unit tests: PGlite with the `@rbw/spend` migrations, the replay `fetch`, synthetic context and prices. No network. |
| `pnpm --filter @rbw/writer run test:integration` | Integration tests against the Postgres in `DATABASE_URL`, in a fresh randomly named schema that is dropped afterwards, also on failure. With `DATABASE_URL` unset it prints `test:integration skipped: DATABASE_URL is not set` and exits 0. |
| `pnpm --filter @rbw/writer run record -- ...` | The live recording command (see [below](#the-record-command)). |
| `build`, `typecheck`, `lint` | The workspace's standard scripts. |

## API

```ts
import { createReplayFetch, createWriter, createWriterProvider, loadRecordings } from "@rbw/writer";

const provider = createWriterProvider({ fetch: createReplayFetch(await loadRecordings(dir)) });
const writer = createWriter({
  spend, // from @rbw/spend's createSpend
  provider,
  context, // run context, validated strictly
  poolKey: "development",
  allocationKey: null,
  slotKey, // the context's root execution must already hold it
  rateSheet, // exact bytes of the rate file
});

const issue = await writer.writeIssue({ candidate, symptom, excludedIdentifiers });
const card = await writer.writeCard({ candidate, source });
```

| Function | Purpose |
| --- | --- |
| `createWriterProvider({ fetch, apiKey? })` | Builds the fixed model on the OpenAI-compatible provider. `fetch` is required; construction without it throws. `apiKey` is sent only as the bearer header and is never recorded. |
| `createWriter(options)` | Validates the run context (unknown fields rejected; throws on an invalid context) and returns the writer. Reads no environment variable. |
| `writer.writeIssue({ candidate, symptom, excludedIdentifiers })` | One metered issue call, then the issue checks. |
| `writer.writeCard({ candidate, source })` | One metered card call; the code-owned fields are filled from `source.confirmation`. |
| `writer.previewIssue(symptom)`, `writer.previewCard(source)` | Render the exact request bytes and count their bound. Reserve and send nothing. |
| `checkIssue(output, symptom, excluded)` | The four issue checks as a pure function. |
| `parseObservedSymptom(value)` | The only way to obtain an `ObservedSymptom` (a branded type). |
| `createReplayFetch`, `loadRecordings`, `makeRecording` | The replay layer (see [Recordings](#recordings-and-the-replay-fetch)). |
| `runRecord(options)` | The `record` command with its dependencies injected. |

A **repair** is not a separate API: after a failed or rejected call, the caller calls `writeIssue` or `writeCard` again. That is a new call with its own ordinal, its own reservation and its own settlement.

Calls of one writer run one at a time, in the order they were made, so overlapping calls never pick the same ordinal. A provider serves one request at a time: if two writers share one provider and their requests overlap after launch, the later one is not sent and its call is recorded as `failed` with `request_not_sent` and settled.

## Model and request settings

All of these are constants in `src/config.ts`. Nothing overrides them, and there is no fallback model.

| Setting | Value | Where it shows |
| --- | --- | --- |
| Model | `nvidia/Nemotron-3_5-Lightning` | `model` in the request body |
| Base URL | `https://api.tokenfactory.nebius.com/v1/` (requests go to `chat/completions`) | request URL |
| SDK | `ai` 7.0.127 `generateText` with `Output.object` (Zod schema, strict JSON schema), `@ai-sdk/openai-compatible` 3.0.62 | `response_format` of type `json_schema` |
| Thinking | off: `chat_template_kwargs: { enable_thinking: false }`, added by the provider's `transformRequestBody` | request body |
| Tools | none; `transformRequestBody` throws if a `tools` field ever appears | no `tools`, `tool_choice` or `parallel_tool_calls` in the body |
| Retries | `maxRetries: 0`, and no retry wrapper. The fetch wrapper also refuses a second request within one call | an HTTP 500 is requested exactly once |
| Output limit | `maxOutputTokens` 8,192 (all output, reasoning included) | `max_tokens: 8192` |
| Usage | `includeUsage: true` is set. In this provider version it adds `stream_options` to streaming requests only; a non-streaming chat completion, which is what the writer sends, carries `usage` in its response without being asked | `usage.prompt_tokens`, `usage.completion_tokens` in the response |
| Request timeout | 600,000 ms, after which the request is abandoned and recorded as a lost response | |

## Limits and how each is enforced

| Limit | Enforced by | When |
| --- | --- | --- |
| Input: 32,768 tokens per call | The counted bound (next section). Over the limit: `prompt_too_large`, nothing reserved, nothing sent. Envelope line `enforced_by: "client_counter"` | Before reserving |
| Output: 8,192 tokens per call | `max_tokens` in the request. Envelope line `enforced_by: "request_parameter"` | In the request |
| 12 billed calls per candidate, shared by card, issue and repairs | The next free ordinal is read from the ledger. With none left: `call_limit_reached` | Before reserving |
| Money | `@rbw/spend` reserves the worst case of both lines against the pool; a refusal (`insufficient_funds` included) stops the call | Before launching |
| One request per call, exact bytes | The fetch wrapper sends only the body that was hashed into `payload_hash`, once | At the request |

## Prompt counting

The bound is a conservative upper bound that needs no tokenizer download:

```
bound = Σ UTF-8 bytes of each message's content
      + UTF-8 bytes of the serialized response_format (the structured-output schema the request carries)
      + 16 per message      (PER_MESSAGE_FRAMING_TOKENS)
      + 256 per request     (PER_REQUEST_FRAMING_TOKENS)
```

- **Assumption:** the model's tokenizer is byte-level, so every ordinary token covers at least one byte, and a text of n bytes is at most n tokens. The per-message allowance covers the chat template's role markers and separators. The per-request allowance covers the template's preamble, the generation prompt and any marker the template adds when thinking is off.
- **What is counted:** the exact request body that will be sent. The writer renders it with the SDK through the fetch wrapper in preview mode, which captures the bytes and sends nothing. The same bytes are hashed into `payload_hash` and are the only bytes the real call may send.
- **Persisted:** `input_token_bound` is part of every call record and of every `record` summary.
- **Checked against the provider:** every call record has `prompt_within_bound` (reported prompt tokens ≤ bound, or `null` when not reported). The `record` command stops and exits non-zero with `BOUND EXCEEDED` when the reported count is above the bound.

## Call order: reserve, launch, settle

Each call follows the `@rbw/spend` caller protocol in this order. Steps 1 to 5 are local or read-only, and a refusal there writes nothing.

1. Validate the input (`invalid_input`).
2. Read the rate record and build the envelope (`unknown_price`).
3. Render the request and count its bound (`prompt_too_large`).
4. Check through `slotStatus` that the context's root execution holds the slot (`slot_not_held`, or `unknown_slot`).
5. Find the next free ordinal: for ordinals 1, 2, … call `operationStatus` on the card and the issue operation IDs and take the first where both are `unknown_operation` (`call_limit_reached` after 12).
6. `reserve`. Any refusal is returned at once; nothing is sent and nothing retries.
7. `transition` `prepared → launching` with the slot key, before the request.
8. Send the request.
9. `transition` to `terminal` with `completed` or `failed`. If the request was sent and its response was lost (the fetch threw, the body broke off or the timeout fired), the operation goes to `uncertain` with `lost_response` and the call stops there, with no settlement and no retry.
10. `settle` once with a `UsageSettlement` (`schema_version` 1). For each line, `actual_quantity` is the reported token count and `actual_microusd` is `ceil(quantity × microusd ÷ per_units)`, computed exactly. When the response lacks a count, that line's quantity and amount are `null` and it retains its full worst case (`partly_unknown` or `unknown`); the operation then stays `terminal` until a manual reconciliation. Missing usage is never zero.

A call is `failed` when the HTTP status is not 2xx (`http_status`), when the response does not match the schema (`invalid_output`), or when the request provably never left the process (`request_not_sent`, for example a replay with no matching recording). A failed call is still settled.

If `prepared → launching` is refused after a reservation, the refusal is returned with the `operation_id`. The operation stays `prepared` and needs a `confirm_no_launch` reconciliation (see the `@rbw/spend` README). A spend refusal on a write after launch is reported as `ledger_refusal` in the call record. An infrastructure error (for example a dropped database connection) once the reservation has been requested is thrown as `WriterInterruptedError`, whose `operation_id` names the operation to check with `operationStatus`.

## Identity fields and the rate record

All hashes and IDs are computed in `src/identity.ts`. The shared schema package will supply these hashes and the run context later.

| Field | Value |
| --- | --- |
| `project_id`, `project_policy_sha256`, `batch_id`, `task_revision`, `root_execution_id`, `execution_id`, `parent_execution_id` | From the run context |
| `kind` | `writer.card` or `writer.issue` |
| `call_name` | `<kind>.<candidate>.<ordinal>`, for example `writer.issue.synthetic-candidate-1.3` |
| `provider` | `token-factory` |
| `provider_replay_key` | `null` |
| `attempt_ordinal`, `previous_operation_id` | `1`, `null` |
| `runtime_profile_sha256` | SHA-256 of the canonical JSON (sorted keys, no whitespace) of the frozen writer profile: provider, model, base URL, limits, retries, thinking, tools, structured-output mode, the counting constants and the request timeout |
| `payload_hash` | SHA-256 of the exact request body bytes sent |
| `operation_id` | SHA-256 of the canonical JSON of project, policy hash, root execution, batch, task revision, kind, profile digest, candidate, call ordinal and attempt ordinal |
| `rate_sheet_sha256` | SHA-256 of the rate file's exact bytes |

The spend ledger accepts call names of lowercase letters, digits, `.`, `_` and `-` only, so the parts of the call name are joined with `.`. A candidate name is therefore limited to lowercase letters, digits, `_` and `-`, at most 46 characters.

**Run context** (strict; every field required):

```json
{
  "project_id": "00000000-0000-4000-8000-000000000001",
  "project_policy_sha256": "000000000000000000000000000000000000000000000000000000000000000b",
  "batch_id": "00000000-0000-4000-8000-000000000002",
  "task_revision": "000000000000000000000000000000000000000000000000000000000000000c",
  "root_execution_id": "00000000-0000-4000-8000-000000000003",
  "execution_id": "00000000-0000-4000-8000-000000000004",
  "parent_execution_id": "00000000-0000-4000-8000-000000000003"
}
```

**Rate record.** Until the shared rate-sheet package exists, the rate file is a JSON array of `{ service, unit, price: { microusd, per_units }, source_url }`. The writer needs `token-factory` lines for `input_token` and `output_token`. A missing file, unreadable JSON, a malformed or repeated entry, or a missing line refuses with `unknown_price` before any reservation. Synthetic example, at the currently published prices of $0.06 and $0.24 per million tokens:

```json
[
  { "service": "token-factory", "unit": "input_token", "price": { "microusd": 60000, "per_units": 1000000 }, "source_url": "https://prices.example.invalid/synthetic" },
  { "service": "token-factory", "unit": "output_token", "price": { "microusd": 240000, "per_units": 1000000 }, "source_url": "https://prices.example.invalid/synthetic" }
]
```

At those prices one call reserves `ceil(32768 × 0.06) + ceil(8192 × 0.24)` = 1,967 + 1,967 = 3,934 micro-USD. The real rate file is supplied when `record` runs and is not committed.

## Outcomes

`writeIssue` and `writeCard` return either a refusal, when nothing was sent, or a call record, when a request was launched.

- **Refusal** `{ ok: false, code, detail, operation_id }`. `code` is a `@rbw/spend` refusal code (`insufficient_funds`, `unknown_price`, `slot_not_held`, `pool_halted`, …) or one of the writer's own:

  | Code | Cause |
  | --- | --- |
  | `invalid_input` | The symptom, card source, candidate name or excluded-identifier list is invalid |
  | `prompt_too_large` | The counted bound is above 32,768 |
  | `call_limit_reached` | The candidate has used all 12 calls |
  | `operation_replayed` | Another process reserved the same call first |

- **Called** `{ ok: true, call, ... }`. `call` holds `operation_id`, `kind`, `candidate`, `call_ordinal`, `call_name`, `payload_hash`, `input_token_bound`, `request_body`, `status` (`completed`, `failed`, `uncertain`), `failure`, `http_status`, `response_body`, `usage`, `prompt_within_bound`, `reserved_microusd`, `settlement` and `ledger_refusal`. An issue outcome adds `issue` and `report`. A card outcome adds `card` and `code_owned_fields`.

## Issue input: ObservedSymptom

The issue writer accepts only an `ObservedSymptom`. A narrow local Zod type in `src/observed-symptom.ts` defines it for now. It will be replaced by the shared schema's `ObservedSymptom`, and field names may change then. Every object in it is strict and every field is required:

| Field | Type |
| --- | --- |
| `schema_version` | `1` |
| `user_action` | string: what the user did, in product terms |
| `request` | `{ method, path, query }`: the public endpoint, with `query` mapping public parameter names to strings |
| `timezone` | IANA zone name |
| `locale` | string or `null` |
| `fixture_description` | string: the recorded visits, in user terms |
| `events` | ordered `{ label, timestamp_seconds, utc_instant }` |
| `http_status` | integer |
| `expected`, `observed` | ordered `{ bucket_label, count }` for the primary time zone |
| `follow_up_examples` | `{ timezone, expected, observed }` |
| `doc_excerpts` | `{ text, source_url }`: user-documentation passages only |

An extra field anywhere (a stack trace, a source path, a check ID, a patch, card content), a missing field or another `schema_version` is refused with `invalid_input` before anything is reserved. The issue prompt builder (`src/issue-prompt.ts`) takes only a validated `ObservedSymptom` and imports nothing from the card modules.

## Issue checks and the check report

The checks run in this order on every issue response:

1. **Structure.** The Zod schema: `title`, `reproduction_steps` (non-empty list), `expected_result`, `actual_result`, `environment`, nothing else. A failure means the call failed (`invalid_output`), and no later check runs.
2. **Numeric statements.** Every digit run in every field must equal, as an integer (`07` matches `7`), a digit run found in the observation's values: counts, timestamps, bucket labels, HTTP status, query values, doc excerpts and the other text fields. In addition, `expected_result` must contain the primary expected counts, and `actual_result` the primary observed counts, in bucket order (other numbers may sit between them). Violations name the field and the number, or the missing vector (`numeric_mismatch`).
3. **Identifier scan** (`excluded_identifier`). Case-insensitive, on word boundaries:
   - every term of the caller's `excludedIdentifiers` list (the fixture's function and helper names, source paths, check IDs, shape ID, source-fix commit ID, supplied as data; no fixture's list is built in);
   - a path or file name ending in `.ts`, `.tsx`, `.js`, `.py` or `.sql`, including absolute paths, `@/` and `~/` paths, bracketed route segments such as `[id]`, route groups such as `(group)`, and paths inside URLs or stack frames (`Node.js` is not treated as a path);
   - a 40-character hexadecimal commit ID;
   - a dotted check-style ID (`word.word-word`);
   - card field names that read as identifiers: `bug_class`, `fault_shape`, `runtime_dependence`, `fidelity_tier`, `shape_id`, `rules_matched`, `matched_lines`, `source_links`, `diff_excerpt`, `failing_tests`, `levers_apply`, `levers_absent`, `levers_unverified`. Single-word card fields (`date`, `trigger`, `symptom`, `value`, …) are ordinary words a bug report needs and are not scanned.
4. **Hint words**, reported to the reviewer with field and offset and never blocking: `argument`, `parameter`, `passed`, `pass through`, `forward`, `default`, `defaults to UTC`, `ignored`, `dropped` (with their plural and past forms).

The report:

```ts
{
  status: "ready_for_review" | "rejected",
  codes: ("invalid_structure" | "numeric_mismatch" | "excluded_identifier")[],
  structure: { ok, detail },
  numeric: { ok, violations: { field, reason, number }[] } | null,
  identifiers: { ok, violations: { field, offset, kind, term }[] } | null,
  hint_words: { field, offset, word }[],
}
```

Fields are named `title`, `reproduction_steps[<i>]`, `expected_result`, `actual_result` and `environment`. An issue that passes checks 1 to 3 is `ready_for_review`.

## Pattern card

The card writer reads public source-fix information only. Its input (`CardSourceSchema`, strict) is `source_links`, `repository`, `date`, `license`, `diff_excerpt`, `issue_text` and the caller's `confirmation` (`card_id`, `shape_id`, `rules_matched`, `matched_lines`).

The output (`CardSchema`, strict) has `id`, `provenance` (`source_links`, `repository`, `date`, `license`), `bug_class`, `mechanism`, `shape` (`shape_id`, `rules_matched`, `matched_lines`), `fault_shape`, `trigger`, `symptom`, `apis`, `runtime_dependence`, `fidelity_tier` (`A`, `B`, `C`) and `references` (`diff_excerpt`, `failing_tests`).

- `bug_class` is one of `time_and_date`, `data_validation`, `permissions`, `async_ordering_and_races`, `caching_and_stale_state`, `configuration_and_environment`, `ui_state_and_hydration`, `api_contract`. Any other value fails the schema, and the call is `failed`.
- `runtime_dependence` is `value` (`yes`, `no`, `unknown`), a `reason` text, and three enum lists, `levers_apply`, `levers_absent` and `levers_unverified`, over the seven levers: `hidden_runtime_state`, `distance_between_symptom_and_cause`, `plausible_wrong_static_fix`, `path_ambiguity`, `ordering_or_concurrency`, `magnitude_visible_only_at_runtime`, `external_side_effect_semantics`. Each lever must appear in exactly one list.
- `id`, `provenance` and `shape` are code-owned. They are filled from the caller's input and replace whatever the model returned. `code_owned_fields` records, per field, whether the model's value differed and was overwritten.

The issue writer never sees a card. The card and issue prompt builders are separate modules with no import between them.

## Recordings and the replay fetch

A recording file (`format_version` 1):

```json
{
  "format_version": 1,
  "provenance": "synthetic",
  "model_id": "nvidia/Nemotron-3_5-Lightning",
  "recorded_at": "2026-10-05T00:00:00Z",
  "request": { "body": { "model": "nvidia/Nemotron-3_5-Lightning", "max_tokens": 8192, "...": "..." } },
  "request_sha256": "<SHA-256 of the canonical JSON of request.body>",
  "response": { "status": 200, "body": "<the response body as sent>" },
  "usage": { "prompt_tokens": 1200, "completion_tokens": 300 }
}
```

- A recording holds no headers of any kind. The loader refuses a file with any unknown field.
- `provenance` is `synthetic` or `live`.
- `usage` is what the response reported, with `null` for a missing count.
- The replay `fetch` answers only `https://api.tokenfactory.nebius.com/v1/chat/completions`. It matches a request by the SHA-256 of its canonical body and returns the recorded status and body. Any other URL throws `unexpected_url`, and an unmatched body throws `no_recording`. Neither is forwarded to the network.

`test/fixtures/recordings/` holds nine synthetic recordings shaped like OpenAI-compatible chat completions: a valid card, a card with an out-of-list bug class, a valid issue, a schema-invalid issue, an issue without usage, an issue with an unsupported number, an issue with an excluded identifier, an issue with hint words, and an HTTP 500. `node test/fixtures/synthesize-recordings.ts` regenerates them from `test/fixtures/cases.ts` with the writer's own request renderer, so a prompt or schema change needs a regeneration. A unit test fails when a committed recording no longer matches the request the writer builds.

## The record command

**Planned:** the owner runs this in a private workflow. It has not been run against the live provider; nothing in this repository was produced by it yet.

```sh
pnpm --filter @rbw/writer run record -- --context <run-context.json> --rate-sheet <rates.json> --input <inputs.json> --out <dir> --slot-key <key> --pool <pool-key> --max-calls <n>
```

- **Environment:** `DATABASE_URL` (the spend database, schema `public`) and `TOKEN_FACTORY_WRITER_KEY` (the writer role's key). No other variable is read, and neither value is printed, recorded or hashed.
- **Order of checks:** `--max-calls` first (required, 1 or 2). Then the other arguments, then both variables, before any file is read or any connection is made. Then the context and input files, then the rate file (`unknown_price` if it is missing or lacks a line), and only then the database.
- **Run:** it acquires the slot for the context's root execution, then makes the card call and, with `--max-calls 2`, the issue call. Each call follows [the call order](#call-order-reserve-launch-settle). At the end it releases the slot.
- **Stops:** at the first refusal, uncertain call, ledger refusal, exceeded bound or unexpected error. It then still tries to release the slot. When an operation is unresolved the release is refused, the slot stays held, and the command exits non-zero naming the operation ID. After an infrastructure error that follows a reservation it prints the operation ID and only the error's name and code.
- **Output:** for each call, `<out>/<card|issue>-<ordinal>.recording.json` (when a response arrived) and `<out>/<card|issue>-<ordinal>.summary.json`. Each summary is also printed. A summary holds `kind`, `call_name`, `call_ordinal`, `operation_id`, `status`, `failure`, `http_status`, `reserved_microusd`, `settled_microusd`, `retained_microusd`, `released_microusd`, `operation_state`, `prompt_tokens`, `completion_tokens`, `input_token_bound`, `prompt_within_bound`, `ledger_refusal`, plus `check_report` for an issue or `code_owned_fields` for a card. Amounts are decimal strings.
- **Exit codes:** 0 when every call completed, every reported prompt count was within its bound, everything was settled and the slot was released; 1 otherwise; 2 for a usage error.

**Inputs file** (synthetic example; `card` follows the card source format, `issue.symptom` the `ObservedSymptom` format):

```json
{
  "candidate": "synthetic-candidate-1",
  "card": {
    "source_links": ["https://code.example.invalid/synthetic-project/pull/1"],
    "repository": "https://code.example.invalid/synthetic-project",
    "date": "2026-01-15",
    "license": "MIT",
    "diff_excerpt": "- const range = synthetic(start, end);\n+ const range = synthetic(start, end, zone);",
    "issue_text": "Synthetic source issue: daily totals shift by a day for some timezones.",
    "confirmation": {
      "card_id": "synthetic-card-1",
      "shape_id": "synthetic-shape-1",
      "rules_matched": ["synthetic-rule-a"],
      "matched_lines": ["+ const range = synthetic(start, end, zone);"]
    }
  },
  "issue": {
    "symptom": { "schema_version": 1, "user_action": "...", "...": "..." },
    "excluded_identifiers": ["getSyntheticRange", "synthetic.check-one"]
  }
}
```

The intended live run is two calls, one card and one issue, from inputs the owner supplies, with `--max-calls 2` and `--pool development`. It is development evidence for the client path, never a candidate's admitted issue.

## Tests

- **Unit** (`test/unit`, PGlite, the replay `fetch`, synthetic values): request shape, symptom-only input, the prompt bound at and one byte over the limit, the twelve-call budget (also from a fresh process over the same on-disk ledger), the reserve → launching → fetch → terminal → settle order, insufficient funds, known and missing usage, lost responses, missing prices, every issue check, the card schema and code-owned fields, issue isolation, the recordings and the replay fetch, and the `record` wiring.
- **Integration** (`test/integration`, real Postgres): one replayed issue call end to end and one `insufficient_funds` refusal, in a fresh schema that is dropped afterwards. Setup errors name only `DATABASE_URL` and a driver error code.

The root `pnpm test` runs only the unit tests.

## Not in this package (planned elsewhere)

- The shared `ObservedSymptom`, run context, operation-ID and payload-hash definitions (shared schema package).
- The shared rate sheet and envelope (rate-sheet package); real prices.
- Documentation search and extraction for issues.
- The private workflow that runs `record`, and the live recordings it will produce.
- Human review of cards and issues, and publication.
