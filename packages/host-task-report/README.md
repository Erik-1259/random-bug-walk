# @rbw/host-task-report

Evaluator-side material for the task-report host, the custom task-and-report service vendored in
`hosts/task-report/app` (baseline `task-report@ca4a71f`, see `hosts/task-report/SOURCE.md`).
Nothing here is given to a debugging agent except the catalog entry's incident description.

| Part | Files | What it is |
| --- | --- | --- |
| Baseline identity | `baseline/task-report-ca4a71f.json`, `src/baseline.ts` | every vendored file's SHA-256, the contract's SHA-256, the dependency manifests, and the frozen original suite: its 12 files, the runner arguments, Playwright 1.63.0 and the 193 test IDs |
| Original-suite runner | `src/suite/` | checks the evaluator's suite copy against the baseline, runs it once with `--workers=1 --retries=0 --reporter=json --global-timeout=600000` in an environment built from nothing, and compares the report with the 193 test IDs; a missing or skipped test makes the run invalid |
| F3 check | `src/f3/`, `data/f3.v1.json` | the verification check for the lost acknowledged completion (below) |
| Repetition protocol | `protocol/f3-repeatability.v1.json`, `src/protocol.ts` | the declared runs per state and the evaluation of their records |
| Candidate catalog | `catalog/v1.json`, `catalog/f3/`, `src/catalog.ts` | the F3 entry: its planted patch, its reference repair and its incident description |
| Copy driver | `src/copy/` | the program `kit/task-report` runs inside a copy |
| Local runner | `src/local/cli.ts` | builds the kit image and runs one copy on local Docker |

The check, the suite runner and the copy driver import only Node's built-ins and `pg`, so they run
in the copy image from its own dependencies. The gate in `src/f3/gate.ts`, parts of the suite
runner and the instance phases are copied or adapted from the custom host harness at baseline 2.

## The F3 check

Criterion `concurrency.lost-acknowledged-change` v1. The observable: every completion the service
answers with `201` is counted by the daily report for its UTC date. Data file SHA-256:
`02db325c908b4f71834f9554239ad4f289a7e7500b6c77f4d647a287c0dbf5b5` (pinned beside it in
`f3.v1.json.sha256`; a unit test checks the pin, and the protocol pins the same value).

A forced trial (kind `main`):

1. Checks that no app backend is idle in a transaction (if one is, waits up to 12 s and checks
   again), creates a fresh task X, ten filler tasks and an unused far-future date, and reads that
   date's report, which must be 0.
2. Locks one filler row behind gate L1 and nine behind gate L2 (the gate role's
   `SELECT ... FOR UPDATE`), then sends one PATCH per filler, which fills the app's pool of 10.
3. P1: within 3000 ms, the gates count 1 and 9 blocked app backends waiting on a `transactionid`
   lock, and the superuser monitor sees exactly 10 app backends, all lock-waiting.
4. Sends the completion for X, waits 150 ms (GAP_SEND), sends a completion for an unknown task
   (D), and waits 150 ms (POST_D).
5. P2: neither completion has settled, the gates still count 10 and the monitor 10 lock-waiting.
6. Releases L1, which frees exactly one pool connection. P3: both completions settle within
   1500 ms while L2 still holds 9 or more. Then releases L2.
7. Statuses: X 201 with its task and instant, D 404 `not_found`, every PATCH 200, no 5xx and no
   transport error. App log, matched by `x-request-id`: X's start is at least 100 ms before D's,
   and D's start at least 100 ms before the freed PATCH's end.
8. Reads the report for the date. Supporting evidence, never graded: the monitor's direct read
   of the date's rows and of X's row, and an 11 s late re-read after all blocks.

If any step does not hold, the trial is invalid with a code from the data file, and an invalid
trial is never a pass and never a detection. A valid trial passes when the report count equals the
acknowledged completions, fails with `acknowledged_completion_not_counted` when it is less, and is
invalid when it is more.

Controls, all expected to pass on every state: `sequential` (X then D, no gates), `valid_partner`
(D replaced by a valid completion on a second task, count 2), `x_alone` (only X under the gates)
and `dx_order` (D sent before X).

## The repetition protocol

Protocol SHA-256: see `protocol/f3-repeatability.v1.json.sha256`. Per state one copy, run as
fresh instances one after another: buggy 3, reference-fixed 3, clean 1. On every instance the
unchanged original suite runs first and must pass 193 of 193, then a main block of 20 valid trials
and one block of 5 valid trials per control. A block tops up each invalid trial with a new index
and is incomplete after more than 2 invalid trials (1 for a control block); an incomplete block is
neither reproduction nor a miss. The case qualifies when every valid buggy main trial shows the
failure, every valid fixed and clean trial passes, and every control passes. Nothing is re-tuned
after the first counted trial: records made under another data file or protocol are not counted.

## Catalog

`catalog/v1.json` holds one entry, `task-report-f3-001` (bug type `concurrency`). Its planted patch
changes only `src/completions/store.ts` of the baseline (SHA-256 `5424120c...` to `22eb9427...`).
The reference repair is the planted patch reversed; applied to the buggy file it gives back the
baseline's exact bytes, so the fixed tree equals the baseline tree. The incident description
states only the user-visible symptom. Difficulty: not assessed; the change is source-inferable.

## Commands

```sh
pnpm --filter @rbw/host-task-report test
node packages/host-task-report/src/local/cli.ts build --tag rbw-task-report:<name>
node packages/host-task-report/src/local/cli.ts run --image rbw-task-report:<name> --state buggy --run-id f3q-<id> --out <new dir>
node packages/host-task-report/src/local/cli.ts evaluate <dir> <dir> <dir>
```

`derive` and `copy` are the two halves of `run`; only `derive` needs this package's dependencies
installed.
