# @rbw/controller

The trusted controller. It runs one job (kit check, observation, admission or judge replay) end to end against the spend ledger, one app copy at a time, on Vercel Sandbox, or on Docker for the conductor's local checks. The conductor starts it with one command; factory runs launch from a conductor command, not a web route. The judge route that will start the same controller is planned. This is part of a hackathon prototype.

Everything it writes is **development evidence**. It makes no admission claim and publishes nothing, and the planted bug is synthetic.

It reuses the existing packages and does not re-implement them:
- **The job:** the local runner's builders (`buildJob`, `expectedVectors`, the code states and the copy profile).
- **Each copy:** the local runner's `run-copy` path (`runCopyCommand`), the same code the `run-copy` command runs.
- **The import:** `@rbw/admission`, through the local runner's `importJob`.
- **The money:** `@rbw/spend` for the ledger, and `@rbw/envelope`'s rate sheet, fixed limits and `toReserveRequest`.

The new code is the orchestration between them (the ledger flow, the deadlines, replay and the grader proof), which no existing package does. That is why it is more than 200 lines.

## Commands

Run from the repository root.

```sh
node tools/controller/src/cli.ts run --job-kind <kit_check|observe|admission|judge_verify> --work <run dir> \
  --image <tag|digest> --manifest <file> --terms <file> --kit-stage <dir> \
  [--original-suite <file>] [--policy <file>] [--fix <dir>] [--name <job name>] \
  [--backend sandbox|docker] [--sandbox-image <repository>@sha256:<digest>]
node tools/controller/src/cli.ts proof --work <run dir> --image ... --manifest ... --terms ... --kit-stage ... \
  [--original-suite <file>] [--policy <file>] [--backend sandbox|docker] [--sandbox-image ...]
node tools/controller/src/cli.ts create-slot-key --slot-key <key>
```

- `--image`, `--manifest`, `--terms`, `--policy` and `--kit-stage` are the local runner's inputs (its README, Host commands). The kit image must be local, because each copy's source export and audit run on the host.
- `--original-suite` is the driver's frozen original-suite manifest. Without it, the controller first runs one freeze copy on local Docker. That copy is free and not on the ledger.
- `--fix` is for `judge_verify` only: the fix to grade as `fixed-01`, in the local runner's alternative-fix layout (`alternative-fix.json` and its patch). The default is the local runner's alternative fix.
- `--backend sandbox` is the default. It reads `DATABASE_URL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` from the environment, never from arguments, and prints none of them. A missing one is named and the command exits 2.
- `--backend docker` runs the copies on local Docker with an in-memory PGlite ledger. That ledger has every `@rbw/spend` migration and both slot keys, as the local runner's recorded mode uses. It needs no credentials. Its amounts are what the same copies would reserve and settle on Sandbox.
- `create-slot-key` is an owner action on the database in `DATABASE_URL`. The migrations seed the pools but no slot key, so `development` and `judge` are each created once.

The job goes in `<run dir>/jobs/<name>/`. The name defaults to `kit-check`, `observe`, `admission` or `judge`. An observation reads its baseline from `<run dir>/jobs/kit-check/evidence.json`, so the kit check and the observation share one run directory.

Exit codes:
- 0: the job is complete (for `proof`, every case held).
- 1: the summary was written, but the job is `incomplete`, `refused` or `needs_reconciliation`.
- 2: a usage or input error, with nothing run.

## Limits (spec §9.4)

