import { PGlite } from "@electric-sql/pglite";
import { sha256Hex } from "@rbw/schema";
import { createSpend, migrate } from "@rbw/spend";
import type { ReserveRequest, Spend } from "@rbw/spend";
import { describe, expect, it } from "vitest";
import { Allowance, guardSpend, ledgerAllowanceSource, requestWorstCase } from "../src/allowance.ts";
import type { AllowanceSource, LedgerView } from "../src/allowance.ts";

const ROOT_A = "00000000-0000-4000-8000-00000000a001";
const ROOT_B = "00000000-0000-4000-8000-00000000b001";
const OTHER = "00000000-0000-4000-8000-00000000c001";

function request(root: string, n: number, microusd: number): ReserveRequest {
  return {
    operation_id: sha256Hex(Buffer.from(`op-${root}-${String(n)}`)),
    payload_hash: sha256Hex(Buffer.from(`payload-${String(n)}`)),
    attempt_ordinal: 1,
    previous_operation_id: null,
    project_id: "00000000-0000-4000-8000-000000000001",
    project_policy_sha256: "1".repeat(64),
    batch_id: "00000000-0000-4000-8000-000000000002",
    task_revision: "2".repeat(64),
    root_execution_id: root,
    execution_id: "00000000-0000-4000-8000-000000000003",
    parent_execution_id: root,
    kind: "solver.turn",
    call_name: `solver.turn:test:${String(n)}`,
    provider: "token-factory",
    provider_replay_key: null,
    pool_key: "development",
    allocation_key: null,
    runtime_profile_sha256: "3".repeat(64),
    rate_sheet_sha256: "4".repeat(64),
    envelope: [{ service: "token-factory.synthetic", unit: "input_token", limit: microusd, enforced_by: "request_parameter", price: { microusd: 1, per_units: 1 } }],
  };
}

function fixedSource(view: Partial<LedgerView>): AllowanceSource & { reads: number } {
  const source = {
    reads: 0,
    view: () => {
      source.reads += 1;
      return Promise.resolve({ settled_microusd: 0n, open_microusd: 0n, settled_by_execution: new Map(), uncertain: [], halted: false, ...view });
    },
  };
  return source;
}

async function ledger(): Promise<{ db: PGlite; spend: Spend }> {
  const db = await PGlite.create();
  await migrate(db, { schema: "public" });
  return { db, spend: createSpend({ client: db, schema: "public" }) };
}

