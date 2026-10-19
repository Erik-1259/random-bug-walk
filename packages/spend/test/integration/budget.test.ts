import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromPg } from "../../src/client.ts";
import { createFactoryRecords, type FactoryRecords } from "../../src/factory.ts";
import type { Spend } from "../../src/spend.ts";
import type { Result } from "../../src/types.ts";
import { budgetRequest, event, exactly, recordRequest } from "../factory-helpers.ts";
import { expectOk, hex, reserveRequest, uuid } from "../helpers.ts";
import { openTestDatabase, suffix, waitFor, type TestDatabase } from "./support.ts";

let database: TestDatabase;
let dropDatabase: (() => Promise<void>) | undefined;
let admin: Spend;
let observer: pg.Client;
let n = 0;

beforeAll(async () => {
  database = await openTestDatabase();
  dropDatabase = () => database.drop();
  const connection = await database.connect();
  admin = connection.spend;
  observer = connection.client;
});

// Setup that failed has already dropped its schema and has nothing to drop here.
afterAll(async () => {
  await dropDatabase?.();
});

async function createPool(cap: number): Promise<string> {
  const poolKey = `synthetic-factory-${suffix()}`;
  expectOk(await admin.createPool({ pool_key: poolKey, cap_microusd: cap, allocations: [], actor_role: "owner", reason: "synthetic integration pool" }));
  return poolKey;
}

/** A new budget with cap `cap` on `poolKey`; returns its key and root. */
async function createBudget(poolKey: string, cap: number): Promise<{ key: string; root: string }> {
  n += 1;
  const key = hex(70_000 + n);
  const root = uuid(70_000 + n);
  expectOk(await admin.createBudget(budgetRequest(n, { budget_key: key, root_execution_id: root, pool_key: poolKey, cap_microusd: cap })));
  return { key, root };
}

/** Factory records over one test connection. */
function recordsOn(connection: { client: pg.Client }): FactoryRecords {
  return createFactoryRecords({ client: fromPg(connection.client), schema: database.schema });
}

/** Creates a budget on `poolKey`, records a request on it and appends request_accepted; returns the request ID. */
async function acceptNewRequest(poolKey: string): Promise<string> {
  n += 1;
  const requestId = uuid(71_000 + n);
  expectOk(
    await recordsOn({ client: observer }).acceptRequest({
      budget: budgetRequest(n, { budget_key: hex(70_000 + n), root_execution_id: uuid(70_000 + n), pool_key: poolKey }),
      request: recordRequest(n, { request_id: requestId, budget_key: hex(70_000 + n), root_execution_id: uuid(70_000 + n) }),
      accepted_message: "Request accepted.",
    }),
  );
  return requestId;
}

function operation(poolKey: string, root: string, microusd: number) {
  n += 1;
  return reserveRequest(n, { pool_key: poolKey, root_execution_id: root, execution_id: root, envelope: exactly(microusd) });
}

/** True once a statement calling `fn` in this run's schema is waiting on a lock. */
async function waitingOnLock(fn: string): Promise<boolean> {
  const rows = await observer.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1",
    [`%${database.schema}.${fn}(%`],
  );
  return (rows.rows[0]?.n ?? 0) > 0;
}

/**
 * Runs `first` inside an open transaction on connection A, starts `second` on connection B,
 * waits until B's statement is blocked on a lock in the server (or has already finished),
 * then commits A and returns both results.
 */
async function forcedOverlap<A, B>(
  a: { client: pg.Client; spend: Spend },
  fn: string,
  first: (spend: Spend, records: FactoryRecords) => Promise<Result<A>>,
  second: () => Promise<Result<B>>,
): Promise<{ results: [Result<A>, Result<B>]; secondWaited: boolean }> {
  await a.client.query("BEGIN");
  let firstResult: Result<A>;
  try {
    firstResult = await first(a.spend, recordsOn(a));
  } catch (error) {
    await a.client.query("ROLLBACK");
    throw error;
  }
  let secondDone = false;
  let secondWaited = false;
  const pending = second().finally(() => {
    secondDone = true;
  });
  try {
    await waitFor(async () => {
      secondWaited = await waitingOnLock(fn);
      return secondWaited || secondDone;
    }, "the second call to start on the server");
  } finally {
    await a.client.query("COMMIT");
  }
  return { results: [firstResult, await pending], secondWaited };
}

function outcome(result: Result<unknown>): string {
  return result.ok ? "ok" : result.code;
}

