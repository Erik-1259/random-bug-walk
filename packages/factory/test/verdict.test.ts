import { validateContract } from "@rbw/factory-contract/validate";
import { canonicalDigest } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { cellVerdict, qualificationRecord } from "../src/verdict.ts";
import type { CellMatrix } from "../src/ports.ts";
import { cell, harnessResult, matrix, record } from "./support.ts";

function verdict(m: CellMatrix | null, extra: { stopped?: boolean; integrity?: "verified" | "failed"; records?: ReturnType<typeof record>[] } = {}) {
  return cellVerdict({ matrix: m, records: extra.records ?? [record("clean"), record("buggy"), record("fixed")], stopped: extra.stopped ?? false, integrity: extra.integrity ?? "verified" });
}

describe("the verdict rule", () => {
  it("matches only when all six cells match the qualification table", () => {
    expect(verdict(matrix())).toEqual({ kind: "matched" });
  });

  it.each([
    ["original_suite", "clean", "fail", "original_suite_failed_clean"],
    ["original_suite", "buggy", "fail", "original_suite_caught_bug"],
    ["original_suite", "fixed", "fail", "original_suite_failed_fixed"],
    ["verification", "clean", "fail", "checks_failed_clean"],
    ["verification", "fixed", "fail", "checks_failed_fixed"],
    ["verification", "buggy", "pass", "bug_not_detected"],
  ] as const)("rejects a valid %s mismatch on the %s copy as %s", (set, state, observed, reason) => {
    const m = matrix(undefined, (x) => {
      x[set][state] = cell(observed);
    });
    expect(verdict(m)).toEqual({ kind: "ended", verdict: "rejected", reason });
  });

  it("names the first mismatch in the reasons table when several cells mismatch", () => {
    const m = matrix(undefined, (x) => {
      x.verification.buggy = cell("pass");
      x.original_suite.fixed = cell("fail");
    });
    expect(verdict(m)).toEqual({ kind: "ended", verdict: "rejected", reason: "original_suite_failed_fixed" });
  });

  it("never folds an error cell into a rejection, even beside a valid mismatch", () => {
    const m = matrix(undefined, (x) => {
      x.original_suite.clean = cell("error");
      x.original_suite.buggy = cell("fail");
    });
    expect(verdict(m)).toEqual({ kind: "ended", verdict: "invalid", reason: "setup_failed" });
  });

  it("treats a copy whose record is invalid as invalid", () => {
    expect(verdict(matrix(), { records: [record("clean", "invalid"), record("buggy"), record("fixed")] })).toEqual({ kind: "ended", verdict: "invalid", reason: "setup_failed" });
  });

  it("never folds an incomplete cell into a rejection", () => {
    const m = matrix(undefined, (x) => {
      x.verification.clean = { ...cell("incomplete"), runs_valid: 2 };
      x.original_suite.buggy = cell("fail");
    });
    expect(verdict(m)).toEqual({ kind: "ended", verdict: "incomplete", reason: "incomplete_run" });
  });

  it("treats an incomplete record as incomplete", () => {
    expect(verdict(matrix(), { records: [record("clean"), record("buggy", "incomplete"), record("fixed")] })).toEqual({ kind: "ended", verdict: "incomplete", reason: "incomplete_run" });
  });

  it("rejects on a valid mismatch when the remaining cells never ran", () => {
    const notRun = { observed: "incomplete" as const, runs_valid: 0, runs_total: 0, failure_codes: [], detail: "" };
    const m = matrix(undefined, (x) => {
      x.original_suite.buggy = cell("fail");
      x.original_suite.fixed = notRun;
      x.verification.buggy = notRun;
      x.verification.fixed = notRun;
    });
    expect(verdict(m, { records: [record("clean"), record("buggy")] })).toEqual({ kind: "ended", verdict: "rejected", reason: "original_suite_caught_bug" });
  });

  it("makes a stopped candidate incomplete, whatever its cells show", () => {
    expect(verdict(matrix(), { stopped: true })).toEqual({ kind: "ended", verdict: "incomplete", reason: "stopped" });
  });

  it("rejects parts that failed their integrity checks as an export mismatch", () => {
    expect(verdict(null, { integrity: "failed", records: [] })).toEqual({ kind: "ended", verdict: "rejected", reason: "export_mismatch" });
  });

  it("makes a harness that ran no cell invalid", () => {
    expect(verdict(null, { records: [] })).toEqual({ kind: "ended", verdict: "invalid", reason: "setup_failed" });
  });
});

describe("the qualification record", () => {
  const base = {
    case_id: "ca".repeat(32),
    defect_id: "da".repeat(32),
    entry_id: "synthetic-task-report-concurrency-01",
    criteria: [
      { criterion_id: "concurrency.lost-acknowledged-change", matched: true },
      { criterion_id: "concurrency.stale-success-response", matched: false },
    ],
  };

  it("records an accepted candidate with every cell's expectation, the harness and the copy record hashes", () => {
    const harness = harnessResult();
    const result = qualificationRecord({ ...base, harness, item_key: "concurrency-1", verdict: "accepted", reason_code: null });
    expect(validateContract("QualificationRecord", result)).toEqual([]);
    expect(result.route).toEqual({ route_id: "behavioral-qualification", version: "1" });
    expect(result.cells.verification.buggy).toMatchObject({ expected: "fail", observed: "fail", matches_expectation: true });
    expect(result.cells.original_suite.clean).toMatchObject({ expected: "pass", observed: "pass", matches_expectation: true });
    expect(result.export_verification).toEqual({ bug_case_sha256: harness.package_sha256.bug_case, validator_sha256: harness.package_sha256.validator, harness: harness.harness });
    expect(result.copy_record_sha256s).toEqual(harness.records.map((r) => canonicalDigest(r).sha256));
  });

  it("records a rejection with its reason and the mismatched cell", () => {
    const harness = harnessResult({ result: "failed", matrix: matrix(undefined, (x) => { x.original_suite.buggy = cell("fail"); }) });
    const result = qualificationRecord({ ...base, harness, item_key: null, verdict: "rejected", reason_code: "original_suite_caught_bug" });
    expect(validateContract("QualificationRecord", result)).toEqual([]);
    expect(result.cells.original_suite.buggy).toMatchObject({ observed: "fail", matches_expectation: false });
  });

  it("records error cells when the harness ran no cell", () => {
    const harness = harnessResult({ result: "error", matrix: null, records: [], integrity: "failed" });
    const result = qualificationRecord({ ...base, harness, item_key: null, verdict: "rejected", reason_code: "export_mismatch" });
    expect(validateContract("QualificationRecord", result)).toEqual([]);
    expect(result.cells.verification.clean).toMatchObject({ observed: "error", runs_total: 0, matches_expectation: false });
  });
});
