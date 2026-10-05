import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expectOk,
  haltWithOverrun,
  harness,
  hex,
  openDb,
  reserveAndLaunch,
  reserveRequest,
  ROOT,
  setup,
  SLOT,
  type Harness,
} from "../helpers.ts";

let db: PGlite;
let h: Harness;
let prepared: string;
let launched: string;
let running: string;
const OTHER_SLOT = "synthetic-other-slot";
const GUARD = /accepts rows only through the spend database functions/;

beforeAll(async () => {
  db = await openDb();
  h = await harness(db);
  await setup(h);
  expectOk(await h.spend.createSlotKey({ slot_key: OTHER_SLOT, actor_role: "owner", reason: "synthetic second slot" }));
  launched = await reserveAndLaunch(h, 1);
  running = await reserveAndLaunch(h, 2);
  expectOk(
    await h.spend.transition({
      operation_id: running,
      from_state: "launching",
      to_state: "running",
      actor_role: "workflow",
      provider_resource_id: "synthetic-running",
    }),
  );
  prepared = reserveRequest(3).operation_id;
  expectOk(await h.spend.reserve(reserveRequest(3)));
  // Leaves new work halted, so a resume row would pass its own trigger.
  await haltWithOverrun(h, 4);
});

afterAll(async () => {
  await db.close();
});

/** Runs `statements` in one transaction on a session that did not go through a spend function. */
async function direct(statements: string): Promise<void> {
  await h.db.exec(`SET search_path TO ${h.schema}`);
  try {
    await h.db.exec(`BEGIN; ${statements}; COMMIT;`);
  } catch (error) {
    await h.db.exec("ROLLBACK");
    throw error;
  }
}

