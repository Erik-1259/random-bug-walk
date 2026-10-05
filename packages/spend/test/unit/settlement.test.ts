import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UsageSettlement, UsageSettlementLine } from "../../src/types.ts";
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
  reserveAndLaunch,
  reserveToTerminal,
  settlement,
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
  await setup(h);
});

// Two lines: input tokens with worst case 1,000 and output tokens with worst case 500.
const TWO_LINES = [
  line({ unit: "input_token", limit: 1000, price: { microusd: 1, per_units: 1 } }),
  line({ unit: "output_token", limit: 250, price: { microusd: 2, per_units: 1 } }),
];

function lines(input: Partial<UsageSettlementLine>, output: Partial<UsageSettlementLine>): UsageSettlementLine[] {
  return [
    { service: "synthetic-llm", unit: "input_token", actual_quantity: 300, actual_microusd: 300, retained_microusd: 0, ...input },
    { service: "synthetic-llm", unit: "output_token", actual_quantity: 100, actual_microusd: 200, retained_microusd: 0, ...output },
  ];
}

function twoLineSettlement(operationId: string, overrides: Partial<UsageSettlement> = {}): UsageSettlement {
  return settlement(operationId, { reserved_microusd: 1500, service_lines: lines({}, {}), ...overrides });
}

async function pool() {
  return expectOk(await h.spend.poolStatus({ pool_key: POOL }));
}

describe("settlement", () => {
  it("records known usage, releases the rest and reconciles", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    const settled = expectOk(await h.spend.settle(twoLineSettlement(op)));
    expect(settled).toMatchObject({
      replay: false,
      state: "reconciled",
      settled_microusd: 500n,
      retained_microusd: 0n,
      released_microusd: 1000n,
      over_envelope: false,
    });
    expect(await pool()).toMatchObject({ settled_microusd: 500n, open_microusd: 0n, committed_microusd: 500n, available_microusd: 999_500n });
  });

  it("retains a line's full worst case when its usage is unknown and stays terminal", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    const settled = expectOk(
      await h.spend.settle(
        twoLineSettlement(op, {
          usage_state: "partly_unknown",
          service_lines: lines({}, { actual_quantity: null, actual_microusd: null, retained_microusd: 500 }),
        }),
      ),
    );
    expect(settled).toMatchObject({ state: "terminal", settled_microusd: 300n, retained_microusd: 500n, released_microusd: 700n });
    expect(await pool()).toMatchObject({ settled_microusd: 300n, open_microusd: 500n, committed_microusd: 800n });
    expect(expectOk(await h.spend.operationStatus({ operation_id: op }))).toMatchObject({
      state: "terminal",
      reserved_microusd: 1500n,
      settled_microusd: 300n,
      open_microusd: 500n,
      released_microusd: 700n,
    });
  });

  it("retains the whole reservation when all usage is unknown", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    const settled = expectOk(
      await h.spend.settle(
        twoLineSettlement(op, {
          usage_state: "unknown",
          service_lines: lines(
            { actual_quantity: null, actual_microusd: null, retained_microusd: 1000 },
            { actual_quantity: 100, actual_microusd: null, retained_microusd: 500 },
          ),
        }),
      ),
    );
    expect(settled).toMatchObject({ state: "terminal", settled_microusd: 0n, retained_microusd: 1500n, released_microusd: 0n });
    expect(await pool()).toMatchObject({ committed_microusd: 1500n, available_microusd: 998_500n });
  });

  it("accepts a zero retained amount for an unknown line whose worst case is zero", async () => {
    const op = await reserveToTerminal(h, 1, {
      envelope: [line(), line({ unit: "call", limit: 0, enforced_by: "client_counter" })],
    });
    const settled = expectOk(
      await h.spend.settle(
        settlement(op, {
          usage_state: "partly_unknown",
          service_lines: [
            { service: "synthetic-llm", unit: "input_token", actual_quantity: 10, actual_microusd: 10, retained_microusd: 0 },
            { service: "synthetic-llm", unit: "call", actual_quantity: null, actual_microusd: null, retained_microusd: 0 },
          ],
        }),
      ),
    );
    expect(settled).toMatchObject({ state: "terminal", retained_microusd: 0n, released_microusd: 990n });
  });

  it("returns the first settlement for an identical duplicate and writes nothing", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    expectOk(await h.spend.settle(twoLineSettlement(op)));
    await expectNothingWritten(h, async () => {
      const again = expectOk(await h.spend.settle(twoLineSettlement(op)));
      expect(again).toMatchObject({ replay: true, state: "reconciled", settled_microusd: 500n, released_microusd: 1000n });
    });
  });

  it("refuses a different second settlement as already_settled", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    expectOk(
      await h.spend.settle(
        twoLineSettlement(op, {
          usage_state: "partly_unknown",
          service_lines: lines({}, { actual_quantity: null, actual_microusd: null, retained_microusd: 500 }),
        }),
      ),
    );
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.settle(twoLineSettlement(op)), "already_settled");
    });
  });

  it("refuses settlement before terminal", async () => {
    const op = await reserveAndLaunch(h, 1, { envelope: TWO_LINES });
    await expectNothingWritten(h, async () => {
      const refusal = expectRefused(await h.spend.settle(twoLineSettlement(op)), "invalid_transition");
      expect(refusal.current_state).toBe("launching");
    });
  });

  it("refuses an unknown operation", async () => {
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.settle(twoLineSettlement(hex(4040))), "unknown_operation");
    });
  });

  it("does not need the slot", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    const status = expectOk(await h.spend.slotStatus({ slot_key: "synthetic-slot" }));
    expectOk(
      await h.spend.releaseSlot({ slot_key: "synthetic-slot", root_execution_id: status.holder ?? "", actor_role: "workflow", evidence: null, reason: null }),
    );
    expectOk(await h.spend.settle(twoLineSettlement(op)));
  });
});

