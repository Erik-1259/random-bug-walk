import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ManualReconciliation, OperationState, ReconciliationDecision } from "../../src/types.ts";
import {
  expectNothingWritten,
  expectOk,
  expectRefused,
  harness,
  hex,
  line,
  loose,
  openDb,
  POOL,
  reconciliation,
  reserveAndLaunch,
  reserveRequest,
  reserveToTerminal,
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

/** Brings a new operation (worst case 1,000) to `state`. */
async function operationIn(state: OperationState, n = 1): Promise<string> {
  if (state === "prepared") {
    expectOk(await h.spend.acquireSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow" }));
    return expectOk(await h.spend.reserve(reserveRequest(n))).operation_id;
  }
  if (state === "terminal") {
    return reserveToTerminal(h, n);
  }
  const op = await reserveAndLaunch(h, n);
  if (state === "running") {
    expectOk(
      await h.spend.transition({
        operation_id: op,
        from_state: "launching",
        to_state: "running",
        actor_role: "workflow",
        provider_resource_id: `synthetic-resource-${String(n)}`,
      }),
    );
  } else if (state === "uncertain") {
    expectOk(
      await h.spend.transition({
        operation_id: op,
        from_state: "launching",
        to_state: "uncertain",
        actor_role: "workflow",
        uncertainty: "lost_response",
      }),
    );
  } else if (state === "reconciled") {
    expectOk(await h.spend.reconcile(reconciliation(op, { previous_state: "launching" })));
  }
  return op;
}

function closing(op: string, previous: OperationState, decision: ReconciliationDecision, overrides: Partial<ManualReconciliation> = {}) {
  return reconciliation(op, { previous_state: previous, decision, retained_microusd: 250, released_microusd: 750, ...overrides });
}

async function opStatus(op: string) {
  return expectOk(await h.spend.operationStatus({ operation_id: op }));
}

describe("confirm_no_launch", () => {
  it.each(["prepared", "launching", "uncertain"] as const)("closes an operation from %s", async (previous) => {
    const op = await operationIn(previous);
    const result = expectOk(await h.spend.reconcile(reconciliation(op, { previous_state: previous })));
    expect(result).toMatchObject({ state: "reconciled", retained_microusd: 0n, released_microusd: 1000n, over_envelope: false });
    expect(await opStatus(op)).toMatchObject({ state: "reconciled", open_microusd: 0n, released_microusd: 1000n });
    expect(expectOk(await h.spend.poolStatus({ pool_key: POOL })).committed_microusd).toBe(0n);
  });

  it("retains an evidenced charge from prepared", async () => {
    const op = await operationIn("prepared");
    expectOk(await h.spend.reconcile(reconciliation(op, { retained_microusd: 100, released_microusd: 900 })));
    expect(await opStatus(op)).toMatchObject({ settled_microusd: 100n, released_microusd: 900n, open_microusd: 0n });
  });

  it.each(["running", "terminal", "reconciled"] as const)("is refused from %s", async (previous) => {
    const op = await operationIn(previous);
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reconcile(reconciliation(op, { previous_state: previous })), "invalid_transition");
    });
  });

  it("refuses listed resources", async () => {
    const op = await operationIn("uncertain");
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.reconcile(reconciliation(op, { previous_state: "uncertain", provider_resource_ids: ["synthetic-r"] })),
        "invalid_request",
      );
    });
  });
});

describe("found_running", () => {
  it.each(["launching", "uncertain"] as const)("moves an operation from %s to running and records its resources", async (previous) => {
    const op = await operationIn(previous);
    const result = expectOk(
      await h.spend.reconcile(
        reconciliation(op, {
          previous_state: previous,
          decision: "found_running",
          provider_resource_ids: ["synthetic-found-1", "synthetic-found-2"],
          retained_microusd: 1000,
          released_microusd: 0,
        }),
      ),
    );
    expect(result.state).toBe("running");
    expect(await opStatus(op)).toMatchObject({ state: "running", open_microusd: 1000n });
    const slot = expectOk(await h.spend.slotStatus({ slot_key: SLOT }));
    expect(slot.children.map((c) => [c.resource_id, c.confirmed])).toEqual([
      ["synthetic-found-1", false],
      ["synthetic-found-2", false],
    ]);
    expect(slot.release_blockers.child_resources).toHaveLength(2);
  });

  it.each(["prepared", "running", "terminal", "reconciled"] as const)("is refused from %s", async (previous) => {
    const op = await operationIn(previous);
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.reconcile(
          reconciliation(op, {
            previous_state: previous,
            decision: "found_running",
            provider_resource_ids: ["synthetic-found"],
            retained_microusd: 1000,
            released_microusd: 0,
          }),
        ),
        "invalid_transition",
      );
    });
  });

  it.each([
    ["no resource id", { provider_resource_ids: [] }],
    ["a release", { retained_microusd: 900, released_microusd: 100 }],
  ])("refuses %s", async (_name, overrides) => {
    const op = await operationIn("uncertain");
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.reconcile(
          reconciliation(op, {
            previous_state: "uncertain",
            decision: "found_running",
            provider_resource_ids: ["synthetic-found"],
            retained_microusd: 1000,
            released_microusd: 0,
            ...overrides,
          }),
        ),
        "invalid_request",
      );
    });
  });
});

