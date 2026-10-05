import { randomBytes } from "node:crypto";
import pg from "pg";
import { createSpend, fromPg, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReplayFetch } from "../../src/recording.ts";
import { createWriter, createWriterProvider } from "../../src/writer.ts";
import { CALL_WORST_CASE_MICROUSD, CANDIDATE, CONTEXT, EXCLUDED_IDENTIFIERS, symptom } from "../fixtures/cases.ts";
import { committedRecordings, rateSheetBytes, spyFetch, spySpend } from "../support.ts";

/** A driver error code only; driver messages can name the host, user or database. */
function code(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
  }
  return "unknown";
}

// Driver and server messages can name the host, port, user or database, and the test runner
// prints every property of a thrown error. Setup errors therefore carry only a step and a code.
function sanitized(step: string, error: unknown): Error {
  return new Error(`${step} on the database named by DATABASE_URL failed (error code ${code(error)})`);
}

async function guarded<T>(step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw sanitized(step, error);
  }
}

const schema = `synthetic_writer_it_${randomBytes(6).toString("hex")}`;
const suffix = randomBytes(4).toString("hex");
const POOL = `synthetic-writer-${suffix}`;
const SMALL_POOL = `synthetic-writer-small-${suffix}`;
const SLOT = `synthetic-writer-slot-${suffix}`;
let client: pg.Client;
let spend: Spend;

beforeAll(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on("error", () => undefined);
  await guarded("connecting", () => client.connect());
  await guarded("creating the test schema", () => client.query(`CREATE SCHEMA ${schema}`));
  try {
    await guarded("applying the spend migrations", () => migrate(fromPg(client), { schema }));
    spend = createSpend({ client: fromPg(client), schema });
    for (const [pool_key, cap_microusd] of [
      [POOL, 1_000_000],
      [SMALL_POOL, CALL_WORST_CASE_MICROUSD - 1],
    ] as const) {
      const pool = await spend.createPool({ pool_key, cap_microusd, allocations: [], actor_role: "owner", reason: "synthetic integration pool" });
      expect(pool.ok).toBe(true);
    }
    expect((await spend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "synthetic integration slot" })).ok).toBe(true);
    expect(
      (await spend.acquireSlot({ slot_key: SLOT, root_execution_id: CONTEXT.root_execution_id, actor_role: "workflow" })).ok,
    ).toBe(true);
  } catch (error) {
    await guarded("dropping the test schema", () => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await client.end();
    throw error;
  }
});

afterAll(async () => {
  try {
    await guarded("dropping the test schema", () => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
  } finally {
    await client.end();
  }
});

async function writerFor(poolKey: string) {
  const events: string[] = [];
  const fetchSpy = spyFetch(createReplayFetch(await committedRecordings()), events);
  const writer = createWriter({
    spend: spySpend(spend, events),
    provider: createWriterProvider({ fetch: fetchSpy.fetch }),
    context: CONTEXT,
    poolKey,
    allocationKey: null,
    slotKey: SLOT,
    rateSheet: rateSheetBytes(),
  });
  return { writer, events, fetchSpy };
}

describe("the writer against a real Postgres", () => {
  it("runs one replayed issue call end to end: reserved, launched, called, terminal, settled", async () => {
    const { writer, events, fetchSpy } = await writerFor(POOL);
    const outcome = await writer.writeIssue({ candidate: CANDIDATE, symptom: symptom("valid"), excludedIdentifiers: EXCLUDED_IDENTIFIERS });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(events).toEqual(["reserve", "transition:launching", "fetch", "transition:terminal", "settle"]);
    expect(fetchSpy.calls).toHaveLength(1);
    expect(outcome.report?.status).toBe("ready_for_review");
    const status = await spend.operationStatus({ operation_id: outcome.call.operation_id });
    expect(status).toMatchObject({ ok: true, state: "reconciled", reserved_microusd: BigInt(CALL_WORST_CASE_MICROUSD) });
  });

  it("refuses with insufficient_funds on a pool smaller than one call, with no call", async () => {
    const { writer, events, fetchSpy } = await writerFor(SMALL_POOL);
    const outcome = await writer.writeIssue({ candidate: "synthetic-candidate-small", symptom: symptom("valid"), excludedIdentifiers: EXCLUDED_IDENTIFIERS });
    expect(outcome).toMatchObject({ ok: false, code: "insufficient_funds" });
    expect(events).toEqual(["reserve"]);
    expect(fetchSpy.calls).toHaveLength(0);
    const pool = await spend.poolStatus({ pool_key: SMALL_POOL });
    expect(pool).toMatchObject({ ok: true, committed_microusd: 0n });
  });
});