describe("request budgets against a real Postgres", () => {
  it("two budget reservations on one budget at once: exactly one fits, the other is budget_exhausted", async () => {
    const poolKey = await createPool(10_000_000);
    const budget = await createBudget(poolKey, 1_000_000);
    const a = await database.connect();
    const b = await database.connect();
    const { results, secondWaited } = await forcedOverlap(
      a,
      "spend_budget_reserve",
      (spend) => spend.budgetReserve({ budget_key: budget.key, role: "request", reservation: operation(poolKey, budget.root, 600_000) }),
      () => b.spend.budgetReserve({ budget_key: budget.key, role: "request", reservation: operation(poolKey, budget.root, 600_000) }),
    );
    expect(results.map(outcome)).toEqual(["ok", "budget_exhausted"]);
    expect(secondWaited).toBe(true);
    const status = expectOk(await admin.budgetStatus({ budget_key: budget.key }));
    expect(status.committed_microusd).toBe(600_000n);
  });

  it("eight concurrent budget reservations of 300,000 on a 1,000,000 budget: exactly three fit", async () => {
    const poolKey = await createPool(10_000_000);
    const budget = await createBudget(poolKey, 1_000_000);
    const connections = await Promise.all(Array.from({ length: 8 }, () => database.connect()));
    const results = await Promise.all(
      connections.map((c) => c.spend.budgetReserve({ budget_key: budget.key, role: "request", reservation: operation(poolKey, budget.root, 300_000) })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.code === "budget_exhausted")).toHaveLength(5);
    expect(expectOk(await admin.budgetStatus({ budget_key: budget.key })).committed_microusd).toBe(900_000n);
  });

  it("a reservation against a close: the close waits for the reservation, which is admitted", async () => {
    const poolKey = await createPool(10_000_000);
    const budget = await createBudget(poolKey, 1_000_000);
    const a = await database.connect();
    const b = await database.connect();
    const { results, secondWaited } = await forcedOverlap<unknown, unknown>(
      a,
      "spend_budget_close",
      (spend) => spend.budgetReserve({ budget_key: budget.key, role: "request", reservation: operation(poolKey, budget.root, 1000) }),
      () => b.spend.closeBudget({ budget_key: budget.key, cause: "cancelled_by_user", actor_role: "web" }),
    );
    expect(results.map(outcome)).toEqual(["ok", "ok"]);
    expect(secondWaited).toBe(true);
    const status = expectOk(await admin.budgetStatus({ budget_key: budget.key }));
    expect(status.committed_microusd).toBe(1000n);
    expect(status.closed?.cause).toBe("cancelled_by_user");
  });

  it("a close against a reservation: the reservation waits for the close and is refused budget_closed", async () => {
    const poolKey = await createPool(10_000_000);
    const budget = await createBudget(poolKey, 1_000_000);
    const a = await database.connect();
    const b = await database.connect();
    const { results, secondWaited } = await forcedOverlap<unknown, unknown>(
      a,
      "spend_budget_reserve",
      (spend) => spend.closeBudget({ budget_key: budget.key, cause: "cancelled_by_user", actor_role: "web" }),
      () => b.spend.budgetReserve({ budget_key: budget.key, role: "request", reservation: operation(poolKey, budget.root, 1000) }),
    );
    expect(results.map(outcome)).toEqual(["ok", "budget_closed"]);
    expect(secondWaited).toBe(true);
    expect(expectOk(await admin.budgetStatus({ budget_key: budget.key })).committed_microusd).toBe(0n);
  });

  it("a budget reservation against a plain reservation on the same pool: the pool's cap still holds", async () => {
    const poolKey = await createPool(1_000_000);
    const budget = await createBudget(poolKey, 1_000_000);
    const a = await database.connect();
    const b = await database.connect();
    const { results, secondWaited } = await forcedOverlap(
      a,
      "spend_budget_reserve",
      (spend) => spend.reserve(operation(poolKey, uuid(79_999), 600_000)),
      () => b.spend.budgetReserve({ budget_key: budget.key, role: "request", reservation: operation(poolKey, budget.root, 600_000) }),
    );
    expect(results.map(outcome)).toEqual(["ok", "insufficient_funds"]);
    expect(secondWaited).toBe(true);
    const pool = expectOk(await admin.poolStatus({ pool_key: poolKey }));
    expect(pool.committed_microusd).toBe(600_000n);
    expect(expectOk(await admin.budgetStatus({ budget_key: budget.key })).committed_microusd).toBe(0n);
  });
});