describe("accept_complete and confirm_stopped_incomplete", () => {
  const decisions = ["accept_complete", "confirm_stopped_incomplete"] as const;
  const allowed = ["launching", "running", "uncertain", "terminal"] as const;

  for (const decision of decisions) {
    it.each(allowed)(`${decision} closes an operation from %s`, async (previous) => {
      const op = await operationIn(previous);
      const result = expectOk(await h.spend.reconcile(closing(op, previous, decision)));
      expect(result).toMatchObject({ state: "reconciled", retained_microusd: 250n, released_microusd: 750n });
      expect(await opStatus(op)).toMatchObject({ settled_microusd: 250n, released_microusd: 750n, open_microusd: 0n });
      expectRefused(await h.spend.settle(settlement(op)), "invalid_transition");
    });

    it.each(["prepared", "reconciled"] as const)(`${decision} is refused from %s`, async (previous) => {
      const op = await operationIn(previous);
      await expectNothingWritten(h, async () => {
        expectRefused(await h.spend.reconcile(closing(op, previous, decision)), "invalid_transition");
      });
    });
  }

  it("records the listed resources as confirmed terminal, which unblocks the slot release", async () => {
    const op = await operationIn("running");
    expectRefused(
      await h.spend.releaseSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow", evidence: null, reason: null }),
      "slot_release_blocked",
    );
    expectOk(
      await h.spend.reconcile(closing(op, "running", "accept_complete", { provider_resource_ids: ["synthetic-resource-1"] })),
    );
    const slot = expectOk(await h.spend.slotStatus({ slot_key: SLOT }));
    expect(slot.children.map((c) => [c.resource_id, c.confirmed])).toEqual([["synthetic-resource-1", true]]);
    expect(slot.release_blockers).toEqual({ child_resources: [], operation_ids: [] });
    expectOk(
      await h.spend.releaseSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow", evidence: null, reason: null }),
    );
  });

  it("closes the retained amount left by a partly unknown settlement", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: [line(), line({ unit: "output_token", limit: 500 })] });
    expectOk(
      await h.spend.settle(
        settlement(op, {
          reserved_microusd: 1500,
          usage_state: "partly_unknown",
          service_lines: [
            { service: "synthetic-llm", unit: "input_token", actual_quantity: 100, actual_microusd: 100, retained_microusd: 0 },
            { service: "synthetic-llm", unit: "output_token", actual_quantity: null, actual_microusd: null, retained_microusd: 500 },
          ],
        }),
      ),
    );
    expectRefused(
      await h.spend.reconcile(closing(op, "terminal", "accept_complete", { retained_microusd: 300, released_microusd: 700 })),
      "invalid_request",
    );
    expectOk(await h.spend.reconcile(closing(op, "terminal", "accept_complete", { retained_microusd: 300, released_microusd: 200 })));
    expect(await opStatus(op)).toMatchObject({
      state: "reconciled",
      reserved_microusd: 1500n,
      settled_microusd: 400n,
      open_microusd: 0n,
      released_microusd: 1100n,
    });
  });
});

describe("the money rule", () => {
  it("refuses retained + released that differs from the open amount", async () => {
    const op = await operationIn("running");
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.reconcile(closing(op, "running", "accept_complete", { retained_microusd: 250, released_microusd: 749 })),
        "invalid_request",
      );
    });
  });

  it("records evidenced usage above the open amount in full and halts new work", async () => {
    const op = await operationIn("running");
    const result = expectOk(
      await h.spend.reconcile(closing(op, "running", "accept_complete", { retained_microusd: 1500, released_microusd: 0 })),
    );
    expect(result.over_envelope).toBe(true);
    expect(await opStatus(op)).toMatchObject({ settled_microusd: 1500n, released_microusd: 0n, open_microusd: 0n });
    const halt = expectOk(await h.spend.haltStatus());
    expect(halt.halted).toBe(true);
    expect(halt.observations[0]).toMatchObject({ source: "reconciliation", observed_microusd: 1500n, bound_microusd: 1000n });
  });

  it("refuses usage above the open amount combined with a release", async () => {
    const op = await operationIn("running");
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.reconcile(closing(op, "running", "accept_complete", { retained_microusd: 1500, released_microusd: 1 })),
        "invalid_request",
      );
    });
  });
});

describe("reconciliation input", () => {
  it("refuses a previous_state that is not the current state", async () => {
    const op = await operationIn("running");
    await expectNothingWritten(h, async () => {
      const refusal = expectRefused(await h.spend.reconcile(closing(op, "uncertain", "accept_complete")), "invalid_transition");
      expect(refusal.current_state).toBe("running");
    });
  });

  it("refuses an unknown operation", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reconcile(reconciliation(hex(5150))), "unknown_operation");
    });
  });

  const malformed: [string, Record<string, unknown>][] = [
    ["empty evidence", { evidence: [] }],
    ["an empty evidence object", { evidence: [{}] }],
    ["a valid evidence element mixed with an empty object", { evidence: [{ key: "synthetic/e", sha256: hex(1) }, {}] }],
    ["evidence with a malformed hash", { evidence: [{ key: "synthetic/e", sha256: "abc" }] }],
    ["evidence with an empty key", { evidence: [{ key: "", sha256: hex(1) }] }],
    ["evidence with an unknown field", { evidence: [{ key: "synthetic/e", sha256: hex(1), note: "x" }] }],
    ["a component role", { actor_role: "workflow" }],
    ["an empty reason", { reason: "" }],
    ["schema_version 2", { schema_version: 2 }],
    ["an unknown field", { clear: true }],
    ["a recorded_at without Z", { recorded_at: "2026-10-04T01:00:00+00:00" }],
    ["an unknown decision", { decision: "clear" }],
    ["a negative retained amount", { retained_microusd: -1, released_microusd: 1001 }],
    ["an empty resource id", { provider_resource_ids: [""] }],
  ];

  it.each(malformed)("refuses %s as invalid_request", async (_name, overrides) => {
    const op = await operationIn("prepared");
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reconcile(loose({ ...reconciliation(op), ...overrides })), "invalid_request");
    });
  });
});
