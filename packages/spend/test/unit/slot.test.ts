import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ReleaseSlotRequest } from "../../src/types.ts";
import {
  expectNothingWritten,
  expectOk,
  expectRefused,
  harness,
  hex,
  ONE_YEAR_MS,
  openDb,
  OTHER_ROOT,
  POOL,
  reconciliation,
  reserveAndLaunch,
  reserveRequest,
  ROOT,
  setup,
  SLOT,
  uuid,
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

function acquire(root = ROOT, slotKey = SLOT) {
  return h.spend.acquireSlot({ slot_key: slotKey, root_execution_id: root, actor_role: "workflow" });
}

function release(overrides: Partial<ReleaseSlotRequest> = {}) {
  return h.spend.releaseSlot({
    slot_key: SLOT,
    root_execution_id: ROOT,
    actor_role: "workflow",
    evidence: null,
    reason: null,
    ...overrides,
  });
}

function child(resourceId: string, overrides: Record<string, unknown> = {}) {
  return h.spend.recordChild({
    slot_key: SLOT,
    root_execution_id: ROOT,
    provider: "synthetic-provider",
    resource_id: resourceId,
    operation_id: null,
    execution_id: uuid(50),
    kind: "synthetic-sandbox",
    actor_role: "workflow",
    ...overrides,
  });
}

function confirm(resourceId: string, root = ROOT) {
  return h.spend.confirmChild({
    slot_key: SLOT,
    root_execution_id: root,
    provider: "synthetic-provider",
    resource_id: resourceId,
    terminal_status: "completed",
    evidence: { key: `synthetic/${resourceId}.json`, sha256: hex(9) },
    actor_role: "workflow",
  });
}

describe("slot keys", () => {
  it("refuses every slot action on a key that was never created", async () => {
    const missing = "synthetic-missing";
    await expectNothingWritten(h, async () => {
      expectRefused(await acquire(ROOT, missing), "unknown_slot");
      expectRefused(await child("synthetic-r", { slot_key: missing }), "unknown_slot");
      expectRefused(
        await h.spend.confirmChild({
          slot_key: missing,
          root_execution_id: ROOT,
          provider: "synthetic-provider",
          resource_id: "synthetic-r",
          terminal_status: "completed",
          evidence: { key: "synthetic/e", sha256: hex(1) },
          actor_role: "workflow",
        }),
        "unknown_slot",
      );
      expectRefused(await release({ slot_key: missing }), "unknown_slot");
      expectRefused(await h.spend.slotStatus({ slot_key: missing }), "unknown_slot");
    });
  });

  it("requires the owner to create a slot key", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.createSlotKey({ slot_key: "synthetic-other", actor_role: "operator", reason: "synthetic" }),
        "invalid_request",
      );
      expectRefused(await h.spend.createSlotKey({ slot_key: SLOT, actor_role: "owner", reason: "again" }), "invalid_request");
    });
  });

  it("starts free", async () => {
    expect(expectOk(await h.spend.slotStatus({ slot_key: SLOT }))).toEqual({
      ok: true,
      slot_key: SLOT,
      holder: null,
      children: [],
      release_blockers: { child_resources: [], operation_ids: [] },
    });
  });
});

describe("acquire", () => {
  it("acquires a free slot, replays for the holder and refuses another root", async () => {
    const first = expectOk(await acquire());
    expect(first).toMatchObject({ replay: false, holder: ROOT });
    await expectNothingWritten(h, async () => {
      expect(expectOk(await acquire())).toMatchObject({ replay: true, holder: ROOT });
      expectRefused(await acquire(OTHER_ROOT), "slot_held");
    });
    expect(expectOk(await h.spend.slotStatus({ slot_key: SLOT })).holder).toBe(ROOT);
  });

  it("lets another root acquire after release", async () => {
    expectOk(await acquire());
    expectOk(await release());
    expectOk(await acquire(OTHER_ROOT));
    expectRefused(await acquire(), "slot_held");
  });

  it("enforces a single holder against direct SQL with the write setting on", async () => {
    expectOk(await acquire());
    await expect(
      h.sqlAsFunction(
        `INSERT INTO slot_events (slot_key, prior_seq, kind, root_execution_id, actor_role, recorded_at)
         SELECT $1::text, max(seq), 'acquire', $2::text, 'workflow', now() FROM slot_events WHERE slot_key = $1::text`,
        [SLOT, OTHER_ROOT],
      ),
    ).rejects.toThrow(/is already held/);
  });

  it("still blocks another root and still counts the reservation a year later", async () => {
    expectOk(await acquire());
    expectOk(await h.spend.reserve(reserveRequest(1)));
    h.clock.advance(ONE_YEAR_MS);
    expectRefused(await acquire(OTHER_ROOT), "slot_held");
    const pool = expectOk(await h.spend.poolStatus({ pool_key: POOL }));
    expect(pool.open_microusd).toBe(1000n);
    expect(pool.available_microusd).toBe(999_000n);
    const events = await h.sql("SELECT recorded_at::text AS at FROM slot_events ORDER BY seq");
    expect(events).toEqual([{ at: "2026-10-04 00:00:00+00" }]);
  });
});

