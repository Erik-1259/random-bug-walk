# @rbw/umami-driver

The protected command that runs inside one Umami app copy in the kit image (`kit/umami`) and writes that copy's trial records. It runs as root, with the verifier's own Node (`/opt/rbw/verifier/node/bin/node`), from `/opt/rbw/verifier/kit/umami-driver`. This is part of a hackathon prototype.

For one trial it does the following:

1. builds the app with the kit's `rbw-build-app`, which runs `pnpm build:docker` as `rbw-app` through the kit launcher;
2. starts Postgres and Umami with the kit's `rbw-start`, which waits for `/api/heartbeat`, and then copies the migrated database to the fixture's template;
3. runs Umami's unchanged API suite (24 spec files at the pinned commit) against a frozen test manifest;
4. resets the fixture and runs the four added checks, for 1 or 20 rounds;
5. stops everything with the kit's `rbw-stop`, and confirms that the process group it started has ended;
6. writes the trial's records as a record set that `@rbw/admission` imports, with phase timings and resource samples.

The trial's status is evidence, not a verdict. The driver never decides admission.

## Commands

```sh
node src/cli.ts freeze [--verifier <dir>] [--out <file>] [--base-url <url>] [--work <dir>]
node src/cli.ts run --job <dir> --trial <trial_id> --out <dir> [--verifier <dir>] [--limits enforce|record-only]
node src/cli.ts fetch-closure --list <closure.sha256> --verifier <dir>
```

The verifier root defaults to `/opt/rbw/verifier`, and the frozen manifest to `<verifier>/original-suite.json`. `run` exits 0 once the records are written, whatever the trial's status. It exits 2, writing nothing, when it refuses the input or cannot run. It exits 3 when an unexpected error ended the trial after it started; the app copy is still stopped and the records are still written, as `incomplete` with `artifact_missing`.

Development options:

- `--limits record-only` records phase overruns without stopping the phase. It marks the phase timings as a development measurement.
- `--app <dir>` and `--verifier <dir>` replace the app copy and the verifier root, and mark the record as a development measurement.
- `--external-app <url>` runs against an app the driver did not start, such as Umami's test stack on a host. The added checks are not run, and the record is marked as a development measurement.
- `fetch-closure` downloads the pristine closure at the pinned commit into `<verifier>/suite`, checks every file against the kit's `closure.sha256`, and copies that list to `<verifier>/closure.sha256`. In the kit image the closure is already staged.

## Input and output

The input is a job directory laid out as a record set: `request.json` (a `JobRequest`) and the `ExpectedTrials` file at the request's `expected_trials_key`. `--trial` names the one trial this copy runs. Both files are read with `parseRecord` from `@rbw/schema`, must be canonical bytes, and must agree: the manifest's SHA-256 is the request's `expected_trials_sha256`. The driver refuses a trial whose `original_suite_sha256` or `original_test_ids` differ from the frozen manifest, or whose `added_suite_sha256` differs from the fixture package's hash. A trial with no original suite (`observe`) skips it.

The output directory must be absent or empty. It becomes the record set that `@rbw/admission` reads (its README, "Record-set layout"):

| Key | Content |
|---|---|
| `request.json` | The input request, byte for byte |
| the request's `expected_trials_key` | The input expected trials, byte for byte |
| `results/<trial_id>/trial-result.json` | The `TrialResult` |
| `results/<trial_id>/observations.json` | The `TrialObservations`: every check of every round, sorted by `repeat_index`, then `check_id` |
| `results/<trial_id>/artifacts.json` | The `ArtifactManifest`; no unlisted file is evidence |
| `results/<trial_id>/artifacts/...` | Every listed artifact |

Every record is checked with the shared schema against the request, and written as canonical bytes with `encodeCanonical`. Every key is relative to the output directory. A job's other trials run in their own copies, each writing its own `results/<trial_id>/`.

Artifacts, by kind:

