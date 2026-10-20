import type { PGlite } from "@electric-sql/pglite";
import { STOP_CODE_VALUES } from "@rbw/factory-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { budgetSpend } from "../../src/budget.ts";
import type { BudgetRole, ReserveRequest } from "../../src/types.ts";
import {
  budgetKey,
  budgetRequest,
  exactly,
  FACTORY_POOL,
  FACTORY_SLOT,
  factoryOperation,
  factorySetup,
  requestRoot,
  validationRoot,
} from "../factory-helpers.ts";
import {
  expectNothingWritten,
  expectOk,
  expectRefused,
  harness,
  hex,
  loose,
  openDb,
  RESUME,
  settlement,
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
  await factorySetup(h);
});

const KEY = budgetKey(1);
const ROOT = requestRoot(1);

async function createBudget(cap = 1_000_000, n = 1): Promise<void> {
  expectOk(await h.spend.createBudget(budgetRequest(n, { cap_microusd: cap })));
}

function reserve(role: BudgetRole, reservation: ReserveRequest, key = KEY) {
  return h.spend.budgetReserve({ budget_key: key, role, reservation });
}

async function close(cause: (typeof STOP_CODE_VALUES)[number] = "fulfilled", key = KEY) {
  return h.spend.closeBudget({ budget_key: key, cause, actor_role: "worker" });
}

async function budgetRefusals(): Promise<Record<string, unknown>[]> {
  return h.sql(
    `SELECT budget_key, operation_id, role, code, requested_microusd::text AS requested,
            budget_available_microusd::text AS available
     FROM budget_refusals ORDER BY seq`,
  );
}

/** Settles a launched-and-finished operation at `actual` micro-USD on its single line. */
async function finishAndSettle(request: ReserveRequest, actual: number): Promise<void> {
  const operationId = request.operation_id;
  expectOk(await h.spend.acquireSlot({ slot_key: FACTORY_SLOT, root_execution_id: request.root_execution_id, actor_role: "worker" }));
  expectOk(
    await h.spend.transition({ operation_id: operationId, from_state: "prepared", to_state: "launching", actor_role: "worker", slot_key: FACTORY_SLOT }),
  );
  expectOk(
    await h.spend.transition({ operation_id: operationId, from_state: "launching", to_state: "terminal", actor_role: "worker", terminal_status: "completed" }),
  );
  const limit = request.envelope[0]?.limit ?? 0;
  expectOk(
    await h.spend.settle(
      settlement(operationId, {
        reserved_microusd: limit,
        service_lines: [
          { service: "synthetic-llm", unit: "input_token", actual_quantity: Math.min(actual, limit), actual_microusd: actual, retained_microusd: 0 },
        ],
      }),
    ),
  );
}

