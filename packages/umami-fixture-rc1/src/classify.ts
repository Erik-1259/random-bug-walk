import type { FailureCode, Observed } from "./fixture.ts";
import type { DoubleSpendEvidence, Evidence, SerialReuseEvidence, VerifyAttempt } from "./race.ts";

export interface Classification {
  observed: Observed;
  failure_code: FailureCode | null;
  /** Human-readable summary for the assertion message: statuses, error codes and times only. */
  detail: string;
}

/** Umami's answer when a backup code is unknown or already used. */
export const INVALID_BACKUP_CODE = "two-factor-error-invalid-backup-code";

type Verdict = "accepted" | "refused" | "unexpected";

function verdict(attempt: VerifyAttempt): Verdict {
  if (attempt.token_issued) {
    return "accepted";
  }
  if (attempt.status === 400 && attempt.error_code === INVALID_BACKUP_CODE) {
    return "refused";
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

function setupFail(failureCode: FailureCode, detail: string): Classification {
  return { observed: "setup_fail", failure_code: failureCode, detail };
}

/**
 * Grades the serial control. The first use of a fresh code must be accepted; otherwise the baked
 * state or the app is broken (setup_fail). The reuse after it settled must be refused with
 * two-factor-error-invalid-backup-code (pass); accepting it is backup_code_reused, and any other
 * answer is unrelated_failure.
 */
export function classifySerialReuse(evidence: SerialReuseEvidence): Classification {
  const [first, second] = evidence.attempts;
  if (first === undefined) {
    return setupFail("unrelated_failure", "no verify request was sent");
  }
  if (first.failure !== null) {
    return setupFail("unrelated_failure", `first use: ${describe(first)}`);
  }
  if (verdict(first) !== "accepted") {
    return setupFail("seed_failed", `first use of a fresh backup code was not accepted: ${describe(first)}`);
  }
  if (second === undefined) {
    return setupFail("unrelated_failure", "the reuse was not sent");
  }
  const detail = `first use: ${describe(first)}; reuse: ${describe(second)}`;
  switch (verdict(second)) {
    case "refused":
      return { observed: "pass", failure_code: null, detail };
    case "accepted":
      return { observed: "assertion_fail", failure_code: "backup_code_reused", detail };
    case "unexpected":
      return setupFail("unrelated_failure", detail);
  }
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
  const verdicts = evidence.attempts.map(verdict);
  const detail = `${evidence.attempts.map((attempt, index) => `request ${index === 0 ? "a" : "b"}: ${describe(attempt)}`).join("; ")}; in flight together ${String(evidence.overlap_ms)} ms`;
  if (verdicts.includes("unexpected")) {
    return setupFail("unrelated_failure", detail);
  }
  if (evidence.overlap_ms <= 0) {
    return setupFail("unrelated_failure", `the requests did not overlap; ${detail}`);
  }
  const accepted = verdicts.filter((item) => item === "accepted").length;
  if (accepted === 2) {
    return { observed: "assertion_fail", failure_code: "double_spend", detail };
  }
  if (accepted === 0) {
    return setupFail("seed_failed", `neither request was accepted; ${detail}`);
  }
  return { observed: "pass", failure_code: null, detail };
}

export function classify(evidence: Evidence): Classification {
  return evidence.kind === "serial_reuse" ? classifySerialReuse(evidence) : classifyDoubleSpend(evidence);
}
