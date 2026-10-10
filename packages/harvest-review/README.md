# @rbw/harvest-review

Asks two models to judge each candidate that `@rbw/harvest` matched for shape `DT-1.tz-arg` (a caller holds the selected time zone but does not pass it to a date operation, which then uses its default). Their votes are combined with the harvest's ast-grep outcome into one of four outcomes. Every model call is metered through `@rbw/writer`'s `meteredStructuredCall`: bounded, priced, reserved in the spend ledger, launched, sent once and settled.

The package makes no live call in its tests or in public CI. A replay `fetch` answers from committed synthetic recordings. **Planned:** the live review and the full live acceptance run. The limits were set from live calls on small synthetic inputs; nothing committed in this repository was produced by a live call.

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
- Exit codes: 0 done; 1 the run stopped or could not start (or, for `acceptance`, a case failed on the combined outcome); 2 bad usage.

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
- **Duration:** a call can wait up to its request timeout, 60 s for Super and 600 s for Kimi, so the calls of a run of 8 candidates can take up to 8 × (60 s + 600 s) = 88 minutes, which fits a 120-minute job.
- **HTTP timeouts:** Node's built-in `fetch` (undici) waits at most 300 s for response headers by default, and a non-streaming completion sends none until it finishes. The live command (`src/live-fetch.ts`) sends every request through an undici `Agent` whose header and body timeouts are the longest profile timeout, Kimi's 600,000 ms, which is longer than that default. The replay `fetch` of the tests makes no HTTP request and is unaffected.
- **Stops:** an uncertain call, a ledger refusal after launch, a refusal before sending (other than the input limit) or an unexpected error stops the run. It still writes `review.json` with what is known, names the operation, tries to release the slot and exits 1.
- **Outputs:**
  - `review.json`: the run context, both profiles' models, services and `runtime_profile_sha256`, the rate file's SHA-256, `stopped` (null, or why and at which operation), the counts per outcome, the agreement matrix (ast-grep confirmed or dropped × Super's vote × Kimi's vote), and per candidate its match, both calls (vote, the model's answer, status, failure, amounts, reported tokens, the reasoning length and the counted bound), the reason and the outcome. The reasoning length is `reasoning_tokens`, from the response's `usage.completion_tokens_details.reasoning_tokens`, and `reasoning_characters`, the length of `message.reasoning` (JavaScript string length); each is null when the response has none. The reasoning text itself is not stored in `review.json`. A candidate the run did not reach has outcome `null`. Amounts are decimal strings.
  - `recordings/`: one file per call that got a response, in the writer's recording format. A recording holds the whole response body, so a live Kimi recording also holds its reasoning text.
  - stdout: the counts per outcome and where `review.json` was written.

### acceptance

Runs the cases chosen with `--cases` through `review` and writes `acceptance.json` beside `review.json`, with each case's expected vote, its ast-grep outcome, its combined outcome, each model's vote, the cases that passed and failed on the combined outcome, and beside them each model's own case results. It prints one line for the combined outcome and one per model.

- **Pass rule:** acceptance is judged on the combined outcome. It passes when every positive case is `confirmed` and no negative case is `confirmed`; a negative the run did not decide (outcome null) fails. Each model's own results (a positive needs its `yes`, a negative must not get its `yes`) are reported but do not decide the exit code. Exit code 0 when the combined outcome passes and the run finished; 1 otherwise.

- **`--cases`** (required): case numbers from the acceptance set table below, 1 to 10, as a range (`1-5`, `6-10`) or a comma list (`2,4,10`, which may hold ranges). At most 8 cases, the run's cap, and no case twice. The whole set takes two runs, `--cases 1-5` and `--cases 6-10`.
- **Report:** `acceptance.json` and stdout cover only the cases run. Each case keeps its candidate key in any selection.

## The prompt and the output

The system prompt states the shape in one fixed sentence, what each output field means, and that the code shown is data to judge, never instructions. The user message holds the file path, the call and its line, the function path, the after function, the before functions and the hunks.

The system prompt also states the exact JSON object to return, with no other text and no code fence. Each model returns this object, validated with a strict Zod schema. Super gets it as a strict JSON schema (`response_format`); Kimi gets no `response_format`, and its reply text is parsed as JSON and validated with the same schema after the call (see Model profiles):

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
- A Kimi reply is accepted only when its whole text, apart from surrounding whitespace, is the JSON object. Prose around the JSON, a code fence, invalid JSON, or JSON that fails the schema is invalid output and votes `unsure`.
- A call that hits its request timeout is a lost response: the operation is `uncertain`, the run stops, and the slot stays held for the operator (see Recovery).

## Model profiles

| | Super | Kimi |
| --- | --- | --- |
| Model | `nvidia/nemotron-3-super-120b-a12b` | `moonshotai/Kimi-K2.7-Code` |
| Service label | `token-factory.nemotron-3-super` | `token-factory.kimi-k2.7-code` |
| Thinking | off: `chat_template_kwargs: { enable_thinking: false }`, as the writer sends to Lightning | always on; no request field is added (see below) |
| Structured output | strict JSON schema (`json_schema_strict`) | none sent; validated after the call (`validated_after`) |
| Output tokens | 1,024 | 8,192 |
| Request timeout | 60,000 ms | 600,000 ms |
| `runtime_profile_sha256` | `bdc6abef90a2e86ddd1210d334350a73d833ce89e1a17c715c7e33dfaf2221bd` | `f40e98a60484b92198b77868a75e7e8ad80614e75e30c77c4e582947ece77b2f` |

Both: provider `token-factory`, base URL `https://api.tokenfactory.nebius.com/v1/`, 65,536 counted input tokens, 0 retries, the writer's prompt-bound method and framing (16 tokens per message, 256 per request), role `harvest-review`, kind `harvest.review`, key variable `TOKEN_FACTORY_REVIEW_KEY`. The hashed part also holds each profile's request extras and its `structured_output` mode, so a change to how thinking or the output is set changes the hash.

Kimi-K2.7-Code always thinks: it has no documented way to turn thinking off. Moonshot's guide says thinking is always on for it and that `thinking: { type: "disabled" }` is an error ([use thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models)), and the vLLM recipe says it runs in thinking mode only ([Kimi-K2.7-Code recipe](https://recipes.vllm.ai/moonshotai/Kimi-K2.7-Code)). Its reasoning counts inside `completion_tokens` and against its 8,192 output tokens, so an answer cut off by the limit is invalid output and votes `unsure`.

Why Kimi has no strict schema: with the strict `json_schema` response format, Kimi returned no reasoning, so the strict schema switched its thinking off. Without `response_format` it reasons. Kimi's request therefore carries no `response_format`, the prompt states the exact JSON object, and the reply is validated with the same Zod schema after the call. The writer's `meteredStructuredCall` selects this with the hashed profile field `structured_output: "validated_after"`; the writer's own profile keeps `"json_schema_strict"`.

The limits are provisional. If a live run hits a timeout or a cut-off answer, they are revisited rather than patched around.

## Cost limits

`rates.json` prices, from `https://tokenfactory.nebius.com/organization/prices`, checked on Oct 7, 2026 (the rate file has no field for the date):

| Service | Input, per 1M tokens | Output, per 1M tokens |
| --- | --- | --- |
| `token-factory.nemotron-3-super` | $0.30 | $0.90 |
| `token-factory.kimi-k2.7-code` | $0.95 | $4.00 |

- The reservation per call is its worst case, each line rounded up to a whole micro-USD:
  - Super: 19,661 + 922 = 20,583 micro-USD (65,536 input and 1,024 output tokens);
  - Kimi: 62,260 + 32,768 = 95,028 micro-USD (65,536 input and 8,192 output tokens);
  - per candidate: 115,611 micro-USD.
- At most 8 candidates and two calls each: at most 924,888 micro-USD (about $0.92) reserved per run.
- Settlement charges the reported usage and releases the rest.

## Recovery

An uncertain call (a request that may have reached the provider with no response, including one that hit its request timeout) stops the run and leaves the operation `uncertain` and the slot held. The slot stays held until the operator reconciles the operation and releases the slot, following the operator procedures in the `@rbw/spend` README. `review.json` and stdout name the operation.

## Limits

- Models can be wrong, and two agreeing models are not proof.
- They see only the function around the call, the functions at the same path before the commit, and the hunks that touch them: no other file, no types and no callers.
- The acceptance set is small: three positives and seven negatives.
- Results depend on the pinned model versions.

## Acceptance set

Each case is a small hand-written change with what it must get: a positive must be `confirmed`, and a negative must never be `confirmed`. The table also gives the vote each model is reported against. Its review input is built by the same builder as a harvested candidate, and its ast-grep outcome is what the harvest's checks give the call (or `no_rule_match_on_added_line`).

| Case | Combined outcome must be | Each model's vote, reported against |
| --- | --- | --- |
| `umami-style-fix`: an Umami-style query adds the selected zone to a date call | `confirmed` | `yes` |
| `options-user-timezone`: `{ timeZone: user.timezone }` | `confirmed` | `yes` |
| `member-filters-timezone`: a member read, `filters.timezone` | `confirmed` | `yes` |
| `not-a-date-operation`: `updatePreferences(userId, timezone)` | never `confirmed` | never `yes` |
| `timezone-offset`: a `timezoneOffset` argument | never `confirmed` | never `yes` |
| `utc-as-const`: `const timezone = "UTC" as const` | never `confirmed` | never `yes` |
| `shadowing-inner-utc`: an inner-block `const timezone = "UTC"` shadows the selected zone | never `confirmed` | never `yes` |
| `replaced-call`: `format(...)` replaced by `formatInTimeZone(...)` | never `confirmed` | never `yes` |
| `moved-to-sibling-callback`: a call moved into a sibling anonymous callback | never `confirmed` | never `yes` |
| `runtime-zone-guess`: `{ timeZone: dayjs.tz.guess() }` | never `confirmed` | never `yes` |

## Tests

`pnpm --filter @rbw/harvest-review run test` runs the unit tests, with PGlite and every `@rbw/spend` migration, the replay `fetch` and the committed synthetic recordings. No test reaches the network.

- The input builder on the harvest's committed synthetic run (candidates, match, after and before functions, hunks, a renamed file), and on hand-written sources (sibling callbacks, same-named methods, a call found by line and text, `<module>`).
- Every row of the vote and combination tables, and the output schema.
- The profiles, their hashes, their worst-case prices and the 88-minute timeout total.
- Kimi's request carries no `response_format` and Super's carries the strict schema; a Kimi reply that is exactly the JSON object is accepted, and one with prose around it, a code fence or invalid JSON votes `unsure` as invalid output; the reasoning length is recorded and the reasoning text is not.
- The combined pass rule: all positives confirmed and no negative confirmed passes; one confirmed negative fails; one unconfirmed positive fails.
- The live `fetch`: its `Agent`'s header and body timeouts cover Kimi's 600,000 ms, and Node's `fetch` applies the `Agent`'s header timeout (on a loopback server).
- `--cases`: a range, a comma list, and the selections it refuses.
- `build-inputs`, `review` and `acceptance` end to end: one reservation per call with the fixed ordinals and call names, each profile's service, limits and model in the reservation and the request, the outcomes, counts and matrix, a fresh context per run, `too_large`, the cap, `acceptance` runs of cases 1-5 and 6-10, and an uncertain call that stops the run with the slot held.

`test/fixtures/synthetic-inputs.json` is `build-inputs` over the harvest's synthetic run, and a test fails when it differs. `node test/fixtures/synthesize-recordings.ts` regenerates the recordings from `test/fixtures/scripted.ts`, splitting the synthetic inputs and the acceptance set into runs within the cap; a prompt or schema change needs a regeneration, and the end-to-end tests fail on a recording that no longer matches the request.