- `original_suite_outcomes` (`original/outcomes.json`): the per-test outcomes in the importer's format, `{ schema_version, trial_id, original_suite_sha256, tests }`, with `tests` sorted by `test_id`. Only executed (`passed`, `failed`) and `skipped` tests are listed; a manifest test that did not execute is absent. A trial without an original suite has no such entry.
- `suite_manifest`, `test_report`, `environment`: the frozen manifest, the suite's Playwright JSON report, and the runner's environment with the identity check and the resolved `analytics-query` import and its hash.
- `fixture_report`, `fixture_outcome`, `check_response`: each round's report, outcome files and response bytes, under `added/round-NN/`.
- `stdout`, `stderr`, `log`: the kit scripts' and runners' output, and the kit's Postgres and Umami logs, each kept up to 1 MiB and marked truncated beyond that.
- `phase_timings`: each phase and round with start, end, duration and limit, and memory, CPU and disk samples every 30 seconds.
- `diagnostics`: every problem in phase order, closure integrity, missing, skipped and unlisted tests, refused and truncated artifacts, and the stop records.

The first problem, in phase order, decides the status: `invalid` for `scope_violation`, `build_failed`, `startup_failed`, `auth_failed`, `seed_failed` and `unrelated_failure`; `incomplete` for every other reason. A failing original test or a failing check is recorded as observed and leaves the trial `complete`. An unexpected error in the driver after the trial started adds `artifact_missing` after the problems found so far: the evidence from the remaining phases is missing, and the error says nothing about the app copy, so it is not `unrelated_failure`. The phases still open end as `failed`, every check of a round that did not finish is `not_run`, and `diagnostics.json` records the error's phase, class and errno-style code in `internal_error`, never its message.

## The original suite

The kit stages the pristine closure in `/opt/rbw/verifier/suite` at the pinned commit, and lists every file's SHA-256 in `/opt/rbw/verifier/closure.sha256`:

- `playwright.api.config.ts`;
- every file in `tests/api/` except `.runtime`;
- `src/lib/analytics-query.ts`, which `report-migration.spec.ts` imports.

Umami's files are never committed here. The kit installs the verifier's own `node_modules` (`@playwright/test` 1.63.0, `otplib` 13.5.0 and `pg` 8.23.1) from `kit/umami/verifier/pnpm-lock.yaml`.

Each trial copies the listed files into a new directory under the output directory, at their original relative paths, with two harness files:

- the wrapper config `rbw-api.config.ts`, which imports the pinned config and adds only Playwright's JSON reporter;
- the verifier's `package.json`, whose `"type": "module"` the suite's sources need, as Umami's own does.

The copy's `node_modules` is a link to the verifier's. The driver checks the copy's hashes against the manifest, and checks that no import can resolve into the app directory or its `node_modules`.

`freeze` runs `playwright test --list` on the clean kit, under the same environment as a real run (`API_COVERAGE=report` included), and writes the manifest as canonical JSON: every enumerated test by ID, file and title path; the closure, harness and lock hashes; and the runner's environment. Its SHA-256 is the expected trial's `original_suite_sha256`. At Playwright 1.63.0, `--list` does not run global setup; the upstream coverage reporter then fails in its `onEnd`, so `--list` exits 1 although its JSON report is complete, and the exit code is not used.

A real run is `playwright test --config=rbw-api.config.ts --workers=1 --retries=0 --max-failures=0`, with this environment:

- `API_COVERAGE=report`;
- `PLAYWRIGHT_BASE_URL` pointing at this copy only;
- `API_SKIP_SEED` unset;
- `API_ALLOW_DESTRUCTIVE=1`, added only after the identity check. It reads only files root can read without ptrace access to other users' processes (`/proc/net/tcp`, `/proc/<pid>/stat` and `status`, and `/run/rbw/umami.pid`), never `/proc/<pid>/fd`: every socket listening on port 3000 was created by `rbw-app`; the launcher named by `/run/rbw/umami.pid` is alive and in the group the driver started for `rbw-start`; a child of that launcher runs as `rbw-app` and leads its own group; and every live `rbw-app` process is in that group. So the listener belongs to Umami under the launcher `rbw-start` left running. The check does not tell which process in that group holds the socket.

Every manifest test must execute. A test absent from the report gives `test_missing`, and a skip gives `test_skipped`. A failing original test is recorded as failed evidence.

## The added checks and the reset

