import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  reserveRequest,
  reserveToTerminal,
  settlement,
  setup,
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

function exactly(microusd: number) {
  return [line({ limit: microusd, price: { microusd: 1, per_units: 1 } })];
}

describe("check-and-reserve", () => {
  it("fits an exact amount and refuses one micro-USD more, recording the refusal", async () => {
    await expectNothingWritten(
      h,
      async () => {
        const refused = expectRefused(
          await h.spend.reserve(reserveRequest(1, { envelope: exactly(1_000_001) })),
          "insufficient_funds",
        );
        expect(refused.requested_microusd).toBe(1_000_001n);
        expect(refused.pool_available_microusd).toBe(1_000_000n);
      },
      ["reservation_refusals"],
    );
    const refusals = await h.sql(
      "SELECT code, requested_microusd::text AS requested, pool_available_microusd::text AS available FROM reservation_refusals",
    );
    expect(refusals).toEqual([{ code: "insufficient_funds", requested: "1000001", available: "1000000" }]);

    const fit = expectOk(await h.spend.reserve(reserveRequest(2, { envelope: exactly(1_000_000) })));
    expect(fit.replay).toBe(false);
    expect(fit.state).toBe("prepared");
    expect(fit.reserved_microusd).toBe(1_000_000n);
    expect(fit.pool_available_microusd).toBe(0n);
    expect(fit.allocation_available_microusd).toBeNull();

    expectRefused(await h.spend.reserve(reserveRequest(3, { envelope: exactly(1) })), "insufficient_funds");
  });

  it("runs the reserve path exactly once per call, without retrying", async () => {
    expectOk(await h.spend.reserve(reserveRequest(1, { envelope: exactly(1_000_000) })));
    const spy = vi.spyOn(h.db, "query");
    try {
      expectRefused(await h.spend.reserve(reserveRequest(2, { envelope: exactly(1) })), "insufficient_funds");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("spend_reserve");
    } finally {
      spy.mockRestore();
    }
  });

  it("counts an open reservation at its full worst case", async () => {
    expectOk(await h.spend.reserve(reserveRequest(1, { envelope: exactly(400_000) })));
    const pool = expectOk(await h.spend.poolStatus({ pool_key: POOL }));
    expect(pool.open_microusd).toBe(400_000n);
    expect(pool.settled_microusd).toBe(0n);
    expect(pool.committed_microusd).toBe(400_000n);
    expect(pool.available_microusd).toBe(600_000n);
  });

  it("refuses an unknown pool", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(reserveRequest(1, { pool_key: "synthetic-missing" })), "unknown_pool");
    });
  });

  it("refuses an allocation on a pool without allocations", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(reserveRequest(1, { allocation_key: "public" })), "unknown_allocation");
    });
  });

  it("refuses a reservation without an allocation on a pool with allocations", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(reserveRequest(1, { pool_key: "judge-demo" })), "unknown_allocation");
    });
  });

  it("refuses an allocation the pool does not have", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.reserve(reserveRequest(1, { pool_key: "judge-demo", allocation_key: "synthetic-other" })),
        "unknown_allocation",
      );
    });
  });

  const malformed: [string, Record<string, unknown>][] = [
    ["an uppercase operation_id", { operation_id: "A".repeat(64) }],
    ["a short payload_hash", { payload_hash: "abc" }],
    ["an uppercase project_id", { project_id: "ABCDEF00-0000-4000-8000-000000000005" }],
    ["a malformed batch_id", { batch_id: "synthetic-batch" }],
    ["a zero attempt_ordinal", { attempt_ordinal: 0 }],
    ["a fractional attempt_ordinal", { attempt_ordinal: 1.5 }],
    ["a previous_operation_id on a first attempt", { previous_operation_id: hex(9) }],
    ["a second attempt without previous_operation_id", { attempt_ordinal: 2 }],
    ["a child execution without a parent", { execution_id: uuid(9) }],
    ["a root execution with a parent", { parent_execution_id: uuid(9) }],
    ["a malformed kind", { kind: "Synthetic Call" }],
    ["an empty provider_replay_key", { provider_replay_key: "" }],
    ["a malformed pool key", { pool_key: "Synthetic_Pool" }],
    ["an unknown field", { note: "synthetic" }],
    ["a missing field", { task_revision: undefined }],
  ];

  it.each(malformed)("refuses %s as invalid_request", async (_name, overrides) => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(loose({ ...reserveRequest(1), ...overrides })), "invalid_request");
    });
  });
});

