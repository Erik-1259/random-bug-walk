# @rbw/screen

The automated static-headroom screen. A planted bug used to compare debugging tools must not be findable from the planted source alone; otherwise every arm solves it by reading. This package asks one model, up to N times, to locate and fix the bug from the source and the symptom alone, scores every answer in code, and writes a `uc1-static-headroom-screen` record with the verdict, the attempts, the hits and the cost.

- Every call is bounded, priced, reserved against a spend pool through `@rbw/spend`, and settled, using the writer's metered call (`meteredStructuredCall` in `@rbw/writer`) under the screen's own model profile and rate file.
- Nothing in the tests or in public CI calls a model. The tests answer from a scripted fake model and use synthetic source.
- The record carries no model text. The model's answers are kept in a separate working file (see [Outputs](#outputs)).

## Contents

- [Commands](#commands)
- [Input](#input)
- [What the model sees](#what-the-model-sees)
- [Scoring and the verdict](#scoring-and-the-verdict)
- [Model profiles, metering and caps](#model-profiles-metering-and-caps)
- [Call order](#call-order)
- [Outputs](#outputs)
- [The screen record](#the-screen-record)
- [Tests](#tests)
- [Not in this package](#not-in-this-package)

## Commands

Run the command line with `node` from the repository root, so relative paths resolve from there. (A package script run through `pnpm --filter` would run from `packages/screen` and resolve every relative path from that directory, which is why this package has none.)

| Command | What it does |
| --- | --- |
| `node packages/screen/src/cli.ts plan ...` | Reads the input, finds the planted site, and prints the files shown, the prompt size, the worst case per call and for the run, and whether it fits the budget. No network and no database. Exits 1 when the run would not fit the budget. |
| `node packages/screen/src/cli.ts run ...` | The metered screen run. Reads `TOKEN_FACTORY_SCREEN_KEY` and `DATABASE_URL`, and never prints either value. |
| `pnpm --filter @rbw/screen run test` | Unit tests: PGlite with the `@rbw/spend` migrations, the scripted fake model, a synthetic tree written to a temporary directory. No network. |
| `build`, `typecheck`, `lint` | The workspace's standard scripts. |

```sh
node packages/screen/src/cli.ts plan --input <screen-input.json> --tree <planted tree> --clean <clean target file> --rate-sheet <rates.json> --attempts <1-8> --budget-microusd <n> [--model super|kimi]
node packages/screen/src/cli.ts run  --input <screen-input.json> --tree <planted tree> --clean <clean target file> --rate-sheet <rates.json> --attempts <1-8> --budget-microusd <n> --out <new dir> --slot-key <key> --pool <pool-key> [--model super|kimi] [--fail-at-hits <n>] [--binding]
```

Example, from the repository root:

```sh
node packages/screen/src/cli.ts plan --input /tmp/case/screen-input.json --tree /tmp/case/tree --clean /tmp/case/clean.ts --rate-sheet packages/screen/rates.json --attempts 4 --budget-microusd 100000
```

| Option | Meaning |
| --- | --- |
| `--tree` | Root of the planted copy. Every shown file is read from here and must resolve inside it (symlinks out of the tree are refused). |
| `--clean` | The clean copy of the planted file. It is used for the site and the scoring only, and is never shown to the model. |
| `--rate-sheet` | The rate file; `rates.json` in this package. Its exact bytes are hashed into every reservation's `rate_sheet_sha256`. |
| `--attempts` | Planned model calls, from 1 to 8. |
| `--budget-microusd` | The run starts only when attempts × the worst case per call is at most this amount. |
| `--model` | `super` (default) or `kimi`. |
| `--fail-at-hits` | Hits at which the case fails the screen; default 1, at most the number of attempts. |
| `--binding` | Sets `screen.binding` to true in the record. Without it the record is a probe that supplements a written judgment. |
| `--out` | A new or empty directory. |
| `--slot-key`, `--pool` | The spend slot the run acquires for its fresh root, and the pool every call reserves from. |

Exit codes: 0 the run finished (whatever the verdict), or stopped because the verdict was decided; 1 the run could not start, did not fit the budget, or stopped on a refusal, an uncertain call or an error; 2 bad usage.

## Input

`screen-input.json`, validated strictly (unknown fields are refused):

| Field | Meaning |
| --- | --- |
| `format_version` | `1` |
| `case` | Case name: lowercase letters, digits, `-` and `_`. |
| `case_status`, `shape` | Copied into the record. |
| `host`, `host_commit`, `source_read_from` | Copied into the record's `subject`. |
| `target_path` | The planted file, relative to the tree. |
| `files` | Every file shown to the model, 1 to 12, `target_path` among them; relative, forward slashes, no `.` or `..` segments. |
| `symptom` | The issue-style symptom, at most 4,000 characters: what a user sees, never where the bug is. |

The planted site is found by comparing the planted file with the clean copy line by line (a longest-common-subsequence line diff). Each run of changed lines is one hunk, so a mutation that touches two far-apart places has two small sites, not one wide region between them. For a hunk that only deletes lines, the site is the two planted lines on either side of it. The record states every hunk (`planted_site` as `path:start-end, start-end`, and `planted_hunks`) and a unified diff of the mutation. A changed region larger than 16,000,000 clean-by-planted line pairs, which no single planted bug produces, is kept as one hunk.

## What the model sees

One system message and one user message, identical for every attempt:

- the symptom, between `=== Bug report ===` and `=== end ===`;
- each shown file, sorted by path, as `File: <path>` and its text with every line prefixed by its number and `|`.

No file is marked, and the clean copy, the site and the mutation never enter the prompt. The model answers with a JSON object: `file`, `start_line`, `end_line`, `fixed_code` (at most 8,000 characters) and `reason` (at most 600 characters). The fix replaces lines `start_line` to `end_line` of `file`.

## Scoring and the verdict

Code scores each answer; no model judges another model's answer.

| Outcome | When |
| --- | --- |
| `located` | The answer names the planted file, its range is at most 10 lines, and the range overlaps one hunk of the planted site widened by 2 lines on each side. |
| `fixed` | Replacing the answer's lines of the planted file with `fixed_code` gives the clean file, compared line by line after trimming each line, collapsing runs of whitespace and dropping blank lines. |
| `located_and_fixed` | Both. |
| `miss` | A valid answer that is neither, with `miss_kind`: `other_file`, `invalid_range` (outside the file), `range_too_wide` (overlaps but wider than 10 lines) or `other_lines`. |
| `no_answer` | The call failed (an HTTP error status, or a reply that did not validate). |

A **hit** is `located`, `fixed` or `located_and_fixed`. The verdict:

- `fail`: hits reached `--fail-at-hits`. The site is findable from the source alone. The run stops at that point, since no further attempt can change the verdict, and spends nothing more.
- `pass`: every planned attempt gave a scored answer, with fewer hits.
- `inconclusive`: neither; for example an attempt gave no answer, or the run stopped early on a refusal.

## Model profiles, metering and caps

The profiles are constants in `src/profiles.ts`. Each profile's hashed part (its canonical digest is the `runtime_profile_sha256` of every call) holds the provider, model, base URL, the kind `screen.static`, both token limits, `max_retries: 0`, the request timeout, the structured-output mode, the prompt-bound method, `sampling: "provider_default"` and the request extras.

| Profile | Model | Input limit (tokens) | Output limit (tokens) | Request timeout (ms) | Worst case per call (micro-USD): input + output |
| --- | --- | --- | --- | --- | --- |
| Super | `nvidia/nemotron-3-super-120b-a12b` | 65,536 | 2,048 | 300,000 | 19,661 + 1,844 = **21,505** |
| Kimi | `moonshotai/Kimi-K2.7-Code` | 65,536 | 8,192 | 600,000 | 62,260 + 32,768 = **95,028** |

- **Super** (default): thinking off (`chat_template_kwargs: { enable_thinking: false }`), output as a strict JSON schema (`response_format`).
- **Kimi** (fallback): it always thinks, so no thinking field is sent, its reasoning counts against its 8,192 output tokens, and no `response_format` is sent: the reply text is parsed and validated with the same schema after the call.
- **Sampling:** no temperature or seed is sent, so every attempt samples at the provider's default and the attempts are independent draws of the same request.
- **Prices** (`rates.json`, from the provider's price page): Super 300,000 micro-USD per million input tokens and 900,000 per million output tokens; Kimi 950,000 and 4,000,000. The worst case of a line is `ceil(limit × microusd ÷ per_units)`.
- **Run worst case:** at most 8 attempts per run, so a run reserves at most 8 × 21,505 = 172,040 micro-USD (about $0.17) with Super and 8 × 95,028 = 760,224 micro-USD (about $0.76) with Kimi. A run whose attempts × worst case is above `--budget-microusd` is refused before it connects to the database.

| Limit | Enforced by | When |
| --- | --- | --- |
| Input tokens per call | The writer's counted prompt bound (UTF-8 bytes of the request plus framing); over the limit the call is refused as `prompt_too_large`, nothing is reserved or sent, and the run stops `inconclusive`. Envelope line `enforced_by: "client_counter"` | Before reserving |
| Output tokens per call | `max_tokens` in the request. Envelope line `enforced_by: "request_parameter"` | In the request |
| Calls per run | `--attempts`, at most 8; each attempt reserves its own call ordinal (1 to N) | Before each call |
| Money | The budget check before the run, then `@rbw/spend` reserving each call's worst case against the pool; a refusal stops the run | Before the run and before each call |
| Retries | None: `max_retries: 0`, and the writer's fetch wrapper sends one request per call | At the request |

The metered values the record carries per attempt: `reserved_microusd`, `settled_microusd`, `prompt_tokens`, `completion_tokens`, `input_token_bound` and `prompt_within_bound`. The run's `cost` sums them and lists any launched call that has no settlement.

The limits are predictions sized for a few source files and one symptom, not measurements; a live run measures them, and any change changes the profile digest.

## Call order

`run` follows the harvest review's order: it checks the key, the database URL, the output directory, the prices and the budget; connects; creates a fresh run context (new batch, root and execution IDs); acquires the slot for that root; makes the calls one at a time; writes the outputs; and releases the slot.

- Every call's candidate name is `s` followed by the first 16 hex characters of SHA-256 of the case name, a newline and the planted file's SHA-256, and its call name is `screen.static:<candidate>:<attempt>`.
- An uncertain call (the response was lost after the request may have been sent) stops the run and leaves the slot held until an operator reconciles the operation. A spend refusal after launch also stops the run.
- A failed call (HTTP error, invalid reply) is settled and counted as `no_answer`; the next attempt runs.

## Outputs

Under `--out`:

| File | Content |
| --- | --- |
| `screen.json` | The screen record (below). It holds no model text: a hit keeps only its range, which is at the planted site; a miss keeps only its `miss_kind`. |
| `answers.json` | Each attempt's full answer, including `reason` and `fixed_code`. A working file: a miss can point anywhere in the host's source, so review it before sharing it. |
| `recordings/` | One recording per call that got an HTTP response (`<candidate>-<attempt>.recording.json`), in the writer's recording format, labeled with the run's provenance. They hold the full request and response. |

## The screen record

`screen.json` is a `uc1-static-headroom-screen` record, version 1, as the written screen records use it: `record`, `record_version`, `case`, `case_status`, `shape`, `screen` (`source`, `criterion`, `binding`, `judged_on`, `judged_by`), `subject` (`host`, `host_commit`, `source_read_from`, `target_file`, `clean_sha256`, `planted_sha256`, plus `planted_site`, `planted_hunks` and `mutation`), `verdict`, `verdict_summary`, `static_tells`, `consequences` and `optional_static_probe`.

The written records can also hold `evidence_comparison` (what each evidence channel would reveal) and `log_headroom_note`. Those are a person's judgment from reading the source and the logs, which the probe does not make, so the automated record leaves them out rather than filling them with placeholders. A test parses every committed record in `docs/uc1-screen/` with `ScreenRecordSchema` and checks that the automated record has every top-level key they have except those two.

- A written record states `optional_static_probe` as text, such as "Not run.". This package fills it with the probe as an object: model, service, `runtime_profile_sha256`, `rate_sheet_sha256`, the SHA-256 of the prompt and of the symptom, the files shown, the run's root execution ID, `attempts_planned`, `attempts_run`, `answered`, `hits`, `fail_at_hits`, the scoring constants, `cost` (`budget_microusd`, `worst_case_microusd_per_call`, `reserved_microusd`, `settled_microusd`, `unsettled_operation_ids`), `stopped` and one entry per attempt.
- `static_tells` lists one entry per hit: the answer's range, whether it located the site, gave the clean file or both, and a sentence written by code.
- `verdict` is `pass`, `fail` or `inconclusive`; written records use the first two.
- `ScreenRecordSchema` (exported) accepts both forms.

## Tests

`pnpm --filter @rbw/screen run test` covers the site finder, the scoring table and the verdict, the input and path checks, the prompt (sorted, numbered, nothing of the clean form), the prices and this README's numbers, and full runs on PGlite with the fake model: one reservation per attempt with the profile's envelope, settled cost equal to the pool's settled amount, the stop at the deciding hit, failed calls counted as no answer, a lost response leaving the slot held, the budget refusal, the fallback model's request, and no model text in the record.

## Not in this package

- Finding candidate sites or planting them (`packages/shapes`, `tools/local-runner`).
- Deciding which cases become comparison subjects; the record states the probe's verdict, and a written judgment can still be recorded beside it.
- Any live call in tests or public CI.