describe("settlement mismatches are invalid_request", () => {
  const cases: [string, (op: string) => unknown][] = [
    ["a different runtime profile hash", (op) => twoLineSettlement(op, { runtime_profile_sha256: hex(999) })],
    ["a different rate sheet hash", (op) => twoLineSettlement(op, { rate_sheet_sha256: hex(999) })],
    ["a different reserved amount", (op) => twoLineSettlement(op, { reserved_microusd: 1499 })],
    ["a missing line", (op) => twoLineSettlement(op, { service_lines: lines({}, {}).slice(0, 1) })],
    [
      "an extra line",
      (op) =>
        twoLineSettlement(op, {
          service_lines: [
            ...lines({}, {}),
            { service: "synthetic-llm", unit: "call", actual_quantity: 1, actual_microusd: 0, retained_microusd: 0 },
          ],
        }),
    ],
    ["a repeated line", (op) => twoLineSettlement(op, { service_lines: loose([lines({}, {})[0], lines({}, {})[0]]) })],
    ["a line with a different unit", (op) => twoLineSettlement(op, { service_lines: lines({}, { unit: "call" }) })],
    [
      "known usage_state with a null amount",
      (op) => twoLineSettlement(op, { service_lines: lines({}, { actual_microusd: null, retained_microusd: 500 }) }),
    ],
    ["unknown usage_state with all amounts known", (op) => twoLineSettlement(op, { usage_state: "unknown" })],
    ["partly_unknown usage_state with all amounts known", (op) => twoLineSettlement(op, { usage_state: "partly_unknown" })],
    ["a retained amount on a known line", (op) => twoLineSettlement(op, { service_lines: lines({ retained_microusd: 1 }, {}) })],
    [
      "less than the full worst case retained on an unknown line",
      (op) =>
        twoLineSettlement(op, {
          usage_state: "partly_unknown",
          service_lines: lines({}, { actual_microusd: null, retained_microusd: 499 }),
        }),
    ],
    [
      "more than the full worst case retained on an unknown line",
      (op) =>
        twoLineSettlement(op, {
          usage_state: "partly_unknown",
          service_lines: lines({}, { actual_microusd: null, retained_microusd: 501 }),
        }),
    ],
    ["schema_version 2", (op) => ({ ...twoLineSettlement(op), schema_version: 2 })],
    ["an unknown field", (op) => ({ ...twoLineSettlement(op), total_microusd: 500 })],
    ["an unknown line field", (op) => twoLineSettlement(op, { service_lines: lines(loose({ note: "x" }), {}) })],
    ["an evidence key without its hash", (op) => twoLineSettlement(op, { terminal_evidence_key: "synthetic/evidence" })],
    ["an evidence hash without its key", (op) => twoLineSettlement(op, { terminal_evidence_sha256: hex(1) })],
    ["a negative actual amount", (op) => twoLineSettlement(op, { service_lines: lines({ actual_microusd: -1 }, {}) })],
    ["a fractional actual quantity", (op) => twoLineSettlement(op, { service_lines: lines({ actual_quantity: 1.5 }, {}) })],
  ];

  it.each(cases)("refuses %s", async (_name, build) => {
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    await expectNothingWritten(h, async () => {
      expectRefused(await h.spend.settle(loose(build(op))), "invalid_request");
    });
    expect(expectOk(await h.spend.operationStatus({ operation_id: op })).state).toBe("terminal");
  });

  it("accepts terminal evidence when both fields are present", async () => {
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    expectOk(
      await h.spend.settle(
        twoLineSettlement(op, { terminal_evidence_key: "synthetic/evidence/terminal.json", terminal_evidence_sha256: hex(12) }),
      ),
    );
  });
});

describe("very large known usage", () => {
  it("records a known total above 2^53 - 1 in full and halts", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const op = await reserveToTerminal(h, 1, { envelope: TWO_LINES });
    const settled = expectOk(
      await h.spend.settle(
        twoLineSettlement(op, { service_lines: lines({ actual_microusd: max }, { actual_microusd: max }) }),
      ),
    );
    expect(settled.settled_microusd).toBe(2n * BigInt(max));
    expect(settled.over_envelope).toBe(true);
    expect((await pool()).settled_microusd).toBe(2n * BigInt(max));
    expect(expectOk(await h.spend.haltStatus()).halted).toBe(true);
  });
});
