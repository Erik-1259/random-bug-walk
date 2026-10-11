// One model's vote, and the outcome of a candidate from both votes and the harvest's ast-grep result.
import type { ReviewOutput } from "./prompt.ts";

export const VOTES = ["yes", "no", "unsure"] as const;
export type Vote = (typeof VOTES)[number];

export const OUTCOMES = ["confirmed", "model_rejected", "needs_review", "not_reviewed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** yes: a fix with both evidence fields yes; no: not_fix; unsure: anything else, a failed call included. */
export function vote(output: ReviewOutput | null): Vote {
  if (output === null) {
    return "unsure";
  }
  if (output.verdict === "not_fix") {
    return "no";
  }
  return output.verdict === "fix" && output.zone_is_selected === "yes" && output.same_call === "yes" ? "yes" : "unsure";
}

/** Two yes votes confirm only what ast-grep confirmed; two no votes reject; anything else needs review. */
export function combine(astGrepConfirmed: boolean, superVote: Vote, kimiVote: Vote): Outcome {
  if (superVote === "yes" && kimiVote === "yes") {
    return astGrepConfirmed ? "confirmed" : "needs_review";
  }
  if (superVote === "no" && kimiVote === "no") {
    return "model_rejected";
  }
  return "needs_review";
}

export type Matrix = Record<"confirmed" | "dropped", Record<Vote, Record<Vote, number>>>;

/** The agreement matrix, ast-grep × Super × Kimi, with every cell at zero. */
export function emptyMatrix(): Matrix {
  const row = (): Record<Vote, Record<Vote, number>> => ({
    yes: { yes: 0, no: 0, unsure: 0 },
    no: { yes: 0, no: 0, unsure: 0 },
    unsure: { yes: 0, no: 0, unsure: 0 },
  });
  return { confirmed: row(), dropped: row() };
}
