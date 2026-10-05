import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OperationState, TransitionRequest } from "../../src/types.ts";
import {
  expectNothingWritten,
  expectOk,
  expectRefused,
  haltWithOverrun,
  harness,
  hex,
  openDb,
  OTHER_ROOT,
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

function launching(operationId: string, slotKey = SLOT): TransitionRequest {
  return { operation_id: operationId, from_state: "prepared", to_state: "launching", actor_role: "workflow", slot_key: slotKey };
}

function running(operationId: string, resourceId = "synthetic-resource-1"): TransitionRequest {
  return {
    operation_id: operationId,
    from_state: "launching",
    to_state: "running",
    actor_role: "workflow",
    provider_resource_id: resourceId,
  };
}

function terminal(operationId: string, from: OperationState): TransitionRequest {
  return { operation_id: operationId, from_state: from, to_state: "terminal", actor_role: "workflow", terminal_status: "completed" };
}

function uncertain(operationId: string, from: OperationState): TransitionRequest {
  return { operation_id: operationId, from_state: from, to_state: "uncertain", actor_role: "workflow", uncertainty: "lost_response" };
}

async function state(operationId: string): Promise<OperationState> {
  return expectOk(await h.spend.operationStatus({ operation_id: operationId })).state;
}

async function prepared(n: number): Promise<string> {
  expectOk(await h.spend.acquireSlot({ slot_key: SLOT, root_execution_id: ROOT, actor_role: "workflow" }));
  return expectOk(await h.spend.reserve(reserveRequest(n))).operation_id;
}

describe("allowed transitions", () => {
  it("prepared → launching → running → terminal, recording and confirming the child resource", async () => {
    const op = await prepared(1);
    expect(expectOk(await h.spend.transition(launching(op))).state).toBe("launching");
    expect(expectOk(await h.spend.transition(running(op))).state).toBe("running");
    let slot = expectOk(await h.spend.slotStatus({ slot_key: SLOT }));
    expect(slot.children).toEqual([
      {
        provider: "synthetic-provider",
        resource_id: "synthetic-resource-1",
        operation_id: op,
        execution_id: ROOT,
        kind: "synthetic-call",
        confirmed: false,
        terminal_status: null,
      },
    ]);
    expect(expectOk(await h.spend.transition(terminal(op, "running"))).state).toBe("terminal");
    slot = expectOk(await h.spend.slotStatus({ slot_key: SLOT }));
    expect(slot.children[0]?.confirmed).toBe(true);
    expect(slot.children[0]?.terminal_status).toBe("completed");
  });

  it("launching → terminal for a synchronous call", async () => {
    const op = await reserveAndLaunch(h, 1);
    expect(expectOk(await h.spend.transition(terminal(op, "launching"))).state).toBe("terminal");
  });

  it("launching → uncertain on a lost response", async () => {
    const op = await reserveAndLaunch(h, 1);
    expect(expectOk(await h.spend.transition(uncertain(op, "launching"))).state).toBe("uncertain");
  });

  it("running → uncertain on an unknown status", async () => {
    const op = await reserveAndLaunch(h, 1);
    expectOk(await h.spend.transition(running(op)));
    expect(
      expectOk(await h.spend.transition({ ...uncertain(op, "running"), uncertainty: "unknown_status" })).state,
    ).toBe("uncertain");
  });

  it("keeps the full reservation open while the call is in flight", async () => {
    const op = await reserveAndLaunch(h, 1);
    expectOk(await h.spend.transition(running(op)));
    const status = expectOk(await h.spend.operationStatus({ operation_id: op }));
    expect(status.open_microusd).toBe(1000n);
    expect(status.reserved_microusd).toBe(1000n);
  });
});

describe("refused transitions", () => {
  const fromPrepared: OperationState[] = ["running", "terminal", "uncertain", "reconciled", "prepared"];

  it.each(fromPrepared)("prepared → %s is invalid_transition and writes nothing", async (to) => {
    const op = await prepared(1);
    await expectNothingWritten(h, async () => {
      const refusal = expectRefused(
        await h.spend.transition({
          operation_id: op,
          from_state: "prepared",
          to_state: to,
          actor_role: "workflow",
          provider_resource_id: to === "running" ? "synthetic-resource" : undefined,
          terminal_status: to === "terminal" ? "completed" : undefined,
          uncertainty: to === "uncertain" ? "lost_response" : undefined,
        }),
        "invalid_transition",
      );
      expect(refusal.current_state).toBe("prepared");
    });
  });

  it("refuses a from_state that is not the current state and names the current state", async () => {
    const op = await prepared(1);
    await expectNothingWritten(h, async () => {
      const refusal = expectRefused(await h.spend.transition(terminal(op, "launching")), "invalid_transition");
      expect(refusal.current_state).toBe("prepared");
    });
  });

  it("refuses leaving terminal, reconciled or uncertain through a transition", async () => {
    const op = await reserveToTerminal(h, 1);
    expectRefused(await h.spend.transition(uncertain(op, "terminal")), "invalid_transition");
    expectRefused(await h.spend.transition({ ...running(op), from_state: "terminal" }), "invalid_transition");
    expectOk(await h.spend.settle(settlement(op)));
    expectRefused(await h.spend.transition(terminal(op, "reconciled")), "invalid_transition");

    const lost = await reserveAndLaunch(h, 2);
    expectOk(await h.spend.transition(uncertain(lost, "launching")));
    expectRefused(await h.spend.transition({ ...running(lost), from_state: "uncertain" }), "invalid_transition");
    expectRefused(await h.spend.transition(terminal(lost, "uncertain")), "invalid_transition");
    expect(await state(lost)).toBe("uncertain");
  });

  it("refuses running → launching and launching → launching", async () => {
    const op = await reserveAndLaunch(h, 1);
    expectRefused(await h.spend.transition({ ...launching(op), from_state: "launching" }), "invalid_transition");
    expectOk(await h.spend.transition(running(op)));
    expectRefused(await h.spend.transition({ ...launching(op), from_state: "running" }), "invalid_transition");
  });

  it("refuses an unknown operation", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.transition(launching(hex(31337))), "unknown_operation");
    });
  });

  it.each([
    ["launching without a slot key", { to_state: "launching", slot_key: undefined }],
    ["running without a resource id", { from_state: "launching", to_state: "running" }],
    ["terminal with an unknown status", { from_state: "launching", to_state: "terminal", terminal_status: "done" }],
    ["an unknown state name", { to_state: "finished" }],
    ["a field that does not belong to the target", { to_state: "launching", slot_key: SLOT, terminal_status: "completed" }],
  ])("refuses %s as invalid_request", async (_name, overrides) => {
    const op = await prepared(1);
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.transition({
          operation_id: op,
          from_state: "prepared",
          to_state: "launching",
          actor_role: "workflow",
          ...(overrides as Partial<TransitionRequest>),
        }),
        "invalid_request",
      );
    });
  });

  it("enters launching at most once, also against direct SQL with the write setting on", async () => {
    const op = await reserveAndLaunch(h, 1);
    await expect(
      h.sqlAsFunction(
        `INSERT INTO operation_events (operation_id, prior_seq, from_state, to_state, cause, slot_key, actor_role, recorded_at)
         SELECT $1::text, max(seq), 'prepared', 'launching', 'transition', $2::text, 'workflow', now() FROM operation_events WHERE operation_id = $1::text`,
        [op, SLOT],
      ),
    ).rejects.toThrow(/is not in state prepared/);
    expect(await state(op)).toBe("launching");
  });
});

