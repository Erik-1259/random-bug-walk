// Budget admission before each candidate (contract section 8.5). The request
// budget's room and the factory pool's available amount must both cover the candidate's worst case;
// otherwise the candidate is skipped (`no_budget_for_candidate`). A halted ledger, a halted pool or an
// overrun admits no new candidate at all and stops the request `operational_error`. The database's
// reserve stays the hard bound behind this pre-check.
import type { LedgerStatus } from "./ports.ts";

export type Admission = { kind: "admit" } | { kind: "skip"; shortfall: "budget" | "pool" };

/** Why the ledger allows no new candidate at all; the request then stops `operational_error`. */
export type LedgerStop = "halted" | "pool_halted" | "overrun";

function room(status: LedgerStatus): number {
  return status.budget_microusd - status.reserved_microusd - status.spent_microusd;
}

export function ledgerStop(status: LedgerStatus): LedgerStop | null {
  if (status.halted) return "halted";
  if (status.pool_halted) return "pool_halted";
  if (room(status) < 0) return "overrun";
  return null;
}

export function admitCandidate(status: LedgerStatus, worstCaseMicrousd: number): Admission {
  if (room(status) < worstCaseMicrousd) return { kind: "skip", shortfall: "budget" };
  if (status.pool_available_microusd < worstCaseMicrousd) return { kind: "skip", shortfall: "pool" };
  return { kind: "admit" };
}
