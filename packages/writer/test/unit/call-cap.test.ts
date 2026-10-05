import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { validateRecord } from "@rbw/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_CALLS_PER_CANDIDATE } from "../../src/config.ts";
import type { Writer } from "../../src/writer.ts";
import { CANDIDATE, EXCLUDED_IDENTIFIERS, cardSource, symptom } from "../fixtures/cases.ts";
import { freshSpend, openDb, rig } from "../support.ts";

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

/** Twelve billed calls: cards, issues and repairs after a schema-invalid issue. */
async function twelveCalls(writer: Writer): Promise<number[]> {
  const ordinals: number[] = [];
  for (let n = 0; n < 4; n += 1) {
    const card = await writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    const broken = await writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("schema-invalid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    const repair = await writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    for (const outcome of [card, broken, repair]) {
      if (!outcome.ok) {
        throw new Error(`call refused: ${outcome.code}`);
      }
      ordinals.push(outcome.call.call_ordinal);
    }
  }
  return ordinals;
}

describe("the shared per-candidate call budget", () => {
  it("is twelve", () => {
    expect(MAX_CALLS_PER_CANDIDATE).toBe(12);
  });

  it("gives ordinals 1 to 12 across card, issue and repairs, and refuses the 13th before reserving", async () => {
    const r = await rig(db);
    expect(await twelveCalls(r.writer)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r.fetchSpy.calls).toHaveLength(12);
    const reservesBefore = r.events.filter((e) => e === "reserve").length;

    const thirteenth = await r.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    expect(thirteenth).toMatchObject({ ok: false, code: "call_limit_reached" });
    const card = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    expect(card).toMatchObject({ ok: false, code: "call_limit_reached" });
    expect(r.fetchSpy.calls).toHaveLength(12);
    expect(r.events.filter((e) => e === "reserve").length).toBe(reservesBefore);
  });

  it("names each call <kind>:<candidate>:<ordinal>, a schema CallName the ledger accepts, and keeps candidates apart", async () => {
    const r = await rig(db);
    const first = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    const other = await r.writer.writeCard({ candidate: "synthetic-candidate-2", source: cardSource("valid") });
    if (!first.ok || !other.ok) {
      throw new Error("expected both calls to run");
    }
    expect(first.call.call_name).toBe(`writer.card:${CANDIDATE}:1`);
    expect(other.call.call_name).toBe("writer.card:synthetic-candidate-2:1");
    expect(validateRecord("CallName", first.call.call_name)).toEqual([]);
    const rows = await db.query(`SELECT call_name FROM ${r.schema}.operations WHERE operation_id = $1`, [first.call.operation_id]);
    expect(rows.rows).toEqual([{ call_name: first.call.call_name }]);
    expect(first.call.operation_id).not.toBe(other.call.operation_id);
  });

  it("finds the next free ordinal from the ledger in a new writer", async () => {
    const first = await rig(db);
    await first.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    await first.writer.writeIssue({
      candidate: CANDIDATE,
      symptom: symptom("valid"),
      excludedIdentifiers: EXCLUDED_IDENTIFIERS,
    });
    const second = await rig(db, { existing: { spend: first.rawSpend, schema: first.schema }, acquireSlot: false });
    const outcome = await second.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    if (!outcome.ok) {
      throw new Error(outcome.code);
    }
    expect(outcome.call.call_ordinal).toBe(3);
  });

  it("still refuses the 13th call in a fresh process over the same ledger", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "synthetic-writer-ledger-"));
    try {
      const disk = await openDb(dataDir);
      const { spend, schema } = await freshSpend(disk);
      const r = await rig(disk, { existing: { spend, schema } });
      await twelveCalls(r.writer);
      await disk.close();

      const script = fileURLToPath(new URL("../thirteenth-call.ts", import.meta.url));
      const child = spawnSync(process.execPath, [script, dataDir, schema], { encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout) as { code: string; fetch_calls: number; reserve_calls: number };
      expect(result).toEqual({ code: "call_limit_reached", fetch_calls: 0, reserve_calls: 0 });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("calls that never reached the provider do not use up the budget", () => {
  const unsent = (writer: Writer) =>
    writer.writeIssue({ candidate: CANDIDATE, symptom: symptom("no-such-case"), excludedIdentifiers: [] });

  it("leaves twelve billed calls after repeated unsent attempts, in this writer and in a new one", async () => {
    const r = await rig(db);
    const ids = new Set<string>();
    for (let n = 0; n < MAX_CALLS_PER_CANDIDATE + 3; n += 1) {
      const outcome = await unsent(r.writer);
      if (!outcome.ok) {
        throw new Error(`unsent attempt ${String(n)} refused: ${outcome.code}`);
      }
      expect(outcome.call).toMatchObject({ failure: "request_not_sent", call_ordinal: 1 });
      expect(outcome.call.settlement).toMatchObject({ settled_microusd: 0n, state: "reconciled" });
      ids.add(outcome.call.operation_id);
    }
    expect(ids.size).toBe(MAX_CALLS_PER_CANDIDATE + 3);

    const fresh = await rig(db, { existing: { spend: r.rawSpend, schema: r.schema }, acquireSlot: false });
    expect(await twelveCalls(fresh.writer)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const thirteenth = await fresh.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
    expect(thirteenth).toMatchObject({ ok: false, code: "call_limit_reached" });
  });

  it("still counts a call whose response was lost", async () => {
    const r = await rig(db, { fetch: () => Promise.reject(new TypeError("synthetic connection reset")) });
    const ordinals: number[] = [];
    for (let n = 0; n < MAX_CALLS_PER_CANDIDATE; n += 1) {
      const outcome = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
      if (!outcome.ok) {
        throw new Error(outcome.code);
      }
      expect(outcome.call.status).toBe("uncertain");
      ordinals.push(outcome.call.call_ordinal);
    }
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") })).toMatchObject({
      ok: false,
      code: "call_limit_reached",
    });
  });

  it("still counts a sent call that failed with an HTTP error", async () => {
    const r = await rig(db, { fetch: () => Promise.resolve(new Response("{}", { status: 500 })) });
    for (let n = 0; n < MAX_CALLS_PER_CANDIDATE; n += 1) {
      const outcome = await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") });
      if (!outcome.ok) {
        throw new Error(outcome.code);
      }
      expect(outcome.call.failure).toBe("http_status");
    }
    expect(await r.writer.writeCard({ candidate: CANDIDATE, source: cardSource("valid") })).toMatchObject({
      ok: false,
      code: "call_limit_reached",
    });
  });
});
