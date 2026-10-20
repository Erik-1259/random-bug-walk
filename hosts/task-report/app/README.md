# Task-and-report service

A synthetic app built for experiments.

## Running locally

Start PostgreSQL, apply the migrations and run the service on `http://127.0.0.1:3000`:

```sh
docker compose up
```

Without Compose, against an existing PostgreSQL 15 server that has the `taskapp` database and
the `taskapp_owner` and `taskapp_app` roles:

```sh
npm ci --ignore-scripts
npm run typecheck
MIGRATION_DATABASE_URL=postgres://taskapp_owner:...@host/taskapp npm run migrate -- apply
DATABASE_URL=postgres://taskapp_app:...@host/taskapp npm run migrate -- verify
DATABASE_URL=postgres://taskapp_app:...@host/taskapp npm start
npm test
```

Load the demo data into the running service (`BASE_URL` defaults to `http://127.0.0.1:3000`):

```sh
node scripts/load-fixture.ts
```

## Contract

# Task-and-report service: contract

This is the contract for a small task-and-report HTTP service, a synthetic app built for experiments.
It covers the data model, the HTTP API, the required behavior, the implementation rules for `src/`,
and how the service is run and tested.

The service stores tasks (a title and a note) and completion records (a unique ID and a UTC instant),
and reports how many completions fall on one local calendar day in an explicitly named IANA time zone.
The six JSON routes under `/api` listed below are the whole interface: there are no delete, list or
authentication routes, and there is no default time zone.

---

## Data model

`migrations/0001_init.sql`:

```sql
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  note  text NOT NULL DEFAULT '' CHECK (char_length(note) <= 10000),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  completed_at timestamptz(3) NOT NULL);
CREATE INDEX completions_completed_at_idx ON completions (completed_at);
CREATE INDEX completions_task_id_idx ON completions (task_id);
-- schema_migrations(version text PK, sha256 char(64), applied_at timestamptz) is managed by the migrator
```

- **Roles and database.**
  - `taskapp_owner`: owns the database and its tables; used for migrations and for administrative data resets.
  - `taskapp_app`: DML on `tasks` and `completions`, plus `SELECT` on `schema_migrations`. The running service connects only as this role.
  - Database: `taskapp`.
- **Migrator.** `apply` runs as the owner role before the service starts (for instance once, when an instance image is built). `verify` runs as the app role at startup; if migrations are not current, the service exits 1, which is a startup failure.

---

## HTTP API

| Route | Request | Success | Errors |
|---|---|---|---|
| `GET /api/heartbeat` | — | 200 `{"status":"ok"}` after `SELECT 1` (1 s limit) | 503 `database_unavailable` |
| `POST /api/tasks` | `{"title": s, "note"?: s}` | 201 Task, with a `location` header (`/api/tasks/{id}`) | 400, 413, 415 |
| `GET /api/tasks/{id}` | — | 200 Task | 404 |
| `PATCH /api/tasks/{id}` | `{"title"?: s, "note"?: s}`, at least one | 200 Task, the row as this update left it | 400, 404, 413, 415 |
| `POST /api/tasks/{id}/completions` | `{"completed_at"?: RFC 3339 with offset}`; omitted means the database's `now()` | 201 Completion | 400, 404, 413, 415 |
| `GET /api/reports/completions/daily?date=YYYY-MM-DD&time_zone=<IANA>` | — | 200 Report | 400 |

### Shapes and errors

- Task `{id,title,note,created_at,updated_at}`. Completion `{id,task_id,completed_at}`. Report `{date,time_zone,start,end,count}`, where `[start,end)` is half-open.
- Every instant in output is `toISOString()`: UTC, `Z`, milliseconds. `time_zone` is echoed exactly as given. Every ID in output (`id`, `task_id` and the `location` header) is lowercase, as PostgreSQL returns it.
- Error body: `{"error":{"code","field"?,"message"}}`, where the message is a fixed string per code and never database text. Codes:

  | Code | Status | Notes |
  |---|---|---|
  | `invalid_json` | 400 | |
  | `validation_failed` | 400 | with `field` |
  | `not_found` | 404 | |
  | `method_not_allowed` | 405 | with an `allow` header |
  | `payload_too_large` | 413 | body over 64 KiB |
  | `unsupported_media_type` | 415 | |
  | `internal_error` | 500 | |
  | `database_unavailable` | 503 | |

