import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EnvelopeLine } from "../../src/types.ts";
import {
  expectNothingWritten,
  expectOk,
  expectRefused,
  harness,
  line,
  loose,
  openDb,
  reserveRequest,
  setup,
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
  await setup(h, Number.MAX_SAFE_INTEGER);
});

async function reservedFor(envelope: EnvelopeLine[]): Promise<bigint> {
  const result = expectOk(await h.spend.reserve(reserveRequest(1, { envelope })));
  return result.reserved_microusd;
}

describe("line worst case", () => {
  it("rounds up: 1 token at 60,000 micro-USD per 1,000,000 tokens is 1 micro-USD", async () => {
    expect(await reservedFor([line({ limit: 1, price: { microusd: 60_000, per_units: 1_000_000 } })])).toBe(1n);
  });

  it("charges 0 for a zero limit", async () => {
    expect(await reservedFor([line({ limit: 0, price: { microusd: 60_000, per_units: 1_000_000 } })])).toBe(0n);
  });

  it("charges 0 for a zero price", async () => {
    expect(await reservedFor([line({ limit: 500, price: { microusd: 0, per_units: 1 } })])).toBe(0n);
  });

  it("rounds each line separately and sums the lines", async () => {
    const envelope = [
      line({ unit: "input_token", limit: 1, price: { microusd: 60_000, per_units: 1_000_000 } }),
      line({ unit: "output_token", limit: 1_000_001, price: { microusd: 60_000, per_units: 1_000_000 } }),
      line({ unit: "call", limit: 3, enforced_by: "client_counter", price: { microusd: 7, per_units: 2 } }),
    ];
    // 1 + ceil(60,000.06) + ceil(10.5)
    expect(await reservedFor(envelope)).toBe(1n + 60_001n + 11n);
  });

  it("computes products beyond 2^53 exactly", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(await reservedFor([line({ limit: max, price: { microusd: max, per_units: max } })])).toBe(
      BigInt(max),
    );
  });

  it("rounds a product beyond 2^53 up without floating point", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const expected = (BigInt(max) * 3n + 6n) / 7n;
    expect(await reservedFor([line({ unit: "byte", limit: max, price: { microusd: 3, per_units: 7 } })])).toBe(
      expected,
    );
  });

  it("refuses a total above the safe range and writes nothing", async () => {
    const half = 2 ** 52;
    const envelope = [
      line({ unit: "input_token", limit: half, price: { microusd: 1, per_units: 1 } }),
      line({ unit: "output_token", limit: half, price: { microusd: 1, per_units: 1 } }),
    ];
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(reserveRequest(1, { envelope })), "invalid_request");
    });
  });
});

describe("amounts at the API boundary", () => {
  const badAmounts: [string, unknown][] = [
    ["a fraction", 1.5],
    ["a negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "1000"],
    ["a value above the safe range", 2 ** 53],
    ["a bigint", 1000n],
  ];

  it.each(badAmounts)("refuses %s as a pool cap", async (_name, amount) => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.createPool({
          pool_key: "synthetic-other",
          cap_microusd: loose(amount),
          allocations: [],
          actor_role: "owner",
          reason: "synthetic",
        }),
        "invalid_request",
      );
    });
  });

  it.each(badAmounts)("refuses %s as a transfer amount", async (_name, amount) => {
    await expectNothingWritten(h, async () => {
      expectRefused(
        await h.spend.transfer({
          pool_key: "judge-demo",
          from_allocation_key: "public",
          to_allocation_key: "judge",
          amount_microusd: loose(amount),
          actor_role: "operator",
          reason: "synthetic",
        }),
        "invalid_request",
      );
    });
  });

  it("accepts the largest safe integer as a cap and reports it exactly", async () => {
    expectOk(
      await h.spend.createPool({
        pool_key: "synthetic-max",
        cap_microusd: Number.MAX_SAFE_INTEGER,
        allocations: [],
        actor_role: "owner",
        reason: "synthetic",
      }),
    );
    const status = expectOk(await h.spend.poolStatus({ pool_key: "synthetic-max" }));
    expect(status.cap_microusd).toBe(9_007_199_254_740_991n);
    expect(status.available_microusd).toBe(9_007_199_254_740_991n);
  });
});

describe("unknown_price writes nothing", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a null price", { price: null }],
    ["a missing price", { price: undefined }],
    ["a price without per_units", { price: { microusd: 1 } }],
    ["a price with zero per_units", { price: { microusd: 1, per_units: 0 } }],
    ["a negative price", { price: { microusd: -1, per_units: 1 } }],
    ["a fractional price", { price: { microusd: 0.5, per_units: 1 } }],
    ["a string price", { price: { microusd: "1", per_units: 1 } }],
    ["a price with an unknown field", { price: { microusd: 1, per_units: 1, currency: "usd" } }],
    ["an empty service", { service: "" }],
    ["a missing service", { service: undefined }],
    ["a malformed service", { service: "Synthetic LLM" }],
    ["a service over 64 characters", { service: "s".repeat(65) }],
    ["an unknown unit", { unit: "parsec" }],
    ["an empty unit", { unit: "" }],
    ["a missing unit", { unit: undefined }],
  ];

  it.each(cases)("refuses %s", async (_name, overrides) => {
    const envelope: EnvelopeLine[] = loose([line(), { ...line({ unit: "output_token" }), ...overrides }]);
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(reserveRequest(1, { envelope })), "unknown_price");
    });
  });
});

describe("unenforceable_limit writes nothing", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a missing limit", { limit: undefined }],
    ["a null limit", { limit: null }],
    ["a negative limit", { limit: -1 }],
    ["a fractional limit", { limit: 2.5 }],
    ["a limit above the safe range", { limit: 2 ** 53 }],
    ["a string limit", { limit: "10" }],
    ["NaN as a limit", { limit: Number.NaN }],
    ["a missing enforced_by", { enforced_by: undefined }],
    ["an enforced_by not on the list", { enforced_by: "best_effort" }],
  ];

  it.each(cases)("refuses %s", async (_name, overrides) => {
    const envelope: EnvelopeLine[] = loose([{ ...line(), ...overrides }]);
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(reserveRequest(1, { envelope })), "unenforceable_limit");
    });
  });
});

describe("envelope shape", () => {
  it("refuses an empty envelope", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(reserveRequest(1, { envelope: [] })), "invalid_request");
    });
  });

  it("refuses a repeated (service, unit) pair", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(reserveRequest(1, { envelope: [line(), line({ limit: 1 })] })), "invalid_request");
    });
  });

  it("accepts the same unit for two services", async () => {
    expect(await reservedFor([line(), line({ service: "synthetic-other" })])).toBe(2000n);
  });

  it("never trusts a caller-supplied total", async () => {
    const request = { ...reserveRequest(1), worst_case_microusd: 1 };
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.reserve(loose(request)), "invalid_request");
    });
  });
});
