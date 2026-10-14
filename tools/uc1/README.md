# @rbw/uc1

The run orchestrator of the UC1 paired comparison (server logs off and on). It runs the attempts that [`docs/uc1-preregistration.md`](../../docs/uc1-preregistration.md) fixes, in its order and arms, and writes the run directory that the analyzer (`packages/solver`'s `analyze`) and the publisher (`packages/publisher`) read. The pre-registration is the contract; where this README and it differ, the pre-registration holds. This is part of a hackathon prototype, and everything it writes is development evidence until the pre-registration's protocol says otherwise.

It is its own tool rather than a command in `tools/solver-session` because that package is one attempt's session on local Docker, with no ledger or controller dependency. The orchestrator spans attempts: the paired_comparison root, the spend ledger, the order and reruns, both grades through the controller, and the run directory. It uses the session through `Session` and `solverSession()`, the loop through `runAttempt`, and the grades through `@rbw/solver-session/grade`, without changing any of them.

## Contents

- [Steps](#steps)
- [Commands](#commands)
- [The case file](#the-case-file)
- [Environment](#environment)
- [The spend guard](#the-spend-guard)
- [Costs](#costs)
- [The run directory](#the-run-directory)
- [Rows for the analyzer](#rows-for-the-analyzer)
- [The report](#the-report)
- [Refusals and stops](#refusals-and-stops)
- [Tests](#tests)
- [Not built here](#not-built-here)

## Steps

Each step is its own command, so grade 2 (the only step that spends on Vercel Sandbox) is always explicit.

1. **`pilot` or `run`: the attempts and grade 1.**
   - Refuses anything the pre-registration does not allow (see [Refusals and stops](#refusals-and-stops)) before writing anything.
   - Derives the case's clean, planted and alternative-fix files from the pinned image (`tools/local-runner`'s export and code states) and checks that the image is the case's digest.
   - Creates the paired_comparison root under the public_demo project policy and writes `root-run.json` (status `prepared`, stages `solver_sessions`, `grade_1`, `grade_2`) before the first attempt or grade.
   - The pilot then runs, once the slot is held (next item), the two seeded grade round trips with no model: the alternative fix's bytes through the fix route (`--judge-fixed alternative_fix`) and the clean bytes through the clean-equal route (`--judge-fixed fixed`), grade 1 here and grade 2 in the next step. If either one does not take its expected route or does not end grade 1 passed after its retries, the pass stops (`seeded_failed`) before any session starts or any model call is made; the slot is still released and the records are written.
   - Holds the development slot for the root (the solver loop needs it for every model call), taking it before the seeded round trips, and runs the attempts in index order, up to `--concurrency` (1 to 3) at once. Each attempt: a fresh session on the case's pinned kit image with the planted projection (`serverLogs` only in the on arm), `runAttempt` with the pre-registered prompt, tools, caps, temperature and seed (the attempt index), the diff on submit or at a cap, `close()`, then grade 1 on local Docker (the controller's in-memory ledger, $0). Every model call passes the spend guard first.
   - Releases the slot when the pass ends. The root stays `running` until `finalize`.
2. **`grade2`: the protected regrade.** For every seeded round trip and every counted, graded attempt (the final run at its index), one controller `judge_verify` job on Vercel Sandbox, serially, on the development pool and slot under the root, each only when its worst case fits the allowance. Its job image is the case's `sandbox_image`, the pinned registry build, which the controller uses on the host (its export, the copies' audits and, when the case has no original suite, a local freeze copy; see [The case file](#the-case-file)), so it must have been pulled: the step refuses before any job when it does not resolve locally. A grade that stops for infrastructure reasons is retried as a grade only, up to 2 times. The slot must be free: the controller takes it for each job. It is checked again before each new job; when another root holds it (`slot_held`), the step stops without running the job, and a job the controller ran with the slot already taken is kept under its own name but spends no grade retry, so the same command resumes once the slot is free.
3. **`finalize`: the records.** The analyzer's rows and its results record, the summary, the report, the publisher's staging directory, and the root's terminal status: `completed` when every planned index has a final status (in a pilot, every planned attempt counted with its grading finished, so a pilot whose attempts ended infrastructure errors never completes) and, in a pilot, both seeded round trips took their expected routes and passed both grades; `incomplete` otherwise (for example when the run stopped); `needs_reconciliation` when the ledger shows an open or uncertain operation under the root. It refuses while any counted, graded attempt or seeded round trip has no finished grade 2.

An existing run directory resumes until it is finalized: `pilot` or `run` with the same `--name` continues at the first index without a final status (and finishes the route and grade 1 of a counted attempt the process stopped before grading, from the target file it saved), with the same root, model, case, policy, issue, runtime profile and rate sheet, and the same content in every file and directory the case names (the run records their hashes). Once `finalize` has made the root terminal, `pilot`, `run` and `grade2` refuse that run, since the publisher freezes the root's first terminal snapshot; continuing after that takes a new `--name` (a new root).

## Commands

From the repository root, after `pnpm install`. `<runs>` holds every UC1 run (the allowance covers every root under it), so keep the pilot and the counted run in the same `<runs>`.

```sh
# 0. The whole pilot with a scripted model, fake sessions, a fake controller and an in-process ledger. No live call, no cost.
node tools/uc1/src/cli.ts dry-run --work "$(mktemp -d)"

# 1. The harness pilot: 4 attempts (off, on, on, off) and the seeded round trips' grade 1.
node tools/uc1/src/cli.ts pilot --runs-dir <runs> --name pilot-01 --case <case.json> --policy <policy.json> --model super --concurrency 1

# 2. Grade 2 for the pilot's attempts and round trips, on Vercel Sandbox.
node tools/uc1/src/cli.ts grade2 --run <runs>/pilot-01

# 3. Rows, analysis, summary, report, staging, and the terminal root.
node tools/uc1/src/cli.ts finalize --run <runs>/pilot-01

# 4. Publish the root (the publisher's own command and options; see packages/publisher/README.md).
node packages/publisher/src/cli.ts publish --policy <runs>/pilot-01/policy.json --root-run <runs>/pilot-01/root-run.json --staging <runs>/pilot-01/staging --state <state> --patterns <patterns> [destination options]
```

The counted run is the same with `run` in place of `pilot` and its own `--name` (for example `run --runs-dir <runs> --name race-01 --case <race-case.json> ...`): 40 attempts in ABBA blocks. `--model kimi` selects the Kimi fallback (its pilot is 2 attempts, off and on, under the $75 cap); the model cannot change after the first counted attempt.

Exit codes: 0 the step finished with nothing left to do; 1 the step stopped or left work (a spend stop, a ledger uncertainty, an infrastructure error after its reruns, a grade still `infrastructure` after its retries, a seeded round trip on the wrong route or with a grade that did not pass, an incomplete root); 2 a usage error, a refusal before anything started, or a missing environment variable. Progress goes to stdout as `uc1 key=value` lines: IDs, outcomes, counts and amounts, never issue text or transcripts. The controller's own output goes to stderr.

## The case file

One JSON object; every field is required, unknown fields are refused, and paths are resolved against the current directory. For the pilot:

```json
{
  "case_id": "umami-tz-arg-001",
  "family": "time-zone",
  "screen_record": "docs/uc1-screen/umami-tz-arg-001.json",
  "issue": "<the released bug report for umami-tz-arg-001, as plain text>",
  "image": "rbw-umami-kit:local",
  "image_digest": "sha256:f987de0db4f62870d0dc479ea6bb4d03aa2e5544af34037ea16ea0ab451f1f75",
  "sandbox_image": "<the kit image in the registry, <repository>@sha256:<digest>>",
  "manifest": "<the projection manifest at the pinned commit (tools/local-runner README, step 2)>",
  "terms": "<the strict term list>",
  "audit_policy": null,
  "probes_dir": null,
  "reference_fix": "tools/local-runner/probes",
  "kit_stage": "<the kit stage directory>",
  "original_suite": null
}
```

- `image_digest` is the digest the time-zone case's screen record names (the local image ID). A session on any other digest is refused, grade 1 passes the controller this digest rather than the tag, and a resumed run first checks that `image` still resolves to it.
- `sandbox_image` is the kit image in the registry, pinned by digest, and must be pulled on the host that runs `grade2`. The sessions and grade 1 run the native kit build (`image` at `image_digest`); grade 2 runs this pinned registry build, both as its job image (`--image`) and as its Sandbox copies' image (`--sandbox-image`), so the controller's check that the job image carries the Sandbox image's repository digest holds. The controller uses the job image on the host: it exports the source from it, and each copy's projection audit runs locally; when the case's `original_suite` is null, as in the pilot's case file, it first runs one freeze copy of that image on local Docker (the driver's `freeze` alone, which lists the original suite with no cold build; free and not on the ledger) before any Sandbox copy.
- The two builds are built from the same kit source, but the tool does not compare them. Beyond each build's digest pin, grade 2's job checks the registry build's content three ways, all on the host before any Sandbox copy. The job derives the target's code states from its own export of the registry build, so a target file whose hash is not the expected clean hash is refused (`base_hash_mismatch`) and the job stops (`cannot_build`). The image's manifest must not name another family's kit (`checkFamilyImage`; a race case's image must name the race kit), or the job also stops `cannot_build`. And for each copy whose bytes differ from the clean file, the projection audit compares the exported app source with the pinned projection manifest and refuses the copy on any difference (`audit_refused`), as grade 1's audit does for the native build. Nothing compares the two builds' kit files (driver, verifier and harness). Both grades take the same case files (the files the case names, whose content the run records and checks before each step). That the two builds behave the same at runtime is shown by the seeded checks (the same seeded round trips pass grade 1 on the native build and grade 2 on the registry build), not by comparing the images. Grade 2 stays authoritative, and any disagreement between an attempt's or a seed's grade 1 and grade 2 stays visible in the records.
- `issue` is the same text in every attempt of both arms; the run records its SHA-256.
- `reference_fix` is the case's committed alternative fix. The session and the code states read it, and the clean-equal route passes it to the controller.
- `family` is `time-zone` or `race`. The session, the code states and both grades use that family's fixture, kit stage and probe checks; a race case's grades pass the controller `--family race`.
- `probes_dir` null uses the shapes package's probes, which are the time-zone case's. A race case names its probe directory; the session, the code states and both grades (the controller's `--probes-dir`) use it.
- A counted run takes a race case's file (`family` `race`) with that case's screen record. The record must be in the pre-registered format, every field present and well formed: `schema_version` 1, `case_id`, `recorded` (YYYY-MM-DD), `recorded_by`, `target` (`upstream`, `host_commit`, `path`, `sha256` as 64 hex, `mutation`: the mutation patch's path, optionally followed by `: ` and a note), `static_headroom` (`verdict`, a non-empty `judgment` and at least one entry in `reasons`), `leak_screen` (`verdict` and non-empty `issue_text`, `observe_and_writer_evidence`, `http_responses` and `server_logs`) and `uc1_use`; both verdicts must be `pass`. The screened target must be the case's bug: `path` and `sha256` must equal the derived target path and its clean bytes' hash, and the patch `mutation` names must turn those clean bytes into the case's derived planted file exactly, so a probe set with a different mutation of the same file is refused.

The policy file is a canonical `ProjectPolicy` with purpose `public_demo`, as the publisher's `policy` command writes it (`node packages/publisher/src/cli.ts policy ...`).

## Environment

| Step | Needs |
|---|---|
| `pilot`, `run` | `DATABASE_URL` (the spend ledger, migrations applied, slot key `development` created); `TOKEN_FACTORY_SOLVER_KEY` (read once, removed from the environment, sent only as the bearer header; the controller never sees it); Docker with the kit image |
| `grade2` | `DATABASE_URL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` (passed to the controller's Sandbox backend); Docker with the case's `sandbox_image` pulled |
| `finalize` | `DATABASE_URL` (to read the root's operations) |
| `dry-run` | nothing |

No step reads a `.env` file.

## The spend guard

The pre-registration's rule: no model call, regrade or rerun starts unless its worst-case cost fits the remaining UC1 allowance, the cap minus settled spend minus every open reservation under the UC1 roots.

- **Cap.** $40 with `--model super`, $75 with `--model kimi` (decision 5). The run records its cap.
- **Roots.** Every `run.json` under `<runs>`, the pilot included, which is the pre-registration's reading of what the cap covers (model calls, Sandbox regrades and reruns, including the pilot).
- **Settled and open.** Read from the ledger: the operations whose `root_execution_id` is a UC1 root (a read of the `operations` table), each one's settled and open amounts from `spend_operation_status`. An operation that is terminal or reconciled with nothing open is cached.
- **Model calls.** The solver's ledger is wrapped so that each reservation is checked first: its envelope's worst case (the solver's turn reservation) must fit, or the reservation is refused with `insufficient_funds` and the detail `uc1_allowance_exceeded: ...`, and the model call is never sent. The attempt ends `spend_refused`.
- **Attempts.** Before an attempt starts, one turn's worst case must fit. Before an infrastructure rerun starts, a whole attempt's worst case at its caps must fit.
- **Regrades.** A grade 2 job starts only when one Sandbox copy's worst case fits; it counts as open until the job ends.
- **Concurrency.** The check and the reservation run under one lock in the process, so 3 sessions at once cannot carry the run past the cap.
- **Stops.** An allowance that does not fit, an uncertain operation under the roots, or a halted ledger stops the run: nothing billable starts again in that process, running attempts are refused at their next turn, no new attempt starts, and the stop goes to `stops.jsonl`. After the ledger is reconciled, the same command resumes. After a spend refusal, the pre-registration's spend stop applies ("the run stops and the ledger is reconciled before anything else happens"): the resume stops with `ledger_unreconciled` while the ledger shows any open, uncertain or halted operation under the UC1 roots.

The development pool's own cap still applies underneath; it does not enforce the UC1 cap.

## Costs

From the committed rate sheets: `packages/solver/rate-sheets/solver-v1.json` (Super $0.30 and $0.90 per million input and output tokens, Kimi $0.95 and $4.00) and the controller's Sandbox copy envelope over `packages/envelope/rate-sheets/v1.json`. These are worst cases from the caps, not measurements; the pilot measures the real cost per attempt.

| Item | Worst case |
|---|---|
| One Super turn's reservation | 46,695 micro-USD |
| One Super attempt at its caps (1.5 million input tokens and 50 turns of 8,192 output tokens) | 818,640 micro-USD, about $0.82 |
| One Kimi turn's reservation | 190,055 micro-USD |
| One Kimi attempt at its caps | 4,701,800 micro-USD, about $4.70 |
| Grade 1 (local Docker) | $0 |
| One grade 2 job (one Sandbox copy: 3,120 vCPU-seconds, 6,240 GB-seconds and one creation) | 147,682 micro-USD, about $0.15 |
| The Super pilot: 4 attempts and 6 grade 2 jobs (4 attempts, 2 round trips) | 4,160,652 micro-USD, about $4.16 |
| The Kimi pilot: 2 attempts and 4 grade 2 jobs | 9,994,328 micro-USD, about $9.99 |
| The counted run on Super: 40 attempts and 40 grade 2 jobs | 38,652,880 micro-USD, about $38.65 |

The Super pilot and the counted run together can reach about $42.81 at their caps, more than $40; the guard stops the run before the cap if spend comes near it. A grade 2 retry adds one job's worst case. Near the cap the guard refuses on reservations (one turn's whole worst case), so it stops before settled spend reaches the cap.

## The run directory

`<runs>/<name>/`:

| Path | What |
|---|---|
| `run.json` | mode, label, case and its hashes, model, runtime profile and rate sheet digests, cap, project, policy hash, root, task revision, the plan |
| `case.json`, `policy.json`, `ids.json` | the case as resolved, the policy's exact bytes, the root's IDs (every grade's ids file derives from them) |
| `root-run.json` | the paired_comparison `RootRun`, canonical JSON; its children are every attempt run's execution and every grade's |
| `states.json`, `states/*.bin` | the target path, the image digest and the clean, planted and alternative-fix files |
| `attempts/<NNN>-<arm>/attempt.json` | one record per index: arm, seed, status and every run (rerun number, attempt key, execution, session, outcome, the solver's result with tokens, turns, tool calls, contamination, caps, wall time and settled spend, the submission, the grade route, each grade 1 and grade 2 try with its settled spend) |
| `attempts/<NNN>-<arm>/r<k>/` | that run's session work directory, `transcript.jsonl` and grade jobs |
| `seeded/<label>/seeded.json` | each seeded round trip's route, whether it is the expected one, and its grades |
| `stops.jsonl` | every stop, with its reason and time |
| `results/rows.json` | the analyzer's input, one `AttemptRow` per index with a final status |
| `results/analysis.json` | `resultsRecordJson(analyze(rows))`, canonical JSON |
| `results/summary.json` | every attempt's numbers (with each run that ended on infrastructure and its cause), the seeded round trips, grade disagreements, spend (this root's, and the ledger's settled and open amounts across every UC1 root under `<runs>`, which the cap covers), each arm's wall time and spend, stops. Every spend figure is read from the ledger's settled operations by execution (each attempt run's execution for model calls, each grade 2 try's for grade 2), not from the records' in-memory results |
| `staging/` | the publisher's layout: `report.md`, `results/` (rows, analysis, summary, each attempt and round trip record), `logs/` (each run's transcript), `inputs/screen-record.json`; no local path appears in a staged file |

## Rows for the analyzer

One row per index whose status is final:

- **Counted** (submit, a cap, or a spend refusal after at least one model turn): tokens are input plus output over every call, turns are model calls, the cap and history elisions as the solver recorded them.
- **Out of scope** (a tracked file besides the target changed): `out_of_scope`, no grades, unsolved. `prohibited_edits` counts the changed files besides the target.
- **No gradeable change** (the target unchanged, or not a single-file patch): `fail` in both grades, unsolved.
- **Graded:** grade 1 is `pass`, `fail`, or null when it never reached a verdict. Grade 2 is `pass` only when it passed; an invalid or (after its retries) infrastructure grade is `fail`, as the pre-registration counts it unsolved. A controller job that ended without a summary (any exit without a verdict, for example after an interruption) is an `infrastructure` grade and is retried within the retry limit, never a missing, unsolved grade.
- **Infrastructure error** (every allowed rerun failed): `infrastructure_error`, no grades; `reruns` counts the infrastructure reruns before the reported run.

A spend refusal after at least one model turn counts the attempt as capped: the pre-registration counts an attempt that hits a cap "with its capped token and turn values recorded as they are and its solve status from its grade (unsolved if it submitted nothing)", and "no other reason permits a rerun" than an infrastructure error. It is never restarted, so its turns and tokens stay in the outcomes, and like any capped attempt its current target file is saved and graded. A refusal before the first model turn ran no model call; the next pass restarts that index from scratch (not an infrastructure rerun), once a whole attempt's worst case fits.

The 40-minute wall cap is checked before each model turn and before each tool call, so an attempt runs past it by at most one model response and one tool call; a `submit` the model asks for after the cap does not run, and the attempt counts as capped. A cap used up before the solver's first turn (the session's open and cold build took the whole 40-minute wall cap) is an infrastructure error, rerun at the same index within the rerun limit: such an attempt has zero turns and zero tokens, so the analysis never receives a counted attempt without a positive token count.

## The report

`report.md` (staged as written, with the run directory replaced by `.` like every other staged file) shows numbers from `results/summary.json` and `results/analysis.json` only. In both modes:

- **Attempts:** every index with its status, runs, outcome, cap, turns, tokens, `server_logs` calls, scope, both grades and model spend.
- **Per arm** (what the pre-registration reports per arm without tests): counted attempts, infrastructure errors and reruns, out_of_scope and prohibited-edit counts, contaminated attempts, attempts that called `server_logs`, and the calls of each tool, all from the analysis; then wall time over the counted attempts (total, median and largest; the solver's, from the session's open to the attempt's end, which is what the wall cap limits) and spend (model calls and grade 2, from the ledger, reruns included), from the summary. Without an analysis, only wall time and spend are shown, with a note.
- **Infrastructure errors and reruns:** each run that ended on an infrastructure error, with its cause and whether it was rerun or its index was excluded, apart from the failures.
- The seeded round trips, grade disagreements, spend against the cap, stops, the analysis's statements and the turns outcome.

A pilot report carries the label, the per-arm measurements as harness evidence and the analysis's statements, and none of the counted run's own wording. A counted run's report adds, per the pre-registration's claim wording: the headline with each arm's counted attempts; the detectable difference from the pre-registration's table (`DETECTABLE_DIFFERENCE` in `src/report.ts`, checked against the table by the tests), or the note that it is omitted when an arm has fewer than 20 counted attempts; the made-worse statement (the off-minus-on solve rate, then plainly whether the tool made this bug worse on solves and on tokens, from the analysis's verdicts, with a non-detection read as inconclusive at this sample size); each arm's solves with a 95% Clopper–Pearson interval; and the tool-use and contamination checks. The fallback branch's "low-headroom contrast" wording is not built (see [Not built here](#not-built-here)).

## Refusals and stops

Refused before anything is written (exit 2):

- a counted run whose screen record is not in the pre-registered format (any field absent or malformed) with both verdicts `pass`, which includes the time-zone case;
- a counted run on a case whose `family` is not `race`;
- a pilot on any case but `umami-tz-arg-001`;
- a counted run with no pilot on the same `--model` under `<runs>` that `finalize` made terminal with outcome `completed`;
- a policy that is not `public_demo` and public;
- `--concurrency` outside 1 to 3;
- a different `--model` after the first counted attempt under `<runs>`, or a resumed run on another model, case, policy, issue, runtime profile or rate sheet;
- a `pilot`, `run`, `grade2` or `finalize` on a run after a file or directory its case names (the screen record, issue, manifest, terms, audit policy, probes, reference fix, kit stage or original suite) changed content since the run started;
- a `pilot`, `run` or `grade2` on a run whose root `finalize` already made terminal;
- an image that resolves to another digest than the case's, on a new run or a resumed one;
- a `grade2` whose case's `sandbox_image` does not resolve locally (it has not been pulled).

Stops during a step (exit 1, recorded in `stops.jsonl`): the allowance, an uncertain operation or a halted ledger, a pilot's seeded round trip that took another route or did not end grade 1 passed after its retries (`seeded_failed`: no session starts and no model is called; the seeds' grade 1 records are final, so a resume stops again and continuing takes a corrected new run under a new `--name`. The stopped run's root may be left open, `running`: closing it with `finalize`, which would make it `incomplete`, first needs `grade2` on Vercel Sandbox for every seeded round trip that reached a grade, both of them in the usual case), a session refused before its container (an audit or image mismatch: the run stops, nothing is rerun; the refusal is terminal for that index, recorded with status `refused`, and a resume stops again with `session_refused` rather than rerun it, so continuing takes a corrected new run under a new `--name`), the slot held by another root (`slot_held`, "slot busy": checked before any grade job, the pilot's seeded round trips included, so no grade retry is spent and the same command resumes once the slot is free), and a slot that cannot be released (the root becomes `needs_reconciliation`).

An infrastructure error (the session cannot start, the model endpoint fails or times out, the diff cannot be read, or a process interrupted mid-run) is rerun from scratch at the same index, up to 2 times, with a new session, execution and rerun number. A lost model response leaves its operation `uncertain`, so the guard stops the run before that rerun until the ledger is reconciled.

## Tests

`pnpm --filter @rbw/uc1 test` runs the orchestrator in the dry-run world (`src/fakes.ts`): a PGlite ledger with the `@rbw/spend` migrations, a scripted model behind the injected fetch, fake sessions, and a fake controller that writes grade summaries and, for grade 2, reserves and settles one Sandbox copy under the root as the controller does. No test makes a live call. They cover the order, arms and seeds in the requests, the root before the first attempt, the seeded round trips' routes with no model, the stop before any session when a seeded round trip does not pass, each grade's kit image, grade 2 as its own step, the run directory and the staged files, the spend guard (before an attempt, mid-attempt, for regrades, with concurrent sessions, on uncertainty), every refusal, infrastructure reruns, the scope rule, grade retries, resuming, the report's per-arm diagnostics and claim wording, and the command line's exit codes.

## Known limits

- After an interruption (the process or the machine stops mid-step), resume with the same command and `--name`. A run the process lost before saving its result is rerun as an infrastructure error; its saved session's container (`rbw-solver-<session>`) is removed first, and the run stops with `stale_session` if it cannot be. A session whose close fails (its logs kept and its container removed) keeps its container, so the run is neither counted nor rerun: the pass stops with `close_failed`, and the resume removes that container before anything else and reruns the index as an infrastructure error (stopping with `close_failed` again if the removal fails). A session whose open fails may leave the container it created, so that container is removed (a missing one counts as removed) before the index is rerun; if the removal fails, the run is kept and handled like a failed close. And a grade job that ended without a summary is retried. A grade 2 job that wrote its summary before the process saved its try is replayed from that summary on resume without a new allowance hold, since its spend has already settled. The ledger is authoritative for spend: what an interrupted run settled is counted from the ledger under that run's execution, so the summary and the report never show it as zero.

## Not built here

- The fallback branch (decision 6): running the time-zone case as a counted low-headroom contrast is an amendment to the pre-registration, so `run` refuses it until the amendment and a code change say otherwise.
- The futility rule, the statistical tests and the analysis's statements are `packages/solver`'s `analyze`; this tool supplies its rows. The report's own wording is listed under [The report](#the-report).
- The ledger reconciliation after a stop, the confirmation of what the cap covers, and the model decision after the pilot are operator steps.
- `host-health.sh` between batches of sessions is not run by the orchestrator.