| Job | Controller deadline | Ceiling | Copies | Pool, allocation | Slot key |
|---|---|---|---|---|---|
| `kit_check` | 9,000 s (admission's) | $8 | 5 | `development` | `development` |
| `observe` | 900 s | $1 | 1 | `development` | `development` |
| `admission` | 9,000 s | $8 | 13 | `development` | `development` |
| `judge_verify` | 2,100 s | $2 | 3 | `judge-demo`, `judge` | `judge` |

- The deadlines, ceilings and copy counts come from `@rbw/envelope`'s `FIXED_LIMITS`. The grader proof's `judge_verify` jobs use the development pool and slot key.
- Each app copy has 4 vCPU and 8 GB, with the driver's 600 s copy deadline. Per copy, the run-copy path makes at most 3 mutating SDK calls, 12 artifact reads and 1 stop. The copies run strictly one after the other.
- Before building, the controller refuses a job with more copies than its limit (`too_many_copies`). It also refuses a job whose copies' reservations together would exceed its ceiling (`ceiling_exceeded`).
- **Child deadline:** a copy's deadline is the minimum of 600 s and the parent's remaining time minus 120 s. A copy with no positive time is refused (`parent_deadline`).
- The run-copy path always gives a copy the driver's whole 600 s, plus 120 s to stop and collect. So a copy starts only when its child deadline is the whole 600 s. A shorter positive child deadline also stops new launches (`child_deadline_short`). This is checked before the reservation, and again at the create itself, after the copy's export and audit.
- When the parent deadline passes, no new copy starts. A running copy is never cut short: it ends within its own outer limit, which the rule above keeps inside the parent deadline. The job is reported `incomplete`.
- Nothing is retried: no launch, copy or job.

## The ledger flow

Before the first copy, the controller acquires the slot for the job's root execution. A `slot_held` or `unknown_slot` refusal stops the job (`refused`) before anything is reserved.

For each copy, in order:

1. Check the child deadline.
2. **Reserve** the copy's priced envelope (operation kind `sandbox.copy`, call name `sandbox.copy:<job>:<trial_id>`, provider `vercel-sandbox` or `docker`). This happens before the copy's sandbox exists.
3. Mark it **launching** under the slot key.
4. Run the copy through `runCopyCommand`. The controller passes it a wrapped SDK and Docker layer, which only note whether the create was called and what it returned, and refuse the create when the child deadline no longer allows the copy.
5. Record the sandbox (or container) as a **child resource** with the `running` transition.
6. **Confirm** its terminal state with `confirmChild`. The evidence is `jobs/<name>/stops/<trial_id>.json` and its SHA-256: the stop confirmation, the final status, the call counts and the phase timings.
7. Mark the copy **terminal**: `completed` when the copy completed, `failed` otherwise.
8. **Settle** from the measured lifetime at the envelope's rates. The lifetime runs from the create call to the confirmed stop, rounded up to whole seconds. Each line's actual cost is rounded up, and all usage is known, so the operation becomes `reconciled`.

A copy whose create was never called (refused before it, or refused by the deadline check at the create) goes `launching → terminal (cancelled)` and settles at zero.

After the last copy, the controller merges and imports the record set. It releases the slot only when every copy's resource is confirmed terminal and nothing is uncertain. The database also refuses a release while any child is unconfirmed.

### An uncertain launch

A launch is uncertain when the controller cannot confirm the copy's resource has ended. That covers:
- a create that was called and failed without the sandbox being recovered by name;
- a stop that was not confirmed;
- any error after the create.

On an uncertain launch the controller:
- records `uncertain` (`lost_response` when no resource came back, `unknown_status` after `running` otherwise);
- stops the job and launches nothing more;
- leaves the slot held and the reservation open;
- still imports what the earlier copies collected, and reports `needs_reconciliation` with what is known.

The operator then follows `@rbw/spend`'s procedures:
- manual reconciliation with the provider's evidence (`accept_complete` keeps a completed copy's result; `confirm_no_launch` when nothing was made);
- then the slot release by an operator.

A ledger call that fails (a dropped connection) is handled the same way: the job stops with `ledger_unavailable` and the slot is not released.

### The per-copy envelope

`@rbw/envelope` prices whole jobs (a controller sandbox plus its copies). This controller runs on the conductor's host and reserves each copy on its own, so `src/envelope.ts` builds one copy's envelope from the same rate sheet and fixed limits. It passes the result to `toReserveRequest`.

