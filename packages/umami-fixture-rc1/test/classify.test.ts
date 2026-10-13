import { describe, expect, it } from "vitest";
import { classifyDoubleSpend, classifySerialReuse, INVALID_BACKUP_CODE, type DoubleSpendEvidence, type VerifyAttempt } from "../src/index.ts";

function accepted(sent: number, settled: number): VerifyAttempt {
  return { sent_ms: sent, settled_ms: settled, status: 200, error_code: null, token_issued: true, failure: null };
}

function refused(sent: number, settled: number, code: string = INVALID_BACKUP_CODE, status = 400): VerifyAttempt {
  return { sent_ms: sent, settled_ms: settled, status, error_code: code, token_issued: false, failure: null };
}

function race(a: VerifyAttempt, b: VerifyAttempt, overlap = Math.min(a.settled_ms, b.settled_ms) - Math.max(a.sent_ms, b.sent_ms)): DoubleSpendEvidence {
  return { check_id: "rc1.backup-code-concurrent-double-spend", kind: "concurrent_double_spend", attempts: [a, b], overlap_ms: overlap };
}

describe("classifyDoubleSpend", () => {
  it("fails with double_spend when both overlapping requests were accepted", () => {
    expect(classifyDoubleSpend(race(accepted(0, 610), accepted(0.4, 640)))).toEqual({
      observed: "assertion_fail",
      failure_code: "double_spend",
      detail: "request a: HTTP 200 token issued sent 0 ms settled 610 ms; request b: HTTP 200 token issued sent 0.4 ms settled 640 ms; in flight together 609.6 ms",
    });
  });

  it("passes when exactly one was accepted and the other refused as an invalid code", () => {
    expect(classifyDoubleSpend(race(accepted(0, 600), refused(0.2, 650)))).toMatchObject({ observed: "pass", failure_code: null });
    expect(classifyDoubleSpend(race(refused(0, 600), accepted(0.2, 650)))).toMatchObject({ observed: "pass", failure_code: null });
  });

  it("is invalid, not evidence, when the requests never overlapped, even with two acceptances", () => {
    for (const evidence of [race(accepted(0, 10), accepted(10, 30)), race(accepted(0, 10), refused(12, 30))]) {
      expect(classifyDoubleSpend(evidence)).toMatchObject({ observed: "setup_fail", failure_code: "unrelated_failure", detail: expect.stringContaining("did not overlap") as unknown });
    }
  });

  it("reports seed_failed when neither request was accepted", () => {
    expect(classifyDoubleSpend(race(refused(0, 600), refused(0, 600)))).toMatchObject({ observed: "setup_fail", failure_code: "seed_failed" });
  });

  it.each([
    ["a rate-limit lockout", refused(0, 50, "two-factor-error-too-many-attempts", 429)],
    ["an expired partial token", refused(0, 50, "two-factor-error-invalid-partial-token", 401)],
    ["a 400 with another code", refused(0, 50, "bad-request")],
    ["a 200 with no token", { ...accepted(0, 50), token_issued: false }],
    ["a network error", { sent_ms: 0, settled_ms: 50, status: null, error_code: null, token_issued: false, failure: "socket hang up" }],
  ])("reports %s as unrelated_failure", (_name, other: VerifyAttempt) => {
    expect(classifyDoubleSpend(race(accepted(0, 600), other))).toMatchObject({ observed: "setup_fail", failure_code: "unrelated_failure" });
  });
});

describe("classifySerialReuse", () => {
  const evidence = (attempts: VerifyAttempt[]) => ({ check_id: "rc1.backup-code-serial-reuse", kind: "serial_reuse" as const, attempts });

  it("passes when the reuse is refused as an invalid code", () => {
    expect(classifySerialReuse(evidence([accepted(0, 300), refused(320, 900)]))).toMatchObject({ observed: "pass", failure_code: null });
  });

  it("fails with backup_code_reused when the reuse is accepted", () => {
    expect(classifySerialReuse(evidence([accepted(0, 300), accepted(320, 600)]))).toMatchObject({ observed: "assertion_fail", failure_code: "backup_code_reused" });
  });

  it("reports seed_failed when the first use of a fresh code is refused", () => {
    expect(classifySerialReuse(evidence([refused(0, 300)]))).toMatchObject({ observed: "setup_fail", failure_code: "seed_failed" });
  });

  it("reports unrelated_failure for any other answer to the reuse, a network error or a missing attempt", () => {
    expect(classifySerialReuse(evidence([accepted(0, 300), refused(320, 400, "two-factor-error-too-many-attempts", 429)]))).toMatchObject({ failure_code: "unrelated_failure" });
    expect(classifySerialReuse(evidence([{ ...accepted(0, 300), status: null, token_issued: false, failure: "socket hang up" }]))).toMatchObject({ failure_code: "unrelated_failure" });
    expect(classifySerialReuse(evidence([accepted(0, 300)]))).toMatchObject({ failure_code: "unrelated_failure" });
    expect(classifySerialReuse(evidence([]))).toMatchObject({ failure_code: "unrelated_failure" });
  });
});
