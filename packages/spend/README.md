# @rbw/spend

Postgres tables and atomic operations that decide whether metered work may start.

- Every metered call reserves its whole worst case against a do-not-exceed pool in one atomic database operation, and later records what it actually cost.
- All execution runs under one serial slot per slot key. Only confirmed termination, or a manual reconciliation recorded with evidence, can free it.
- A factory request is charged against one request budget on its own pool, and its progress (request, events, heartbeats, stop, evidence, validation runs) is stored in insert-only factory records with idempotent writes. See [Request budgets](#request-budgets) and [Factory records](#factory-records).

Every rule is enforced in the database. PL/pgSQL functions created by the migrations perform every operation and hold the rules that need context: settlement, reconciliation, the halt and resume, and slot release. Constraints and triggers hold the invariants listed below, and a trigger on every table refuses rows that do not come through those functions (see [Invariants](#invariants) for what that guard does not cover). The TypeScript API is a typed wrapper over the functions. It never writes the tables directly, and it does no logging.

## Contents

- [Setup](#setup)
- [TypeScript API](#typescript-api)
- [Calling the database operations from another language](#calling-the-database-operations-from-another-language)
- [Money, identifiers and times](#money-identifiers-and-times)
- [Invariants](#invariants)
- [Pools, allocations and caps](#pools-allocations-and-caps)
- [The priced envelope](#the-priced-envelope)
- [Check-and-reserve](#check-and-reserve)
- [Operation states](#operation-states)
- [Settlement](#settlement)
- [Over-envelope halt](#over-envelope-halt)
- [Serial execution slot](#serial-execution-slot)
- [Request budgets](#request-budgets)
- [Factory records](#factory-records)
- [Refusal codes](#refusal-codes)
- [Caller protocol](#caller-protocol)
- [Operator procedures](#operator-procedures)
- [Tables](#tables)
- [Tests](#tests)
- [Known limits](#known-limits)
- [Not in this package](#not-in-this-package)

## Setup

Requires Postgres 17 or later. `migrate` needs a role that owns the target schema; it does not need superuser privileges. Unit tests use PGlite in process.

| Script | What it does |
| --- | --- |
| `pnpm --filter @rbw/spend run migrate [--schema <name>]` | Applies pending migrations to the database in `DATABASE_URL` (schema `public` by default; the schema must exist). Prints each file it applies and a final count (`applied 0 migrations` on a re-run). Exits non-zero, naming the file and the reason, if an applied file has changed or is missing, if a new file sorts before an applied one, or if a file fails. With `DATABASE_URL` unset it exits non-zero with a message naming the variable. It never prints any part of the connection string. |
| `pnpm --filter @rbw/spend run operator <command> [options]` | Reads ledger status or previews an operator action against `DATABASE_URL`; `--apply` records the action. See [Operator command](#operator-command). |
| `pnpm --filter @rbw/spend run test` | Unit tests (PGlite, no network). |
| `pnpm --filter @rbw/spend run test:integration` | Integration tests (I1–I5 and the others listed under [Tests](#tests)) against the Postgres in `DATABASE_URL`. Each run uses its own randomly named schema and drops it afterwards, also when setup fails. With `DATABASE_URL` unset, prints a skip message and exits 0. |
| `build`, `typecheck`, `lint` | The workspace's standard scripts. |

`migrate`, `operator` and `test:integration` run from source with Node 24; none needs a build step.

Migrations are forward-only plain SQL files in `migrations/`.
- They are applied in lexical order, each exactly once. A new file that sorts before an applied one is refused (exit non-zero, naming the file), so every database applies them in the same order.
- A run applies all of them in one transaction. Deferred constraints are checked after each file, so a failure names the file that caused it.
- Concurrent runs against one schema take a transaction-scoped advisory lock and run one after the other, also on the schema's first run.
- Each applied file is recorded in `applied_migrations` with its SHA-256.
- They name no schema: the runner sets `search_path` to `<schema>, pg_temp` for its transaction, and each function captures it (`SET search_path FROM CURRENT`). Naming `pg_temp` last means a session's temp tables never shadow the spend tables inside the functions.

The migrations seed two pools and no slot key:

| Pool | Cap (micro-USD) | Allocations |
| --- | --- | --- |
| `development` | 1,000,000,000 ($1,000) | none |
| `judge-demo` | 200,000,000 ($200) | `public` 50,000,000 (anonymous use), `judge` 150,000,000 (protected for judges) |

A deployment's slot key is created with `createSlotKey` when the package is first set up on a long-lived database. That setup is not done by the migrations.

The same holds for factory requests: migration `0006_factory.sql` seeds no pool and no slot key. An owner creates the `factory` pool (cap 40,000,000 micro-USD, no allocations) with `createPool` and the `factory` slot key with `createSlotKey`; tests create both in their setup.

## TypeScript API

```ts
import pg from "pg";
import { createSpend, fromPg, migrate } from "@rbw/spend";

const client = new pg.Client({ connectionString });
await client.connect();
await migrate(fromPg(client), { schema: "public" });
const spend = createSpend({ client: fromPg(client), schema: "public" });

const result = await spend.reserve(request);
if (!result.ok) {
  // result.code is one of the refusal codes below. Stop; do not retry.
}
```

- **Client.** The library takes a database client from its caller (`SqlClient`: `query(text, params)` and `exec(sql)`). Wrap a node-postgres `Client` or `PoolClient` with `fromPg`; a PGlite instance satisfies the interface directly. The library reads no environment variables.
- **One statement per call.** Each call is one statement that runs one database function. It works over direct and pooled (transaction-mode) connections: no session state is used, names are schema-qualified, and only transaction-scoped locks are taken.
- **Options.** `schema` (default `public`) and `clock` (default system time) are optional. The clock supplies every event time and can be replaced in tests.
- **Results.** Every call returns `{ ok: true, ... }` or a typed refusal `{ ok: false, code, ... }`. Infrastructure failures (for example a dropped connection) are thrown and are never reported as success or refusal. Nothing retries.
- **Amounts in results** are exact `bigint`s.

| Function | Database operation | Purpose |
| --- | --- | --- |
| `migrate(client, { schema, migrationsDir })` | | Apply pending migrations; returns the applied file names. `runMigrate` is what the CLI runs and returns its exit code. |
| `createPool` | `spend_create_pool` | Owner: create a pool with a cap and optional allocations. |
| `createSlotKey` | `spend_create_slot_key` | Owner: create a slot key (starts free). |
| `raiseCap` | `spend_raise_cap` | Owner: raise the cap of a pool without allocations. |
| `transfer` | `spend_transfer` | Owner or operator: move an amount from `public` to `judge` in `judge-demo`. |
| `resume` | `spend_resume` | Owner or operator: resume new work after an over-envelope halt. |
| `reserve` | `spend_reserve` | Atomic check-and-reserve. |
| `transition` | `spend_transition` | `prepared → launching`, `launching → running`, `launching/running → terminal`, `launching/running → uncertain`. |
| `settle` | `spend_settle` | Record a `UsageSettlement` exactly once. |
| `reconcile` | `spend_reconcile` | Owner or operator: record a `ManualReconciliation`. |
| `acquireSlot` | `spend_slot_acquire` | Acquire the slot for a root execution. |
| `recordChild` | `spend_slot_record_child` | Record a child resource under the held slot. |
| `confirmChild` | `spend_slot_confirm_child` | Record a child resource's confirmed terminal state with evidence. |
| `releaseSlot` | `spend_slot_release` | Release by the holder, or by an owner or operator with evidence and a reason. |
| `haltStatus` | `spend_halt_status` | Halted or not, and the observations since the latest resume. |
| `poolStatus` | `spend_pool_status` | Cap, allocation limits, settled, open, committed, available. |
| `operationStatus` | `spend_operation_status` | State, reserved, settled, open, released. |
| `slotStatus` | `spend_slot_status` | Holder, the holder's children, release blockers. |
| `createBudget` | `spend_create_budget` | Create a request budget (see [Request budgets](#request-budgets)). |
| `budgetReserve` | `spend_budget_reserve` | Check-and-reserve against a request budget, then its pool. |
| `closeBudget` | `spend_budget_close` | Close a budget to `request` reservations, with a contract stop code. |
| `budgetStatus` | `spend_budget_status` | Cap, settled, open, committed, available, overrun, closure, and the operations not yet reconciled. |
| `budgetOperations` | `spend_budget_operations` | Every operation the budget admitted, settled and reconciled ones included. |

`budgetSpend(spend, budgetKey, role)` returns a `Spend` whose `reserve` calls `budgetReserve` for that budget and role; every other method is the wrapped one's. Code that takes a `Spend`, such as a copy runner, runs unchanged under a budget.

`createFactoryRecords({ client, schema, clock })` returns the factory records API (see [Factory records](#factory-records)). It takes the same options as `createSpend`, and its calls follow the same rules: one statement each, refusals returned, infrastructure errors thrown, nothing retried.

Request and result field names are the snake_case names in `src/types.ts` and `src/factory.ts`. They are the same JSON documents the database functions accept and return.

## Calling the database operations from another language

- **Write operations:** `SELECT <schema>.<function>($1::jsonb, $2::text)::text`. `$1` is the JSON request, and `$2` is the event time as a UTC RFC3339 string ending in `Z`.
- **Read operations:** `SELECT <schema>.<function>($1::jsonb)::text`.

Each returns one JSON document: `{"ok": true, ...}` or `{"ok": false, "code": "...", "detail": "..."}`. Amounts, and quantities in halt observations, are decimal strings, so they must be parsed exactly. Calls must run under READ COMMITTED (Postgres's default); every write operation raises an error under any other isolation level.

## Money, identifiers and times

- **Money** is integer micro-USD (1 USD = 1,000,000), stored as `bigint` and never negative.
  - Every amount and quantity in a request is a JSON integer from 0 to 9,007,199,254,740,991.
  - Fractions, negatives, NaN, Infinity, numeric strings, bigints and larger values are refused.
  - Products and sums use `numeric` in the database.
- **Prices** are `{ microusd, per_units }`, a non-negative integer per positive integer block of units. A line's worst case is `ceil(limit × microusd ÷ per_units)`, computed exactly as `div(limit × microusd + per_units − 1, per_units)`.
- **Hashes:** `operation_id`, `payload_hash`, `task_revision`, `project_policy_sha256`, `runtime_profile_sha256`, `rate_sheet_sha256` and evidence hashes are 64 lowercase hexadecimal characters.
- **IDs:** project, batch and execution IDs are lowercase UUID strings.
- **Keys:** pool, allocation and slot keys are lowercase letters, digits and hyphens.
- **Labels:** service, kind and provider are lowercase letters, digits, `.`, `_` and `-`, at most 64 characters.
- **Call names** use the shared schema's `CallName` pattern, `^[a-z0-9._-]+(?::[a-z0-9._-]+)*$` (segments joined by `:`, such as `writer.issue:cand-17:3`), at most 128 characters. Migration `0005_call_name.sql` gives the column its own domain, and a unit test checks that its pattern equals the one in `packages/schema/schema/records.schema.json`.
- **Roles:** `actor_role` is a role label (`owner`, `operator`, or a component such as `workflow`), never a person's name, account or email.
- The package validates all of these formats. It computes no hash or ID; callers supply them.
- **Times** at the API boundary are UTC RFC3339 strings ending in `Z`. Events are ordered by one database sequence, never by time.
- `UsageSettlement` and `ManualReconciliation` carry `schema_version` 1. Any other version, and any unknown field, is refused. Every other request is also refused when it has an unknown or missing field.
- `null` means unknown only where a field is documented as nullable. Missing or null usage never means zero.

## Invariants

- **Insert-only.** Every table is insert-only: a trigger rejects UPDATE, DELETE and TRUNCATE. Current state is derived from the rows: an operation's state, the slot holder, pool totals and whether new work is halted. No current-state row is kept.
- **Writes only through the functions.** Every table, `applied_migrations` included, has a BEFORE INSERT trigger that refuses the row unless the transaction-local setting `rbw.spend_api` is `on`. Only the writing entry points turn it on. Each one calls `set_config('rbw.spend_api', 'on', true)` on entry, runs its body (`spend_<name>_body`), and sets the previous value back before it returns, so a direct INSERT later in the same transaction is still refused. If the body raises an error, the transaction is aborted; rolling back to a savepoint taken before the call (or a PL/pgSQL exception handler around it) undoes the `set_config` with the rest of the call, so the guard is off again. Calling a `_body` function directly writes nothing, because the guard is off. A SET clause on the functions is not used: attaching a custom parameter such as `rbw.spend_api` to a function needs superuser privileges, and the owner role of a hosted database is usually not a superuser. A direct INSERT from a session that did not go through a function is refused with `table <name> accepts rows only through the spend database functions`. The rules that free money or the slot, and the halt, are checked inside the functions, so this guard is what stops a direct INSERT from bypassing them.
- **Limits of the guards.** The tables, triggers and functions belong to the role that runs `migrate`; there is no separate owner role and no REVOKE. A role that owns the schema can still turn the setting on itself, set the event sequence, or alter, disable or drop the triggers and functions, so neither the insert-only rule nor the function-only rule holds against it. These guards stop direct writes by application code, not a deliberate change by the schema owner. A separate migration owner and a runtime role limited to EXECUTE on the entry points is not part of this package.
- **Halt race (accepted, known limit).**
  - *What can happen.* The halt check in reservations and in the `prepared → launching` transition does not take the lock that over-envelope observations and resumes take. A reservation or launch in one pool that runs at the same moment as an over-envelope settlement in another pool can therefore succeed just after the halt has committed.
  - *Bound.* At most the reservations and launches already past their halt check when the halt commits. Each is still limited by its pool's cap and its own worst-case reservation. The race does not let spend exceed a pool's cap.
  - *How to notice.* This read-only query lists operations reserved or launched after the event sequence of the first observation of the current halt (the first observation newer than the latest resume). It returns no rows when nothing is halted or nothing slipped through.

    ```sql
    WITH first_halt AS (
      SELECT min(seq) AS seq
      FROM halt_observations
      WHERE seq > coalesce((SELECT max(seq) FROM halt_resumes), 0)
    )
    SELECT 'reserved' AS what, s.operation_id, s.seq
    FROM spend s, first_halt f
    WHERE s.kind = 'reserve' AND s.seq > f.seq
    UNION ALL
    SELECT 'launched', e.operation_id, e.seq
    FROM operation_events e, first_halt f
    WHERE e.to_state = 'launching' AND e.seq > f.seq
    ORDER BY seq;
    ```

  - *What to do.* Settle those operations normally, or reconcile them, then resume as usual. If it ever matters, the fix is to have admissions take the same lock in shared mode.
- **Nothing expires.** No lease, TTL, heartbeat, timer or schedule frees a reservation or the slot. Caps are cumulative and are never reset or replenished. A test advances the clock by a year and shows a held slot and an open reservation unchanged.
- **Committed and available.** Committed = settled + open (open includes amounts retained for unknown usage), per pool and per allocation. Available = cap (or allocation limit) − committed. It can go negative after an overrun, and then every reservation is refused.
- **Allocations.** Allocation limits always sum to the cap (a constraint trigger checked at commit).
- **Ledger.** A ledger row always uses its operation's pool and allocation. The reservation equals the envelope's worst case. Per operation, nothing closes more than was reserved, and nothing is released beyond what was closed.
- **Operation history.** An operation's state events form one linear chain; each event names its predecessor, and a uniqueness constraint stops concurrent forks. Only the allowed state pairs exist. An operation enters `launching` at most once (a unique index).
- **Slot history.** Slot events form one linear chain per key. A trigger allows an acquire only when the slot is free, and a release only by the holder when nothing blocks it.
- **One operation ID at a time.** Reservations of one operation ID take a transaction-scoped advisory lock on it, so two first reservations of the same ID on different pools run one after the other: the later one returns the replay or `operation_conflict`.
- **Attempts.** A later attempt needs its predecessor, one ordinal lower, to be `terminal` or `reconciled`. This is checked by a trigger as well as by `reserve`.

### Who may act

| Action | Roles |
| --- | --- |
| Pool creation, slot key creation, cap raise | `owner` |
| Transfer, resume, reconciliation, operator release | `owner` or `operator` |
| Reserve, transitions, settlement, acquire, child records and confirmations, holder release | any role label |

A request from a role that may not perform the action is refused with `invalid_request`. Authenticating the caller is outside this package.

## Pools, allocations and caps

- **Allocations.** A reservation against a pool with allocations names exactly one allocation, and its worst case must fit both that allocation and the pool cap. A reservation against a pool without allocations names none. Otherwise the result is `unknown_allocation`.
- **Transfer.** The only transfer moves a positive amount from `public` to `judge` in `judge-demo`, up to `public`'s available amount. It takes the same pool lock as `reserve`. A table constraint makes every other transfer impossible, and the operation refuses one with `transfer_refused`. Anonymous use can therefore never draw on the judge allocation.
- **Caps.** A pool without allocations may be raised by an owner, with a reason, and never lowered. A pool with allocations refuses every cap change. Refusals use `cap_change_refused`.

## The priced envelope

Each line has `service`, `unit`, `limit`, `enforced_by` and `price` (`{ microusd, per_units }` or `null`). Lines cover every billable component: both token directions, calls and retries, compute (size × time limit), billing minimums, and fixed allowances such as shutdown, hosting and storage.

**Units** (table `units`):

| Unit | Meaning |
| --- | --- |
| `input_token` | Model input tokens |
| `output_token` | Model output tokens |
| `call` | Provider calls, retries included |
| `creation` | Resource creations |
| `step` | Agent or workflow steps |
| `operation` | Provider operations billed per request |
| `credit` | Provider credits |
| `vcpu_second` | Compute: vCPU count times seconds |
| `memory_gb_second` | Compute: memory in GB times seconds |
| `byte` | Stored or transferred bytes |
| `allowance` | One unit per fixed allowance |

**Enforcement methods** (table `enforcement_methods`):

| `enforced_by` | Meaning |
| --- | --- |
| `request_parameter` | A request parameter caps the quantity (for example a max token setting) |
| `client_counter` | The caller counts and stops at the limit (for example calls and retries) |
| `provider_timeout` | A provider-side timeout bounds the duration |
| `provider_quota` | A provider-side quota or spend limit bounds the quantity |
| `fixed_allowance` | A fixed amount set aside, not metered per unit |

Both lists are closed and enforced by foreign keys. Additions are proposed through the inbox and added by a new migration.

**Refusals that write nothing:**

| Code | Cause |
| --- | --- |
| `unknown_price` | A null or malformed price; a missing, empty or malformed `service`; or a `unit` that is missing, empty or not on the list |
| `unenforceable_limit` | A missing, null, negative, fractional or out-of-range `limit`; or an `enforced_by` that is missing or not on the list |
| `invalid_request` | An empty envelope, a repeated (service, unit) pair, or a total above the safe range |

When several lines are bad, `unknown_price` is checked across all lines first, then `unenforceable_limit`. The database computes the worst case; a caller's total is never accepted.

## Check-and-reserve

`reserve` runs one database function. It locks the pool row (`SELECT … FOR NO KEY UPDATE`, which serializes callers without blocking foreign-key checks) and reads every total in later statements, so under READ COMMITTED it sees a reservation committed while it waited. Concurrent calls on one pool therefore behave as if they ran one at a time. In order:

1. **Validation:** formats and fields (`invalid_request`), then the envelope (`unknown_price`, `unenforceable_limit`, `invalid_request`), then `unknown_pool` and `unknown_allocation`.
2. **Existing `operation_id`:** with an identical request, it returns the existing reservation and the operation's current state with `replay: true`, and writes nothing. Otherwise it returns `operation_conflict`.
3. **Earlier attempt:** if `attempt_ordinal` > 1 and `previous_operation_id` does not name an operation one ordinal lower that is `terminal` or `reconciled`, it returns `previous_attempt_unresolved`.
4. **Halt:** if new work is halted, it returns `pool_halted`.
5. **Funds:** if the worst case exceeds the pool's or the allocation's available amount, it returns `insufficient_funds`. Equality fits.
6. **Insert:** otherwise it inserts the operation's intent (state `prepared`), its envelope lines and a reservation of the whole worst case. It returns the reservation and the remaining available amounts.

`insufficient_funds` and `pool_halted` refusals are recorded in `reservation_refusals` with the requested worst case and the available amounts at that moment. Refusals create no operation and no reservation. An open reservation counts at its full worst case until settlement or manual reconciliation.

## Operation states

The states are `prepared → launching → running → terminal → reconciled`, plus `uncertain`.
- An operation starts in `prepared` when it is reserved.
- Each later state is an insert-only event recording its time and acting role.
- A transition names `from_state`, which must be the current state; otherwise the result is `invalid_transition`, naming the current state.

| Transition | Requires | Effect |
| --- | --- | --- |
| `prepared → launching` | `slot_key` held by the operation's root | Refused in order: `invalid_transition`, `pool_halted`, `unknown_slot`, `slot_not_held`. Recorded before the external call. |
| `launching → running` | `provider_resource_id` | The resource becomes a child resource of the root under the slot. |
| `launching → terminal`, `running → terminal` | `terminal_status` (`completed`, `failed`, `cancelled`) | Confirms the operation's own child resources as terminal. |
| `launching → uncertain`, `running → uncertain` | `uncertainty` (`lost_response`, `unknown_status`) | Only manual reconciliation leaves `uncertain`. |

- A `prepared` operation leaves `prepared` only through `launching`, or through a reconciliation with decision `confirm_no_launch`. There is no withdrawal or cancel action.
- `terminal → reconciled` happens through settlement with all usage known, or through reconciliation.
- Nothing else changes state, and no transition is triggered by time.

## Settlement

`settle` takes a `UsageSettlement` and is accepted only in `terminal` (otherwise `invalid_transition`). It needs no slot.

**Matching.** These mismatches return `invalid_request`:
- The two hashes and `reserved_microusd` must equal the reservation's.
- `service_lines` must match the envelope's (service, unit) pairs one to one.
- `usage_state` must be `known` when no `actual_microusd` is null, `unknown` when all are, and `partly_unknown` otherwise.
- A known line retains 0. An unknown line retains exactly its full worst case.

**Effect.**
- Settled spend increases by the known amounts.
- Unknown lines stay committed as an open retained amount.
- The rest of the reservation is released (never a negative release).
- With `usage_state` `known`, the operation becomes `reconciled`. Otherwise it stays `terminal` with its retained amount, which only a manual reconciliation resolves.

**Repeats.** A repeat with identical content returns the first settlement and writes nothing. Different content returns `already_settled`.

Per-trial or per-step cost figures recorded elsewhere are diagnostics; they are never added to pool totals.

## Over-envelope halt

An over-envelope observation is any of these:
- a known amount above its line's worst case;
- an actual quantity above its line's limit;
- a reconciliation whose evidenced usage exceeds the open amount.

The spend is still recorded in full. The observation halts new work in every pool: new reservations and `prepared → launching` are refused with `pool_halted`. A refused reservation is recorded; a refused launch writes nothing.

New work is halted while any observation is newer, by sequence, than the latest resume. One resume therefore clears every earlier observation, and a resume while nothing is halted is refused (`invalid_request`).

Settlement, all other transitions, reconciliation, transfers, cap raises, child records, and slot acquisition and release keep working while halted.

## Serial execution slot

- **Keys.** There is one slot per slot key. Slot keys are created by an owner and start free. Every slot action on a key that was never created is refused with `unknown_slot`, and so is `prepared → launching`.
- **Holder.** The holder is a root execution ID, and the database allows at most one holder per key.
- **Acquire.** Acquire succeeds when the slot is free. A repeat by the holder returns the existing hold (`replay: true`) and writes nothing. Any other root is refused at once with `slot_held`: no waiting, queueing or retry. Children act under their root and never acquire.
- **Children.**
  - While holding the slot, the root records each child resource (provider, resource ID, owning operation or execution, kind), and later its confirmed terminal state with evidence.
  - Repeating either record with the same values is harmless and writes nothing. A repeated confirmation with a different terminal status, evidence or actor role is refused with `confirmation_conflict`, and the stored confirmation stays as it was.
  - Recording for a root that does not hold the slot is refused with `slot_not_held`.
- **Release.** The holder can release the slot, or an owner or operator can, with evidence and a reason. Release is allowed only when every child resource of that root, under any slot key, has a confirmed terminal state, and no operation of that root is `prepared`, `launching`, `running` or `uncertain`. Otherwise it is refused with `slot_release_blocked`, listing the blocking resources (each with the slot key it is confirmed under) and operation IDs. Release is the only way the slot becomes free.

## Request budgets

A request budget caps what one factory request commits, on its own pool. It is bound to the request's root execution, and every operation it admits is recorded in `budget_operations` with a role:

- **`request`:** an operation of the request itself. Its root must be the budget's root.
- **`validation`:** an operation of a validation run of one of the request's cases. Its root is the run's own root: never the budget's root, never any other budget's root, never a root already charged to another budget, and never the root of another request's recorded validation run. A run need not be recorded before its reservation (a run is recorded only after its reservation succeeds). Budget creation, validation reservations and validation records take one lock per root, so these checks see each other's concurrent writes.

**Money.** The budget's committed amount is settled plus open over all its operations, whatever their root or role; available = cap − committed. Creating a budget holds nothing in the pool: the pool counts only what the budget's operations commit, like any other reservation. A settlement above an operation's worst case still records the spend in full, so committed can exceed the cap: `budgetStatus` then reports `overrun: true` and a negative `available_microusd`, and every later budget reservation is refused.

**`createBudget`** takes `budget_key`, `root_execution_id`, `pool_key`, `cap_microusd` (at least 1), `pool_required_microusd` and `actor_role`.
- An identical request replays (`replay: true`) and writes nothing. Another request with the same key, or another key on the same root, is refused with `idempotency_conflict`.
- `judge-demo` is refused (`invalid_request`, and a table constraint), as is any pool with allocations; an unknown pool is `unknown_pool`.
- A root that already has operations, or is a recorded validation run's root, is refused (`invalid_request`): reservations made before the budget would never count against it.
- When it is first created, the pool's available amount must cover `pool_required_microusd` (for a factory request, the worker's worst case), and new work must not be halted. Otherwise it is refused with `insufficient_funds` or `pool_halted`, and nothing is recorded.

**`budgetReserve`** takes `{ budget_key, role, reservation }`, where `reservation` is a `ReserveRequest` on the budget's pool. In order:

1. **Validation:** the request and the whole reservation (`invalid_request`).
2. **Existing `operation_id`,** under the same per-operation lock as `reserve`: the replay when it is this budget's operation with the same role and an identical reservation, otherwise `operation_conflict`. This comes before any closed or cap check, so a replay after the budget is full or closed still returns the replay and records no refusal.
3. **Budget lock:** the budget row is locked (`FOR NO KEY UPDATE`), so concurrent budget reservations and a close run one at a time. `unknown_budget` if it does not exist.
4. **Pool and root:** the reservation's pool must be the budget's, and its root must fit the role (`invalid_request`).
5. **Envelope:** priced as for `reserve` (`unknown_price`, `unenforceable_limit`, `invalid_request`).
6. **Closed:** a closed budget refuses `request` reservations with `budget_closed`. It still admits `validation` reservations within its remaining room.
7. **Budget room:** a worst case above the budget's available amount is refused with `budget_exhausted`. Equality fits.
8. **Pool:** otherwise the existing reservation body runs (halt, earlier attempt, pool funds, insert), and the admitted operation is recorded in `budget_operations`. Its refusals are its own (`pool_halted`, `insufficient_funds`, ...), recorded in `reservation_refusals`.

`budget_closed` and `budget_exhausted` are recorded in `budget_refusals` with the role, the requested worst case and the budget's available amount, and return `requested_microusd` and `budget_available_microusd`. Lock order is operation, budget, pool. Settlement and reconciliation take pool then operation and never a budget, so the orders do not invert.

**`closeBudget`** takes `budget_key`, `cause` (one of the contract stop codes: `fulfilled`, `budget_exhausted`, `time_limit`, `candidate_limit`, `sources_exhausted`, `cancelled_by_user`, `worker_lost`, `needs_reconciliation`, `operational_error`) and `actor_role`. A repeat with the same cause replays; another cause is refused with `idempotency_conflict`. Closing leaves open operations open; they settle and reconcile as usual.

**Reads.** `budgetStatus` returns the cap, settled, open, committed and available amounts, `overrun`, `closed` (`{ cause, closed_at }` or null) and the operations not yet reconciled. `budgetOperations` returns every operation the budget admitted. Each operation has its ID, role, root and execution IDs, kind, call name, attempt ordinal, state, reserved and open amounts, `settled_microusd` (null until a settlement, or a reconciliation that settles, is recorded) and `reserved_at`.

## Factory records

The factory tables hold a request's durable progress. Every write is idempotent by key: the same key with the same content replays (`replay: true`) and writes nothing, and the same key with other content is refused with `idempotency_conflict`. Times in results are UTC ISO 8601 strings with milliseconds and `Z`, taken from the API clock.

| Function | Database operation | Purpose |
| --- | --- | --- |
| `acceptRequest` | `factory_accept_request` | Create the budget, record the request and append `request_accepted` (event key `request_accepted`, seq 1) in one transaction. A refusal from any step leaves nothing behind, so a refused start can be sent again with the same IDs. |
| `recordRequest` | `factory_record_request` | Record a request: `request_id`, `request_sha256`, the frozen `interpretation` (its `interpretation_sha256` field must equal `interpretation_sha256`), `budget_key` (an existing budget no other request uses), `root_execution_id` (the budget's root) and `factory_profile_sha256`. |
| `readRequest` | `factory_request_read` | The request, its events with `seq > after` (at most `limit`, 1 to 1000), `next_after`, `last_seq`, `last_event_at`, the request's `last_heartbeat_at`, its stop, its evidence (case, hash, time) and its validation runs. `unknown_request` if it was never recorded. |
| `appendEvent` | `factory_append_event` | Append one contract event (`type`, `host_id`, `candidate_id`, `item_key`, `case_id`, `message`, `data`) with a deterministic `event_key`; returns its `seq` and `at`. A message is plain text of at most 2,000 characters: tabs and line breaks are allowed, other control characters are not. |
| `recordHeartbeat` | `factory_record_heartbeat` | Record a worker heartbeat for the request (`validation_id` null) or one of its validation runs. Heartbeats are never events. |
| `recordStop` | `factory_record_stop` | Record the request's stop request (one per request, keyed by request; `actor_role` is its content). |
| `recordEvidence` | `factory_record_evidence` | Store a case's evidence as exact JSON text with the SHA-256 of its UTF-8 bytes, which the database checks. |
| `readEvidence` | `factory_evidence_read` | The evidence text, byte for byte. `unknown_evidence` if none is stored. |
| `recordValidation` | `factory_record_validation` | Record a validation run: `validation_id`, `request_id`, `case_id` and its own root. The ID is scoped to the request and case: the same ID on another request or case is `idempotency_conflict`. The root may not be a budget's root, another run's root, or a root whose reservations are charged to another request's budget. |
| `readValidation` | `factory_validation_read` | A run by ID alone (with its request and case), its events after `after` and its `last_heartbeat_at`. `unknown_validation` if it was never recorded. |
| `appendValidationEvent` | `factory_append_validation_event` | Append a run's event (`type`: lowercase letters, digits and underscores; `data`: an object) with an event key. |
| `readRoot` | `factory_root_read` | The request, or the validation run and its request, that a root execution belongs to, for example the factory slot's holder. |

- **Event numbering.** A request's events are numbered from 1 with no gaps. The append function computes the next number under a lock on the request's row, so concurrent writers (the worker, the stop and status routes) get consecutive numbers; a trigger and a primary key on `(request_id, seq)` refuse any other. A validation run's events follow the same rule under its own row.
- **Event keys** are segments of lowercase letters, digits, `.`, `_` and `-` joined by `:` (at most 256 characters), unique per request. A replay compares every field of the event.
- **First and last events.** `request_accepted` is a request's first event and only its first; a request's first event is always `request_accepted`. After `request_finished`, only `budget_updated`, `attention`, `attention_cleared`, `validation_started` and `validation_finished` are appended; any other type, a second `request_finished` included, is refused with `event_not_allowed`. An existing key still replays.
- **Stored documents come back as stored.** Event data, validation event data and the interpretation are returned exactly as written; only a result's own amounts (for example a refusal's) become bigints.
- **Event types** are the contract's list (`bug-request/1`, section 8.4), and closure causes are its stop codes; a unit test compares both lists with `@rbw/factory-contract`.
- **Order of writes for a validation run.** Check the ID with `readValidation` first, take the slot under the run's root, reserve with role `validation`, and only then record the run, so a refused run records nothing. Each call replays, so repeating the same sequence after an interruption completes it.

## Refusal codes

| Code | Meaning |
| --- | --- |
| `invalid_request` | Malformed, missing or unknown field; a role not permitted for the action; a mismatch with the reservation; a money rule broken; a resume while nothing is halted |
| `unknown_pool` | The pool key does not exist |
| `unknown_allocation` | The allocation does not belong to the pool, or the request names one when the pool has none (or the reverse) |
| `unknown_operation` | The operation ID does not exist |
| `unknown_price` | An envelope line cannot be priced (see the envelope section) |
| `unenforceable_limit` | An envelope line's limit or enforcement method is unusable |
| `insufficient_funds` | The worst case exceeds the pool's or allocation's available amount |
| `pool_halted` | New work is halted after an over-envelope observation |
| `operation_conflict` | The operation ID exists with a different request |
| `confirmation_conflict` | The child resource already has a confirmation with a different terminal status, evidence or actor role |
| `previous_attempt_unresolved` | The previous attempt is not `terminal` or `reconciled` |
| `invalid_transition` | The current state does not allow the action; the result names `current_state` |
| `already_settled` | A different settlement was already recorded |
| `slot_held` | Another root holds the slot |
| `slot_not_held` | The root does not hold the slot |
| `slot_release_blocked` | Unconfirmed children or unresolved operations block the release |
| `unknown_slot` | The slot key does not exist |
| `transfer_refused` | Any transfer other than `public → judge` in `judge-demo` within `public`'s available amount |
| `cap_change_refused` | A lower or equal cap, or any cap change on a pool with allocations |
| `budget_exhausted` | The worst case exceeds the request budget's available amount |
| `budget_closed` | A `request` reservation on a closed budget |
| `unknown_budget` | The budget key does not exist |
| `idempotency_conflict` | A budget, closure, request, event key, stop, evidence or validation run exists under the same key with other content |
| `unknown_request` | The factory request (or the root's owner) does not exist |
| `unknown_validation` | The validation run does not exist, or belongs to another request |
| `unknown_evidence` | The request has no evidence for the case |
| `event_not_allowed` | An event type that may not follow `request_finished`, or a `request_accepted` that is not the first event (or a first event that is not `request_accepted`) |

## Caller protocol

1. **Acquire the slot first.** Acquire the slot for the root execution before its first reservation, so a `slot_held` refusal never leaves a reservation behind.
2. **Reserve when ready.** Reserve each operation only when it is ready to launch.
3. **Record `launching` before the external call** (`prepared → launching`, naming the slot key).
4. **Record the outcome.** Record `running` with the provider resource ID, then `terminal` with the provider's status, or `terminal` directly for a synchronous call. Then settle with the usage you know; never report missing usage as zero.
5. **Record a lost response as `uncertain`.** Do not guess.
6. **Stop on any refusal without retrying.** Stop when an infrastructure error leaves the outcome unknown too. `reserve` and `settle` are idempotent, so repeating the identical request is the safe way to learn the outcome of a call whose response was lost.
7. **Release the slot** when nothing blocks it (`slotStatus` lists the blockers).

## Operator procedures

All three procedures are recorded actions by an `owner` or `operator`, with evidence (one or more `{ key, sha256 }`) and a non-blank reason. There is no other way to free an orphaned reservation or slot, and no free-form clear action.

### Manual reconciliation

1. **Read the current state.** Call `operationStatus`. The open amount is what the operation still holds: the whole reservation before settlement, or the retained amount after a partly or wholly unknown settlement.
2. **Gather evidence.** Collect the provider's records for the operation (console export, invoice line, resource listing), store them, and note each file's key and SHA-256.
3. **Record the decision with `reconcile`.** Set `previous_state` to the state you read; if it changed meanwhile, the call is refused with `invalid_transition` and you start again.

| Decision | Allowed from | Effect |
| --- | --- | --- |
| `found_running` | `launching`, `uncertain` | The operation becomes `running`. List at least one resource ID; each becomes a child of the root. Retained = open amount, released = 0. |
| `confirm_no_launch` | `prepared`, `launching`, `uncertain` | The operation becomes `reconciled`. List no resources. Released = the whole open amount and retained = 0, unless the evidence shows a charge. |
| `accept_complete` | `launching`, `running`, `uncertain`, `terminal` | The operation becomes `reconciled`. Listed resources are recorded as confirmed terminal. A later settlement is refused. |
| `confirm_stopped_incomplete` | `launching`, `running`, `uncertain`, `terminal` | As `accept_complete`, for work that stopped before completing. |

For the three closing decisions:
- Retained (kept as settled spend) + released (returned to the pool) must equal the open amount.
- If the evidenced usage exceeds the open amount, set retained to that usage and released to 0. This records an over-envelope observation and halts new work.
- If usage still cannot be established, retain the whole open amount.

**Closing a `prepared` operation that will not be launched.** Record `confirm_no_launch` with `previous_state: "prepared"`, an empty `provider_resource_ids`, `retained_microusd: 0` and `released_microusd` equal to the reservation. The operation becomes `reconciled`, the reservation returns to the pool, and the operation no longer blocks its root's slot release.

### Resume after an over-envelope halt

1. Call `haltStatus` to list the observations since the latest resume.
2. Investigate each one: the envelope that was exceeded, and why its limit did not hold.
3. Record `resume` with evidence and a reason. One resume clears every listed observation; a later observation halts new work again.

### Slot release by an operator

1. Call `slotStatus` to see the holder, its children and the release blockers.
2. Resolve each blocker:
   - an unresolved operation, through manual reconciliation;
   - an unconfirmed child resource, through `confirmChild` under the slot key the blocker names, with the provider's terminal-state evidence (the root still holds that slot, so this works).
3. Call `releaseSlot` with the holder's `root_execution_id`, `actor_role` `owner` or `operator`, evidence and a reason.

### Operator command

Run `pnpm --filter @rbw/spend run operator <command> [options]` with `DATABASE_URL` configured. Every command accepts `--schema <name>` (default `public`, a lowercase SQL identifier). The command connects once, with a 15-second connection timeout, and never retries. It does not print connection details or operation intents.

| Command | Options |
| --- | --- |
| `status` | `[--root <uuid>] [--json]` |
| `reconcile` | `--operation <id> --from <state> --decision <decision> --retained <microusd> --released <microusd> --evidence <file>... --reason <text> [--resource <id>...] [--apply]` |
| `confirm-child` | `--slot <key> --root <uuid> --provider <label> --resource <id> --status completed\|failed\|cancelled --evidence <file> [--apply]` |
| `release-slot` | `--slot <key> --root <uuid> --evidence <file>... --reason <text> [--apply]` |
| `resume` | `--evidence <file>... --reason <text> [--apply]` |

`status` reads one repeatable-read, read-only snapshot and ends with a rollback. It shows the halt and observations since the latest resume, every pool and allocation, and every slot key with its holder, latest event time and role, holder age in seconds, children and release blockers. It lists every non-`reconciled` operation in creation order, with its root, kind, call name, provider, pool, allocation, recorded time and amounts. `--root` also includes that root's operations in every state and its slot events. Event order follows the ledger sequence, even when timestamps run backward. Text amounts are integer micro-USD and USD; JSON amounts are decimal strings.

Operations of a run that is still going also appear in the non-`reconciled` list. Compare an operation's root with the slot holder and its age before closing it. The command cannot tell whether a run is still executing, and age alone does not show it: one operation can stay `running` for hours. Before `reconcile` or `release-slot`, confirm from the holder's age in `status` and from the run's own record that the run's process or container has ended. A holder between two operations has no release blockers, so `release-slot` would free the slot under a live run.

Write commands default to a dry run: they read and print the current state, check the preconditions below, and print the exact request document without writing. Add `--apply` to send that request through the matching library call, print the result and re-read the affected status. All requests use `actor_role: "operator"`; the database decides which actions are allowed. A dry run does not ask the database to validate a write and does not promise that an apply will succeed.

- `reconcile` requires the current state to match `--from`. Decisions and allowed states are listed under [Manual reconciliation](#manual-reconciliation). Amounts must be integers from 0 to 9007199254740991. `found_running` needs at least one resource, retained equal to open spend and released 0; `confirm_no_launch` lists no resources. Closing decisions need retained + released equal to open spend, or released 0 with retained above open spend. The latter is evidenced over-envelope usage: both dry run and apply warn that it halts new work, and a successful over-envelope apply also prints the halt status. The request uses schema version 1 and a UTC recorded time.
- `confirm-child` requires the named root to hold the slot and the provider/resource pair to be listed among its children. It prints that child, including its confirmation and terminal status. An already confirmed child reaches the database for replay or conflict handling. It takes exactly one evidence file.
- `release-slot` requires the named root to hold the slot and no release blockers.
- `resume` requires new work to be halted. Investigate every observation before recording the resume.

Repeat `--evidence <file>` for each evidence file. Each becomes `{ "key": "<path exactly as typed>", "sha256": "<lowercase SHA-256 of the file bytes>" }`. Missing or unreadable files fail before any database read. Under `pnpm --filter`, relative evidence paths resolve from `packages/spend`; the stored key and the dry run use the path exactly as typed. Keep the evidence at that key so the recorded hash can be checked later.

Examples use synthetic identifiers and evidence paths relative to the package directory. Replace them with the operation, root and evidence from the records being investigated. Write examples preview the request; inspect it before repeating with `--apply`.

```sh
pnpm --filter @rbw/spend run operator status --root 00000000-0000-4000-8000-000000000001
pnpm --filter @rbw/spend run operator reconcile --operation 0000000000000000000000000000000000000000000000000000000000000001 --from terminal --decision accept_complete --retained 1000 --released 0 --evidence synthetic-evidence/usage.json --reason "Synthetic completed usage"
pnpm --filter @rbw/spend run operator confirm-child --slot synthetic-slot --root 00000000-0000-4000-8000-000000000001 --provider synthetic-provider --resource synthetic-resource --status completed --evidence synthetic-evidence/terminal.json
pnpm --filter @rbw/spend run operator release-slot --slot synthetic-slot --root 00000000-0000-4000-8000-000000000001 --evidence synthetic-evidence/ended.json --reason "Synthetic process ended; all blockers resolved"
pnpm --filter @rbw/spend run operator resume --evidence synthetic-evidence/investigation.json --reason "Synthetic envelope corrected"
```

For piped or JSON output use `pnpm --silent --filter @rbw/spend run operator status --json`, or run `node src/operator-cli.ts status --json` from `packages/spend`. Without `--silent`, pnpm prints a banner on stdout before the command's output, which includes the package's path.

Exit codes: **0** for completion or a valid dry run; **1** for a ledger refusal or failed pre-check; **2** for usage errors, unset `DATABASE_URL`, failed connections or infrastructure errors. Refusals print the code, detail and any blocking IDs returned by the ledger. On a connection failure, the command prints only the error code and says it can be run again.

## Tables

| Table | Holds |
| --- | --- |
| `pools`, `pool_allocations`, `pool_cap_changes`, `allocation_transfers` | Pools, allocations, cap history, transfers |
| `operations`, `operation_lines` | Immutable operation intent and frozen envelope |
| `operation_events` | State transitions |
| `spend` | The ledger: `reserve`, `close`, `settle` and `release` rows |
| `settlements`, `reconciliations` | Recorded settlements and manual reconciliations |
| `reservation_refusals` | `insufficient_funds` and `pool_halted` refusals |
| `halt_observations`, `halt_resumes` | Over-envelope observations and resumes |
| `execution_slot`, `slot_events`, `slot_children`, `slot_child_confirmations` | Slot keys, acquire/release events, child resources and their confirmations |
| `units`, `enforcement_methods` | The closed lists |
| `budgets`, `budget_operations`, `budget_closures`, `budget_refusals` | Request budgets, the operations each admitted, closures and refused budget reservations |
| `factory_requests`, `factory_events` | Factory requests with their frozen interpretation, and their numbered events |
| `factory_heartbeats`, `factory_stops`, `factory_evidence` | Worker heartbeats, stop requests, per-case evidence text |
| `factory_validations`, `factory_validation_events` | Validation runs and their numbered events |
| `applied_migrations` | Applied migration files and checksums |

In `reconciliations`, `recorded_at` is the time given in the record, and `logged_at` is the event time.

## Tests

- **Unit tests:** `test/unit`, PGlite, a fresh schema per test.
- **Integration tests:** `test/integration`, real Postgres:
  - I1: forced-overlap race on check-and-reserve;
  - I2: burst of eight reservations;
  - I3: unknown price;
  - I4: missing usage;
  - I5: forced-overlap slot acquisition;
  - forced-overlap reuse of one operation ID on two pools;
  - request budgets: two forced-overlap budget reservations on one budget, a burst of eight, a reservation against a close in both orders, and a budget reservation against a plain reservation on the same pool;
  - concurrent event appends from eight connections, which get consecutive sequence numbers;
  - concurrent first runs of `migrate` on one schema;
  - the operator command: a read-only `status` snapshot, a `reconcile` dry run that writes nothing, and `release-slot --apply`;
  - the insert guard: a direct INSERT after an entry function in the same transaction, an entry function that raises an error, and a rollback to a savepoint before it;
  - that the connection's role is not a superuser, as the hosted owner role is not, so a statement that needs superuser privileges fails here too;
  - a failed setup that drops its schema.

  Setup errors name only `DATABASE_URL` and a driver error code, never the host, port, user, database or password.

  To run them against a local Postgres, connect as a role created with `LOGIN` and without `SUPERUSER` that owns the test database (`CREATE DATABASE <name> OWNER <role>`). Connected as a superuser, the role test fails.

  I1, I5 and the operation ID test hold the first call's transaction open until the second call is observed waiting on a lock in `pg_stat_activity`.

The root `pnpm test` runs only the unit tests. A unit test applies `0001`–`0005`, records the judge-demo pool, its allocations and every function, trigger, column and constraint, applies `0006_factory.sql`, and checks that all of them are unchanged.

## Known limits

- **The spend halt is global.** An over-envelope settlement or reconciliation of a factory operation halts new work in every pool, so it also pauses judge replays (`pool_halted`) until an operator resumes. Detect it with `haltStatus` (or `operator status`); act with [Resume after an over-envelope halt](#resume-after-an-over-envelope-halt).
- **Plain reservations bypass a budget.** Only `budgetReserve` counts against a budget. A plain `reserve` on the same pool, even under a budget's or a validation run's root, is bound by the pool's cap alone and never appears in the budget's totals, so factory code passes `budgetSpend(...)` wherever it hands a `Spend` on. `createBudget` refuses a root that already has operations, but a plain `reserve` does not take the root lock, so one that runs at the same moment as the budget's creation is not caught. Changing `reserve` itself would change an existing function, which this migration does not do.
- **Validation roots.** A `validation` reservation's root, and a recorded validation run's root, are checked against budgets, other budgets' operations and other requests' runs, not against reservations made outside any budget (see the previous item).

## Not in this package

- Operation IDs and payload hashes: callers compute them, through `@rbw/schema`'s identity computations. Rate sheets, their hashes and provider prices are the callers' too: `@rbw/envelope` holds the rate sheet the controller prices its Sandbox jobs from (the judge routes use it too), and the writer, search, screen, solver and harvest-review packages each read a rate file of their own, separate from it, and hash its bytes.
- Expected-trial manifests: `@rbw/schema` records, built by the local runner (`tools/local-runner`). There are no callbacks to authenticate or deduplicate; results are read from record sets (`@rbw/admission`).
- Judge-request precedence for a slot, and a watchdog, are not implemented. Judge replays run under their own `judge` slot key.
- HTTP routes and their authentication: the judge routes in `packages/web`. No Python code calls these operations.
- Creating a deployment's slot keys: the controller's `create-slot-key` (`tools/controller`), an owner action after `migrate`.