- Every response carries `cache-control: no-store` and an `x-request-id` header holding a fresh UUID.

### Validation

- **Routing.** Matching is exact and case-sensitive on the raw path before `?`, with no percent-decoding and no slash normalization; `{id}` matches one non-empty path segment. Any other path gets 404 `not_found`. A known path with any other method that reaches node:http's `request` event, `HEAD` and `OPTIONS` included, gets 405 `method_not_allowed` with an `allow` header listing that route's methods in a fixed form (`GET`, `POST` or `GET, PATCH`). Query strings are ignored on every route except the report.
- **Order of evaluation** (first match wins):
  1. no route matches the path: 404 `not_found`;
  2. the method is not allowed for the route: 405 `method_not_allowed`;
  3. `{id}` is not a UUID: 404 `not_found`, without reading the body;
  4. body routes only (steps 4 to 6 apply to no other route): the media type is not JSON: 415 `unsupported_media_type`;
  5. the body is over 64 KiB: 413 `payload_too_large`;
  6. bad UTF-8, an empty body, unparseable JSON, or a top-level value that is not an object: 400 `invalid_json`;
  7. field or query validation: 400 `validation_failed`;
  8. the route's single SQL statement runs; zero rows gives 404 `not_found`.

  No route queries the database before its request has passed validation.