// One row per table that every other constraint and trigger accepts, so only the guard refuses it.
const DIRECT_INSERTS: Record<string, () => string> = {
  units: () => "INSERT INTO units (unit, description) VALUES ('synthetic_unit', 'synthetic')",
  enforcement_methods: () =>
    "INSERT INTO enforcement_methods (enforced_by, description) VALUES ('synthetic_method', 'synthetic')",
  pools: () =>
    "INSERT INTO pools (pool_key, actor_role, reason, recorded_at) VALUES ('synthetic-direct', 'owner', 'synthetic', now())",
  pool_allocations: () =>
    "INSERT INTO pool_allocations (pool_key, allocation_key, initial_limit_microusd, recorded_at) VALUES ('judge-demo', 'synthetic-zero', 0, now())",
  pool_cap_changes: () =>
    "INSERT INTO pool_cap_changes (pool_key, kind, amount_microusd, actor_role, reason, recorded_at) VALUES ('development', 'raise', 1, 'owner', 'synthetic', now())",
  allocation_transfers: () =>
    "INSERT INTO allocation_transfers (pool_key, from_allocation_key, to_allocation_key, amount_microusd, actor_role, reason, recorded_at) VALUES ('judge-demo', 'public', 'judge', 1, 'owner', 'synthetic', now())",
  execution_slot: () =>
    "INSERT INTO execution_slot (slot_key, actor_role, reason, recorded_at) VALUES ('synthetic-direct-slot', 'owner', 'synthetic', now())",
  operations: () => `
    INSERT INTO operations (operation_id, payload_hash, attempt_ordinal, project_id, project_policy_sha256, task_revision,
      root_execution_id, execution_id, kind, call_name, provider, pool_key, runtime_profile_sha256, rate_sheet_sha256,
      worst_case_microusd, intent, recorded_at)
    VALUES ('${hex(9001)}', '${hex(9002)}', 1, '00000000-0000-4000-8000-000000000100', '${hex(3)}', '${hex(4)}',
      '${ROOT}', '${ROOT}', 'synthetic-call', 'synthetic.generate', 'synthetic-provider', 'synthetic-pool', '${hex(5)}', '${hex(6)}',
      1, '{}', now());
    INSERT INTO operation_lines (operation_id, line_no, service, unit, limit_quantity, enforced_by, price_microusd, price_per_units, worst_case_microusd)
    VALUES ('${hex(9001)}', 1, 'synthetic-llm', 'input_token', 1, 'request_parameter', 1, 1, 1);
    INSERT INTO spend (operation_id, pool_key, kind, amount_microusd, source, recorded_at)
    VALUES ('${hex(9001)}', 'synthetic-pool', 'reserve', 1, 'reservation', now())`,
  operation_lines: () =>
    `INSERT INTO operation_lines (operation_id, line_no, service, unit, limit_quantity, enforced_by, price_microusd, price_per_units, worst_case_microusd)
     VALUES ('${prepared}', 2, 'synthetic-llm', 'output_token', 1, 'request_parameter', 1, 1, 1)`,
  // Closes a running call's reservation with no settlement or reconciliation behind it.
  spend: () =>
    `INSERT INTO spend (operation_id, pool_key, kind, amount_microusd, source, recorded_at)
     VALUES ('${running}', 'synthetic-pool', 'close', 1000, 'settlement', now())`,
  // Reconciles a launching call with no reconciliation record or evidence.
  operation_events: () =>
    `INSERT INTO operation_events (operation_id, prior_seq, from_state, to_state, cause, actor_role, recorded_at)
     SELECT '${launched}', max(seq), 'launching', 'reconciled', 'reconciliation', 'workflow', now()
     FROM operation_events WHERE operation_id = '${launched}'`,
  settlements: () =>
    `INSERT INTO settlements (operation_id, content, usage_state, settled_microusd, retained_microusd, released_microusd, over_envelope, recorded_at)
     VALUES ('${running}', '{}', 'known', 0, 0, 1000, false, now())`,
  reconciliations: () =>
    `INSERT INTO reconciliations (operation_id, previous_state, decision, evidence, provider_resource_ids, recorded_at, actor_role,
       open_microusd, retained_microusd, released_microusd, over_envelope, reason, content, logged_at)
     VALUES ('${prepared}', 'prepared', 'confirm_no_launch', '[{"key": "synthetic/e.json", "sha256": "${hex(7)}"}]', '[]', now(), 'operator',
       1000, 0, 1000, false, 'synthetic', '{}', now())`,
  reservation_refusals: () =>
    `INSERT INTO reservation_refusals (operation_id, pool_key, code, requested_microusd, pool_available_microusd, recorded_at)
     VALUES ('${hex(9003)}', 'synthetic-pool', 'insufficient_funds', 1, 0, now())`,
  halt_observations: () =>
    `INSERT INTO halt_observations (operation_id, pool_key, source, measure, observed, bound, recorded_at)
     VALUES ('${running}', 'synthetic-pool', 'settlement', 'microusd', 2, 1, now())`,
  // A resume with the largest sequence number would disable the halt for good.
  halt_resumes: () =>
    `INSERT INTO halt_resumes (seq, actor_role, evidence, reason, recorded_at)
     VALUES (9223372036854775807, 'operator', '[{"key": "synthetic/e.json", "sha256": "${hex(7)}"}]', 'synthetic', now())`,
  slot_events: () =>
    `INSERT INTO slot_events (slot_key, prior_seq, kind, root_execution_id, actor_role, recorded_at)
     VALUES ('${OTHER_SLOT}', NULL, 'acquire', '${ROOT}', 'workflow', now())`,
  slot_children: () =>
    `INSERT INTO slot_children (slot_key, root_execution_id, provider, resource_id, kind, source, actor_role, recorded_at)
     VALUES ('${SLOT}', '${ROOT}', 'synthetic-provider', 'synthetic-direct-child', 'synthetic-kind', 'holder', 'workflow', now())`,
  // Confirms a running call's child resource with no evidence.
  slot_child_confirmations: () =>
    `INSERT INTO slot_child_confirmations (child_seq, terminal_status, source, actor_role, recorded_at)
     SELECT seq, 'completed', 'transition', 'workflow', now() FROM slot_children WHERE resource_id = 'synthetic-running'`,
  applied_migrations: () =>
    `INSERT INTO applied_migrations (file_name, checksum) VALUES ('9999_synthetic.sql', '${hex(8)}')`,
};

