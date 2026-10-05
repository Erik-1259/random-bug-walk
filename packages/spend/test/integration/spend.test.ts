import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Spend } from "../../src/spend.ts";
import type { Result } from "../../src/types.ts";
import { expectOk, hex, line, reserveRequest, settlement, uuid } from "../helpers.ts";
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
  const poolKey = `synthetic-${suffix()}`;
  expectOk(await admin.createPool({ pool_key: poolKey, cap_microusd: cap, allocations: [], actor_role: "owner", reason: "synthetic integration pool" }));
  return poolKey;
}

async function createSlot(): Promise<string> {
  const slotKey = `synthetic-slot-${suffix()}`;
  expectOk(await admin.createSlotKey({ slot_key: slotKey, actor_role: "owner", reason: "synthetic integration slot" }));
  return slotKey;
}

function request(poolKey: string, microusd: number, root = uuid(1)) {
  n += 1;
  return reserveRequest(n, {
    pool_key: poolKey,
    root_execution_id: root,
    execution_id: root,
    envelope: [line({ limit: microusd, price: { microusd: 1, per_units: 1 } })],
  });
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
async function forcedOverlap<T>(
  a: { client: pg.Client; spend: Spend },
  fn: string,
  first: (spend: Spend) => Promise<Result<T>>,
  second: () => Promise<Result<T>>,
): Promise<{ results: [Result<T>, Result<T>]; secondWaited: boolean }> {
  await a.client.query("BEGIN");
  let firstResult: Result<T>;
  try {
    firstResult = await first(a.spend);
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

describe("spend against a real Postgres", () => {
  it("I1 forced-overlap race: two 600,000 reservations against a 1,000,000 pool, exactly one succeeds", async () => {
    const poolKey = await createPool(1_000_000);
    const a = await database.connect();
    const b = await database.connect();
    const { results, secondWaited } = await forcedOverlap(
      a,
      "spend_reserve",
      (spend) => spend.reserve(request(poolKey, 600_000)),
      () => b.spend.reserve(request(poolKey, 600_000)),
    );
    const outcomes = results.map((r) => (r.ok ? "ok" : r.code)).sort();
    expect(outcomes).toEqual(["insufficient_funds", "ok"]);
    // The second reservation was blocked on the server until the first committed.
    expect(secondWaited).toBe(true);
    const status = expectOk(await admin.poolStatus({ pool_key: poolKey }));
    expect(status.committed_microusd).toBe(600_000n);
    expect(status.committed_microusd <= status.cap_microusd).toBe(true);
  });

  it("I2 burst: eight concurrent 300,000 reservations against a 1,000,000 pool, exactly three succeed", async () => {
    const poolKey = await createPool(1_000_000);
    const connections = await Promise.all(Array.from({ length: 8 }, () => database.connect()));
    const results = await Promise.all(connections.map((c) => c.spend.reserve(request(poolKey, 300_000))));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.code === "insufficient_funds")).toHaveLength(5);
    const status = expectOk(await admin.poolStatus({ pool_key: poolKey }));
    expect(status.committed_microusd).toBe(900_000n);
  });

  it("I3 unknown price: refused unknown_price with no operation or reservation written", async () => {
    const poolKey = await createPool(1_000_000);
    const before = expectOk(await admin.poolStatus({ pool_key: poolKey }));
    const unpriced = request(poolKey, 1000);
    const result = await admin.reserve({ ...unpriced, envelope: [line({ price: null })] });
    expect(result.ok ? "ok" : result.code).toBe("unknown_price");
    const written = await observer.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM ${database.schema}.operations WHERE operation_id = $1)::int
            + (SELECT count(*) FROM ${database.schema}.spend WHERE operation_id = $1)::int AS n`,
      [unpriced.operation_id],
    );
    expect(written.rows[0]?.n).toBe(0);
    expect(await admin.operationStatus({ operation_id: unpriced.operation_id })).toMatchObject({ ok: false, code: "unknown_operation" });
    expect(expectOk(await admin.poolStatus({ pool_key: poolKey }))).toEqual(before);
  });

  it("I4 missing usage: an unknown line keeps its full worst case committed and the operation stays terminal", async () => {
    const poolKey = await createPool(1_000_000);
    const slotKey = await createSlot();
    const root = uuid(400);
    const reservation = reserveRequest(9000, {
      pool_key: poolKey,
      root_execution_id: root,
      execution_id: root,
      envelope: [
        line({ unit: "input_token", limit: 10_000, price: { microusd: 60_000, per_units: 1_000_000 } }),
        line({ unit: "output_token", limit: 2_000, price: { microusd: 240_000, per_units: 1_000_000 } }),
      ],
    });
    expectOk(await admin.acquireSlot({ slot_key: slotKey, root_execution_id: root, actor_role: "workflow" }));
    const reserved = expectOk(await admin.reserve(reservation));
    expect(reserved.reserved_microusd).toBe(600n + 480n);
    const op = reservation.operation_id;
    expectOk(await admin.transition({ operation_id: op, from_state: "prepared", to_state: "launching", actor_role: "workflow", slot_key: slotKey }));
    expectOk(await admin.transition({ operation_id: op, from_state: "launching", to_state: "terminal", actor_role: "workflow", terminal_status: "completed" }));
    const settled = expectOk(
      await admin.settle(
        settlement(op, {
          reserved_microusd: 1080,
          usage_state: "partly_unknown",
          service_lines: [
            { service: "synthetic-llm", unit: "input_token", actual_quantity: 5_000, actual_microusd: 300, retained_microusd: 0 },
            { service: "synthetic-llm", unit: "output_token", actual_quantity: null, actual_microusd: null, retained_microusd: 480 },
          ],
          terminal_evidence_key: "synthetic/i4/terminal.json",
          terminal_evidence_sha256: hex(44),
        }),
      ),
    );
    expect(settled.state).toBe("terminal");
    const status = expectOk(await admin.poolStatus({ pool_key: poolKey }));
    expect(status.committed_microusd).toBe(300n + 480n);
    expect(status.available_microusd).toBe(1_000_000n - 780n);
    expect(expectOk(await admin.operationStatus({ operation_id: op })).state).toBe("terminal");
  });

  it("reusing one operation ID on two pools at once: the later call is refused operation_conflict", async () => {
    const first = await createPool(1_000_000);
    const second = await createPool(1_000_000);
    const a = await database.connect();
    const b = await database.connect();
    const intent = request(first, 1000);
    const { results, secondWaited } = await forcedOverlap(
      a,
      "spend_reserve",
      (spend) => spend.reserve(intent),
      () => b.spend.reserve({ ...intent, pool_key: second }),
    );
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["ok", "operation_conflict"]);
    expect(secondWaited).toBe(true);
    expect(expectOk(await admin.poolStatus({ pool_key: second })).committed_microusd).toBe(0n);
  });

  it("I5 slot: two overlapping acquisitions by different roots, exactly one holds; a third root is refused", async () => {
    const slotKey = await createSlot();
    const a = await database.connect();
    const b = await database.connect();
    const { results, secondWaited } = await forcedOverlap(
      a,
      "spend_slot_acquire",
      (spend) => spend.acquireSlot({ slot_key: slotKey, root_execution_id: uuid(501), actor_role: "workflow" }),
      () => b.spend.acquireSlot({ slot_key: slotKey, root_execution_id: uuid(502), actor_role: "workflow" }),
    );
    const outcomes = results.map((r) => (r.ok ? "ok" : r.code)).sort();
    expect(outcomes).toEqual(["ok", "slot_held"]);
    expect(secondWaited).toBe(true);
    const third = await admin.acquireSlot({ slot_key: slotKey, root_execution_id: uuid(503), actor_role: "workflow" });
    expect(third.ok ? "ok" : third.code).toBe("slot_held");
    expect(expectOk(await admin.slotStatus({ slot_key: slotKey })).holder).toBe(uuid(501));
  });
});