describe("creating a budget", () => {
  it("records a budget that holds nothing in the pool", async () => {
    const created = expectOk(await h.spend.createBudget(budgetRequest(1, { pool_required_microusd: 200_000 })));
    expect(created).toEqual({ ok: true, replay: false, budget_key: KEY, created_at: "2026-10-04T00:00:00.000Z" });
    const pool = expectOk(await h.spend.poolStatus({ pool_key: FACTORY_POOL }));
    expect(pool.committed_microusd).toBe(0n);
    expect(pool.available_microusd).toBe(40_000_000n);
    const status = expectOk(await h.spend.budgetStatus({ budget_key: KEY }));
    expect(status).toEqual({
      ok: true,
      budget_key: KEY,
      root_execution_id: ROOT,
      pool_key: FACTORY_POOL,
      cap_microusd: 1_000_000n,
      settled_microusd: 0n,
      open_microusd: 0n,
      committed_microusd: 0n,
      available_microusd: 1_000_000n,
      overrun: false,
      closed: null,
      operations: [],
    });
  });

  it("replays an identical request and refuses a different one with idempotency_conflict, writing nothing", async () => {
    await createBudget();
    h.clock.advance(1000);
    await expectNothingWritten(h, async () => {
      const replay = expectOk(await h.spend.createBudget(budgetRequest(1)));
      expect(replay).toEqual({ ok: true, replay: true, budget_key: KEY, created_at: "2026-10-04T00:00:00.000Z" });
      expectRefused(await h.spend.createBudget(budgetRequest(1, { cap_microusd: 999_999 })), "idempotency_conflict");
      // Another key on the same root is refused too: one budget per request root.
      expectRefused(await h.spend.createBudget(budgetRequest(1, { budget_key: hex(777) })), "idempotency_conflict");
    });
  });

  it("refuses the judge-demo pool, writing nothing", async () => {
    await expectNothingWritten(h, async () => {
      const refused = expectRefused(await h.spend.createBudget(budgetRequest(1, { pool_key: "judge-demo" })), "invalid_request");
      expect(refused.detail).toMatch(/judge-demo/);
    });
  });

  it("refuses judge-demo in the table itself, also with the write setting on", async () => {
    await expect(
      h.sqlAsFunction(
        `INSERT INTO budgets (budget_key, root_execution_id, pool_key, cap_microusd, content, actor_role, recorded_at)
         VALUES ('${hex(901)}', '${requestRoot(901)}', 'judge-demo', 1, '{}', 'web', now())`,
      ),
    ).rejects.toThrow(/budgets_pool_not_judge_demo/);
  });

  it("refuses a pool with allocations and an unknown pool", async () => {
    expectOk(
      await h.spend.createPool({
        pool_key: "synthetic-split",
        cap_microusd: 10,
        allocations: [{ allocation_key: "a", limit_microusd: 10 }],
        actor_role: "owner",
        reason: "synthetic",
      }),
    );
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.createBudget(budgetRequest(1, { pool_key: "synthetic-split" })), "invalid_request");
      expectRefused(await h.spend.createBudget(budgetRequest(1, { pool_key: "synthetic-missing" })), "unknown_pool");
    });
  });

  it("needs the pool's available amount to cover pool_required_microusd, and refuses with nothing recorded", async () => {
    expectOk(await h.spend.reserve(factoryOperation(1, requestRoot(50), 39_800_000)));
    await expectNothingWritten(h, async () => {
      const refused = expectRefused(
        await h.spend.createBudget(budgetRequest(1, { pool_required_microusd: 200_001 })),
        "insufficient_funds",
      );
      expect(refused.requested_microusd).toBe(200_001n);
      expect(refused.pool_available_microusd).toBe(200_000n);
    });
    expectOk(await h.spend.createBudget(budgetRequest(1, { pool_required_microusd: 200_000 })));
  });

  it("refuses with pool_halted while new work is halted, with nothing recorded", async () => {
    const request = factoryOperation(1, requestRoot(50), 1000);
    expectOk(await h.spend.reserve(request));
    await finishAndSettle(request, 1001);
    expect(expectOk(await h.spend.haltStatus()).halted).toBe(true);
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.createBudget(budgetRequest(1)), "pool_halted");
    });
    expectOk(await h.spend.resume(RESUME));
    expectOk(await h.spend.createBudget(budgetRequest(1)));
  });

  it("refuses a root that already has operations, which the budget would never count", async () => {
    expectOk(await h.spend.reserve(factoryOperation(1, ROOT, 1000)));
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.createBudget(budgetRequest(1)), "invalid_request");
    });
  });

  it("checks a budget reservation's fields exactly as the reservation body does", async () => {
    // spend_reservation_error repeats spend_reserve_body's field checks; a later change to one must change both.
    const fieldChecks = async (fn: string): Promise<string> => {
      const rows = await h.sql("SELECT pg_get_functiondef(to_regprocedure($1)) AS def", [fn]);
      const match = /v_err := coalesce\(([\s\S]*?)\n\s*\);/.exec(String(rows[0]?.def));
      return (match?.[1] ?? "").replace(/\s+/g, " ").trim();
    };
    const body = await fieldChecks("spend_reserve_body(jsonb, text)");
    expect(body).toContain("spend_keys_error(r, ARRAY[ 'operation_id'");
    expect(body).toContain("spend_field_error(r, 'call_name', 'call_name')");
    expect(await fieldChecks("spend_reservation_error(jsonb)")).toBe(body);
  });

  it.each([
    ["a missing field", { pool_required_microusd: undefined }],
    ["an unknown field", { extra: 1 }],
    ["a zero cap", { cap_microusd: 0 }],
    ["a fractional cap", { cap_microusd: 1.5 }],
    ["an uppercase budget key", { budget_key: "A".repeat(64) }],
    ["a malformed root", { root_execution_id: "synthetic-root" }],
  ])("refuses %s as invalid_request", async (_label, overrides) => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.createBudget(loose({ ...budgetRequest(1), ...overrides })), "invalid_request");
    });
  });
});

