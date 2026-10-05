import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UsageSettlement } from "../../src/types.ts";
import {
  expectNothingWritten,
  expectOk,
  expectRefused,
  haltWithOverrun,
  hex,
  harness,
  line,
  loose,
  openDb,
  POOL,
  reconciliation,
  reserveAndLaunch,
  reserveRequest,
  reserveToTerminal,
  RESUME,
  ROOT,
  settlement,
  setup,
  SLOT,
  type Harness,
} from "../helpers.ts";

let db: PGlite;
let h: Harness;

beforeAll(async () => {
  db = await openDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  h = await harness(db);
  await setup(h);
});

describe("over-envelope halt", () => {
  it("records an overrun in full and refuses new reservations in every pool", async () => {
    const op = await haltWithOverrun(h, 1);
    expect(expectOk(await h.spend.operationStatus({ operation_id: op })).settled_microusd).toBe(1001n);

    const halt = expectOk(await h.spend.haltStatus());
    expect(halt.halted).toBe(true);
    expect(halt.observations).toHaveLength(1);
    expect(halt.observations[0]).toMatchObject({
      operation_id: op,
      pool_key: POOL,
      source: "settlement",
      service: "synthetic-llm",
      unit: "input_token",
      observed_microusd: 1001n,
      bound_microusd: 1000n,
    });

    await expectNothingWritten(
      h,
      async () => {
        expectRefused(await h.spend.reserve(reserveRequest(2, { pool_key: "development" })), "pool_halted");
      },
      ["reservation_refusals"],
    );
    expectRefused(
      await h.spend.reserve(reserveRequest(3, { pool_key: "judge-demo", allocation_key: "judge" })),
      "pool_halted",
    );
    const recorded = await h.sql("SELECT code, pool_key FROM reservation_refusals ORDER BY seq");
    expect(recorded).toEqual([
      { code: "pool_halted", pool_key: "development" },
      { code: "pool_halted", pool_key: "judge-demo" },
    ]);
  });

  it("halts on an actual quantity above the line's limit even when the amount fits", async () => {
    const op = await reserveToTerminal(h, 1);
    const settled = expectOk(
      await h.spend.settle(
        settlement(op, {
          service_lines: [
            { service: "synthetic-llm", unit: "input_token", actual_quantity: 1001, actual_microusd: 900, retained_microusd: 0 },
          ],
        }),
      ),
    );
    expect(settled.over_envelope).toBe(true);
    const halt = expectOk(await h.spend.haltStatus());
    expect(halt.observations[0]).toMatchObject({ observed_quantity: 1001n, bound_quantity: 1000n });
    expectRefused(await h.spend.reserve(reserveRequest(2)), "pool_halted");
  });

  it("halts on an unknown line whose reported quantity exceeds its limit", async () => {
    const op = await reserveToTerminal(h, 1);
    expectOk(
      await h.spend.settle(
        settlement(op, {
          usage_state: "unknown",
          service_lines: [
            { service: "synthetic-llm", unit: "input_token", actual_quantity: 5000, actual_microusd: null, retained_microusd: 1000 },
          ],
        }),
      ),
    );
    expect(expectOk(await h.spend.haltStatus()).halted).toBe(true);
  });

  it("keeps a prepared operation out of launching until a resume", async () => {
    expectOk(await h.spend.acquireSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow" }));
    const waiting = expectOk(await h.spend.reserve(reserveRequest(1))).operation_id;
    await haltWithOverrun(h, 2);
    const launch = {
      operation_id: waiting,
      from_state: "prepared",
      to_state: "launching",
      actor_role: "workflow",
      slot_key: SLOT,
    } as const;
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.transition(launch), "pool_halted");
    });
    expect(expectOk(await h.spend.operationStatus({ operation_id: waiting })).state).toBe("prepared");
    expectOk(await h.spend.resume(RESUME));
    expect(expectOk(await h.spend.haltStatus())).toEqual({ ok: true, halted: false, observations: [] });
    expectOk(await h.spend.transition(launch));
  });

  it("keeps settlement, transitions, reconciliation, transfers, cap raises and the slot working", async () => {
    const inFlight = await reserveAndLaunch(h, 1);
    const toClose = expectOk(await h.spend.reserve(reserveRequest(2))).operation_id;
    await haltWithOverrun(h, 3);

    expectOk(
      await h.spend.transition({
        operation_id: inFlight,
        from_state: "launching",
        to_state: "running",
        actor_role: "workflow",
        provider_resource_id: "synthetic-resource",
      }),
    );
    expectOk(
      await h.spend.transition({
        operation_id: inFlight,
        from_state: "running",
        to_state: "terminal",
        actor_role: "workflow",
        terminal_status: "completed",
      }),
    );
    expectOk(await h.spend.settle(settlement(inFlight)));
    expectOk(await h.spend.reconcile(reconciliation(toClose)));
    expectOk(
      await h.spend.transfer({
        pool_key: "judge-demo",
        from_allocation_key: "public",
        to_allocation_key: "judge",
        amount_microusd: 1,
        actor_role: "operator",
        reason: "synthetic",
      }),
    );
    expectOk(await h.spend.raiseCap({ pool_key: POOL, new_cap_microusd: 2_000_000, actor_role: "owner", reason: "synthetic" }));
    expectOk(await h.spend.releaseSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow", evidence: null, reason: null }));
    expectOk(await h.spend.acquireSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow" }));
    expect(expectOk(await h.spend.haltStatus()).halted).toBe(true);
  });

  it("clears every earlier observation with one resume and halts again on a later one", async () => {
    const overrun: Partial<UsageSettlement> = {
      service_lines: [
        { service: "synthetic-llm", unit: "input_token", actual_quantity: 1000, actual_microusd: 1001, retained_microusd: 0 },
      ],
    };
    const first = await reserveToTerminal(h, 1);
    const second = await reserveToTerminal(h, 2);
    expectOk(await h.spend.settle(settlement(first, overrun)));
    expectOk(await h.spend.settle(settlement(second, overrun)));
    expect(expectOk(await h.spend.haltStatus()).observations).toHaveLength(2);
    expectOk(await h.spend.resume(RESUME));
    expectOk(await h.spend.reserve(reserveRequest(3)));
    await haltWithOverrun(h, 4);
    const halt = expectOk(await h.spend.haltStatus());
    expect(halt.halted).toBe(true);
    expect(halt.observations).toHaveLength(1);
  });

  it("refuses a resume while nothing is halted", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.resume(RESUME), "invalid_request");
    });
  });

  it.each([
    ["a component role", { actor_role: "workflow" }],
    ["empty evidence", { evidence: [] }],
    ["an empty evidence object", { evidence: [{}] }],
    ["a valid evidence element mixed with an empty object", { evidence: [{ key: "synthetic/ok", sha256: hex(1) }, {}] }],
    ["an empty reason", { reason: "" }],
  ])("refuses a resume with %s", async (_name, overrides) => {
    await haltWithOverrun(h, 1);
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.resume(loose({ ...RESUME, ...overrides })), "invalid_request");
    });
  });

  it("does not halt when usage stays within the envelope", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: [line({ limit: 1000 })] });
    expectOk(
      await h.spend.settle(
        settlement(op, {
          service_lines: [
            { service: "synthetic-llm", unit: "input_token", actual_quantity: 1000, actual_microusd: 1000, retained_microusd: 0 },
          ],
        }),
      ),
    );
    expect(expectOk(await h.spend.haltStatus()).halted).toBe(false);
  });
});