describe("child resources", () => {
  it("refuses to record a child for a root that does not hold the slot", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await child("synthetic-r"), "slot_not_held");
    });
    expectOk(await acquire(OTHER_ROOT));
    await expectNothingWritten(h, async () => {
      expectRefused(await child("synthetic-r"), "slot_not_held");
      expectRefused(await confirm("synthetic-r"), "slot_not_held");
    });
  });

  it("records a child once and confirms it once", async () => {
    expectOk(await acquire());
    expect(expectOk(await child("synthetic-r")).replay).toBe(false);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await child("synthetic-r")).replay).toBe(true);
    });
    expect(expectOk(await confirm("synthetic-r")).replay).toBe(false);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await confirm("synthetic-r")).replay).toBe(true);
    });
  });

  it("refuses to confirm a child that was never recorded", async () => {
    expectOk(await acquire());
    await expectNothingWritten(h, async () => {
      expectRefused(await confirm("synthetic-unrecorded"), "invalid_request");
    });
  });
});

describe("release", () => {
  it("is blocked by an unconfirmed child until it is confirmed", async () => {
    expectOk(await acquire());
    expectOk(await child("synthetic-r"));
    await expectNothingWritten(h, async () => {
      const refusal = expectRefused(await release(), "slot_release_blocked");
      expect(refusal.blocking_child_resources).toEqual([{ slot_key: SLOT, provider: "synthetic-provider", resource_id: "synthetic-r" }]);
      expect(refusal.blocking_operation_ids).toEqual([]);
    });
    expectOk(await confirm("synthetic-r"));
    expectOk(await release());
    expect(expectOk(await h.spend.slotStatus({ slot_key: SLOT })).holder).toBeNull();
  });

  it("is blocked by the root's unconfirmed child recorded under another slot key", async () => {
    const otherSlot = "synthetic-other-account";
    expectOk(await h.spend.createSlotKey({ slot_key: otherSlot, actor_role: "owner", reason: "synthetic second account" }));
    expectOk(await acquire());
    expectOk(await acquire(ROOT, otherSlot));
    expectOk(await child("synthetic-elsewhere", { slot_key: otherSlot }));
    await expectNothingWritten(h, async () => {
      const refusal = expectRefused(await release(), "slot_release_blocked");
      expect(refusal.blocking_child_resources).toEqual([
        { slot_key: otherSlot, provider: "synthetic-provider", resource_id: "synthetic-elsewhere" },
      ]);
    });
    expect(expectOk(await h.spend.slotStatus({ slot_key: SLOT })).release_blockers.child_resources).toHaveLength(1);
    expectOk(
      await h.spend.confirmChild({
        slot_key: otherSlot,
        root_execution_id: ROOT,
        provider: "synthetic-provider",
        resource_id: "synthetic-elsewhere",
        terminal_status: "completed",
        evidence: { key: "synthetic/elsewhere.json", sha256: hex(9) },
        actor_role: "workflow",
      }),
    );
    expectOk(await release());
    expectOk(await acquire(OTHER_ROOT));
  });

  it("is blocked by a prepared operation of the root", async () => {
    expectOk(await acquire());
    const op = expectOk(await h.spend.reserve(reserveRequest(1))).operation_id;
    await expectNothingWritten(h, async () => {
      const refusal = expectRefused(await release(), "slot_release_blocked");
      expect(refusal.blocking_operation_ids).toEqual([op]);
    });
    expectOk(await h.spend.reconcile(reconciliation(op)));
    expectOk(await release());
  });

  it("is blocked by launching, running and uncertain operations", async () => {
    const launchingOp = await reserveAndLaunch(h, 1);
    const runningOp = await reserveAndLaunch(h, 2);
    expectOk(
      await h.spend.transition({
        operation_id: runningOp,
        from_state: "launching",
        to_state: "running",
        actor_role: "workflow",
        provider_resource_id: "synthetic-running",
      }),
    );
    const uncertainOp = await reserveAndLaunch(h, 3);
    expectOk(
      await h.spend.transition({
        operation_id: uncertainOp,
        from_state: "launching",
        to_state: "uncertain",
        actor_role: "workflow",
        uncertainty: "lost_response",
      }),
    );
    const refusal = expectRefused(await release(), "slot_release_blocked");
    expect([...(refusal.blocking_operation_ids ?? [])].sort()).toEqual([launchingOp, runningOp, uncertainOp].sort());
    expect(refusal.blocking_child_resources).toEqual([{ slot_key: SLOT, provider: "synthetic-provider", resource_id: "synthetic-running" }]);
  });

  it("is not blocked by another root's operations", async () => {
    expectOk(await h.spend.reserve(reserveRequest(1, { root_execution_id: OTHER_ROOT, execution_id: OTHER_ROOT })));
    expectOk(await acquire());
    expectOk(await release());
  });

  it("refuses a release by a root that does not hold the slot", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await release(), "slot_not_held");
    });
    expectOk(await acquire(OTHER_ROOT));
    await expectNothingWritten(h, async () => {
      expectRefused(await release(), "slot_not_held");
    });
  });

  it("lets an operator release with evidence and a reason", async () => {
    expectOk(await acquire());
    await expectNothingWritten(h, async () => {
      expectRefused(await release({ actor_role: "operator" }), "invalid_request");
      expectRefused(
        await release({ actor_role: "operator", evidence: [], reason: "synthetic" }),
        "invalid_request",
      );
    });
    expectOk(
      await release({
        actor_role: "operator",
        evidence: [{ key: "synthetic/release.json", sha256: hex(3) }],
        reason: "synthetic workflow stopped",
      }),
    );
    const rows = await h.sql("SELECT kind, actor_role, reason FROM slot_events ORDER BY seq");
    expect(rows).toEqual([
      { kind: "acquire", actor_role: "workflow", reason: null },
      { kind: "release", actor_role: "operator", reason: "synthetic workflow stopped" },
    ]);
  });
});
