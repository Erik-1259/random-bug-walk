# @rbw/host-task-report

Evaluator-side material for the task-report host, the custom task-and-report service vendored in
`hosts/task-report/app` (baseline `task-report@ca4a71f`, see `hosts/task-report/SOURCE.md`), and
the host's factory adapter. A debugging agent receives only what the adapter's bug case inputs
hold: the buggy app tree, the incident description and neutral provenance.

| Part | Files | What it is |
| --- | --- | --- |
| Baseline identity | `baseline/task-report-ca4a71f.json`, `src/baseline.ts` | every vendored file's SHA-256, the contract's SHA-256, the dependency manifests, and the frozen original suite: its 12 files, the runner arguments, Playwright 1.63.0 and the 193 test IDs |
| Original-suite runner | `src/suite/` | checks the evaluator's suite copy against the baseline, runs it once with `--workers=1 --retries=0 --reporter=json --global-timeout=600000` in an environment built from nothing, and compares the report with the 193 test IDs; a missing or skipped test makes the run invalid |
| F3 check | `src/f3/`, `data/f3.v1.json` | the verification check for the lost acknowledged completion (below), shared by both evaluator versions |
| Evaluator version 1 | `protocol/f3-repeatability.v1.json`, `src/protocol.ts`, `catalog/v1.json`, `src/catalog.ts`, `src/copy/`, `src/local/cli.ts` | the protocol, catalog, copy driver and local runner of the recorded version 1 qualification; frozen |
| Evaluator version 2 | `v2/protocol/f3-repeatability.v2.json`, `v2/`, `catalog/v2.json` | the same check values under a new protocol identity, a copy driver that records which entry, catalog and tree it ran, and an evaluation that checks both (below) |
| Factory adapter | `adapter/` (`@rbw/host-task-report/adapter`) | `taskReportAdapter`, the host adapter of the factory's shared interface, on evaluator version 2 |
| Kit images | `kit/task-report/Dockerfile` (version 1), `kit/task-report/v2/` (version 2) | the copy image of each version; see their READMEs |

The check, the suite runner and the copy drivers import only Node's built-ins and `pg`, so they run
in the copy image from its own dependencies. The gate in `src/f3/gate.ts`, parts of the suite
runner and the instance phases are copied or adapted from the unpublished prototype harness the
service comes from; `hosts/task-report/SOURCE.md` says what was taken and defines the labels the
comments use.

## The F3 check

Criterion `concurrency.lost-acknowledged-change` v1. The observable: every completion the service
answers with `201` is counted by the daily report for its UTC date. Data file SHA-256:
`02db325c908b4f71834f9554239ad4f289a7e7500b6c77f4d647a287c0dbf5b5` (pinned beside it in
`f3.v1.json.sha256`; a unit test checks the pin, and both protocols pin the same value).

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

Both versions declare the same values. Per state one copy, run as fresh instances one after
another: buggy 3, reference-fixed 3, clean 1. On every instance the unchanged original suite runs
first and must pass 193 of 193, then a main block of 20 valid trials and one block of 5 valid
trials per control. A block tops up each invalid trial with a new index and is incomplete after
more than 2 invalid trials (1 for a control block); an incomplete block is neither reproduction
nor a miss. The case qualifies when every valid buggy main trial shows the failure, every valid
fixed and clean trial passes, and every control passes. Nothing is re-tuned after the first
counted trial: records made under another data file or protocol are not counted.

| | Version 1 | Version 2 |
| --- | --- | --- |
| Protocol file | `protocol/f3-repeatability.v1.json`, SHA-256 `56cdd1fe...` | `v2/protocol/f3-repeatability.v2.json`, SHA-256 in its `.sha256` pin |
| Catalog | `catalog/v1.json` | `catalog/v2.json`: the same entry and patch files, with the contract's fields (source, criteria, client-safe presentation) and the check set bound to the version 2 protocol |
| Where the checks live | baked into the kit image | in the validator: the check package is placed into each copy; the version 2 kit image holds the runtime and the instance setup (settings, roles and grants, environment files) without comment lines, root-only |
| What a copy records | state, data, protocol and baseline, the tree hash, the block statuses | also the copy ID, the catalog entry, the catalog's SHA-256, the tree the catalog fixes for its state, every file's hash and every block's trial outcomes in run order |
| What the evaluation trusts | each record's state label and block counts | nothing it can recompute: see the next section |
| Result | qualified, not qualified or incomplete | the contract's two cells per state; a state is met, not met, invalid or incomplete |

