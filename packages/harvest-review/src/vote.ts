// One model's vote, and the outcome of a candidate from both votes and the harvest's ast-grep result.
import type { ReviewAnswer } from "./prompt.ts";

/** DT-1.tz-arg's evidence fields, the default. */
const DT1_EVIDENCE: readonly string[] = ["zone_is_selected", "same_call"];

export const VOTES = ["yes", "no", "unsure"] as const;
export type Vote = (typeof VOTES)[number];

export const OUTCOMES = ["confirmed", "model_rejected", "needs_review", "not_reviewed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * yes: a fix with every evidence field of the shape yes; no: not_fix; unsure: anything else, a
 * failed call included. The evidence fields are DT-1.tz-arg's unless a shape's are given.
 */
export function vote(output: ReviewAnswer | null, evidence: readonly string[] = DT1_EVIDENCE): Vote {
  if (output === null) {
    return "unsure";
  }
  if (output.verdict === "not_fix") {
    return "no";
  }
  const fields: Readonly<Record<string, string>> = output;
  return output.verdict === "fix" && evidence.length > 0 && evidence.every((field) => fields[field] === "yes") ? "yes" : "unsure";
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