describe("request events against a real Postgres", () => {
  it("concurrent appends from separate connections get consecutive sequence numbers", async () => {
    const poolKey = await createPool(10_000_000);
    n += 1;
    const key = hex(70_000 + n);
    const root = uuid(70_000 + n);
    const requestId = uuid(71_000 + n);
    const first = await database.connect();
    const writer = createFactoryRecords({ client: fromPg(first.client), schema: database.schema });
    expectOk(
      await writer.acceptRequest({
        budget: budgetRequest(n, { budget_key: key, root_execution_id: root, pool_key: poolKey }),
        request: recordRequest(n, { request_id: requestId, budget_key: key, root_execution_id: root }),
        accepted_message: "Request accepted.",
      }),
    );
    const writers = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const { client } = await database.connect();
        return createFactoryRecords({ client: fromPg(client), schema: database.schema });
      }),
    );
    // Eight connections append at once; each sends its three events one after another.
    const perWriter = await Promise.all(
      writers.map(async (w, i) => {
        const appended: number[] = [];
        for (const j of [0, 1, 2]) {
          appended.push(expectOk(await w.appendEvent(event(requestId, `concurrent:${String(i)}:${String(j)}`))).seq);
        }
        return appended;
      }),
    );
    const seqs = perWriter.flat().sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 24 }, (_v, i) => i + 2));
    const read = expectOk(await writer.readRequest({ request_id: requestId, after: 0, limit: 1000 }));
    expect(read.events.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_v, i) => i + 1));
  });
});

// Each test below holds the first write open in a transaction on one connection while the second,
// on another connection, waits on the row lock that the write function takes. Without that lock,
// the second write would read no row, insert under the same key and fail with a unique violation.
describe("stops, evidence and validation events against a real Postgres", () => {
  it("two overlapping stops with the same actor: the second waits and replays the first", async () => {
    const requestId = await acceptNewRequest(await createPool(10_000_000));
    const a = await database.connect();
    const b = recordsOn(await database.connect());
    const stop = { request_id: requestId, actor_role: "web" };
    const { results, secondWaited } = await forcedOverlap(
      a,
      "factory_record_stop",
      (_spend, records) => records.recordStop(stop),
      () => b.recordStop(stop),
    );
    const [first, second] = results.map((r) => expectOk(r));
    expect([first?.replay, second?.replay]).toEqual([false, true]);
    expect(second?.recorded_at).toBe(first?.recorded_at);
    expect(secondWaited).toBe(true);
  });

  it("two overlapping evidence records for one case: the second waits and replays the first", async () => {
    const requestId = await acceptNewRequest(await createPool(10_000_000));
    const a = await database.connect();
    const b = recordsOn(await database.connect());
    const text = JSON.stringify({ synthetic: "evidence" });
    const evidence = { request_id: requestId, case_id: hex(72_001), sha256: createHash("sha256").update(text, "utf8").digest("hex"), evidence_json: text };
    const { results, secondWaited } = await forcedOverlap(
      a,
      "factory_record_evidence",
      (_spend, records) => records.recordEvidence(evidence),
      () => b.recordEvidence(evidence),
    );
    expect(results.map((r) => expectOk(r).replay)).toEqual([false, true]);
    expect(secondWaited).toBe(true);
  });

  async function newValidation(): Promise<string> {
    const requestId = await acceptNewRequest(await createPool(10_000_000));
    n += 1;
    const validationId = uuid(73_000 + n);
    expectOk(
      await recordsOn({ client: observer }).recordValidation({
        validation_id: validationId,
        request_id: requestId,
        case_id: hex(72_002),
        root_execution_id: uuid(74_000 + n),
      }),
    );
    return validationId;
  }

  it("two overlapping validation events: the second waits and takes the next seq", async () => {
    const validationId = await newValidation();
    const a = await database.connect();
    const b = recordsOn(await database.connect());
    const { results, secondWaited } = await forcedOverlap(
      a,
      "factory_append_validation_event",
      (_spend, records) => records.appendValidationEvent({ validation_id: validationId, event_key: "copy:1", type: "copy_finished", data: {} }),
      () => b.appendValidationEvent({ validation_id: validationId, event_key: "copy:2", type: "copy_finished", data: {} }),
    );
    expect(results.map((r) => expectOk(r).seq)).toEqual([1, 2]);
    expect(secondWaited).toBe(true);
  });

  it("concurrent validation events from separate connections get consecutive sequence numbers", async () => {
    const validationId = await newValidation();
    const writers = await Promise.all(Array.from({ length: 8 }, async () => recordsOn(await database.connect())));
    const perWriter = await Promise.all(
      writers.map(async (w, i) => {
        const appended: number[] = [];
        for (const j of [0, 1, 2]) {
          const key = `copy:${String(i)}:${String(j)}`;
          appended.push(expectOk(await w.appendValidationEvent({ validation_id: validationId, event_key: key, type: "copy_finished", data: {} })).seq);
        }
        return appended;
      }),
    );
    expect(perWriter.flat().sort((x, y) => x - y)).toEqual(Array.from({ length: 24 }, (_v, i) => i + 1));
    const read = expectOk(await recordsOn({ client: observer }).readValidation({ validation_id: validationId, after: 0, limit: 1000 }));
    expect(read.events.map((e) => e.seq)).toEqual(Array.from({ length: 24 }, (_v, i) => i + 1));
  });
});
