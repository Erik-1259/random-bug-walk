import { describe, expect, it } from "vitest";
import { admitCandidate, ledgerStop } from "../src/budget.ts";
import type { LedgerStatus } from "../src/ports.ts";

function status(overrides: Partial<LedgerStatus> = {}): LedgerStatus {
  return { budget_microusd: 1_000_000, reserved_microusd: 200_000, spent_microusd: 210_000, halted: false, pool_available_microusd: 40_000_000, pool_halted: false, ...overrides };
}

describe("budget admission", () => {
  it("admits a candidate whose worst case fits the remaining budget and the pool, including an exact fit", () => {
    expect(admitCandidate(status(), 300_000)).toEqual({ kind: "admit" });
    expect(admitCandidate(status(), 590_000)).toEqual({ kind: "admit" });
  });

  it("skips a candidate the remaining budget cannot cover (partial-budget: $0.59 against $0.60)", () => {
    expect(admitCandidate(status(), 600_000)).toEqual({ kind: "skip", shortfall: "budget" });
  });

  it("skips a candidate the factory pool cannot cover, the same way", () => {
    expect(admitCandidate(status({ pool_available_microusd: 299_999 }), 300_000)).toEqual({ kind: "skip", shortfall: "pool" });
  });

  it("counts reservations and spend against the budget", () => {
    expect(admitCandidate(status({ reserved_microusd: 500_000, spent_microusd: 0 }), 500_001)).toEqual({ kind: "skip", shortfall: "budget" });
  });
});

describe("ledger stops", () => {
  it("allows candidates while the ledger and pool run and nothing overran", () => {
    expect(ledgerStop(status())).toBeNull();
    expect(ledgerStop(status({ reserved_microusd: 0, spent_microusd: 1_000_000 }))).toBeNull();
  });

  it("stops for a halted ledger, a halted pool and an overrun", () => {
    expect(ledgerStop(status({ halted: true }))).toBe("halted");
    expect(ledgerStop(status({ pool_halted: true }))).toBe("pool_halted");
    expect(ledgerStop(status({ reserved_microusd: 0, spent_microusd: 1_000_001 }))).toBe("overrun");
  });
});
