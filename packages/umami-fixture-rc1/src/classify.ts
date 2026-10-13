import type { FailureCode, Observed } from "./fixture.ts";
import type { DoubleSpendEvidence, Evidence, SerialReuseEvidence, VerifyAttempt } from "./race.ts";
import { classifyConcurrent, classifyReuse, type Verdict } from "./template/index.ts";

export interface Classification {
  observed: Observed;
  failure_code: FailureCode | null;
  /** Human-readable summary for the assertion message: statuses, error codes and times only. */
  detail: string;
}

/** Umami's answer when a backup code is unknown or already used. */
export const INVALID_BACKUP_CODE = "two-factor-error-invalid-backup-code";

/**
 * The verdict the RC-1 checks read from one verify attempt: a code accepted (a session issued) is
 * "applied", the pinned invalid-backup-code refusal is "rejected", and anything else is
 * "unexpected". This is the one place the template's generic grading is tied to Umami's answers.
 */
function verdict(attempt: VerifyAttempt): Verdict {
  if (attempt.token_issued) {
    return "applied";
  }
  if (attempt.status === 400 && attempt.error_code === INVALID_BACKUP_CODE) {
    return "rejected";
  }
  return "unexpected";
}

function describe(attempt: VerifyAttempt): string {
  if (attempt.failure !== null) {
    return `request failed (${attempt.failure})`;
  }
  const code = attempt.error_code === null ? "" : ` ${attempt.error_code}`;
  return `HTTP ${String(attempt.status)}${code}${attempt.token_issued ? " token issued" : ""} sent ${String(attempt.sent_ms)} ms settled ${String(attempt.settled_ms)} ms`;
}

/**
 * Grades the serial control. The first use of a fresh code must be accepted; otherwise the baked
 * state or the app is broken (setup_fail). The reuse after it settled must be refused with
 * two-factor-error-invalid-backup-code (pass); accepting it is backup_code_reused, and any other
 * answer is unrelated_failure.
 */
export function classifySerialReuse(evidence: SerialReuseEvidence): Classification {
  return classifyReuse(evidence.attempts, {
    verdictOf: verdict,
    transportFailed: (attempt) => attempt.failure !== null,
    pass: { observed: "pass", failure_code: null },
    reused: { observed: "assertion_fail", failure_code: "backup_code_reused" },
    unrelated: { observed: "setup_fail", failure_code: "unrelated_failure" },
    seedFailed: { observed: "setup_fail", failure_code: "seed_failed" },
    noFirstDetail: "no verify request was sent",
    firstTransportDetail: (first) => `first use: ${describe(first)}`,
    firstNotAppliedDetail: (first) => `first use of a fresh backup code was not accepted: ${describe(first)}`,
    noSecondDetail: "the reuse was not sent",
    pairDetail: (first, second) => `first use: ${describe(first)}; reuse: ${describe(second)}`,
  });
}

/**
 * Grades the race, in this order:
 * 1. unrelated_failure: a request failed, or an answer is neither an accepted code (HTTP 200 with
 *    a token) nor two-factor-error-invalid-backup-code.
 * 2. unrelated_failure: the two requests were never in flight together (overlap_ms <= 0), so the
 *    round did not exercise the race and is not evidence either way.
 * 3. double_spend: both requests were accepted; one backup code opened two sessions.
 * 4. seed_failed: neither was accepted, so the fresh code itself did not work.
 * 5. pass: exactly one was accepted and the other refused.
 */
export function classifyDoubleSpend(evidence: DoubleSpendEvidence): Classification {
  return classifyConcurrent(evidence.attempts, evidence.overlap_ms, {
    verdictOf: verdict,
    cleanApplied: 1,
    plantedApplied: 2,
    planted: { observed: "assertion_fail", failure_code: "double_spend" },
    clean: { observed: "pass", failure_code: null },
    unrelated: { observed: "setup_fail", failure_code: "unrelated_failure" },
    seedFailed: { observed: "setup_fail", failure_code: "seed_failed" },
    detail: (attempts, overlapMs) =>
      `${attempts.map((attempt, index) => `request ${index === 0 ? "a" : "b"}: ${describe(attempt)}`).join("; ")}; in flight together ${String(overlapMs)} ms`,
    noOverlapDetail: (detail) => `the requests did not overlap; ${detail}`,
    seedFailedDetail: (detail) => `neither request was accepted; ${detail}`,
  });
}

export function classify(evidence: Evidence): Classification {
  return evidence.kind === "serial_reuse" ? classifySerialReuse(evidence) : classifyDoubleSpend(evidence);
}