describe("the UC1 allowance", () => {
  it("lets an operation start only when its worst case fits the cap minus settled minus open", async () => {
    const allowance = new Allowance(fixedSource({ settled_microusd: 30_000_000n, open_microusd: 9_000_000n }), 40_000_000n, () => [ROOT_A]);
    expect(await allowance.check(1_000_000n)).toMatchObject({ ok: true, remaining_microusd: 1_000_000n });
    expect(allowance.stop).toBeNull();
    const refused = await allowance.check(1_000_001n);
    expect(refused).toMatchObject({ ok: false, reason: "allowance_exceeded" });
    // After a stop nothing billable starts in this process, even an operation that would fit.
    expect(await allowance.check(1n)).toMatchObject({ ok: false, reason: "allowance_exceeded" });
  });

  it("stops on an uncertain operation or a halted ledger before checking the amounts", async () => {
    expect(await new Allowance(fixedSource({ uncertain: ["abc"] }), 40_000_000n, () => [ROOT_A]).check(1n)).toMatchObject({ ok: false, reason: "ledger_uncertain" });
    expect(await new Allowance(fixedSource({ halted: true }), 40_000_000n, () => [ROOT_A]).check(1n)).toMatchObject({ ok: false, reason: "ledger_halted" });
  });

  it("counts a regrade that is starting as open until it ends", async () => {
    const allowance = new Allowance(fixedSource({}), 1_000n, () => [ROOT_A]);
    let inner: unknown = null;
    const held = await allowance.withHold("grade-2", 600n, async () => {
      inner = await allowance.check(500n);
      return "done";
    });
    expect(held).toEqual({ ok: true, value: "done" });
    expect(inner).toMatchObject({ ok: false, reason: "allowance_exceeded" });
  });

  it("holds an admitted rerun's whole worst case until it is released, so a second rerun starting at once does not fit", async () => {
    const allowance = new Allowance(fixedSource({}), 1_500n, () => [ROOT_A]);
    expect(await allowance.admit("rerun-a", 1_000n)).toMatchObject({ ok: true });
    expect(await allowance.admit("rerun-b", 1_000n)).toMatchObject({ ok: false, reason: "allowance_exceeded" });
    const released = new Allowance(fixedSource({}), 1_500n, () => [ROOT_A]);
    expect(await released.admit("rerun-a", 1_000n)).toMatchObject({ ok: true });
    released.release("rerun-a");
    expect(await released.admit("rerun-b", 1_000n)).toMatchObject({ ok: true });
  });

  it("lets a held rerun's own model calls draw on its hold, which shrinks as they reserve", async () => {
    const { db, spend } = await ledger();
    const allowance = new Allowance(ledgerAllowanceSource(db, spend), 1_500n, () => [ROOT_A]);
    expect(await allowance.admit("rerun-a", 1_000n)).toMatchObject({ ok: true });
    // 600 fits the rerun's own hold, though not what is left beside it (500).
    expect((await guardSpend(spend, allowance, "rerun-a").reserve(request(ROOT_A, 1, 600))).ok).toBe(true);
    // Open 600 plus the hold's remaining 400 leave 500 for anyone else, not 600 + 1 000.
    expect(await allowance.check(500n)).toMatchObject({ ok: true, remaining_microusd: 500n });
    expect(await allowance.check(501n)).toMatchObject({ ok: false, reason: "allowance_exceeded" });
    await db.close();
  });

  it("refuses a model call before reserving it when it does not fit, and serializes concurrent reservations", async () => {
    const { db, spend } = await ledger();
    const source = ledgerAllowanceSource(db, spend);
    const allowance = new Allowance(source, 2_500n, () => [ROOT_A]);
    const guarded = guardSpend(spend, allowance);
    // Three reservations of 1 000 at once: only two fit 2 500; the third is refused and never reserved.
    const results = await Promise.all([1, 2, 3].map((n) => guarded.reserve(request(ROOT_A, n, 1_000))));
    expect(results.map((result) => result.ok)).toEqual([true, true, false]);
    const refused = results[2];
    expect(refused?.ok === false ? refused.code : null).toBe("insufficient_funds");
    expect(refused?.ok === false ? refused.detail : null).toMatch(/^uc1_allowance_exceeded: worst case 1000 micro-USD does not fit/);
    expect((await spend.operationStatus({ operation_id: request(ROOT_A, 3, 1_000).operation_id })).ok).toBe(false);
    expect(requestWorstCase(request(ROOT_A, 1, 1_000))).toBe(1_000n);
    await db.close();
  });

  it("reads settled and open amounts and uncertain operations under the UC1 roots only", async () => {
    const { db, spend } = await ledger();
    await spend.createSlotKey({ slot_key: "development", actor_role: "owner", reason: "test" });
    for (const [root, n] of [
      [ROOT_A, 1],
      [ROOT_B, 2],
      [OTHER, 3],
    ] as const) {
      expect((await spend.reserve(request(root, n, 1_000))).ok).toBe(true);
    }
    // ROOT_A's operation is launched and ends uncertain; ROOT_B's stays open; OTHER is not a UC1 root.
    await spend.acquireSlot({ slot_key: "development", root_execution_id: ROOT_A, actor_role: "test" });
    const a = request(ROOT_A, 1, 1_000).operation_id;
    await spend.transition({ operation_id: a, from_state: "prepared", to_state: "launching", actor_role: "test", slot_key: "development" });
    await spend.transition({ operation_id: a, from_state: "launching", to_state: "uncertain", actor_role: "test", uncertainty: "lost_response" });
    const view = await ledgerAllowanceSource(db, spend).view([ROOT_A, ROOT_B]);
    expect(view).toEqual({ settled_microusd: 0n, open_microusd: 2_000n, settled_by_execution: view.settled_by_execution, uncertain: [a], halted: false });
    expect(await ledgerAllowanceSource(db, spend).view([])).toEqual({ settled_microusd: 0n, open_microusd: 0n, settled_by_execution: new Map(), uncertain: [], halted: false });
    expect(() => ledgerAllowanceSource(db, spend, "public; drop")).toThrow("plain lower-case identifier");
    await db.close();
  });
});
