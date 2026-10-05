import type { CheckObservation, ExpectedCheck, TrialReason } from "@rbw/schema";
import type { AddedVerdict, ImportCode, ObservationClass } from "./output.ts";

export interface Classified {
  classification: ObservationClass;
  reason: TrialReason | null;
  code: ImportCode | null;
}

function trialReason(code: CheckObservation["failure_code"], fallback: TrialReason): TrialReason {
  // The schema gives setup_fail, skipped and not_run a TrialReason, so the fallback only narrows the type.
  return code === null || code === "local_day_counts_mismatch" || code === "bucket_labels_mismatch" ? fallback : code;
}

/** Classifies one added-check observation against its expected check. */
export function classifyObservation(expected: ExpectedCheck, observation: CheckObservation): Classified {
  switch (observation.observed) {
    case "setup_fail":
      return { classification: "invalid", reason: trialReason(observation.failure_code, "unrelated_failure"), code: "import:outcome_setup_fail" };
    case "skipped":
    case "not_run":
      return { classification: "incomplete", reason: trialReason(observation.failure_code, "test_skipped"), code: "import:outcome_not_run" };
    case "pass":
      // ADM-04: a valid unexpected pass of a negative check rejects the negative-control claim.
      return expected.expected === "pass" ? { classification: "positive", reason: null, code: null } : { classification: "reject", reason: null, code: null };
    case "assertion_fail":
      // ADM-03: a fully executed positive check with a valid assertion failure rejects the positive
      // claim; it is never reclassified as an infrastructure failure.
      if (expected.expected === "pass") return { classification: "reject", reason: null, code: null };
      // ADM-04: an unrelated code on a negative check is not evidence of the bug.
      if (observation.failure_code !== expected.failure_code) return { classification: "invalid", reason: "unrelated_failure", code: "import:outcome_unrelated_code" };
      return { classification: "negative_control", reason: null, code: null };
  }
}

/**
 * A trial's added-check verdict: any rejection first, then any invalid, then any incomplete,
 * otherwise the trial matches its vector. Returns the first observation of the winning class.
 */
export function combineObservations(classified: readonly Classified[]): { verdict: AddedVerdict; first: Classified | null } {
  for (const [verdict, target] of [["reject", "reject"], ["invalid", "invalid"], ["incomplete", "incomplete"]] as const) {
    const first = classified.find((item) => item.classification === target);
    if (first !== undefined) return { verdict, first };
  }
  return { verdict: "match", first: null };
}