The time limit is the copy sandbox's own timeout, which the provider enforces: the run-copy path's 720 s (the driver's 600 s plus 120 s), plus the 60 s shutdown allowance.

| Line | Limit | Price | Reserved (micro-USD) |
|---|---|---|---|
| `vcpu_second`, `provider_timeout` | 4 × 780 = 3,120 | 128,000 per 3,600 | 110,934 |
| `memory_gb_second`, `provider_timeout` | 8 × 780 = 6,240 | 21,200 per 3,600 | 36,747 |
| `creation`, `client_counter` | 1 | 600,000 per 1,000,000 | 1 |
| **Total** | | | **147,682** |

The most copies of each kind fit under its ceiling: 13 copies reserve 1,919,866 micro-USD against admission's 8,000,000. The job request names the total it reserves (copies × 147,682) as `reservation_microusd`, and its deadline as `deadline_at`.

## Replay

A job directory holds `controller.json`, written before anything runs. It records the job's IDs and a fingerprint of its inputs:
- the command's options and the hash of every input file;
- the image's resolved digest, so a rebuild under the same tag counts as a different job;
- the kit stage's fixture and added suite;
- for an observation, the kit-check baseline's hash.

Running the same command again with the same run directory and name is a replay:
- With a summary, it returns the existing job's summary. It makes no ledger write and launches nothing.
- Without one (the earlier run stopped part-way, or is still running), it reports `needs_reconciliation` (`interrupted`) with the slot's holder and blockers. It launches nothing.

Different inputs under the same name are refused, and the command exits 2. A new attempt uses a new run directory or `--name`. For example, an observation refused because the kit check had not run yet is run again as `--name observe-2` once the kit check has run.

## Grader proof (spec §9.2)

`proof` runs two `judge_verify` jobs, three copies in all, then re-imports two tampered copies of the first job's record set. Its inputs are the small patches in `proof/`, each pinned by its SHA-256 in `proof/inputs.json`. Every patch applies to the planted target file (`7cb32193…6c`).

| Case | Patch | SHA-256 | Copy | Holds when |
|---|---|---|---|---|
| Valid fix | `valid-fix.patch` (the local runner's alternative fix: line 28 passes `timezone \|\| 'utc'`) | `eb9f8e13…f5c3` | `proof-fix` `fixed-01` | complete, added verdict `match`, original suite run with no failure, and the placed file is `49a8fba2…e649` |
| Empty fix | `empty-fix.patch` (0 bytes) | `e3b0c442…b855` | `proof-fix` `planted-01` | the planted file, complete with added verdict `match` against the planted vector: it fails exactly as declared |
| Attempted forgery | `forgery.patch` | `fa97cef8…ba48` | `proof-forgery` `fixed-01` | complete with added verdict `reject` (the planted failures remain), and the marker `synthetic-forged-pass` appears nowhere in the record set or in what the copy brought back |
| Failed protected regrade | `valid-fix.patch` | `eb9f8e13…f5c3` | `proof-fix` `fixed-01`, re-imported | the valid fix passed, and with `fixed-01`'s `trial-result.json` removed, or its observations altered, the trial imports as `incomplete` or `invalid`, never a pass |

- The forgery keeps the planted bug. On every query, it tries to write a passing `trial-result.json`, a `run.exit`, a `reward.txt` and a report to these paths: its own temp directory, the root-only results directory, `/logs/verifier`, and `/tmp`. The kit lets the app write only its own temp directory and build outputs, and the driver reads only its own records.
- `proof.json` in the run directory records each case's inputs, expectation, observation and result.

## Summary

`jobs/<name>/summary.json` is canonical JSON (`encodeCanonical`). It holds:

- the labels (`development_evidence`, `admission_claim: false`, `published: false`);
- `status` (`complete`, `incomplete`, `needs_reconciliation`, `refused`), with a reason and detail;
- the job: execution IDs, task revision, request and expected-trials hashes, deadline, baseline and trials;
- the controller: backend, ledger, pool, allocation, slot key, limits, the copy's reserved amount, start and end;
- the image digest and `kit_sha256`, and the original suite's hash, test count and source;
- per copy:
  - the status and reason;
  - `launch` (`not_launched`, `confirmed`, `uncertain`), the child resource ID and the stop confirmation;
  - the phase timings;
  - the operation ID, the reserved and settled micro-USD and the ledger state;
  - the run-copy summary, which includes the sandbox's call counts;
- the importer's evidence and decision hashes and per-trial results;
- the job's total reserved, settled and open micro-USD, read back from the ledger;
- whether the slot was acquired and released, and any release blockers.

## Conductor commands

Run on the host, from the repository root, with the kit image built and pushed as in the local runner's README (Host commands, steps 1, 2 and 5).

Load the secrets into the shell from the owner's private env file, never on a command line. For example `set -a; . <private env file>; set +a`, where the file sets `DATABASE_URL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`.

1. Once per database: apply the migrations and create both slot keys.

   ```sh
   pnpm --filter @rbw/spend run migrate
   node tools/controller/src/cli.ts create-slot-key --slot-key development
   node tools/controller/src/cli.ts create-slot-key --slot-key judge
   ```

2. A live kit check, then a live observation, on Sandbox, in one run directory `<run>`:

   ```sh
   node tools/controller/src/cli.ts run --job-kind kit_check --work <run> --image rbw-umami-kit:local \
     --manifest <manifest> --terms <terms> --kit-stage <stage> \
     --backend sandbox --sandbox-image <vcr repository>@sha256:<digest>
   node tools/controller/src/cli.ts run --job-kind observe --work <run> --image rbw-umami-kit:local \
     --manifest <manifest> --terms <terms> --kit-stage <stage> \
     --original-suite <run>/jobs/kit-check/freeze/collected/original-suite.json \
     --backend sandbox --sandbox-image <vcr repository>@sha256:<digest>
   jq '{status, reason, spend, slot, copies: [.copies[] | {trial_id, status, launch, reserved_microusd, settled_microusd, child_resource_id}]}' <run>/jobs/kit-check/summary.json <run>/jobs/observe/summary.json
   ```

   The observation needs the kit check's original suite, so it reads the manifest the kit check's freeze copy made.

3. The four grader proofs, in a new run directory `<proof run>`:

   ```sh
   node tools/controller/src/cli.ts proof --work <proof run> --image rbw-umami-kit:local \
     --manifest <manifest> --terms <terms> --kit-stage <stage> \
     --backend sandbox --sandbox-image <vcr repository>@sha256:<digest>
   jq '.cases[] | {case, ok, trial_id, observed}' <proof run>/proof.json
   ```

Adding `--backend docker` (and leaving out `--sandbox-image`) runs any of these on local Docker with the in-memory ledger, with no credentials.

## Tests

```sh
pnpm --filter @rbw/controller test
pnpm --filter @rbw/controller run test:integration
```

The unit tests use a PGlite ledger with every spend migration, plus the local runner's test doubles: its fake Sandbox SDK, and its simulated kit image, whose copies run the real driver's `runTrial`. They start no container and use no network. They cover:
- the ledger flow and its order against the SDK calls;
- the judge pool;
- an uncertain create, and a lost create recovered by name;
- both deadline stops, and the refusal at the create;
- the Docker backend;
- replay;
- the per-copy envelope;
- the committed proof inputs, and the grader proof against the fake backend.

Spec §6.1's four serial-run checks are in `test/support/serial-checks.ts`:
- a replay creates no second job;
- an uncertain launch holds its slot and reservation;
- manual reconciliation of a completed copy keeps its result;
- the slot is released only after termination is confirmed.

They run on PGlite in the unit tests, and on the Postgres in `DATABASE_URL` in `test:integration`. There each check gets its own random schema, dropped afterwards. With `DATABASE_URL` unset, `test:integration` prints a skip message and exits 0.

## What it does not do

- It is not the web route that starts a judge replay (planned), and it does not write or search candidates.
- It never retries a launch, a copy or a job, and it never reconciles or releases a slot after an uncertain launch. Both are the operator's recorded actions.
- It does not shorten a copy below the driver's 600 s: when the child deadline is shorter, the copy does not start.
- It does not calibrate anything, and its summaries are not admissions.
- It runs the controller itself on the conductor's host, not in a sandbox, so it reserves only the copies.
