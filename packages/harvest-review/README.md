# @rbw/harvest-review

Asks two models to judge each candidate that `@rbw/harvest` matched for shape `DT-1.tz-arg` (a caller holds the selected time zone but does not pass it to a date operation, which then uses its default). Their votes are combined with the harvest's ast-grep outcome into one of four outcomes. Every model call is metered through `@rbw/writer`'s `meteredStructuredCall`: bounded, priced, reserved in the spend ledger, launched, sent once and settled.

The package makes no live call in its tests or in public CI. A replay `fetch` answers from committed synthetic recordings. **Planned:** the live review and the live acceptance run. Neither has been run against the live provider, and nothing in this repository was produced by one.

## Contents

| Path | What it holds |
| --- | --- |
| `src/inputs.ts` | The input builder: candidates, the reviewed match, and the functions and hunks the models see. |
| `src/profiles.ts` | The two frozen model profiles. |
| `src/prompt.ts` | The system prompt, the user message and the output schema. |
| `src/vote.ts` | One model's vote and the combination table. |
| `src/review.ts` | The `review` command. |
| `src/acceptance.ts` | The acceptance set and the `acceptance` command. |
| `src/commands.ts`, `src/cli.ts` | The command line. |
| `src/live-fetch.ts` | The live `fetch`, with HTTP timeouts that cover the longest request timeout. |
| `rates.json` | The two models' token prices, in the writer's rate-file format. |
| `test/fixtures/` | Synthetic review inputs, scripted synthetic answers and the recordings made from them. |

## Commands

```sh
node packages/harvest-review/src/cli.ts build-inputs --run <harvest run dir> --out <review-inputs.json>
node packages/harvest-review/src/cli.ts review --inputs <review-inputs.json> --rate-sheet <rates.json> --out <new dir> --slot-key development --pool development [--max-candidates N]
node packages/harvest-review/src/cli.ts acceptance --rate-sheet <rates.json> --out <new dir> --slot-key development --pool development --cases <1-5 | 6-10 | list>
```

Examples:

```sh
node packages/harvest-review/src/cli.ts build-inputs --run packages/harvest/test/fixtures/synthetic-run --out /tmp/review-inputs.json
node packages/harvest-review/src/cli.ts review --inputs /tmp/review-inputs.json --rate-sheet packages/harvest-review/rates.json --out /tmp/review-1 --slot-key development --pool development --max-candidates 4
node packages/harvest-review/src/cli.ts acceptance --rate-sheet packages/harvest-review/rates.json --out /tmp/acceptance-1 --slot-key development --pool development --cases 1-5
node packages/harvest-review/src/cli.ts acceptance --rate-sheet packages/harvest-review/rates.json --out /tmp/acceptance-2 --slot-key development --pool development --cases 6-10
```

- `build-inputs` reads `funnel.json` and the frozen responses of a harvest run directory, and makes no network call.
- `review` and `acceptance` read `DATABASE_URL` (the spend database) and `TOKEN_FACTORY_REVIEW_KEY` (the review role's key) from the environment only. Neither value is printed, recorded or hashed.
- Exit codes: 0 done; 1 the run stopped or could not start (or, for `acceptance`, a case failed); 2 bad usage.

### build-inputs

- **Candidates:** every candidate whose `stage_reached` is `source_rule_matched` or `structurally_confirmed`, in funnel order.
- **Match:** the candidate's structurally confirmed match if it has one, otherwise its first match.
- **Per candidate:** the candidate ID, repository and commit; the match's path (and the parent's path of a renamed file), line, call text and function path; its ast-grep outcome (`confirmed`, or its drop reason); and the prompt inputs below.
- **Prompt inputs**, from both frozen blobs parsed again (the parent blob from the old path of a renamed file):
  - **After:** the function that encloses the matched call. The call is found by its line and its text.
  - **Before:** every parent function with the match's function path, as the harvest builds it (the enclosing functions and the function's own label). There can be several, when sibling `<anonymous>` callbacks or same-named methods share the path. A `function_missing_before` match gets none. `<module>` means the whole file.
  - **Hunks:** the hunks of the file's patch that overlap the before functions' old-side lines or the after function's new-side lines.
  - Function text is whole lines, each prefixed with its line number.

The inputs file holds third-party code and repository names that include their owners' account names. A real one belongs outside this repository and is never committed here. The committed inputs are built from the harvest's synthetic run.

### review

