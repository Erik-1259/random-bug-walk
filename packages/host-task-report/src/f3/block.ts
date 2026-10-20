// One block of trials of one kind on one instance: trials with indices 1, 2, ... until the block
// has its target of valid trials. Each invalid trial is topped up by a trial with the next new
// index. The block is incomplete, neither reproduction nor a miss, as soon as it has more invalid
// trials than its ceiling or would need more top-ups than allowed. Pure.
import type { Outcome } from "./data.ts";

export interface BlockRule {
  valid_target: number;
  max_invalid: number;
  max_top_ups: number;
}

export type BlockState = "running" | "complete" | "incomplete";

export interface BlockStatus {
  state: BlockState;
  attempts: number;
  valid: number;
  invalid: number;
  top_ups: number;
  /** The next trial index while running, otherwise null. */
  next_index: number | null;
  /** Valid outcomes by code. */
  outcomes: Record<string, number>;
}

export function blockStatus(rule: BlockRule, outcomes: readonly Outcome[]): BlockStatus {
  const attempts = outcomes.length;
  const invalid = outcomes.filter((outcome) => outcome === "invalid").length;
  const valid = attempts - invalid;
  const counted: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (outcome !== "invalid") counted[outcome] = (counted[outcome] ?? 0) + 1;
  }
  const topUps = Math.max(0, attempts - rule.valid_target);
  let state: BlockState = "running";
  if (invalid > rule.max_invalid) state = "incomplete";
  else if (valid >= rule.valid_target) state = "complete";
  else if (attempts >= rule.valid_target + rule.max_top_ups) state = "incomplete";
  return { state, attempts, valid, invalid, top_ups: topUps, next_index: state === "running" ? attempts + 1 : null, outcomes: counted };
}

/** Whether a finished block's valid outcomes all equal the expected one. */
export function blockMatches(status: BlockStatus, expected: Exclude<Outcome, "invalid">): boolean {
  return status.state === "complete" && Object.keys(status.outcomes).every((outcome) => outcome === expected) && (status.outcomes[expected] ?? 0) === status.valid;
}