describe("idempotent replay", () => {
  it("returns the existing reservation for identical intent and writes nothing", async () => {
    const first = expectOk(await h.spend.reserve(reserveRequest(1)));
    await expectNothingWritten(h, async () => {
      const again = expectOk(await h.spend.reserve(reserveRequest(1)));
      expect(again.replay).toBe(true);
      expect(again.operation_id).toBe(first.operation_id);
      expect(again.reserved_microusd).toBe(first.reserved_microusd);
      expect(again.state).toBe("prepared");
    });
  });

  it("reports the operation's current state on replay", async () => {
    await reserveToTerminal(h, 1);
    const again = expectOk(await h.spend.reserve(reserveRequest(1)));
    expect(again.replay).toBe(true);
    expect(again.state).toBe("terminal");
  });

  it("replays even when the pool could no longer fit the reservation", async () => {
    expectOk(await h.spend.reserve(reserveRequest(1, { envelope: exactly(1_000_000) })));
    const again = expectOk(await h.spend.reserve(reserveRequest(1, { envelope: exactly(1_000_000) })));
    expect(again.replay).toBe(true);
  });

  const conflicting: [string, Record<string, unknown>][] = [
    ["a different payload hash", { payload_hash: hex(99) }],
    ["a different envelope", { envelope: exactly(5) }],
    ["a different call name", { call_name: "synthetic.other" }],
    ["a different batch", { batch_id: uuid(77) }],
    ["an unknown pool", { pool_key: "synthetic-missing" }],
    ["an unpriced envelope", { envelope: [line({ price: null })] }],
  ];

  it.each(conflicting)("refuses %s as operation_conflict", async (_name, overrides) => {
    expectOk(await h.spend.reserve(reserveRequest(1)));
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve({ ...reserveRequest(1), ...overrides }), "operation_conflict");
    });
  });
});

describe("attempt chain", () => {
  function secondAttempt(previous: string) {
    return reserveRequest(2, { attempt_ordinal: 2, previous_operation_id: previous });
  }

  it("refuses a second attempt while the first is prepared", async () => {
    const first = expectOk(await h.spend.reserve(reserveRequest(1)));
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(secondAttempt(first.operation_id)), "previous_attempt_unresolved");
    });
  });

  it("refuses a second attempt naming an operation that does not exist", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(secondAttempt(hex(424242))), "previous_attempt_unresolved");
    });
  });

  it("refuses an attempt naming an operation more than one ordinal lower", async () => {
    const first = await reserveToTerminal(h, 1);
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.reserve(reserveRequest(3, { attempt_ordinal: 3, previous_operation_id: first })),
        "previous_attempt_unresolved",
      );
    });
  });

  it("accepts a second attempt after the first is terminal", async () => {
    const first = await reserveToTerminal(h, 1);
    expectOk(await h.spend.reserve(secondAttempt(first)));
  });

  it("accepts a second attempt after the first is reconciled", async () => {
    const first = expectOk(await h.spend.reserve(reserveRequest(1)));
    expectOk(await h.spend.reconcile(reconciliation(first.operation_id)));
    expectOk(await h.spend.reserve(secondAttempt(first.operation_id)));
  });

  it("accepts a second attempt after the first settled", async () => {
    const first = await reserveToTerminal(h, 1);
    expectOk(await h.spend.settle(settlement(first)));
    expectOk(await h.spend.reserve(secondAttempt(first)));
  });
});