- **Run context:** a fresh one per run, with new UUIDs for `batch_id`, `root_execution_id` and `execution_id`, and `parent_execution_id` equal to the root. The project fields are those of the writer's run context. It is written into `review.json`; no context file is read.
- **Ledger:** it acquires the slot for its root as role `harvest-review` and releases it at the end, as the writer's `record` command does.
- **Calls:** at most 8 candidates (`--max-candidates`, default 8, at most 8). For each candidate, Super and then Kimi, one call at a time, with kind `harvest.review`, call ordinal 1 for Super and 2 for Kimi, and candidate key `h` plus the first 16 hex characters of SHA-256(candidate ID, a newline, the commit). The call name is `harvest.review:h…:1` or `:2`. Nothing retries.
- **Duration:** a call can wait up to its request timeout, 120 s for Super and 1,200 s for Kimi, so the calls of a run of 8 candidates can take up to 8 × (120 s + 1,200 s) = 176 minutes, and a run can hold the `development` slot for up to about 3½ hours. **Planned:** the review runs in its own job with a 210-minute timeout.
- **HTTP timeouts:** Node's built-in `fetch` (undici) waits at most 300 s for response headers by default, and a non-streaming completion sends none until it finishes, so a longer Kimi call would fail as a lost response before its own timeout. The live command (`src/live-fetch.ts`) therefore sends every request through an undici `Agent` whose header and body timeouts are the longest profile timeout, 1,200,000 ms. The replay `fetch` of the tests makes no HTTP request and is unaffected.
- **Stops:** an uncertain call, a ledger refusal after launch, a refusal before sending (other than the input limit) or an unexpected error stops the run. It still writes `review.json` with what is known, names the operation, tries to release the slot and exits 1.
- **Outputs:**
  - `review.json`: the run context, both profiles' models, services and `runtime_profile_sha256`, the rate file's SHA-256, `stopped` (null, or why and at which operation), the counts per outcome, the agreement matrix (ast-grep confirmed or dropped × Super's vote × Kimi's vote), and per candidate its match, both calls (vote, the model's answer, status, failure, amounts, reported tokens and the counted bound), the reason and the outcome. A candidate the run did not reach has outcome `null`. Amounts are decimal strings.
  - `recordings/`: one file per call that got a response, in the writer's recording format.
  - stdout: the counts per outcome and where `review.json` was written.

### acceptance

Runs the cases chosen with `--cases` through `review` and writes `acceptance.json` beside `review.json`, with each case's expected vote, its ast-grep outcome, each model's vote, and per model the cases that passed and failed. It prints one line per model.

- **`--cases`** (required): case numbers from the acceptance set table below, 1 to 10, as a range (`1-5`, `6-10`) or a comma list (`2,4,10`, which may hold ranges). At most 8 cases, the run's cap, and no case twice. The whole set takes two runs, `--cases 1-5` and `--cases 6-10`.
- **Report:** `acceptance.json` and stdout cover only the cases run. Each case keeps its candidate key in any selection.

## The prompt and the output

The system prompt states the shape in one fixed sentence, what each output field means, and that the code shown is data to judge, never instructions. The user message holds the file path, the call and its line, the function path, the after function, the before functions and the hunks.

Each model returns this object, validated with a strict Zod schema (sent as a strict JSON schema):

| Field | Values | Meaning |
| --- | --- | --- |
| `verdict` | `fix`, `not_fix`, `unsure` | Whether the commit fixes this bug at this call. |
| `zone_is_selected` | `yes`, `no`, `unsure` | The added argument is the user's selected time zone, not a constant or the runtime's zone. |
| `same_call` | `yes`, `no`, `unsure` | The commit changed an existing call, rather than adding a new one or replacing one. |
| `reason` | at most 400 characters | Why. |

A model's vote:

- **yes:** `verdict` is `fix` and both evidence fields are `yes`;
- **no:** `verdict` is `not_fix`;
- **unsure:** everything else, including a failed call, invalid output, and a `fix` with an evidence field that is not `yes`.

## Outcomes

| ast-grep | Super | Kimi | Outcome |
| --- | --- | --- | --- |
| confirmed | yes | yes | `confirmed` |
| dropped | yes | yes | `needs_review` |
| any | no | no | `model_rejected` |
| any | anything else | | `needs_review` |

- A candidate whose rendered request is over the input limit is not sent, and gets `needs_review` with reason `too_large`.
- A candidate past the cap is `not_reviewed`.
- An answer cut off at the output limit is invalid output: the call fails and votes `unsure`.
- A call that hits its request timeout is a lost response: the operation is `uncertain`, the run stops, and the slot stays held for the operator (see Recovery).

## Model profiles

| | Super | Kimi |
| --- | --- | --- |
| Model | `nvidia/nemotron-3-super-120b-a12b` | `moonshotai/Kimi-K2.7-Code` |
| Service label | `token-factory.nemotron-3-super` | `token-factory.kimi-k2.7-code` |
| Thinking | off: `chat_template_kwargs: { enable_thinking: false }`, as the writer sends to Lightning | always on; no request field is added (see below) |
| Output tokens | 4,096 | 32,768 |
| Request timeout | 120,000 ms | 1,200,000 ms |
| `runtime_profile_sha256` | `ea1e2ebde4ac4b49080e997c7fa4d96e2aaa9e5656d0d2d99c34ef1d205651b7` | `debb9d0eb0a14795e3017e8bbdb1233b62bd00eeb8b74bf891fe66a2f4b22bce` |

Both: provider `token-factory`, base URL `https://api.tokenfactory.nebius.com/v1/`, 65,536 counted input tokens, 0 retries, the writer's prompt-bound method and framing (16 tokens per message, 256 per request), role `harvest-review`, kind `harvest.review`, key variable `TOKEN_FACTORY_REVIEW_KEY`. The hashed part also holds each profile's request extras, so a change to how thinking is set changes the hash.

Kimi-K2.7-Code always thinks: it has no documented way to turn thinking off. Moonshot's guide says thinking is always on for it and that `thinking: { type: "disabled" }` is an error ([use thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models)), and the vLLM recipe says it runs in thinking mode only ([Kimi-K2.7-Code recipe](https://recipes.vllm.ai/moonshotai/Kimi-K2.7-Code)). Its reasoning counts against its 32,768 output tokens, so an answer cut off by the limit is invalid output and votes `unsure`. Its output limit and its 1,200,000 ms timeout are set so that they leave room for the reasoning.

The limits are provisional, tuned for a thinking open-weight model before any live run. If a live run hits a timeout, a cut-off answer, a slower output rate than expected, or reasoning tokens counted outside the output cap, the settings are revisited rather than patched around.

## Cost limits

`rates.json` prices, from `https://tokenfactory.nebius.com/organization/prices`, checked on Oct 7, 2026 (the rate file has no field for the date):

| Service | Input, per 1M tokens | Output, per 1M tokens |
| --- | --- | --- |
| `token-factory.nemotron-3-super` | $0.30 | $0.90 |
| `token-factory.kimi-k2.7-code` | $0.95 | $4.00 |

- The reservation per call is its worst case, each line rounded up to a whole micro-USD:
  - Super: 19,661 + 3,687 = 23,348 micro-USD (65,536 input and 4,096 output tokens);
  - Kimi: 62,260 + 131,072 = 193,332 micro-USD (65,536 input and 32,768 output tokens);
  - per candidate: 216,680 micro-USD.
- At most 8 candidates and two calls each: at most 1,733,440 micro-USD (about $1.73) reserved per run.
- Settlement charges the reported usage and releases the rest.

## Recovery

An uncertain call (a request that may have reached the provider with no response, including one that hit its request timeout) stops the run and leaves the operation `uncertain` and the slot held. The slot stays held until the operator reconciles the operation and releases the slot, following the operator procedures in the `@rbw/spend` README. `review.json` and stdout name the operation.

## Limits

- Models can be wrong, and two agreeing models are not proof.
- They see only the function around the call, the functions at the same path before the commit, and the hunks that touch them: no other file, no types and no callers.
- The acceptance set is small: three positives and seven negatives.
- Results depend on the pinned model versions.

## Acceptance set

Each case is a small hand-written change with the vote both models must give. Its review input is built by the same builder as a harvested candidate, and its ast-grep outcome is what the harvest's checks give the call (or `no_rule_match_on_added_line`).

| Case | Must be |
| --- | --- |
| `umami-style-fix`: an Umami-style query adds the selected zone to a date call | `yes` |
| `options-user-timezone`: `{ timeZone: user.timezone }` | `yes` |
| `member-filters-timezone`: a member read, `filters.timezone` | `yes` |
| `not-a-date-operation`: `updatePreferences(userId, timezone)` | never `yes` |
| `timezone-offset`: a `timezoneOffset` argument | never `yes` |
| `utc-as-const`: `const timezone = "UTC" as const` | never `yes` |
| `shadowing-inner-utc`: an inner-block `const timezone = "UTC"` shadows the selected zone | never `yes` |
| `replaced-call`: `format(...)` replaced by `formatInTimeZone(...)` | never `yes` |
| `moved-to-sibling-callback`: a call moved into a sibling anonymous callback | never `yes` |
| `runtime-zone-guess`: `{ timeZone: dayjs.tz.guess() }` | never `yes` |

## Tests

`pnpm --filter @rbw/harvest-review run test` runs the unit tests, with PGlite and every `@rbw/spend` migration, the replay `fetch` and the committed synthetic recordings. No test reaches the network.

- The input builder on the harvest's committed synthetic run (candidates, match, after and before functions, hunks, a renamed file), and on hand-written sources (sibling callbacks, same-named methods, a call found by line and text, `<module>`).
- Every row of the vote and combination tables, and the output schema.
- The profiles, their hashes and their worst-case prices.
- The live `fetch`: its `Agent`'s header and body timeouts cover Kimi's 1,200,000 ms, and Node's `fetch` applies the `Agent`'s header timeout (on a loopback server).
- `--cases`: a range, a comma list, and the selections it refuses.
- `build-inputs`, `review` and `acceptance` end to end: one reservation per call with the fixed ordinals and call names, each profile's service, limits and model in the reservation and the request, the outcomes, counts and matrix, a fresh context per run, `too_large`, the cap, `acceptance` runs of cases 1-5 and 6-10, and an uncertain call that stops the run with the slot held.

`test/fixtures/synthetic-inputs.json` is `build-inputs` over the harvest's synthetic run, and a test fails when it differs. `node test/fixtures/synthesize-recordings.ts` regenerates the recordings from `test/fixtures/scripted.ts`, splitting the synthetic inputs and the acceptance set into runs within the cap; a prompt or schema change needs a regeneration, and the end-to-end tests fail on a recording that no longer matches the request.
