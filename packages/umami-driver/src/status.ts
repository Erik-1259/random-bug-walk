// A trial's status from its first reason. The shared schema lists the reasons; which of them
// means invalid evidence and which means missing evidence is the driver's rule.
import type { TrialReason, TrialStatus } from "@rbw/schema";

/** Reasons meaning the copy could not produce valid evidence; every other reason means evidence is missing. */
const INVALID_REASONS: ReadonlySet<TrialReason> = new Set<TrialReason>([
  "scope_violation",
  "build_failed",
  "startup_failed",
  "auth_failed",
  "seed_failed",
  "unrelated_failure",
]);

/** `complete` when there is no reason; otherwise `invalid` or `incomplete` by the reason. */
export function statusForReason(reason: TrialReason | null): TrialStatus {
  if (reason === null) return "complete";
  return INVALID_REASONS.has(reason) ? "invalid" : "incomplete";
}