Version 1 stays the evaluator of the recorded version 1 qualification: its data file, protocol,
check code, catalog and kit files are unchanged, and `test/v1-frozen.test.ts` recomputes their
frozen hashes. The package manifest gained the adapter export and its three workspace dependencies;
the test pins the version 1 manifest's hash, so the rest of the version 1 evaluator tree still
reproduces its frozen value.

## Evaluator version 2

The copy driver (`v2/copy.ts`, run by `rbw-copy-v2` in the version 2 kit image) takes the state,
a copy ID with the prefix `f3q2-` and the catalog entry. Before any instance it hashes
`/workspace/app` and compares it with the tree the catalog fixes for the state; on a mismatch it
records both and stops. Otherwise it runs version 1's phases unchanged (dependency manifests,
typecheck, then per instance a fresh database and app, the original suite and the F3 blocks under
the protocol file's rules) and writes `copy.json` (format `rbw.task-report.copy.v2`).

The evaluation (`v2/evaluate.ts`) runs on the host side, over that record set, with its own
baseline manifest, catalog and protocol:

- the copy, its state, entry, catalog SHA-256, baseline, data file and protocol must be the ones
  the evaluator expects;
- the tree hash is recomputed from the recorded per-file hashes and must equal the recorded hash,
  the tree the copy expected and the tree the evaluator expects for the state: for clean and fixed
  the baseline tree with the reference repair's result
  (`22e67f24fdc4e2edffe357d10572ed3a799b7ddbeb8b8176a29d6f7581c3eedd`), for buggy the baseline with
  the target file at its planted SHA-256
  (`e3bfdfff056fff3d044c67246758a72698cc5e58a9755b18cfc3f9150afffa91`);
- every block rule comes from the protocol file, a record whose rules differ is not counted, and
  each block's status is recomputed from its ordered outcomes: trials after the rule stops the
  block, a block that ends early or a recorded status that differs from the recomputed one make
  the instance's checks invalid.

Any of these mismatches makes the copy, and so its state, incomplete; it is never qualified. A copy
or instance that could not be prepared (dependency manifests, typecheck, a failed instance phase,
a refused suite run) is invalid, and the two stay distinct. The two cells of a copy:

- original suite: pass when every declared instance ran all 193 tests and all passed, fail when
  every run is valid and a test failed (code `original_test_failed`), incomplete with fewer valid
  runs;
- verification: pass when every valid trial passed; fail with `acknowledged_completion_not_counted`
  only when every valid trial matches the data file's buggy vector (every main trial shows the
  failure, every control passes); fail with `f3_detection_inconsistent` or `f3_control_failed`
  for any other failing pattern; incomplete with fewer valid instances.

A state is met when its cells match the contract's qualification table (original suite pass,
pass, pass; verification pass, fail with the declared code, pass). A mismatch counts only when
every state's evidence is complete; otherwise the result is invalid or incomplete. The protocol
lists the rule IDs the evaluation applies (`valid_trial_rules`).

**Known limit closed.** Version 1's `evaluate` trusted each record's state label and block counts:
it did not check which source tree a copy ran (`copy.json` named no catalog entry), or that a
block's invalid trials and attempts stayed within its rule, so the version 1 qualification also
recorded those two comparisons by hand. Version 2 makes both part of the evaluation.

## Factory adapter

`taskReportAdapter` (and `createTaskReportAdapter` for another work directory, package directory or
kit image) implements the shared host adapter interface of `@rbw/factory-contract`:

| Method | What it gives |
| --- | --- |
| `baseline()` | `task-report@ca4a71f`, its commit and the original suite's identity (tree hash, 193 tests, the hash of the sorted test IDs) |
| `catalog()` | the F3 entry, targeting criterion `concurrency.lost-acknowledged-change` v1; the failure code a criterion demonstrates comes from the criteria catalog, never from the entry |
| `protocol(entry)` | `f3-repeatability` version 2 per state: one copy, one round per instance, every instance valid |
| `availability()` | always available |
| `bugCaseInputs(entry)` | the buggy app tree (40 files, with the unchanged `test/` tree, no version-control history), `incident.md`, `provenance.json` (host, baseline, commit, MIT license, tool versions) and the runtime: the kit image and setup steps |
| `validatorInputs(entry)` | the check package (the version 2 copy driver with every module it imports, the data file, the protocol, the baseline manifest and catalog version 2), the expected cells, the clean reconstruction and the reference repair with its result hashes |
| `copyPlans(state, pair, protocol)` | one plan per declared copy: the harness-built tree at `/workspace/app`, the check package at `/opt/rbw/evaluator/pkg`, results at `/var/lib/rbw/results/copy`, the command `rbw-copy-v2`, 4 vCPUs, 8192 MB, 720 s, no network; it applies no patch and refuses a check package, protocol or buggy tree it does not know |
| `collect(plan, collected)` | the copy record: a setup failure is invalid, a timeout incomplete, otherwise the version 2 evaluation of the record set; the evidence hash is the collected results hash |
| `interpret(records, protocol)` | a state's two cells from its copy records under the declared counts |