describe("prepared → launching under the slot", () => {
  it("refuses with slot_not_held when the slot is free", async () => {
    const op = expectOk(await h.spend.reserve(reserveRequest(1))).operation_id;
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.transition(launching(op)), "slot_not_held");
    });
  });

  it("refuses with slot_not_held when another root holds the slot", async () => {
    expectOk(await h.spend.acquireSlot({ slot_key: SLOT, root_execution_id: OTHER_ROOT, actor_role: "workflow" }));
    const op = expectOk(await h.spend.reserve(reserveRequest(1))).operation_id;
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.transition(launching(op)), "slot_not_held");
    });
  });

  it("refuses with unknown_slot for a slot key that was never created", async () => {
    const op = await prepared(1);
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.transition(launching(op, "synthetic-missing")), "unknown_slot");
    });
  });

  it("applies the refusal order invalid_transition, pool_halted, unknown_slot, slot_not_held", async () => {
    expectOk(await h.spend.createSlotKey({ slot_key: "synthetic-free", actor_role: "owner", reason: "synthetic" }));
    const launched = await reserveAndLaunch(h, 1);
    const waiting = expectOk(await h.spend.reserve(reserveRequest(2))).operation_id;
    await haltWithOverrun(h, 3);

    // All four conditions hold for `launched` (it is not prepared).
    expectRefused(await h.spend.transition(launching(launched, "synthetic-missing")), "invalid_transition");
    // Halted, unknown slot and slot not held all hold for `waiting`.
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.transition(launching(waiting, "synthetic-missing")), "pool_halted");
      expectRefused(await h.spend.transition(launching(waiting, "synthetic-free")), "pool_halted");
    });
    expectOk(await h.spend.resume(RESUME));
    expectRefused(await h.spend.transition(launching(waiting, "synthetic-missing")), "unknown_slot");
    expectRefused(await h.spend.transition(launching(waiting, "synthetic-free")), "slot_not_held");
    expect(await state(waiting)).toBe("prepared");
    expectOk(await h.spend.transition(launching(waiting)));
  });
});