describe("allocations", () => {
  function judgeDemo(n: number, allocation: string, microusd: number) {
    return reserveRequest(n, { pool_key: "judge-demo", allocation_key: allocation, envelope: exactly(microusd) });
  }

  it("refuses public beyond its own available amount while judge has room", async () => {
    await expectNothingWritten(
      h,
      async () => {
        const refused = expectRefused(await h.spend.reserve(judgeDemo(1, "public", 50_000_001)), "insufficient_funds");
        expect(refused.allocation_available_microusd).toBe(50_000_000n);
        expect(refused.pool_available_microusd).toBe(200_000_000n);
      },
      ["reservation_refusals"],
    );
    const fit = expectOk(await h.spend.reserve(judgeDemo(2, "public", 50_000_000)));
    expect(fit.allocation_available_microusd).toBe(0n);
    expect(fit.pool_available_microusd).toBe(150_000_000n);
    expectRefused(await h.spend.reserve(judgeDemo(3, "public", 1)), "insufficient_funds");
  });

  it("lets judge use its own allocation", async () => {
    expectOk(await h.spend.reserve(judgeDemo(1, "public", 50_000_000)));
    const judge = expectOk(await h.spend.reserve(judgeDemo(2, "judge", 150_000_000)));
    expect(judge.allocation_available_microusd).toBe(0n);
    expect(judge.pool_available_microusd).toBe(0n);
    expectRefused(await h.spend.reserve(judgeDemo(3, "judge", 1)), "insufficient_funds");
  });

  it("transfers from public to judge within public's available amount", async () => {
    expectOk(await h.spend.reserve(judgeDemo(1, "public", 30_000_000)));
    expectOk(
      await h.spend.transfer({
        pool_key: "judge-demo",
        from_allocation_key: "public",
        to_allocation_key: "judge",
        amount_microusd: 20_000_000,
        actor_role: "operator",
        reason: "synthetic transfer",
      }),
    );
    const status = expectOk(await h.spend.poolStatus({ pool_key: "judge-demo" }));
    const limits = Object.fromEntries(status.allocations.map((a) => [a.allocation_key, a.limit_microusd]));
    expect(limits).toEqual({ judge: 170_000_000n, public: 30_000_000n });
    expect(status.cap_microusd).toBe(200_000_000n);
    expect(status.allocations.reduce((sum, a) => sum + a.limit_microusd, 0n)).toBe(status.cap_microusd);
    expectRefused(await h.spend.reserve(judgeDemo(2, "public", 1)), "insufficient_funds");
    expectOk(await h.spend.reserve(judgeDemo(3, "judge", 170_000_000)));
  });

  it("refuses a transfer beyond public's available amount", async () => {
    expectOk(await h.spend.reserve(judgeDemo(1, "public", 30_000_000)));
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.transfer({
          pool_key: "judge-demo",
          from_allocation_key: "public",
          to_allocation_key: "judge",
          amount_microusd: 20_000_001,
          actor_role: "owner",
          reason: "synthetic transfer",
        }),
        "transfer_refused",
      );
    });
  });

  const otherTransfers: [string, string, string, string][] = [
    ["judge to public", "judge-demo", "judge", "public"],
    ["public to public", "judge-demo", "public", "public"],
    ["a pool without allocations", POOL, "public", "judge"],
    ["a pool that does not exist", "synthetic-missing", "public", "judge"],
  ];

  it.each(otherTransfers)("refuses a transfer from %s", async (_name, pool, from, to) => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.transfer({
          pool_key: pool,
          from_allocation_key: from,
          to_allocation_key: to,
          amount_microusd: 1,
          actor_role: "owner",
          reason: "synthetic transfer",
        }),
        "transfer_refused",
      );
    });
  });

  it("refuses a transfer by a component role", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.transfer({
          pool_key: "judge-demo",
          from_allocation_key: "public",
          to_allocation_key: "judge",
          amount_microusd: 1,
          actor_role: "workflow",
          reason: "synthetic transfer",
        }),
        "invalid_request",
      );
    });
  });
});

