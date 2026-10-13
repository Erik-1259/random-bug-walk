# @rbw/umami-fixture

The first public fixture, `umami-tz-arg-001`: one data file, an independent derivation of its expected values, and four added checks that ask a pinned Umami install for daily pageview counts in four time zones.

The checks target a **synthetic** bug, planted only for this project and never filed upstream. In `relationalQuery` of Umami's `src/queries/sql/pageviews/getPageviewStats.ts`, the call `getDateSQL('website_event.created_at', unit, timezone)` loses its third argument, so daily pageview buckets are always computed in UTC. The checks pass on clean Umami and fail, at the named assertion, on the mutated copy.

Host: Umami at commit `ec0ff50388c264ed8ce46f00967e92f7e71476ae` (MIT). This package copies no Umami code; it follows the patterns of Umami's `tests/api` helpers with its own thin client over Playwright's request context.

## Contents

- [Data file](#data-file)
- [Expected values and their derivation](#expected-values-and-their-derivation)
- [Requests](#requests)
- [Checks and outcomes](#checks-and-outcomes)
- [Interface for the protected driver](#interface-for-the-protected-driver)
- [Reset between rounds](#reset-between-rounds)
- [Live proof](#live-proof)
- [Host scripts for the proof copies](#host-scripts-for-the-proof-copies)
- [Tests](#tests)
- [Not in this package](#not-in-this-package)

## Data file

`data/umami-tz-arg-001.v1.json` SHA-256: `787bd7722d86d585de86193c145b70884a075b4cc1e2fd6f08ff38c710528bdf`

A unit test checks this value, so any change to the file is deliberate and updates this line.

The file is the single source for the fixture loader, the checks, the protected driver and the issue writer's symptom input. Nothing retypes its values, tests included. It is canonical JSON: `schema_version: 1`, integers only, keys sorted at every level, no duplicate keys, two-space indent and a trailing newline. `loadFixture()` rejects any other form.

| Field | Content |
| --- | --- |
| `fixture_id`, `host` | `umami-tz-arg-001`, and the upstream and pinned commit. |
| `website` | The website the setup creates: fixed id, name and domain. |
| `send` | The fixed `/api/send` body fields. |
| `events` | Twelve rows `{ id, utc_instant, timestamp_seconds }`. They straddle local midnight in each zone and the America/Los_Angeles daylight-saving change on March 8, 2026 (−08 to −07 at 10:00Z). This is one selected transition, not exhaustive DST coverage. |
| `request` | Path, `startAt` and `endAt` in **milliseconds** (March 7 00:00:00.000Z to March 9 23:59:59.999Z), and `unit: "day"`. Event timestamps are in **seconds**. |
| `bucket_labels` | The three day labels. In this API they encode local calendar days: compare them as strings and never parse the `Z` as an instant. |
| `checks` | The four checks in query order, the UTC control first, each with its zone and expected counts. |
| `outcome_vectors` | The expected outcome of each check per code state (`clean`, `fixed`, `planted`, `partial`, `stub`), for later use by the job records. |
| `predicted_planted_counts` | `[2, 8, 2]` for each non-UTC check, marked `predicted`. No code uses these as observed values. |
| `derivation` | The method, Python and `tzdata` versions, and every event's local time in every zone, as the derivation script wrote them. |

| `check_id` | Zone | Expected Mar 7, 8, 9 |
| --- | --- | --- |
| `tzarg.utc-day-counts` | `UTC` | 2, 8, 2 |
| `tzarg.la-day-counts` | `America/Los_Angeles` | 3, 8, 1 |
| `tzarg.auckland-day-counts` | `Pacific/Auckland` | 1, 6, 5 |
| `tzarg.kolkata-day-counts` | `Asia/Kolkata` | 2, 7, 3 |

## Expected values and their derivation

`derive/derive_expected.py` computes each event's local date and time in each zone with Python's `zoneinfo`, reading zone data only from the `tzdata` package pinned in its inline metadata (PEP 723, locked in `derive_expected.py.lock`), and counts events per local day. It never uses Umami's code, date-fns or Postgres. Run it from the repository root:

```sh
PYTHONTZPATH= uv run --locked --script packages/umami-fixture/derive/derive_expected.py --check
PYTHONTZPATH= uv run --locked --script packages/umami-fixture/derive/derive_expected.py --write
```

- `--write` fills `checks[].expected` and `derivation`; `--check` exits 1 if the file differs from the derivation and 0 if it matches. `--file <path>` points either mode at another copy. Exit code 2 means the file could not be read or is malformed.
- `PYTHONTZPATH=` keeps the system zone files out; the script also clears the search path itself.
- The recorded Python version is major and minor only, because the result depends on the `tzdata` release, not the interpreter's patch level.

The script is not a uv workspace member; the root `ruff check` and `ruff format --check` cover it. In CI, without network access, a Vitest test recomputes the table with Node's `Intl.DateTimeFormat` and compares it, and every event's local time, with the file.

## Requests

All requests go through Playwright's `APIRequestContext`, with no retries.

1. `POST /api/auth/login` with the admin login from `RBW_FIXTURE_ADMIN_USERNAME` and `RBW_FIXTURE_ADMIN_PASSWORD`. When unset, these default to `admin` and `umami`, the synthetic values that the pinned migration creates in a disposable install. Requires HTTP 200 and a non-empty `token`. The token stays in memory: it is never written to a file, a log, an observation or a failure message.
2. `POST /api/websites` with exactly the data file's `{ id, name, domain }`. Requires HTTP 200 and the same `id` back.
3. Twelve `POST /api/send` calls, once each, serially and in table order, with no `x-umami-cache` header. Each body is the e01 body below with only `id` and `timestamp` substituted; with no `name` field, Umami records a pageview. Requires HTTP 200, no `beep` field and a non-empty `cache` field. The first failed or uncertain send stops the round as a setup failure. Nothing is retried, and no later event is sent.

   ```json
   {"type":"event","payload":{"website":"11111111-1111-4111-8111-111111111111","hostname":"timezone-fixture.test","url":"/timezone-fixture","language":"en-US","screen":"1280x720","id":"e01","timestamp":1772881140}}
   ```

4. One `GET <request.path>` per check with the bearer token and exactly `startAt`, `endAt`, `unit=day` and `timezone=<zone>`, URL-encoded, the UTC control first.

## Checks and outcomes

The four `check_id`s are four independent Playwright tests in `checks/tzarg.check.ts`, in the default (non-serial) mode, so a failure in one zone never stops another zone from executing. Setup (login, website, twelve sends) runs once per round in Playwright's global setup, before the checks. Playwright replaces its worker after a failed test, so setup is deliberately not a worker fixture: a replacement worker only logs in again and never resends. The setup outcome reaches the workers through an inherited environment variable that carries a status and a reason, never the token.

The assertion wrapper (`classify(response, check)`) grades each response in this order:

1. **Invalid** (`observed: "setup_fail"`, `failure_code: "unrelated_failure"`): HTTP status other than 200, a body that is not UTF-8 JSON, a missing or non-array `pageviews`, a missing `sessions`, or an item whose `y` is not a nonnegative integer of number type. Strings are never coerced. A request that gets no response at all is also invalid.
2. `assertion_fail` with `bucket_labels_mismatch`: the labels are not exactly the three `bucket_labels`, unique and ascending (a missing, extra, duplicated, reordered or differently formatted label).
3. `assertion_fail` with `local_day_counts_mismatch`: the labels are right but a count differs (a total other than 12 is a count mismatch).
4. `pass`, with `failure_code: null`.

`sessions` must be present; its counts are not graded. A setup failure makes every check `setup_fail` with `auth_failed` (login) or `seed_failed` (website or send); it is never an intended negative outcome. The codes are fields in the written outcome, never parsed from log text. Each check writes its outcome before its one named assertion, whose message gives the observed labels and counts.

## Interface for the protected driver

Inputs, all environment variables, read by `readFixtureEnv()`:

| Variable | Meaning |
| --- | --- |
| `RBW_FIXTURE_BASE_URL` | The app's base URL. |
| `RBW_FIXTURE_REPEAT_INDEX` | A positive integer. |
| `RBW_FIXTURE_OUTPUT_DIR` | An existing directory, empty at the start of the round. |
| `RBW_FIXTURE_ADMIN_USERNAME`, `RBW_FIXTURE_ADMIN_PASSWORD` | Optional admin login (defaults above). |

One round, from the repository root (with the package's `playwright` binary, for example through `pnpm --filter @rbw/umami-fixture exec`, which runs in the package directory, so the config path is then `playwright.config.ts`):

```sh
playwright test --config packages/umami-fixture/playwright.config.ts --workers=1 --retries=0
```

The config sets no retries and no max-failures stop, and writes Playwright's JSON report to `RBW_FIXTURE_OUTPUT_DIR/report.json`. Playwright's own scratch output goes to a temporary directory, not the output directory.

Outputs in `RBW_FIXTURE_OUTPUT_DIR`:

- `responses/<check_id>.json`: the exact response body bytes, whenever a response arrived (whatever its status).
- `observations/<check_id>.json`: one object per executed check with exactly `check_id`, `repeat_index`, `observed` (`pass`, `assertion_fail` or `setup_fail`), `failure_code` (nullable), `duration_ms`, `response_artifact_key` (`responses/<check_id>.json` or null) and `response_artifact_sha256` (or null). The last two are both set or both null. The field names follow the shared check-observation record; when the shared schema package gains that record (item W1-1), the type switches to it.
- A check that never ran writes nothing; the driver records it as `not_run`. A round whose output directory is not empty stops when the config loads: it sends nothing and writes nothing, so an earlier round's files stay as they were.

Library exports from `src/index.ts`: `loadFixture()` and `parseFixture()`, the request builders (`loginRequest`, `createWebsiteRequest`, `sendBody`, `sendRequests`, `queryString`, `queryRequests`), the setup steps (`login`, `seed`, `runSetup`), `classify`, `writeObservation`, `readFixtureEnv` and `resetFixture` with `createFixtureTemplate` (see below).

Runtime dependencies: `@playwright/test` 1.63.0 and `pg` 8.23.1, nothing else.

## Reset between rounds

Each round needs the same starting point: a freshly migrated database, then login, website creation, the twelve sends and the four read-only queries. Never resend into a populated database.

**Chosen method: (b), a template copy.** `createFixtureTemplate(connectionString)` copies the application database once, right after Umami's migration. Before every round, `resetFixture(connectionString)` drops the application database, closing its sessions, and recreates it from that copy. Umami keeps running; its connection pool reconnects on the next request, so no restart is needed. Both functions take the application database's connection string as a parameter, read no environment variable, and need a role that may create and drop databases (the test stack's own database role is one).

The choice comes from a measured study, committed as `evidence/reset-study.json`, against the pinned clean stack (PostgreSQL 15.19):

| Candidate | Rounds | Outcomes | Response bytes vs a freshly migrated database | Reset | Wall time per round, reset included |
| --- | --- | --- | --- | --- | --- |
| (a) in place: truncate the tables and copy back a snapshot taken after migration | 10: two batches of 5, one after a fixture round, one after Umami's own API suite (its first round starts from the post-suite state) | all pass | identical in every round | at most 66 ms | at most 1.2 s |
| (b) template copy, no restart | 10: two batches of 5, one after a fixture round, one after Umami's own API suite (its first round starts from the post-suite state) | all pass | identical in every round | at most 146 ms | at most 1.2 s |
| (c) fresh stack and Umami restart, run on the host | 5 | all rounds exit 0 | not compared | included | 20 to 21 s (62 s for the first, with the image start) |

- (c) needs about 420 seconds for 20 rounds, beyond the 240-second test phase that also holds the original suite (54 to 74 seconds measured).
- (a) and (b) both gave the same bytes as a fresh database, including the first round after the original suite, so no state held in Umami's memory showed up in these requests. (b) is chosen because it restores the whole database at the Postgres level, every table and sequence included, from a copy taken right after migration, while (a) depends on a snapshot schema inside the application database and on the table list it read. (b) costs about 0.1 s more per reset.
- In both suite runs of the study, two of Umami's own revenue tests failed (269 passed); they failed the same way when run alone right after a template reset, so they do not come from the fixture data. This is reported through the inbox.

The study's own scripts are `study/reset-study.ts` (candidates (a) and (b), and a per-round summary with byte comparisons) with `study/in-place.ts`, and `host/reset-study-fresh.sh` (candidate (c)). The committed evidence file combines that summary with the host-reported figures for (c), the budget and the choice.

## Live proof

`evidence/live-proof.json` records the proof against pinned Umami on host Docker, one fresh stack per state, from the conductor's host runs:

| State | Target file SHA-256 (prefix) | UTC | Los Angeles | Auckland | Kolkata |
| --- | --- | --- | --- | --- | --- |
| clean | `1f679f7a` | pass | pass | pass | pass |
| planted | `7cb32193` | pass | `local_day_counts_mismatch` | `local_day_counts_mismatch` | `local_day_counts_mismatch` |
| partial | `3dfbe7db` | pass | `local_day_counts_mismatch` | pass | `local_day_counts_mismatch` |
| stub | `422eb568` | pass | `bucket_labels_mismatch` | `bucket_labels_mismatch` | `bucket_labels_mismatch` |

Each row matches the data file's `outcome_vectors`. In the revert run, with the `timezone` query parameter removed from the requests (a patch that was never committed), clean and planted gave the same outcomes as planted above, so the proof no longer tells them apart. One further round on the clean stack, after a `resetFixture` reset, passed all four checks with response bytes identical to the reset study's reference.

## Host scripts for the proof copies

These are proof scaffolding, run by the conductor on a host with Docker; they are POSIX `sh`, pass `shellcheck`, use no `sudo` and print no credentials.

- `host/prepare-copy.sh <clean|planted|partial|stub> <dir>` clones Umami, checks out the pinned commit, verifies the target file's SHA-256, applies the state's one-line edit, requires exactly one changed hunk in that one file, and prints the resulting SHA-256. The canonical rule and probe data belong to another package (item W1-6); the script switches to that data once it merges.
- `host/stack.sh <up|down> <state> <dir> <port>` runs `docker-compose.test.yml` with the `postgres` profile, a per-state project name and image tag, and `UMAMI_TEST_PORT=<port>`. One stack runs at a time. With `RBW_FIXTURE_DB_PORT` set, `up` also applies `host/compose.db-port.yml`, which publishes Postgres on host loopback for the reset study.
- `host/reset-study-fresh.sh <dir> <port> <rounds> <out>` runs the reset study's fresh-stack candidate.

## Tests

| Script | What it does |
| --- | --- |
| `pnpm --filter @rbw/umami-fixture test` | Unit tests: the data file and its `Intl` recomputation, request builders, classifier, setup failures, output contract, config loader, and real Playwright rounds against a local `node:http` fake of the Umami API on loopback. No network service. |
| `pnpm --filter @rbw/umami-fixture check` | One round against `RBW_FIXTURE_BASE_URL`. |
| `build`, `typecheck`, `lint` | The workspace's standard scripts. |

Vitest collects only `test/**/*.test.ts`; the Playwright checks are named `*.check.ts`.

## Not in this package

The protected driver and its records (item W1-3), the kit image (W1-4), the shared job record types (W1-1), the rule confirmation and canonical probe patches (W1-6), and the issue writer.
