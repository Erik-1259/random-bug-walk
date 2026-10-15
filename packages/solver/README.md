# @rbw/solver

The fixed solver of the paired comparison (spec §2.3 UC1, §2.4): a small tool-calling loop on Token Factory, with its own envelope and metering on `@rbw/spend`, and the analysis that turns graded attempts into the results record.

- One attempt is one run of the loop on one bug in one arm. The arms differ only in the `server_logs` tool: the `off` arm does not have it, the `on` arm does. The system prompt, the first message, the other tools, the caps, the temperature and the seed (the attempt index) are the same in both.
- Every model turn is one metered call: bounded, priced, reserved, recorded as launching, sent once and settled, in the writer's order. Nothing retries.
- The package makes no live call in its tests. A scripted `fetch` stands in for the model and a fake session for the container. The model limits and sampling settings below are predictions, not measurements.

## Contents

- [Scripts](#scripts)
- [Model profiles](#model-profiles)
- [Attempt caps](#attempt-caps)
- [Envelope and cost limits](#envelope-and-cost-limits)
- [Tools and the session interface](#tools-and-the-session-interface)
- [The loop](#the-loop)
- [Transcript](#transcript)
- [Contamination check](#contamination-check)
- [Analysis and the results record](#analysis-and-the-results-record)
- [Tests](#tests)
- [Not in this package](#not-in-this-package)

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm --filter @rbw/solver run test` | Unit tests: PGlite with the `@rbw/spend` migrations, a scripted `fetch`, a fake session. No network. |
| `build`, `typecheck`, `lint` | The workspace's standard scripts. |

## Model profiles

A profile reuses the writer's `ModelProfile` shape (`packages/writer/src/profile.ts`). Its hashed part is canonical JSON v1, and its digest is the `runtime_profile_sha256` of every call. The hashed part holds the model, the per-call limits, the prompt-bound method, the history policy, the sampling settings, the attempt caps, the tool output caps and the request extras, so a change to any of them changes the digest.

| | Super (pre-registered) | Kimi (fallback only) |
| --- | --- | --- |
| Model | `nvidia/nemotron-3-super-120b-a12b` | `moonshotai/Kimi-K2.7-Code` |
| Service label | `token-factory.nemotron-3-super` | `token-factory.kimi-k2.7-code` |
| Thinking | off: `chat_template_kwargs: { enable_thinking: false }`, as harvest-review sends it | always on; no field sent |
| Input tokens per call (counted bound) | 131,072 | 131,072 |
| Output tokens per call | 8,192 | 16,384 |
| Request timeout | 300,000 ms | 600,000 ms |
| Temperature | 0.6 | 0.6 |
| `runtime_profile_sha256` | `572e4f48907ccf7e905b00f24e7141dcad03c6a4e70b3f7b5544de8f5b6ed271` | `17386e61aed8cb33864c836b1e7efa269f3e1091cd5104e07cf7bcc7778d0ceb` |

Both: provider `token-factory`, base URL `https://api.tokenfactory.nebius.com/v1/`, 0 retries, kind `solver.turn`, role `solver`, key variable `TOKEN_FACTORY_SOLVER_KEY`, seed = the attempt index.

The per-call limits, the timeouts and the temperature are predictions. The pilot measures them, and the profile is frozen after it. The fallback is used only if the pilot shows Super's tool calling broken.

## Attempt caps

| Cap | Value | Enforced |
| --- | --- | --- |
| Model turns | 50 | before each turn |
| Input tokens | 1,500,000 summed | before each turn: reported input so far (the counted bound for a call that reported none) plus this turn's counted bound |
| Wall time | 40 minutes | before each turn and each tool call; a `bash` call's timeout is the smaller of its own (2 minutes) and the remaining wall time, at least 5 seconds |
| `rebuild_restart` calls | 8 | the 9th call is answered with an error and never reaches the session |
| Context window (`context_window`) | one request's counted bound at most 131,072 (UTF-8 bytes of the body plus framing) | before each turn, after the history policy below; reached only when a request is still over the limit with nothing left to elide |

A capped attempt counts, with its values recorded as they are. The analysis reports, per arm, how many counted attempts each cap stopped, `context_window` included.

### History policy

The per-call limit is counted in bytes, an upper bound on tokens, so it binds well below 131,072 real tokens (code and JSON run at several bytes per token; the pilot can measure the ratio). Without a policy, every tool result stays in every later request: two 64 KB file reads, or four `bash` calls with full 16 KB stdout and stderr, fill the limit, and in the synthetic 20-turn test the loop without the policy stopped on `context_window` at turn 4 (off arm) and turn 5 (on arm). That cap would bind long before the others, and sooner in the `on` arm, whose `server_logs` pages add to the history. So the history is kept within the limit, by the same rule in both arms:

- Before each turn, while the request's counted bound is over the per-call limit, the oldest tool result outside the newest tool message is replaced by a stub: `[an earlier tool result was elided to keep the request within the per-call limit; call the tool again to see it (<n> bytes)]`. A result shorter than its stub, and one already a stub, are skipped. The newest tool results, the messages, the assistant's tool calls and the tool definitions are never changed.
- The request is then rendered and counted again. Each elision is a `history_elided` transcript event, and the attempt's `elided_tool_results` counts them; the analysis reports the elisions per arm.
- The policy is part of the hashed profile (`history_policy`), so it is frozen with the profile.

The limit stays at 131,072 counted bytes: a byte count at or under it cannot be over the model's context in tokens, so the provider never rejects a request for its length and the reservation stays an upper bound. Raising it would need the pilot to measure the served context and the bytes per token first.

## Envelope and cost limits

`rate-sheets/solver-v1.json` uses the writer's rate-file format and holds the same four entries as `packages/harvest-review/rates.json` (Token Factory price list, Oct 7, 2026): Super $0.30 input and $0.90 output per million tokens, Kimi $0.95 and $4.00. `solverEnvelope` prices a turn with the writer's `buildEnvelope(entries, profile)`. It does not use `@rbw/envelope`, whose reservations carry the judge path's fixed runtime profile, and nothing here touches `packages/envelope` or the controller's frozen files.

- Reservation per turn, each line rounded up to a whole micro-USD: Super 39,322 + 7,373 = 46,695 micro-USD; Kimi 124,519 + 65,536 = 190,055 micro-USD. One turn is open at a time.
- Settlement charges the reported usage and releases the rest. A call with no reported usage retains its worst case.
- Most one Super attempt can settle, by the caps: 1,500,000 input tokens ($0.45) plus 50 × 8,192 output tokens ($0.37), about $0.82, assuming reported input does not pass the counted bound. 40 attempts: about $33, under the $40 UC1 cap.
- The same bound for Kimi is about $1.43 + $3.28 = $4.70 per attempt, so 40 attempts could pass the $75 fallback cap. The spend pool's cap is what stops a run there.

The prompt bound is the UTF-8 byte length of the exact request body, plus 16 tokens per message and 256 per request. The body holds every message, tool call, tool result and tool definition the model reads, so with a byte-level tokenizer it bounds the text tokens.

## Tools and the session interface

| Tool | Arms | What the model gets |
| --- | --- | --- |
| `bash` | both | exit code, stdout and stderr, each cut to its last 16,384 bytes; the session is asked for a 120 s timeout |
| `read_file` | both | the file's first 65,536 bytes |
| `write_file` | both | a confirmation or the session's error |
| `rebuild_restart` | both | the build's exit code, the last 8,192 bytes of each of the build's stdout log, its stderr log and rbw-build-app's own messages, rbw-start's exit code, and only rbw-start's status lines |
| `submit` | both | ends the attempt |
| `server_logs` | on only | a page of at most 16,384 bytes and a cursor |

`read_file` and `write_file` take a path relative to the app's root, with no leading `/`, no `.`, `..` or empty segment; anything else is refused before the session sees it. A call to a tool the arm does not have, or with input that fails the tool's schema, is answered with an error by the AI SDK and never runs.

The log scrub: rbw-start's `fail()` prints the last 50 lines of the Umami and Postgres logs. `rebuild_restart` removes every `--- /var/lib/rbw/logs/<umami|postgres>.*.log` section from the build output, and from rbw-start's output shows only lines that start with `rbw-start: `, `postgres_ready_ms=`, `ready_ms=` or `listening `. In both arms, runtime logs reach the model only through `server_logs`.

The session runner implements `SolverSession` (`src/tools.ts`) against one container:

```ts
interface SolverSession {
  bash(command: string, options: { timeoutMs: number }): Promise<CommandResult>;
  readFile(path: string): Promise<FileResult>;
  writeFile(path: string, content: string): Promise<WriteResult>; // tracked files only
  rebuildRestart(): Promise<RebuildResult>; // rbw-stop, cold-build reset, rbw-build-app, rbw-start
  serverLogs(request: { cursor: string | null; maxBytes: number }): Promise<ServerLogsPage>;
}
```

`RebuildResult.build` is rbw-build-app's exit status with its own stdout and stderr, unchanged. rbw-build-app prints the build's logs on its stdout, under `--- build stdout (<path>)` and `--- build stderr (<path>)` headers followed by `build_exit=` and `build_wall_ms=` lines, and keeps its stderr for its precheck and font-server messages; `buildLogSections` cuts the two logs out, so a compile error reaches the model whichever log it is in. `RebuildResult.start` is rbw-start's exit status, stdout and stderr, or null when the build failed.

A thrown error from the session is an infrastructure error: the attempt stops, to be rerun under the rerun rule.

## The loop

`runAttempt(options)` takes the ledger, the injected `fetch`, the profile, the run context (validated strictly), the pool, allocation and slot keys, the rate file's bytes, the attempt (`{ arm, index, rerun }`), the bug report text, the session, a transcript sink and an optional clock.

Each turn: render the exact body (a preview that sends nothing), count its bound, apply the history policy while it is over the per-call limit, stop on a cap, check that the context's root holds the slot, reserve, record launching, send, then record the terminal or uncertain state and settle. The call name is `solver.turn:<arm>-<index, 3 digits>-r<rerun>:<turn>`, such as `solver.turn:on-007-r0:12`, so each rerun at an index has its own operations. The loop then runs the turn's tool calls in order and sends their results in the next request. A reply without a tool call gets the fixed reminder as the next user message, and counts as a turn.

| Outcome | When |
| --- | --- |
| `submitted` | the model called `submit` |
| `cap_reached` | a cap was reached (`turns`, `input_tokens`, `wall`, or `context_window` when one request is still over the per-call limit after the history policy). The wall cap is checked before each turn and before each tool call: once it has passed, the turn's remaining tool calls do not run (a `submit` after the cap is not a submission), and a `bash` call's timeout is bounded by the remaining wall time (at least 5 seconds), so a command cannot run on past the cap. A tool call that ends at or after the cap ends the attempt there, and its result is not sent. So an attempt overshoots the cap by at most one model response, 5 seconds of a `bash` call, or one `rebuild_restart`, which is not interrupted |
| `spend_refused` | the slot is not held, or the ledger refused the reservation or the launch; nothing was sent |
| `infrastructure_error` | a lost response (the operation is left `uncertain` for the operator), an HTTP error, an unreadable response, a ledger refusal after launch, a ledger call that threw from the reservation on (`ledger_exception: <message>`, with the operation's ID for the operator), or a session error |

## Transcript

The sink receives one event per step, and `transcriptLine` writes each as one JSONL line: `attempt_start` (arm, index, rerun, model, endpoint, profile and rate-file digests, tools, seed), `model_call` (turn, operation ID, the profile's model, the response's `model` field, endpoint, request and response times, payload SHA-256, counted bound, status, HTTP status, reported usage, settled amount, the reply's text and tool calls), `tool_call` (input, the output the model got, times), `reminder`, `history_elided` (the tool call ID and name whose result became a stub, and its size in bytes), and `attempt_end` (the result). Request bodies are not stored: the events hold every message the loop added, and each call's payload hash identifies its exact body.

## Contamination check

`contaminationHits(commands)` flags bash commands that start a server (`node server.js`, `next start` or `dev`, a package `start` or `dev` script, `rbw-start`, `postgres -D`, `pg_ctl start`) or read process output (`/var/lib/rbw/logs`, `/proc/<pid>/fd`, `strace`, `ltrace`, `journalctl`); `contaminationHits(commands, filePaths)` also flags every `read_file` or `write_file` path into `/var/lib/rbw/logs`, resolved as the session resolves it from the app's root directory (`/workspace/app`): an absolute path into it, or a `../` traversal that reaches it (a relative path such as `var/lib/rbw/logs/x` names a file in the app tree and is not flagged), including the ones refused before the session sees them. It is a pattern check: attempts are counted per arm, never excluded.

## Analysis and the results record

`analyze(rows)` takes one row per pre-registered attempt index (`AttemptRow`: arm, index, counted or infrastructure error, reruns, both grades, out of scope, prohibited edits, tokens, turns, cap, history elisions, tool calls, contamination) and returns the record; `resultsRecordJson` writes it as canonical JSON v1 for the publisher. Fractions and token ratios are decimal strings with six places; medians and the turns estimate are exact.

- A solve is a counted, in-scope attempt whose grade 2 (the protected Sandbox regrade) passed. Out-of-scope attempts are unsolved and ungraded. A counted, in-scope row without grade 2 is refused.
- Infrastructure errors are excluded from every outcome and reported per arm, with the rerun count.
- Per arm: counts, the solve rate with its exact Clopper–Pearson 95% interval, tool calls, attempts that used `server_logs`, contamination, caps (in all and per cap name), attempts with history elisions and the elisions in all, out of scope, prohibited edits, grade 1 and grade 2 disagreements, and median tokens and turns.
- Per bug: the off-minus-on solve rate with Fisher's exact two-sided p, and for tokens and turns the estimates the UC1 pre-registration names (Outcomes 2 and 3), each with the exact permutation Wilcoxon–Mann–Whitney p (the on arm's rank sum, midranks for ties); Holm across the three.
  - Tokens: the Hodges–Lehmann shift of natural-log tokens, on minus off, reported as the ratio `ratio_on_over_off` = exp(shift) with `ratio_interval_on_over_off`, the exponentiated interval ends. Each log difference is ln(on / off), so the ratio is the median pairwise ratio on / off (the geometric mean of the middle two for an even count). Below 1 the on arm used fewer tokens; 0.75 is the registered 25% reduction. Every counted attempt needs a positive token count; a zero is refused.
  - Turns: the Hodges–Lehmann shift on raw turns, on minus off, as `hodges_lehmann_on_minus_off` with `interval_on_minus_off`, in turns. Positive means the on arm took more turns.
- The interval is the distribution-free (Moses) one over the no-ties null distribution, the one R's exact `wilcox.test` uses: at 20 against 20, the 128th to the 273rd of the 400 ordered differences. The record carries its level, and `interval_coverage_approximate` is true when any value repeats in the pooled samples, within an arm or across arms, since the stated level is then nominal.
- Futility: if the first 6 counted attempts of each arm by index are all unsolved in both arms, or all solved in both, the solve test is not run (`solve: null`), and it enters Holm as p = 1. Tokens and turns continue.
- "Made worse" per bug, for solves and for tokens: `worse` when the on arm did worse (fewer solves, or a token ratio above 1) and the Holm-adjusted test rejects, `not_worse` when it did better and the test rejects, otherwise `inconclusive` (or `not_tested`), with a sentence that says "inconclusive at this sample size" for a non-detection. The record's `claim_scope` states that it is an illustration on the listed bugs.

## Tests

- Statistics against R 4.5.1 (`binom.test`, `fisher.test`, `wilcox.test` with `exact = TRUE`, `p.adjust(..., "holm")`), against hand computations shown in the test comments, and the tied Mann–Whitney p against full enumeration.
- The loop with a scripted model: the arms' requests differ only by `server_logs`, the ledger order per turn, every cap, every refusal and infrastructure error, the log scrub inside the loop, and the transcript fields.

## Not in this package

- The session runner on local Docker (fresh container, projection overlay, cold-build reset, diff extraction, scope check).
- Grading (judge_verify on fixed-01 and the Sandbox regrade), the RootRun and project policy, and the pre-registration.
- A live recording of Token Factory responses.
