import type { Spend } from "./spend.ts";
import type { BudgetRole } from "./types.ts";

/**
 * A Spend whose `reserve` is charged to one request budget (`budgetReserve` with the given role).
 * Every other method is the wrapped Spend's, so callers that take a Spend, such as a copy runner,
 * run unchanged under the budget. The database decides every refusal; nothing here checks money.
 */
export function budgetSpend(spend: Spend, budgetKey: string, role: BudgetRole): Spend {
  return {
    ...spend,
    reserve: (reservation) => spend.budgetReserve({ budget_key: budgetKey, role, reservation }),
  };
}