describe("caps", () => {
  it("records an owner's cap raise on a pool without allocations", async () => {
    expectOk(
      await h.spend.raiseCap({ pool_key: POOL, new_cap_microusd: 1_500_000, actor_role: "owner", reason: "synthetic" }),
    );
    const status = expectOk(await h.spend.poolStatus({ pool_key: POOL }));
    expect(status.cap_microusd).toBe(1_500_000n);
    expect(status.available_microusd).toBe(1_500_000n);
  });

  it.each([
    ["a lower cap", 999_999],
    ["the same cap", 1_000_000],
  ])("refuses %s", async (_name, cap) => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.raiseCap({ pool_key: POOL, new_cap_microusd: cap, actor_role: "owner", reason: "synthetic" }),
        "cap_change_refused",
      );
    });
  });

  it("refuses any cap change on a pool with allocations", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.raiseCap({
          pool_key: "judge-demo",
          new_cap_microusd: 300_000_000,
          actor_role: "owner",
          reason: "synthetic",
        }),
        "cap_change_refused",
      );
    });
  });

  it("refuses a cap raise by an operator", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.raiseCap({ pool_key: POOL, new_cap_microusd: 2_000_000, actor_role: "operator", reason: "x" }),
        "invalid_request",
      );
    });
  });

  it("refuses a cap raise on an unknown pool", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.raiseCap({
          pool_key: "synthetic-missing",
          new_cap_microusd: 2_000_000,
          actor_role: "owner",
          reason: "x",
        }),
        "unknown_pool",
      );
    });
  });

  it("lets available go negative after an overrun and then refuses every reservation", async () => {
    const operationId = await reserveToTerminal(h, 1, { envelope: exactly(1_000_000) });
    const overrun = settlement(operationId, {
      reserved_microusd: 1_000_000,
      service_lines: [
        { service: "synthetic-llm", unit: "input_token", actual_quantity: 1_000_000, actual_microusd: 1_000_100, retained_microusd: 0 },
      ],
    });
    expectOk(await h.spend.settle(overrun));
    expectOk(await h.spend.resume({ actor_role: "owner", evidence: [{ key: "synthetic/ok", sha256: hex(1) }], reason: "x" }));
    const status = expectOk(await h.spend.poolStatus({ pool_key: POOL }));
    expect(status.available_microusd).toBe(-100n);
    expectRefused(await h.spend.reserve(reserveRequest(2, { envelope: exactly(0) })), "insufficient_funds");
  });
});

describe("pool creation", () => {
  it("creates a pool with allocations that sum to the cap", async () => {
    expectOk(
      await h.spend.createPool({
        pool_key: "synthetic-split",
        cap_microusd: 100,
        allocations: [
          { allocation_key: "first", limit_microusd: 60 },
          { allocation_key: "second", limit_microusd: 40 },
        ],
        actor_role: "owner",
        reason: "synthetic",
      }),
    );
    const status = expectOk(await h.spend.poolStatus({ pool_key: "synthetic-split" }));
    expect(status.allocations.map((a) => [a.allocation_key, a.limit_microusd])).toEqual([
      ["first", 60n],
      ["second", 40n],
    ]);
  });

  const refused: [string, Record<string, unknown>][] = [
    ["allocations that do not sum to the cap", { allocations: [{ allocation_key: "first", limit_microusd: 99 }] }],
    [
      "repeated allocation keys",
      {
        allocations: [
          { allocation_key: "first", limit_microusd: 50 },
          { allocation_key: "first", limit_microusd: 50 },
        ],
      },
    ],
    ["an operator", { actor_role: "operator" }],
    ["an existing key", { pool_key: POOL }],
    ["an uppercase key", { pool_key: "Synthetic" }],
    ["an empty reason", { reason: "" }],
  ];

  it.each(refused)("refuses %s", async (_name, overrides) => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.createPool(
          loose({
            pool_key: "synthetic-new",
            cap_microusd: 100,
            allocations: [],
            actor_role: "owner",
            reason: "synthetic",
            ...overrides,
          }),
        ),
        "invalid_request",
      );
    });
  });
});