describe("budget check-and-reserve", () => {
  beforeEach(async () => {
    await createBudget();
  });

  it("fits an exact amount and refuses one micro-USD more, recording a budget refusal and nothing else", async () => {
    const fit = expectOk(await reserve("request", factoryOperation(1, ROOT, 600_000)));
    expect(fit.replay).toBe(false);
    expect(fit.reserved_microusd).toBe(600_000n);
    await expectNothingWritten(
      h,
      async () => {
        const refused = expectRefused(await reserve("request", factoryOperation(2, ROOT, 400_001)), "budget_exhausted");
        expect(refused.requested_microusd).toBe(400_001n);
        expect(refused.budget_available_microusd).toBe(400_000n);
      },
      ["budget_refusals"],
    );
    expect(await budgetRefusals()).toEqual([
      {
        budget_key: KEY,
        operation_id: factoryOperation(2, ROOT, 400_001).operation_id,
        role: "request",
        code: "budget_exhausted",
        requested: "400001",
        available: "400000",
      },
    ]);
    expectOk(await reserve("request", factoryOperation(3, ROOT, 400_000)));
    const status = expectOk(await h.spend.budgetStatus({ budget_key: KEY }));
    expect(status.committed_microusd).toBe(1_000_000n);
    expect(status.available_microusd).toBe(0n);
    expect(status.operations.map((o) => o.operation_id)).toEqual([
      factoryOperation(1, ROOT, 0).operation_id,
      factoryOperation(3, ROOT, 0).operation_id,
    ]);
  });

  it("charges the pool exactly like a plain reservation", async () => {
    expectOk(await reserve("request", factoryOperation(1, ROOT, 600_000)));
    const pool = expectOk(await h.spend.poolStatus({ pool_key: FACTORY_POOL }));
    expect(pool.open_microusd).toBe(600_000n);
    const rows = await h.sql("SELECT operation_id, budget_key, role, root_execution_id FROM budget_operations");
    expect(rows).toEqual([{ operation_id: factoryOperation(1, ROOT, 0).operation_id, budget_key: KEY, role: "request", root_execution_id: ROOT }]);
  });

  it("replays an identical reservation without a second budget row", async () => {
    const request = factoryOperation(1, ROOT, 600_000);
    expectOk(await reserve("request", request));
    await expectNothingWritten(h, async () => {
      const replay = expectOk(await reserve("request", request));
      expect(replay.replay).toBe(true);
      expect(replay.reserved_microusd).toBe(600_000n);
    });
  });

  it("returns the replay of an exact fit after the budget is full, with no refusal row", async () => {
    const request = factoryOperation(1, ROOT, 1_000_000);
    expectOk(await reserve("request", request));
    await expectNothingWritten(h, async () => {
      expect(expectOk(await reserve("request", request)).replay).toBe(true);
    });
    expect(await budgetRefusals()).toEqual([]);
  });

  it("returns the replay after the budget is closed, with no refusal row", async () => {
    const request = factoryOperation(1, ROOT, 600_000);
    expectOk(await reserve("request", request));
    expectOk(await close());
    await expectNothingWritten(h, async () => {
      expect(expectOk(await reserve("request", request)).replay).toBe(true);
    });
    expect(await budgetRefusals()).toEqual([]);
  });

  it("answers operation_conflict for a changed intent before any closed or cap check", async () => {
    const request = factoryOperation(1, ROOT, 600_000);
    expectOk(await reserve("request", request));
    expectOk(await close());
    await expectNothingWritten(h, async () => {
      expectRefused(await reserve("request", { ...request, envelope: exactly(2_000_000) }), "operation_conflict");
      // The same intent charged under the other role is not this budget's operation either.
      expectRefused(await reserve("validation", request), "operation_conflict");
    });
  });

  it("answers operation_conflict for an operation reserved outside the budget", async () => {
    const request = factoryOperation(1, ROOT, 600_000);
    expectOk(await h.spend.reserve(request));
    await expectNothingWritten(h, async () => {
      expectRefused(await reserve("request", request), "operation_conflict");
    });
  });

  it("refuses a request reservation after close with budget_closed and records the refusal", async () => {
    expectOk(await close("budget_exhausted"));
    await expectNothingWritten(
      h,
      async () => {
        const refused = expectRefused(await reserve("request", factoryOperation(1, ROOT, 1)), "budget_closed");
        expect(refused.requested_microusd).toBe(1n);
        expect(refused.budget_available_microusd).toBe(1_000_000n);
      },
      ["budget_refusals"],
    );
    expect((await budgetRefusals())[0]).toMatchObject({ code: "budget_closed", role: "request" });
  });

  it("admits a validation reservation after close within the remaining room, and refuses one that does not fit", async () => {
    expectOk(await reserve("request", factoryOperation(1, ROOT, 700_000)));
    expectOk(await close());
    const fits = expectOk(await reserve("validation", factoryOperation(2, validationRoot(1), 300_000)));
    expect(fits.replay).toBe(false);
    await expectNothingWritten(
      h,
      async () => {
        const refused = expectRefused(await reserve("validation", factoryOperation(3, validationRoot(2), 1)), "budget_exhausted");
        expect(refused.budget_available_microusd).toBe(0n);
      },
      ["budget_refusals"],
    );
    expect((await budgetRefusals())[0]).toMatchObject({ code: "budget_exhausted", role: "validation" });
  });

  it("counts a validation reservation in the request budget's committed amount", async () => {
    expectOk(await reserve("validation", factoryOperation(1, validationRoot(1), 300_000)));
    const status = expectOk(await h.spend.budgetStatus({ budget_key: KEY }));
    expect(status.committed_microusd).toBe(300_000n);
    expect(status.operations.map((o) => [o.role, o.root_execution_id])).toEqual([["validation", validationRoot(1)]]);
    expectRefused(await reserve("request", factoryOperation(2, ROOT, 700_001)), "budget_exhausted");
    expectOk(await reserve("request", factoryOperation(3, ROOT, 700_000)));
  });

  it("refuses a root that does not match the role, writing nothing", async () => {
    await createBudget(1_000_000, 2);
    await expectNothingWritten(h, async () => {
      // A request reservation must use the budget's own root.
      expectRefused(await reserve("request", factoryOperation(1, validationRoot(1), 1)), "invalid_request");
      // A validation reservation never uses the budget's root, nor another budget's root.
      expectRefused(await reserve("validation", factoryOperation(2, ROOT, 1)), "invalid_request");
      expectRefused(await reserve("validation", factoryOperation(3, requestRoot(2), 1)), "invalid_request");
    });
  });

  it("refuses a validation root already charged to another budget", async () => {
    await createBudget(1_000_000, 2);
    expectOk(await reserve("validation", factoryOperation(1, validationRoot(1), 1), budgetKey(2)));
    await expectNothingWritten(h, async () => {
      expectRefused(await reserve("validation", factoryOperation(2, validationRoot(1), 1)), "invalid_request");
    });
  });

  it("refuses a reservation on another pool than the budget's, writing nothing", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await reserve("request", factoryOperation(1, ROOT, 1, { pool_key: "development" })), "invalid_request");
    });
  });

  it("refuses an unknown budget", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await reserve("request", factoryOperation(1, ROOT, 1), hex(999)), "unknown_budget");
    });
  });

  it.each([
    ["an unknown role", { role: "worker" }],
    ["a missing reservation", { reservation: undefined }],
    ["a reservation with an unknown field", { reservation: { ...factoryOperation(1, requestRoot(1), 1), extra: 1 } }],
    ["a reservation missing a field", { reservation: { ...factoryOperation(1, requestRoot(1), 1), payload_hash: undefined } }],
  ])("refuses %s as invalid_request without a refusal row", async (_label, overrides) => {
    expectOk(await close());
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.budgetReserve(loose({ budget_key: KEY, role: "request", reservation: factoryOperation(1, ROOT, 1), ...overrides })),
        "invalid_request",
      );
    });
  });

  it("passes the pool's own refusal through: insufficient_funds is recorded as a reservation refusal only", async () => {
    expectOk(await h.spend.reserve(factoryOperation(9, requestRoot(50), 39_500_000)));
    await expectNothingWritten(
      h,
      async () => {
        const refused = expectRefused(await reserve("request", factoryOperation(1, ROOT, 500_001)), "insufficient_funds");
        expect(refused.pool_available_microusd).toBe(500_000n);
      },
      ["reservation_refusals"],
    );
  });

  it("refuses an overrun budget: an over-envelope settlement leaves available negative", async () => {
    const request = factoryOperation(1, ROOT, 1_000_000);
    expectOk(await reserve("request", request));
    await finishAndSettle(request, 1_000_250);
    const status = expectOk(await h.spend.budgetStatus({ budget_key: KEY }));
    expect(status.settled_microusd).toBe(1_000_250n);
    expect(status.open_microusd).toBe(0n);
    expect(status.committed_microusd).toBe(1_000_250n);
    expect(status.available_microusd).toBe(-250n);
    expect(status.overrun).toBe(true);
    expect(status.operations).toEqual([]);
    expectOk(await h.spend.resume(RESUME));
    const refused = expectRefused(await reserve("validation", factoryOperation(2, validationRoot(1), 1)), "budget_exhausted");
    expect(refused.budget_available_microusd).toBe(-250n);
  });

  it("lists every operation, settled ones included, with their state and amounts", async () => {
    const settled = factoryOperation(1, ROOT, 400_000, { kind: "factory.worker", call_name: "factory.worker:synthetic" });
    expectOk(await reserve("request", settled));
    await finishAndSettle(settled, 150_000);
    h.clock.advance(5);
    expectOk(await reserve("validation", factoryOperation(2, validationRoot(1), 300_000)));
    const all = expectOk(await h.spend.budgetOperations({ budget_key: KEY }));
    expect(all.operations).toEqual([
      {
        operation_id: settled.operation_id,
        role: "request",
        root_execution_id: ROOT,
        execution_id: ROOT,
        kind: "factory.worker",
        call_name: "factory.worker:synthetic",
        attempt_ordinal: 1,
        state: "reconciled",
        reserved_microusd: 400_000n,
        open_microusd: 0n,
        settled_microusd: 150_000n,
        reserved_at: "2026-10-04T00:00:00.000Z",
      },
      {
        operation_id: factoryOperation(2, ROOT, 0).operation_id,
        role: "validation",
        root_execution_id: validationRoot(1),
        execution_id: validationRoot(1),
        kind: "synthetic-call",
        call_name: "synthetic.generate",
        attempt_ordinal: 1,
        state: "prepared",
        reserved_microusd: 300_000n,
        open_microusd: 300_000n,
        settled_microusd: null,
        reserved_at: "2026-10-04T00:00:00.005Z",
      },
    ]);
    const status = expectOk(await h.spend.budgetStatus({ budget_key: KEY }));
    expect(status.operations.map((o) => o.operation_id)).toEqual([factoryOperation(2, ROOT, 0).operation_id]);
    expect(status.settled_microusd).toBe(150_000n);
    expect(status.open_microusd).toBe(300_000n);
    expect(status.committed_microusd).toBe(450_000n);
  });
});