describe("direct INSERT outside the spend functions", () => {
  it("covers every table in the schema", async () => {
    expect(Object.keys(DIRECT_INSERTS).sort()).toEqual(Object.keys(await h.counts()).sort());
  });

  it.each(Object.keys(DIRECT_INSERTS))("is refused on %s", async (table) => {
    const before = await h.counts();
    const statement = DIRECT_INSERTS[table];
    if (statement === undefined) {
      throw new Error(`no statement for ${table}`);
    }
    await expect(direct(statement())).rejects.toThrow(GUARD);
    expect(await h.counts()).toEqual(before);
  });

  it("is refused after a spend function returned in the same transaction", async () => {
    const before = await h.counts();
    await expect(
      direct(`
        SELECT spend_create_slot_key('{"slot_key": "synthetic-in-tx", "actor_role": "owner", "reason": "synthetic"}', '2026-10-04T00:00:00Z');
        ${DIRECT_INSERTS.units?.() ?? ""}`),
    ).rejects.toThrow(GUARD);
    expect(await h.counts()).toEqual(before);
  });

  it("is refused after a spend function that reserved money returned in the same transaction", async () => {
    const before = await h.counts();
    await expect(
      direct(`
        SELECT spend_reserve('${JSON.stringify(reserveRequest(10))}', '2026-10-04T00:00:00Z');
        ${DIRECT_INSERTS.units?.() ?? ""}`),
    ).rejects.toThrow(GUARD);
    expect(await h.counts()).toEqual(before);
  });

  it("leaves the spend functions working", async () => {
    expectOk(await h.spend.createSlotKey({ slot_key: "synthetic-after", actor_role: "owner", reason: "synthetic" }));
    expect((await h.spend.haltStatus()).ok).toBe(true);
  });
});

describe("session temp tables", () => {
  it("do not shadow the spend tables inside the database functions", async () => {
    const own = await openDb();
    try {
      const fresh = await harness(own);
      await setup(fresh);
      await fresh.sql("CREATE TEMP TABLE pools (pool_key text, seq bigint, actor_role text, reason text, recorded_at timestamptz)");
      expectOk(await fresh.spend.reserve(reserveRequest(1)));
      const status = expectOk(await fresh.spend.poolStatus({ pool_key: "synthetic-pool" }));
      expect(status.open_microusd).toBe(1000n);
    } finally {
      await own.close();
    }
  });
});

describe("the rbw.spend_api guard inside the entry functions", () => {
  const CALL = `SELECT spend_create_slot_key('{"slot_key": "synthetic-guard-slot", "actor_role": "owner", "reason": "synthetic"}', '2026-10-04T00:00:00Z')`;
  const DIRECT = "INSERT INTO units (unit, description) VALUES ('synthetic_guard_unit', 'synthetic')";

  /** Runs `body` inside a transaction opened with `begin`, and rolls it back afterwards. */
  async function inTransaction<T>(begin: string, body: () => Promise<T>): Promise<T> {
    await h.db.exec(`SET search_path TO ${h.schema}`);
    await h.db.exec(begin);
    try {
      return await body();
    } finally {
      await h.db.exec("ROLLBACK");
    }
  }

  async function setting(): Promise<string | null | undefined> {
    return (await h.db.query<{ v: string | null }>("SELECT current_setting('rbw.spend_api', true) AS v")).rows[0]?.v;
  }

  // A non-superuser owner may not attach a custom parameter to a function (SQLSTATE 42501).
  it("is never attached to a function with a SET clause", async () => {
    const rows = await h.sql(
      `SELECT p.proname FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'rbw.%')`,
      [h.schema],
    );
    expect(rows).toEqual([]);
  });

  it("restores the value the setting had before the call", async () => {
    const after = await inTransaction("BEGIN", async () => {
      await h.db.query("SELECT set_config('rbw.spend_api', 'synthetic-prior', true)");
      await h.db.query(CALL);
      return setting();
    });
    expect(after).toBe("synthetic-prior");
  });

  // The error aborts the transaction, so no later statement in it can insert a row.
  it("aborts the transaction when an entry function raises an error", async () => {
    const before = await h.counts();
    await inTransaction("BEGIN ISOLATION LEVEL REPEATABLE READ", async () => {
      await expect(h.db.query(CALL)).rejects.toThrow(/require READ COMMITTED/);
      await expect(h.db.query(DIRECT)).rejects.toThrow(/current transaction is aborted/);
    });
    expect(await h.counts()).toEqual(before);
  });

  // Rolling back to a savepoint undoes the failed call's set_config with the rest of its work.
  it("is off after a rollback to a savepoint taken before an entry function that raised an error", async () => {
    const before = await h.counts();
    const after = await inTransaction("BEGIN ISOLATION LEVEL REPEATABLE READ", async () => {
      await h.db.query("SAVEPOINT synthetic_before_call");
      await expect(h.db.query(CALL)).rejects.toThrow(/require READ COMMITTED/);
      await h.db.query("ROLLBACK TO SAVEPOINT synthetic_before_call");
      const value = await setting();
      await expect(h.db.query(DIRECT)).rejects.toThrow(GUARD);
      return value;
    });
    expect(after).not.toBe("on");
    expect(await h.counts()).toEqual(before);
  });
});
