import { PGlite } from "@electric-sql/pglite";
import { expect } from "vitest";
import type { SqlClient } from "../src/client.ts";
import { migrate } from "../src/migrate.ts";
import { createSpend } from "../src/spend.ts";
import type { Spend } from "../src/spend.ts";
import type {
  EnvelopeLine,
  ManualReconciliation,
  Refusal,
  RefusalCode,
  ReserveRequest,
  Result,
  UsageSettlement,
} from "../src/types.ts";

/** A clock that only moves when a test moves it. */
export class TestClock {
  private current: number;

  constructor(start = "2026-10-04T00:00:00.000Z") {
    this.current = Date.parse(start);
  }

  now = (): Date => new Date(this.current);

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

export const ONE_YEAR_MS = 366 * 24 * 60 * 60 * 1000;

/** 64 lowercase hexadecimal characters derived from a small number. */
export function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A lowercase UUID string derived from a small number. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const ROOT = uuid(1);
export const OTHER_ROOT = uuid(2);
export const POOL = "synthetic-pool";
export const SLOT = "synthetic-slot";

/** Lets a test send a value the TypeScript types would reject, as a caller in another language could. */
export function loose(value: unknown): never {
  return value as never;
}

export interface Harness {
  db: PGlite;
  client: SqlClient;
  schema: string;
  clock: TestClock;
  spend: Spend;
  sql(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Runs one statement in its own transaction with rbw.spend_api on, as the spend functions do. */
  sqlAsFunction(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  counts(): Promise<Record<string, number>>;
}

export async function openDb(): Promise<PGlite> {
  return PGlite.create();
}

let schemaCounter = 0;

/** Applies all migrations into a new schema of the shared in-process database. */
export async function harness(db: PGlite): Promise<Harness> {
  schemaCounter += 1;
  const schema = `synthetic_unit_${String(schemaCounter)}`;
  await db.exec(`CREATE SCHEMA ${schema}`);
  await migrate(db, { schema });
  const clock = new TestClock();
  const spend = createSpend({ client: db, schema, clock: clock.now });
  const sql = async (text: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    await db.exec(`SET search_path TO ${schema}`);
    const result = await db.query<Record<string, unknown>>(text, params);
    return result.rows;
  };
  const sqlAsFunction = async (text: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    await db.exec(`SET search_path TO ${schema}`);
    return db.transaction(async (tx) => {
      await tx.query("SELECT set_config('rbw.spend_api', 'on', true)");
      return (await tx.query<Record<string, unknown>>(text, params)).rows;
    });
  };
  const counts = async (): Promise<Record<string, number>> => {
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1",
      [schema],
    );
    const out: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
      const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${schema}.${table_name}`);
      out[table_name] = rows.rows[0]?.n ?? -1;
    }
    return out;
  };
  return { db, client: db, schema, clock, spend, sql, sqlAsFunction, counts };
}

export function expectOk<T>(result: Result<T>): { ok: true } & T {
  if (!result.ok) {
    throw new Error(`expected success, got refusal ${result.code}: ${result.detail ?? ""}`);
  }
  return result;
}

export function expectRefused<T>(result: Result<T>, code: RefusalCode): Refusal {
  if (result.ok) {
    throw new Error(`expected refusal ${code}, got success`);
  }
  expect(result.code).toBe(code);
  return result;
}

/**
 * Runs `action` and asserts that it changed no table, except that `allowed` tables
 * (refusal records) may each gain exactly one row.
 */
export async function expectNothingWritten(
  h: Harness,
  action: () => Promise<unknown>,
  allowed: string[] = [],
): Promise<void> {
  const before = await h.counts();
  await action();
  const after = await h.counts();
  for (const [table, count] of Object.entries(before)) {
    const expected = allowed.includes(table) ? count + 1 : count;
    expect({ table, count: after[table] }).toEqual({ table, count: expected });
  }
}

export function line(overrides: Partial<EnvelopeLine> = {}): EnvelopeLine {
  return {
    service: "synthetic-llm",
    unit: "input_token",
    limit: 1000,
    enforced_by: "request_parameter",
    price: { microusd: 1, per_units: 1 },
    ...overrides,
  };
}

export function reserveRequest(n: number, overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    operation_id: hex(1000 + n),
    payload_hash: hex(2000 + n),
    attempt_ordinal: 1,
    previous_operation_id: null,
    project_id: uuid(100),
    project_policy_sha256: hex(3),
    batch_id: null,
    task_revision: hex(4),
    root_execution_id: ROOT,
    execution_id: ROOT,
    parent_execution_id: null,
    kind: "synthetic-call",
    call_name: "synthetic.generate",
    provider: "synthetic-provider",
    provider_replay_key: null,
    pool_key: POOL,
    allocation_key: null,
    runtime_profile_sha256: hex(5),
    rate_sheet_sha256: hex(6),
    envelope: [line()],
    ...overrides,
  };
}

export function settlement(
  operationId: string,
  overrides: Partial<UsageSettlement> = {},
): UsageSettlement {
  return {
    schema_version: 1,
    operation_id: operationId,
    runtime_profile_sha256: hex(5),
    rate_sheet_sha256: hex(6),
    reserved_microusd: 1000,
    service_lines: [
      {
        service: "synthetic-llm",
        unit: "input_token",
        actual_quantity: 400,
        actual_microusd: 400,
        retained_microusd: 0,
      },
    ],
    usage_state: "known",
    terminal_evidence_key: null,
    terminal_evidence_sha256: null,
    ...overrides,
  };
}

export function reconciliation(
  operationId: string,
  overrides: Partial<ManualReconciliation> = {},
): ManualReconciliation {
  return {
    schema_version: 1,
    operation_id: operationId,
    previous_state: "prepared",
    evidence: [{ key: "synthetic/evidence/1.json", sha256: hex(77) }],
    provider_resource_ids: [],
    recorded_at: "2026-10-04T01:00:00Z",
    actor_role: "operator",
    decision: "confirm_no_launch",
    retained_microusd: 0,
    released_microusd: 1000,
    reason: "synthetic reconciliation",
    ...overrides,
  };
}

/** Creates the synthetic pool and slot key most tests use. */
export async function setup(h: Harness, cap = 1_000_000): Promise<void> {
  expectOk(
    await h.spend.createPool({
      pool_key: POOL,
      cap_microusd: cap,
      allocations: [],
      actor_role: "owner",
      reason: "synthetic test pool",
    }),
  );
  expectOk(await h.spend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "synthetic test slot" }));
}

/** Reserves operation `n`, acquires the slot for its root and records `launching`. */
export async function reserveAndLaunch(
  h: Harness,
  n: number,
  overrides: Partial<ReserveRequest> = {},
): Promise<string> {
  const request = reserveRequest(n, overrides);
  expectOk(
    await h.spend.acquireSlot({ slot_key: SLOT, root_execution_id: request.root_execution_id, actor_role: "workflow" }),
  );
  expectOk(await h.spend.reserve(request));
  expectOk(
    await h.spend.transition({
      operation_id: request.operation_id,
      from_state: "prepared",
      to_state: "launching",
      actor_role: "workflow",
      slot_key: SLOT,
    }),
  );
  return request.operation_id;
}

/** Reserves, launches and records a synchronous `launching → terminal` for operation `n`. */
export async function reserveToTerminal(
  h: Harness,
  n: number,
  overrides: Partial<ReserveRequest> = {},
): Promise<string> {
  const operationId = await reserveAndLaunch(h, n, overrides);
  expectOk(
    await h.spend.transition({
      operation_id: operationId,
      from_state: "launching",
      to_state: "terminal",
      actor_role: "workflow",
      terminal_status: "completed",
    }),
  );
  return operationId;
}

/** Settles operation `n` above its worst case, which halts new work in every pool. */
export async function haltWithOverrun(h: Harness, n: number): Promise<string> {
  const operationId = await reserveToTerminal(h, n);
  expectOk(
    await h.spend.settle(
      settlement(operationId, {
        service_lines: [
          {
            service: "synthetic-llm",
            unit: "input_token",
            actual_quantity: 1000,
            actual_microusd: 1001,
            retained_microusd: 0,
          },
        ],
      }),
    ),
  );
  return operationId;
}

export const RESUME = {
  actor_role: "operator",
  evidence: [{ key: "synthetic/resume.json", sha256: hex(88) }],
  reason: "synthetic resume after review",
};
