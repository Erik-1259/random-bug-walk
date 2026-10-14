# @rbw/umami-fixture-rc1

The race-class fixture, `rc-1-backup-code-001`: one data file and two added checks that spend a two-factor backup code on a pinned Umami install, once serially and once with two concurrent requests.

The checks target a **synthetic** bug, planted only for this project and never filed upstream. It is an RC-1 shape (shared state read, then an `await`, then written back): in Umami's `src/app/api/2fa/verify/route.ts`, the backup-code branch reads the unused codes, awaits a bcrypt compare against each, and then marks the matched code used with `updateMany({ where: { id, used: false } })`, refusing the code when no row changed. The planted mutation drops `used: false` from that `where`, one line:

```diff
-      where: { id: unusedCodes[matchIndex].id, used: false },
+      where: { id: unusedCodes[matchIndex].id },
```

Two requests that both read the code before either writes are then both accepted, and one backup code opens two sessions. The `consumed.count === 0` branch after it stays in the source but can no longer be reached. Upstream commit 3e165a8c added the guard (spec §2.5).

Host: Umami at commit `ec0ff50388c264ed8ce46f00967e92f7e71476ae` (MIT). The verify route above was read from the pinned kit image's `/workspace/app`. This package copies no Umami code.

This package is separate from `@rbw/umami-fixture` on purpose: the driver hashes the whole staged fixture package as `added_suite_sha256`, and the released time-zone family's trials pin that hash. Each family stages its own fixture package into the kit's one `umami-fixture` slot (see [Staging](#staging)).

## Contents

- [Data file](#data-file)
- [Checks and outcomes](#checks-and-outcomes)
- [Overlap evidence](#overlap-evidence)
- [Interface for the protected driver](#interface-for-the-protected-driver)
- [Two-factor state and reset](#two-factor-state-and-reset)
- [Staging](#staging)
- [Local proof](#local-proof)
- [Delay study](#delay-study)
- [Admission status](#admission-status)
- [Tests](#tests)
- [Not in this package](#not-in-this-package)

## Data file

`data/rc-1-backup-code-001.v1.json` SHA-256: `0d7c9ca3b9ea003cf0f5c005884fd02ea233e1441f87f9ea997cfa11794faee7`

A unit test checks this value, so any change to the file is deliberate and updates this line.

The file is canonical JSON (sorted keys, two-space indent, trailing newline). It holds:

- `target`: the path and the clean and planted forms of the one changed line;
- `two_factor`: the pinned migration's admin user ID, a synthetic row ID, a synthetic placeholder for the TOTP secret column (no check uses a TOTP code) and ten backup codes, each with a synthetic ID, a plaintext of the form `SYNTHETIC-RC1-CODE-NN` and its bcrypt hash at 10 rounds, the form Umami stores. A unit test checks every hash against its plaintext with bcryptjs 3.0.3, the version the pinned app uses;
- `checks`: the serial control on code 01, then the race on code 10, the last code stored, so each racing request compares every unused code before its write;
- `outcome_vectors` for `clean`, `fixed` and `planted`;
- `adm05`: the declared vectors for the 20 repetitions in `fixed-01` and `planted-01`, equal to the fixed and planted vectors. The planted vector is **unproven**: at zero database delay the [local proof](#local-proof) met it in 17 of 30 rounds, so as committed it would fail ADM-05 (see [Admission status](#admission-status));
- `adm06`: `not_applicable`, with the reason. A partial or stub fix of a lost-update race has no natural form, so ADM-06 is recorded as not applicable for this family. There are no `partial` or `stub` states.

## Checks and outcomes

| Check | What it does | clean, fixed | planted |
| --- | --- | --- | --- |
| `rc1.backup-code-serial-reuse` | Signs in, spends code 01, and once that was accepted signs in again and spends it again | pass | pass |
| `rc1.backup-code-concurrent-double-spend` | Signs in twice, one request context each, then sends both verify requests for code 10 together | pass | `assertion_fail`, `double_spend` |

The control passes in every state: a reuse after the first use has settled reads the code as used, with or without the guard. So a planted failure of the race check comes from the race, not from a broken backup-code path, and the planted vector has the shape ADM-05 asks for (the control passes, every declared assertion fails).

Grading, in `src/classify.ts`:

- Serial control: the first use must be accepted (HTTP 200 with a token), otherwise `setup_fail` with `seed_failed`. The reuse then gives `pass` when refused with `two-factor-error-invalid-backup-code`, `assertion_fail` with `backup_code_reused` when accepted, and `setup_fail` with `unrelated_failure` for anything else.
- Race, in this order: `unrelated_failure` for a network error or any answer other than an accepted code or `two-factor-error-invalid-backup-code`; `unrelated_failure` when the two requests were never in flight together; `double_spend` when both were accepted; `seed_failed` when neither was; `pass` when exactly one was.

A failed sign-in is `auth_failed`; a sign-in that returns a full session instead of a two-factor challenge means the baked state is missing and is `seed_failed`.

`double_spend` and `backup_code_reused` are assertion failure codes of the shared schema's `AssertionFailureCode`, so the driver accepts an outcome file with either; a driver test parses the outcome this package's own writer produces for each.

## Overlap evidence

The spec (§2.5) asks each run to establish that the intended operations overlapped. The race check records, for each request, when it was sent and when it settled (milliseconds from the first send, `performance.now()` in the check), its status, Umami's error code and whether a token was issued, never a token, partial token, code or response body. It also records `overlap_ms`, how long both requests were in flight together. This record is the check's response artifact, `responses/<check_id>.json`, so the driver hashes and keeps it with the trial's records like any response.

What the record proves, measured in the [local proof](#local-proof):

- On a planted copy, two accepted requests prove the interleaving: the second read happened before the first write.
- In-flight overlap is necessary but not sufficient. In 13 of 30 planted rounds both requests overlapped by at least 639 ms, yet only one was accepted, because the second request read the code after the first had marked it used. From outside the app, such a round looks the same as a clean round where the guard refused the second write: both answer `two-factor-error-invalid-backup-code`.

So `overlap_ms > 0` is the grading condition, and the repeatability of the race at a chosen database delay has to come from the delay study and ADM-05. Because each request spends hundreds of milliseconds in the app (bcrypt compares and database round trips), `overlap_ms > 0` holds in almost every round: in the local proof the 13 planted rounds where the race did not occur still overlapped by at least 639 ms. The overlap gate therefore almost never fires, and a `pass` on a clean or fixed copy does not show that either request read before the other wrote. This only partly meets spec §2.5.

**Open question, to settle before the race family is admitted.** One of:

- (a) add database-side ordering evidence that the driver collects: a Postgres statement log with process IDs and timestamps, or a per-request read and write timestamp; or
- (b) accept the weaker, client-side evidence and say so in the family's public claims.

The race wiring step (driver, admission and runners) has to settle this question.

## Interface for the protected driver

The same interface as `@rbw/umami-fixture`:

- Inputs, read by `readFixtureEnv()`: `RBW_FIXTURE_BASE_URL`, `RBW_FIXTURE_REPEAT_INDEX`, `RBW_FIXTURE_OUTPUT_DIR` (empty at the start of a round) and the optional `RBW_FIXTURE_ADMIN_USERNAME` and `RBW_FIXTURE_ADMIN_PASSWORD` (default `admin` and `umami`, the pinned migration's synthetic login).
- One round: `playwright test --config <fixture>/playwright.config.ts --workers=1 --retries=0`. There is no global setup: the state is baked into the template, and each check signs in for itself. The race runs inside one test with `Promise.all`, so one worker is enough.
- Outputs in `RBW_FIXTURE_OUTPUT_DIR`: `report.json`, `observations/<check_id>.json` with exactly the shared observation fields, and `responses/<check_id>.json`, the evidence record above, whenever a verify request was sent.
- The entry module `src/index.ts` exports `createFixtureTemplate`, `resetFixture` and `TEMPLATE_DATABASE` (`rbw_fixture_template`, the same name as the time-zone fixture), which the driver loads by path, plus `FIXTURE_FILE`, `loadFixture()`, the request builders, `runSerialReuse`, `runDoubleSpend`, `classify` and `writeObservation`.

Runtime dependencies: `@playwright/test` 1.63.0 and `pg` 8.23.1, which the kit's verifier already holds, and nothing else. `bcryptjs` is a development dependency for the unit tests only.

## Two-factor state and reset

`createFixtureTemplate(connectionString)` runs once after Umami's migration, as the owner role. It first copies the migrated application database to the template, as the time-zone fixture does. Then, connected to the template copy only, it deletes any two-factor rows of the admin user and, in one transaction, inserts a `two_factor_auth` row with `is_enabled` true and the ten backup codes, unused, in data-file order. The application database is never seeded: the driver runs Umami's original suite after the template is made and before the first reset, and that suite signs in as admin with a password only, so it needs stock Umami. A unit test checks that every seed statement goes to the template database, after the copy, and none to the application database. `resetFixture(connectionString)` recreates the application database from the template before every round, so every round starts with all ten codes unused and no failed-attempt count. Nothing is set up over HTTP, so a round has no setup step that can fail before the checks.

The kit's app environment sets `TWO_FACTOR_ENCRYPTION_KEY` to a valid placeholder key, without which Umami answers the sign-in with HTTP 503. Redis is not configured in the kit, so Umami keeps the failed-attempt count in Postgres, and the reset clears it.

## Staging

`node packages/umami-driver/scripts/stage-kit.ts --dest <dir> --fixture-package packages/umami-fixture-rc1` stages this package's `package.json`, `playwright.config.ts`, `src/`, `checks/` and `data/` into the kit's `umami-fixture/` slot and prints its `added_suite_sha256`. Without `--fixture-package`, the script stages `packages/umami-fixture` exactly as before; a driver test checks that the default staging is byte for byte the same as naming it, and that its hash is still the released one. `evidence/`, `host/`, `test/` and this README are not staged, so they do not change the hash.

## Local proof

`host/live-proof.sh` runs one copy inside a kit image: it plants the line (for `planted`), builds, starts, bakes the template and runs a number of rounds, each after a reset. `evidence/live-proof.json` summarizes the runs of Oct 13, 2026, on a kit image built locally for arm64, with no delay between Umami and Postgres:

| Copy | Rounds | Serial control | Race |
| --- | --- | --- | --- |
| clean | 25 | 25 pass | 25 pass |
| planted | 30 | 30 pass | 17 `double_spend`, 13 pass |

The checks grade as declared, but with no database delay the planted race is not repeatable enough for ADM-05, which needs 20 of 20. The delay study picks a database delay that gives 20 of 20 on a planted copy, ahead of the ADM-05 run itself.

With no guard in the planted route, a refusal can only come from the branch where no unused code matched, so in the 13 lost planted rounds the second request read after the first wrote. The delay study sizes a database delay to cover that lag.

## Delay study

`host/race-delay-study.sh` runs the same single-copy flow in a **race** kit image (`kit/umami-race`, the kit with Toxiproxy between Umami and Postgres) and sweeps the downstream latency toxic. It builds once, starts, bakes the template, then for each delay sets the latency once with `rbw-proxy set-latency`, checks the proxy once after setting it and again after every round, and runs the rounds, each after a reset. It writes one JSON line per check per round to `study-<variant>/rounds.jsonl` (delay, round, outcome, the two verify attempts, overlap, round time) and prints a line per check per round. Like `host/live-proof.sh`, it refuses to start when its output directory is not empty, so an earlier run's round files are never read as this run's. `evidence/rc-1-race-study.json` summarizes a run of Oct 13, 2026, 20 planted and 20 clean rounds at each delay, on a race kit image built locally for arm64 (4 CPUs, 6 GB):

| Delay | Planted race | Clean race (false positives) | Serial control | Planted overlap (median) |
| --- | --- | --- | --- | --- |
| 0 ms | 9/20 `double_spend` | 0/20 | 40/40 pass | 881 ms |
| 25 ms | 20/20 `double_spend` | 0/20 | 40/40 pass | 1266 ms |
| 50 ms | 20/20 `double_spend` | 0/20 | 40/40 pass | 1507 ms |
| 100 ms | 20/20 `double_spend` | 0/20 | 40/40 pass | 2001 ms |
| 200 ms | 20/20 `double_spend` | 0/20 | 40/40 pass | 3186 ms |

The smallest delay giving 20/20 planted `double_spend` and 0/20 clean on arm64 is **25 ms**. This is a pre-admission repeatability result on the planted and clean copies; it is not ADM-05, which needs 20 repetitions on `fixed-01` and `planted-01`. The delay widens the window between each request's read and the first request's write; the clean copy overlaps by the same amount but the guard still refuses the second write, so it stays 0/20 at every delay. At 0 ms the planted race was 9/20, so 25 ms has little margin.

This result is from a native arm64 build. The released image is amd64, and bcrypt and database timing differ by arch, so the chosen delay must be re-measured on the released amd64 image on native amd64 hardware before the family is admitted; a release targeting amd64 may prefer 50 ms for margin. The amd64 race kit built from this source passes all ten in-image race self-tests under `linux/amd64` emulation (the latency toxic, per-container `set-latency`, the API-change audit and the timed database-through-proxy check), so the delay mechanism itself works on amd64, but the per-round app build cannot run under emulation: `rbw-build-app`'s cold-build check refuses the `/root/.cache` that Rosetta recreates on every emulated process, the same limitation this image's README records for the base self-test.

## Admission status

This fixture is **not ready to be wired or admitted**, and no paid run should use it yet:

- At zero delay a planted copy shows `double_spend` in about half the rounds (9 of 20 in the [delay study](#delay-study), 17 of 30 in the earlier no-delay proof), so ADM-05's 20 of 20 on `planted-01` is far out of reach without a delay.
- A single race round that passes is not evidence of a fix. A "fix" that changes nothing passes the race check in about half the no-delay rounds, because a lost race on a planted copy grades `pass` (a unit test shows this with an app that writes before the second read). A fixed verdict needs many race rounds, as ADM-05's 20 repetitions give; a trial that grades a solver's fix from fewer rounds must not rely on one race round.
- The [delay study](#delay-study) shows 20 of 20 planted `double_spend` and 0 of 20 clean false positives at a 25 ms downstream latency toxic (and at 50, 100 and 200 ms), with the serial control passing throughout, on a native **arm64** race image. Before admission this must be re-measured on the released **amd64** image on native amd64 hardware, since the chosen delay depends on bcrypt and database timing and 25 ms has little margin over the flaky 0 ms cell.
- The driver accepts `double_spend` and `backup_code_reused`. One round must still run through the staged kit and the driver (`stage-kit --fixture-package`, then the driver), not through `host/live-proof.sh`, which calls the fixture and Playwright directly.
- The overlap-evidence question above is still open.

## Tests

`pnpm test` runs the unit tests. They use an in-memory stand-in for the sign-in and verify routes (`test/fake-app.ts`) that reads the unused codes, yields, and writes with or without the guard, so the runner and the classifier are tested end to end on both variants without an app. The stand-in can also hold the race's two reads until both have happened, or run verify requests one at a time; the second mode shows that a planted copy grades `pass` when the race is lost.

`test/rounds.test.ts` runs real Playwright rounds of the staged files (`playwright.config.ts` and `checks/rc1.check.ts`), as the driver does, against the stand-in served on loopback. It checks `report.json`, the observation files, the race's response artifact and its overlap on clean and planted routes, `seed_failed` with no response file when sign-in returns no challenge, `auth_failed` when the connection drops, the serial control's response file when only its follow-up sign-in drops, and the refusal of an output directory that is not empty.

## Not in this package

- The race kit image itself (`kit/umami-race`), and the choice of delay for the released amd64 image. The arm64 [delay study](#delay-study) is in this package; its re-measurement on native amd64 is not.
- The ast-grep rules and probe records for the RC-1 shape.
- Wiring the family into the runners, the controller and admission, with the 11-copy profile without the two ADM-06 probes: `--family race` in `tools/local-runner` and `tools/controller` (see the local runner's README, Bug families). The candidate attempt still refuses the race family, because the issue writer's `ObservedSymptom` holds time-zone fields only.