The bug case inputs never hold a check, the data file, an expected value, the planted patch or
the repair; `test/adapter.test.ts` checks this with sentinels planted in each of them. The app's
own README states the contract's query for a completion, so the planted change is
source-inferable (difficulty not assessed).

The kit image pin is `catalog/kit-image.v2.json`: the local arm64 build the version 2
qualification ran on. A hosted amd64 build replaces it when one is pushed to a registry (planned);
a new pin changes the environment hash and with it the case ID.

## Evidence sets

- **Version 1 qualification:** local Docker, native arm64, image `rbw-task-report:f3q-134d6f4`,
  run IDs `f3q-qual1-buggy`, `f3q-qual1-fixed` and `f3q-qual1-clean`, evaluated with version 1's
  `evaluate` plus the two hand-made comparisons above. Result: qualified.
- **Version 2 qualification:** local Docker, native arm64, the pinned version 2 kit image
  (`rbw-task-report:kit-v2-arm64-r2`), the three states built from the adapter's inputs as the
  package harness builds them (clean is the clean reconstruction applied to the buggy source,
  fixed the reference repair applied to it), every copy plan run through the local Docker runner,
  each copy collected and each state interpreted by the adapter. Copy IDs
  `f3q2-ffa914890d91cc15-buggy-1`, `-fixed-1` and `-clean-1`; check set SHA-256
  `f19694529ecc51967ca81a77fe24275fe14ffe920b91a945b07aa3a335c079df`. Result: qualified, every
  state met. The original suite passed 193 of 193 on all seven instances; on buggy all 60 valid
  main trials reported `acknowledged_completion_not_counted`, on fixed and clean all 60 and 20
  passed, every control trial passed, and no trial was invalid. A direct evaluation of the three
  record sets gives the same verdict. An earlier run with the same check package on a previous
  build of the image, whose setup files kept their comments and were readable by every user
  (copy IDs `f3q2-8477824b6f78795f-*`), gave the same verdict and trial counts. A buggy copy
  handed the clean tree stopped before its first instance and was collected as incomplete. These
  copies were collected before the local runner took the results archive hash, so their
  `results_sha256`, and the evidence hash of their copy records, is the tree hash of each results
  directory.

The copies' record sets are evaluator material and are not committed.

## Commands

```sh
pnpm --filter @rbw/host-task-report test

# version 1
node packages/host-task-report/src/local/cli.ts build --tag rbw-task-report:<name>
node packages/host-task-report/src/local/cli.ts run --image rbw-task-report:<name> --state buggy --run-id f3q-<id> --out <new dir>
node packages/host-task-report/src/local/cli.ts evaluate <dir> <dir> <dir>

# version 2
node packages/host-task-report/adapter/qualify.ts build --tag rbw-task-report:<name>
node packages/host-task-report/adapter/qualify.ts pin --tag rbw-task-report:<name>
node packages/host-task-report/adapter/qualify.ts prepare --out <new dir>
node packages/host-task-report/adapter/qualify.ts run --dir <dir>
node packages/host-task-report/adapter/qualify.ts evaluate --dir <dir>
```

A version 2 qualification is of the pinned kit image, the one the entry's environment and case ID
name. `pin` writes the built image's reference, image ID and architecture, as Docker reports them,
to `catalog/kit-image.v2.json`; `prepare` and `evaluate` read the image from that pin, and the
runner refuses a copy whose image has another ID, so the image a qualification records is the
image its copies ran. Without `pin`, the copies run the image pinned before, or fail setup where it
is absent. A new pin changes the environment hash and with it the case ID, so it is committed with
the qualification that ran on it.

`prepare`, `run` and `evaluate` need this package's dependencies installed; `build` and `pin` use
Node's built-ins only, so they run where Docker is. The local runner reports each copy's
`results_sha256` as the shared runners do: the SHA-256 of the deterministic results archive from
`@rbw/case-package`, over every entry of the results directory. `run --smoke f3q2-smoke-<name>` runs one
reduced clean copy, which the evaluation never counts.