describe("leaving prepared", () => {
  it("is possible only through launching or confirm_no_launch", async () => {
    const op = await prepared(1);
    expectRefused(await h.spend.settle(settlement(op)), "invalid_transition");
    for (const decision of ["found_running", "accept_complete", "confirm_stopped_incomplete"] as const) {
      expectRefused(
        await h.spend.reconcile(
          reconciliation(op, { decision, provider_resource_ids: ["synthetic-resource"], retained_microusd: 1000, released_microusd: 0 }),
        ),
        "invalid_transition",
      );
    }
    expect(await state(op)).toBe("prepared");
    const closed = expectOk(await h.spend.reconcile(reconciliation(op)));
    expect(closed.state).toBe("reconciled");
    expect(closed.released_microusd).toBe(1000n);
    const status = expectOk(await h.spend.operationStatus({ operation_id: op }));
    expect(status).toMatchObject({ open_microusd: 0n, settled_microusd: 0n, released_microusd: 1000n });
  });
});

describe("terminal confirmation of child resources", () => {
  it("confirms only the resource the operation named, not other children linked to it", async () => {
    const op = await reserveAndLaunch(h, 1);
    expectOk(
      await h.spend.recordChild({
        slot_key: SLOT,
        root_execution_id: ROOT,
        provider: "synthetic-other-provider",
        resource_id: "synthetic-sandbox",
        operation_id: op,
        execution_id: ROOT,
        kind: "synthetic-sandbox",
        actor_role: "workflow",
      }),
    );
    expectOk(await h.spend.transition(running(op)));
    expectOk(await h.spend.transition(terminal(op, "running")));
    const slot = expectOk(await h.spend.slotStatus({ slot_key: SLOT }));
    expect(slot.children.map((c) => [c.resource_id, c.confirmed])).toEqual([
      ["synthetic-sandbox", false],
      ["synthetic-resource-1", true],
    ]);
    expect(slot.release_blockers.child_resources).toEqual([
      { slot_key: SLOT, provider: "synthetic-other-provider", resource_id: "synthetic-sandbox" },
    ]);
  });

  it("confirms the named resource when the holder recorded it before the running transition", async () => {
    const op = await reserveAndLaunch(h, 1);
    expectOk(
      await h.spend.recordChild({
        slot_key: SLOT,
        root_execution_id: ROOT,
        provider: "synthetic-provider",
        resource_id: "synthetic-resource-1",
        operation_id: null,
        execution_id: null,
        kind: "synthetic-call",
        actor_role: "workflow",
      }),
    );
    expectOk(await h.spend.transition(running(op)));
    expectOk(await h.spend.transition(terminal(op, "running")));
    const slot = expectOk(await h.spend.slotStatus({ slot_key: SLOT }));
    expect(slot.children.map((c) => [c.resource_id, c.confirmed])).toEqual([["synthetic-resource-1", true]]);
    expect(slot.release_blockers).toEqual({ child_resources: [], operation_ids: [] });
  });
});