- **Body.** The media type (the part of `content-type` before any `;`, trimmed, compared ASCII case-insensitively) must be `application/json`. Parameters are ignored, and the body is always decoded as UTF-8 with `new TextDecoder("utf-8", {fatal: true})` (a leading BOM is ignored) and parsed with `JSON.parse` (for a repeated key, the last one wins). A missing header or any other media type, `+json` types included, gets 415. All three body routes require a JSON object body; to omit `completed_at`, send `{}`. Unknown keys get 400.
- **Fields.** `null` is rejected for every field on every route, with 400 `validation_failed` naming the field; omitting a field is the only way to get its default. `field` is the JSON key or query parameter name, and appears only with `validation_failed`. Body fields are validated in this order: `title`, then `note` (or `completed_at`), then unknown keys (the first in `Object.keys` order of the parsed object), then the `PATCH` at-least-one rule, which reports `"field": "body"`.
- **`title`.** A string of 1 to 200 code points, well-formed Unicode, no U+0000, stored as given. It is rejected when `title.trim() === ""` (ECMAScript white space and line terminators).
- **`note`.** A string of 0 to 10,000 code points, well-formed Unicode, no U+0000, stored as given. A whitespace-only note is allowed.
- **`PATCH`.** At least one field. An empty note is `""`.
- **`{id}`.** Valid if and only if it matches `^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`, with any hex digit accepted in every position (any value PostgreSQL's `uuid` type stores is addressable); anything else gets 404 before any query runs.
- **`completed_at`.**
  - A string that must match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$`.
  - Calendar fields are validated by arithmetic, never by `Date.parse`. V8 rolls Feb 30 over to Mar 2, accepts `24:00`, and reads offset-less strings as local time.
  - Ranges: month 01-12, day 01 to the month's length (Gregorian leap rule), hour 00-23, minute 00-59, second 00-59 (no leap second). Offset hours are 00-23 and minutes 00-59, validated by arithmetic like the calendar fields.
  - The instant must lie in [1970-01-01T00:00:00.000Z, 2100-01-01T00:00:00.000Z).
- **`date`.** Exactly once. `^\d{4}-\d{2}-\d{2}$`, a real Gregorian date between 1970-01-01 and 2099-12-31.
- **`time_zone`.**
  - Exactly once, at most 64 characters, matching `^(?:UTC|[A-Za-z][A-Za-z_-]*(?:/[A-Za-z0-9_+-]+)+)$`, and accepted by `new Intl.DateTimeFormat("en-US",{timeZone})`.
  - This shape rejects abbreviations such as `EST`, POSIX-style names such as `EST5EDT`, and numeric offsets, whose meaning depends on the ICU version.
  - Never validated against `Intl.supportedValuesOf`, which omits `UTC`.
  - Clients must percent-encode `+`: a raw `Etc/GMT+5` decodes to `Etc/GMT 5`.
- **Order.** `date`, then `time_zone`, then unknown query parameters (`validation_failed` naming the parameter).

---

## Behavior

| ID | Behavior |
|---|---|
| C-1 | `POST /api/tasks` stores exactly the given title and note (note defaults to `""`) and returns them |
| C-2 | `GET` returns the latest committed state, or 404 |
| C-3 | `PATCH` changes only the fields present. An omitted field keeps its current committed value, **including a value committed by a concurrent request** |
| C-4 | A task starts at T0/N0. A = `{title:T1}`, B = `{note:N1}`. A then B, B then A, and A overlapping B (either arrival order) **each get a 2xx**, and a fresh `GET` after both responses returns T1/N1. Rejecting one of two independent updates because of the other violates the contract |
| C-5 | Updates to different tasks never change each other |
| C-6 | Concurrent changes to the **same** field: last committed wins. Which of them commits last is not specified |
| C-7 | A completion `POST` stores one row with a new unique ID and the given instant (or `now()`), and returns it to the millisecond in UTC. An unknown task gets 404 |
| C-8 | The report counts rows with `start ≤ completed_at < end`. `start(D,Z)` is the earliest instant whose local date in Z is on or after D; `end = start(D+1,Z)`. Rows sharing an instant each count |
| C-9 | **No 24-hour-day assumption.** C-8 holds for 23, 24 and 25 h days. A missing midnight means the day starts when the gap ends. A repeated midnight means its first occurrence. A skipped date gives `start = end` and count 0. Where the local date steps backward across a midnight (the 00:01 fall-backs in America/St_Johns, America/Goose_Bay and America/Moncton between 1987 and 2010, and Antarctica/Casey on 2010-03-05), the windows of the dates involved are deterministic but otherwise unspecified |
| C-10 | Every response is identical whatever the app process `TZ` and the PostgreSQL `timezone` are |
| C-11 | No response contains database error text. 5xx bodies are generic |

---

## Implementation rules for `src/`

These rules are written so that a reviewer can confirm them by searching `src/`.

- **PATCH.** One autocommit statement with no read before it:
  `UPDATE tasks SET title = COALESCE($2,title), note = COALESCE($3,note), updated_at = now() WHERE id = $1 RETURNING id,title,note,created_at,updated_at`. Zero rows means 404.
  - It is correct under READ COMMITTED because a blocked `UPDATE` re-evaluates against the newest row version, and its `SET` reads that version (PostgreSQL 15 manual: "Read Committed Isolation Level" and the `UPDATE` reference page).
- **Completion insert.** `INSERT INTO completions (task_id, completed_at) SELECT t.id, COALESCE($2::timestamptz, now()) FROM tasks t WHERE t.id = $1 RETURNING id, task_id, completed_at`. Zero rows means 404.
  - `$2` is the validated instant as its `toISOString()` string, or null when `completed_at` is omitted; the raw input string is never bound.
- **Report.** `localDayWindow(date, zone)` works in TypeScript:
  - `start` is found by binary search to 1 ms over [`Date.UTC(D)` − 26 h, `Date.UTC(D)` + 26 h], using `Intl.DateTimeFormat` with an explicit `timeZone` and `hourCycle:"h23"` as the predicate;
  - `end` is the same function applied to `nextDate(date)`, which is pure calendar arithmetic;
  - the count is `SELECT count(*)::int FROM completions WHERE completed_at >= $1::timestamptz AND completed_at < $2::timestamptz`, with ISO-Z strings;
  - the window is never computed with SQL `AT TIME ZONE`, which resolves an ambiguous midnight to the later instant.
  - The search assumes the local date never decreases. Where it steps backward (C-9), it may land on either entry to the date: in America/St_Johns on 2006-10-29 it returns 03:30Z, not the first midnight at 02:30Z.
- **Helpers.** A helper with a single caller stays private in its caller's module (`nextDate` stays private in `src/time/local-day.ts`).
- **Time-zone independence.**
  - No local-time `Date` API.
  - No offset-less parsing.
  - Never select `date` or `timestamp` columns; string parsers are registered for OIDs 1082 and 1114 anyway.
  - No `::date`, `date_trunc` or `AT TIME ZONE` in SQL.
  - The app never sets the session `TimeZone`.
- **Pool.**
  - `max` comes from `DB_POOL_MAX`: default 10, range 2 to 100.
  - `connectionTimeoutMillis` 2000, `idleTimeoutMillis` 10000.
  - `statement_timeout` 30000 ms as a connection parameter.
  - `application_name` is `taskapp`.
  - A `pool.on('error')` handler logs and keeps the process up.
  - The app never uses `NOWAIT`, `SKIP LOCKED` or `lock_timeout`.
- **Process.**
  - One process that spawns no other process groups, so that the service can be identified and stopped by a single process ID.
  - It listens on `HOST` (default 127.0.0.1) and `PORT` (default 3000).
  - Server timeouts: `requestTimeout` 30 s, `headersTimeout` 10 s.
  - On SIGTERM or SIGINT: wait up to 4 s for in-flight requests, call `pool.end()`, exit 0.
- **Logging.**
  - JSON lines on stderr only, with fields `ts` (UTC ISO), `level` and `event`.
  - Events:
    - `listening`;
    - `request`: request ID, method, path with query string (truncated at 512), route template, status, `duration_ms`, error code; successful heartbeats are not logged;
    - `request_error`: error name, SQLSTATE and the `pg` fields, plus the stack;
    - `db_pool_error`, `config_error`, `migrations_not_current`, `shutdown`, `fatal`.
  - Never logged: bodies, title or note values, counts, computed windows, SQL text or database URLs.
  - PostgreSQL logging stays at its defaults: no `log_lock_waits`, no statement log.

---

## Operations

### Runtime

- Node 24. The TypeScript sources run directly through Node's built-in type stripping (erasable syntax only); there is no compile step and no build output.
- PostgreSQL 15.

### Environment variables

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `HOST` | `127.0.0.1` | `start` | Listen address |
| `PORT` | `3000` | `start` | Listen port |
| `DB_POOL_MAX` | `10` | `start` | Pool size, an integer from 2 to 100 |
| `DATABASE_URL` | none (required) | `start`, `migrate verify` | Connection URL for the app role `taskapp_app` on database `taskapp` |
| `MIGRATION_DATABASE_URL` | none (required) | `migrate apply` only | Connection URL for the owner role `taskapp_owner` on database `taskapp`; never read by the running service |
| `BASE_URL` | `http://127.0.0.1:3000` | `test` | Address of the running service that the HTTP tests call |

When `start` or `migrate` finds a variable it needs missing, or a value invalid, it logs `config_error` and exits 1.

### npm scripts

| Script | Command | Purpose |
|---|---|---|
| `typecheck` | `tsc -p . --noEmit` | Type check; writes nothing |
| `start` | `node src/main.ts` | Runs the service |
| `migrate` | `node src/db/migrate.ts` | `npm run migrate -- apply` applies pending migrations as the owner role; `npm run migrate -- verify` exits 0 when migrations are current and 1 when they are not |
| `test` | `playwright test` | Runs the Playwright tests over HTTP against the running service at `BASE_URL` |

Packages are installed with `npm ci --ignore-scripts` from `package-lock.json`.

### Database prerequisites

- A PostgreSQL 15 server where these already exist before any migration runs, created by whoever provisions the server:
  - role `taskapp_owner` with `LOGIN`, owning database `taskapp`;
  - role `taskapp_app` with `LOGIN`.
- Applying migrations creates the schema in `taskapp` and grants `taskapp_app` its privileges (DML on `tasks` and `completions`, `SELECT` on `schema_migrations`).
- `migrate apply` runs as `taskapp_owner` before the service starts. Migrations are current when every file in `migrations/` is recorded in `schema_migrations` with the SHA-256 of its bytes.
- At startup the service runs `verify` as `taskapp_app`. A stale schema logs `migrations_not_current` and the process exits 1; the service never applies migrations itself.
- Startup order: read configuration, create the pool, verify migrations, listen, log `listening`. `GET /api/heartbeat` answers 200 once the service is ready.