The fixture package (`@rbw/umami-fixture`) sits at `/opt/rbw/verifier/kit/umami-fixture`. One round is its config run with the verifier's Playwright, `--workers=1 --retries=0`, with `RBW_FIXTURE_BASE_URL`, `RBW_FIXTURE_REPEAT_INDEX`, `RBW_FIXTURE_OUTPUT_DIR` (a new empty directory), `RBW_FIXTURE_ADMIN_USERNAME` and `RBW_FIXTURE_ADMIN_PASSWORD`, and `TMPDIR` set to a scratch directory of the round's own.

For each round and check, the driver validates `observations/<check_id>.json`, copies the response bytes, and cross-checks the outcome against the report's status for the test titled with the check ID:

- no outcome file gives `not_run` with `artifact_missing`;
- a skipped test gives `skipped` with `test_skipped`;
- an outcome that contradicts the report gives `setup_fail` with `unrelated_failure`.

Nothing is read from log text or exit codes. A failing check never stops later rounds.

The reset is the fixture's template copy. After `rbw-start`, the driver calls `createFixtureTemplate`; before each round it calls `resetFixture`, which drops the application database `WITH (FORCE)` and recreates it from the template while Umami keeps running. Both connect as `umami_owner` over the socket: `postgresql://umami_owner@localhost/umami?host=/run/rbw-pg`. `CREATE DATABASE` does not copy database-level grants, so after each copy the driver restores the kit's grants (`etc/bootstrap.sql`): `PUBLIC` has no access to either database, and `umami_app` may connect only to `umami`. Before the round starts, the driver then checks that `umami_app` can connect and query, with the password from `/opt/rbw/etc/app.environment`, and that Umami answers `/api/heartbeat` within 30 seconds.

`added_suite_sha256` is the SHA-256 of the canonical JSON of `{ <relative path>: <SHA-256> }` for every file in the fixture directory, leaving out `node_modules` and a top-level `test-results`.

## Limits

| Phase | Limit |
|---|---|
| build | 240 s |
| readiness (Postgres, Umami, template copy) | 60 s |
| tests (the original suite, every reset and every round) | 240 s |
| stop, artifacts and setup | 60 s |
| whole copy | 600 s |

A phase deadline never moves the whole-copy deadline. Reaching a limit stops the phase and gives `timeout`, recorded with the phase name and its elapsed time. Stopping a process group sends TERM, waits up to 20 seconds (longer than the kit launcher's own stop), sends KILL, and confirms the group has ended. Each artifact's size is checked before it is read, against a total of 64 MiB per trial; exceeding it gives `limit_exceeded`, and truncated output is never parsed as evidence.

## The kit image

`scripts/stage-kit.ts` stages the directory to pass as `--build-context rbw-kit=<dir>`:

```sh
node packages/umami-driver/scripts/stage-kit.ts --dest <dir>
docker build --build-arg REGISTRY=docker.io --build-context rbw-kit=<dir> -t <tag> kit/umami
```

It holds `umami-driver/`, `umami-fixture/` and `schema/`, with `node_modules/@rbw/schema` as a symlink to `../../schema` and copies of the schema's runtime dependencies (`ajv` and its own). Node does not strip types from `.ts` files under `node_modules`, so the schema is linked rather than copied. `@playwright/test` and `pg` resolve from the verifier's own `node_modules`. The script prints the staged fixture's `added_suite_sha256`.

`scripts/proof-job.ts` writes a synthetic `kit_check` job for a proof run, from a frozen manifest, the staged fixture's hash and the image digest. Its project, policy and profile fields are placeholders.

## Tests

`pnpm test` runs the unit tests. They use an injected process runner, an injected clock and canned Playwright reports, and start no app. The round output comes from the fixture package's own `writeObservation`, and one test file runs `@rbw/admission`'s importer over record sets the driver wrote. Two tests read the committed `kit/umami` files, so a change to the kit's paths, scripts or connection strings fails them.

## What it does not do

- It does not apply source patches or audit the source projection.
- It does not decide admission, grade outcomes or call the importer.
- It has not yet run in the kit image; the in-image proof runs on a host with Docker.
