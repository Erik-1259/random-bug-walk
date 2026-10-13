// What one screen call can cost at most, priced from the screen's rate file, and the run's budget
// check. A run starts only when its planned attempts at the worst case fit inside the budget.
import { buildEnvelope, lineWorstCase, parseRateSheet } from "@rbw/writer";
import type { ModelProfile } from "@rbw/writer";

export type WorstCase = { ok: true; per_call_microusd: number; input_microusd: number; output_microusd: number } | { ok: false; detail: string };

/** The reserved worst case of one call under `profile`: input limit × input price + output limit × output price, each rounded up. */
export function worstCasePerCall(rateSheet: Uint8Array, profile: ModelProfile): WorstCase {
  const sheet = parseRateSheet(rateSheet);
  if (!sheet.ok) {
    return sheet;
  }
  const priced = buildEnvelope(sheet.entries, profile);
  if (!priced.ok) {
    return priced;
  }
  const [input, output] = priced.envelope.map(lineWorstCase);
  if (input === undefined || output === undefined) {
    return { ok: false, detail: "the envelope has fewer than two lines" };
  }
  return { ok: true, per_call_microusd: input + output, input_microusd: input, output_microusd: output };
}

/** Null when `attempts` calls at `perCall` fit in `budget`, else why not. */
export function budgetRefusal(attempts: number, perCall: number, budget: number): string | null {
  const needed = attempts * perCall;
  return needed <= budget
    ? null
    : `${String(attempts)} attempts at a worst case of ${String(perCall)} micro-USD each need ${String(needed)} micro-USD, above the budget of ${String(budget)}`;
}
