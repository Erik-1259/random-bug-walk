import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENFORCED_BY, UNITS } from "../../src/types.ts";
import {
  expectOk,
  haltWithOverrun,
  harness,
  hex,
  openDb,
  reserveAndLaunch,
  reserveRequest,
  RESUME,
  setup,
  type Harness,
} from "../helpers.ts";

let db: PGlite;
let h: Harness;

const INSERT_ONLY_TABLES = [
  "allocation_transfers",
  "applied_migrations",
  "enforcement_methods",
  "execution_slot",
  "halt_observations",
  "halt_resumes",
  "operation_events",
  "operation_lines",
  "operations",
  "pool_allocations",
  "pool_cap_changes",
  "pools",
  "reconciliations",
  "reservation_refusals",
  "settlements",
  "slot_child_confirmations",
  "slot_children",
  "slot_events",
  "spend",
  "units",
];

beforeAll(async () => {
  db = await openDb();
  h = await harness(db);
  await setup(h);
  // Write at least one row to every table so row-level guards have something to reject.
  await haltWithOverrun(h, 1);
  expect((await h.spend.reserve(reserveRequest(2))).ok).toBe(false);
  expectOk(await h.spend.resume(RESUME));
  const op = await reserveAndLaunch(h, 3);
  expectOk(
    await h.spend.transition({
      operation_id: op,
      from_state: "launching",
      to_state: "running",
      actor_role: "workflow",
      provider_resource_id: "synthetic-resource",
    }),
  );
  expectOk(
    await h.spend.transition({ operation_id: op, from_state: "running", to_state: "terminal", actor_role: "workflow", terminal_status: "failed" }),
  );
  expectOk(
    await h.spend.reconcile({
      schema_version: 1,
      operation_id: op,
      previous_state: "terminal",
      evidence: [{ key: "synthetic/evidence.json", sha256: hex(5) }],
      provider_resource_ids: [],
      recorded_at: "2026-10-04T02:00:00Z",
      actor_role: "operator",
      decision: "confirm_stopped_incomplete",
      retained_microusd: 10,
      released_microusd: 990,
      reason: "synthetic failure",
    }),
  );
  expectOk(
    await h.spend.transfer({
      pool_key: "judge-demo",
      from_allocation_key: "public",
      to_allocation_key: "judge",
      amount_microusd: 5,
      actor_role: "owner",
      reason: "synthetic",
    }),
  );
  expectOk(await h.spend.raiseCap({ pool_key: "development", new_cap_microusd: 1_000_000_001, actor_role: "owner", reason: "x" }));
});

afterAll(async () => {
  await db.close();
});

describe("append-only tables", () => {
  it("covers every table in the schema", async () => {
    const counts = await h.counts();
    expect(Object.keys(counts).sort()).toEqual(INSERT_ONLY_TABLES);
    for (const [table, count] of Object.entries(counts)) {
      expect({ table, populated: count > 0 }).toEqual({ table, populated: true });
    }
  });

  it.each(INSERT_ONLY_TABLES)("rejects UPDATE, DELETE and TRUNCATE on %s", async (table) => {
    const before = (await h.counts())[table];
    const column = await h.sql(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position LIMIT 1",
      [h.schema, table],
    );
    const firstColumn = String(column[0]?.column_name);
    await expect(h.sql(`UPDATE ${table} SET ${firstColumn} = ${firstColumn}`)).rejects.toThrow(/insert-only/);
    await expect(h.sql(`DELETE FROM ${table}`)).rejects.toThrow(/insert-only/);
    await expect(h.sql(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/insert-only/);
    expect((await h.counts())[table]).toBe(before);
  });
});

describe("closed lists", () => {
  it("holds exactly the documented units", async () => {
    const rows = await h.sql("SELECT unit FROM units ORDER BY unit");
    expect(rows.map((r) => r.unit)).toEqual([...UNITS].sort());
  });

  it("holds exactly the documented enforcement methods", async () => {
    const rows = await h.sql("SELECT enforced_by FROM enforcement_methods ORDER BY enforced_by");
    expect(rows.map((r) => r.enforced_by)).toEqual([...ENFORCED_BY].sort());
  });
});

describe("seeds", () => {
  it("seeds development and judge-demo with nothing committed", async () => {
    const fresh = await harness(db);
    const development = expectOk(await fresh.spend.poolStatus({ pool_key: "development" }));
    expect(development).toEqual({
      ok: true,
      pool_key: "development",
      cap_microusd: 1_000_000_000n,
      settled_microusd: 0n,
      open_microusd: 0n,
      committed_microusd: 0n,
      available_microusd: 1_000_000_000n,
      allocations: [],
    });
    const judgeDemo = expectOk(await fresh.spend.poolStatus({ pool_key: "judge-demo" }));
    expect(judgeDemo).toEqual({
      ok: true,
      pool_key: "judge-demo",
      cap_microusd: 200_000_000n,
      settled_microusd: 0n,
      open_microusd: 0n,
      committed_microusd: 0n,
      available_microusd: 200_000_000n,
      allocations: [
        {
          allocation_key: "judge",
          limit_microusd: 150_000_000n,
          settled_microusd: 0n,
          open_microusd: 0n,
          committed_microusd: 0n,
          available_microusd: 150_000_000n,
        },
        {
          allocation_key: "public",
          limit_microusd: 50_000_000n,
          settled_microusd: 0n,
          open_microusd: 0n,
          committed_microusd: 0n,
          available_microusd: 50_000_000n,
        },
      ],
    });
    const pools = await fresh.sql("SELECT pool_key FROM pools ORDER BY pool_key");
    expect(pools).toEqual([{ pool_key: "development" }, { pool_key: "judge-demo" }]);
    expect(await fresh.sql("SELECT slot_key FROM execution_slot")).toEqual([]);
  });

  it("refuses an allocation sum that differs from the cap, also against direct SQL with the write setting on", async () => {
    const fresh = await harness(db);
    await expect(
      fresh.sqlAsFunction(
        "INSERT INTO pool_allocations (pool_key, allocation_key, initial_limit_microusd, recorded_at) VALUES ('judge-demo', 'extra', 1, now())",
      ),
    ).rejects.toThrow(/must sum to its cap/);
  });
});

describe("unknown read targets", () => {
  it("reports unknown pools and operations as refusals", async () => {
    const pool = await h.spend.poolStatus({ pool_key: "synthetic-missing" });
    expect(pool.ok ? "ok" : pool.code).toBe("unknown_pool");
    const op = await h.spend.operationStatus({ operation_id: hex(999_999) });
    expect(op.ok ? "ok" : op.code).toBe("unknown_operation");
  });
});