describe("closing a budget", () => {
  beforeEach(async () => {
    await createBudget();
  });

  it("is idempotent for the same cause and refuses another cause with idempotency_conflict", async () => {
    const closed = expectOk(await close("cancelled_by_user"));
    expect(closed).toEqual({ ok: true, replay: false, budget_key: KEY, cause: "cancelled_by_user", closed_at: "2026-10-04T00:00:00.000Z" });
    h.clock.advance(1000);
    await expectNothingWritten(h, async () => {
      expect(expectOk(await close("cancelled_by_user"))).toEqual({ ...closed, replay: true });
      expectRefused(await close("fulfilled"), "idempotency_conflict");
    });
    const status = expectOk(await h.spend.budgetStatus({ budget_key: KEY }));
    expect(status.closed).toEqual({ cause: "cancelled_by_user", closed_at: "2026-10-04T00:00:00.000Z" });
  });

  it("accepts every contract stop code and nothing else", async () => {
    for (const [i, cause] of STOP_CODE_VALUES.entries()) {
      await createBudget(1, 10 + i);
      expectOk(await close(cause, budgetKey(10 + i)));
    }
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.closeBudget(loose({ budget_key: KEY, cause: "stopped", actor_role: "worker" })), "invalid_request");
    });
    const rows = await h.sql("SELECT factory_stop_codes() AS codes");
    expect(rows).toEqual([{ codes: [...STOP_CODE_VALUES] }]);
  });

  it("refuses an unknown budget", async () => {
    expectRefused(await close("fulfilled", hex(999)), "unknown_budget");
  });

  it("leaves open operations open; they still settle", async () => {
    const request = factoryOperation(1, ROOT, 600_000);
    expectOk(await reserve("request", request));
    expectOk(await close());
    await finishAndSettle(request, 100);
    expect(expectOk(await h.spend.budgetStatus({ budget_key: KEY })).committed_microusd).toBe(100n);
  });
});

describe("budgetSpend", () => {
  beforeEach(async () => {
    await createBudget();
  });

  it("charges reserve to the budget and leaves every other method unchanged", async () => {
    const scoped = budgetSpend(h.spend, KEY, "request");
    expectOk(await scoped.reserve(factoryOperation(1, ROOT, 1_000_000)));
    expectRefused(await scoped.reserve(factoryOperation(2, ROOT, 1)), "budget_exhausted");
    expect(Object.keys(scoped).sort()).toEqual(Object.keys(h.spend).sort());
    expect(await scoped.poolStatus({ pool_key: FACTORY_POOL })).toEqual(await h.spend.poolStatus({ pool_key: FACTORY_POOL }));
    const rows = await h.sql("SELECT role FROM budget_operations");
    expect(rows).toEqual([{ role: "request" }]);
  });

  it("charges a validation run's reservations under the validation role", async () => {
    expectOk(await close());
    const scoped = budgetSpend(h.spend, KEY, "validation");
    expectOk(await scoped.reserve(factoryOperation(1, validationRoot(1), 10)));
    expect(await h.sql("SELECT role FROM budget_operations")).toEqual([{ role: "validation" }]);
  });
});
