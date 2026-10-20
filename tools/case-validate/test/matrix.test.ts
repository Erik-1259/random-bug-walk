import type { CellObservation, CopyState, ExpectedMatrix, ObservedOutcome } from "@rbw/factory-contract";
import type { InterpretedCells } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import { evaluateMatrix } from "../src/matrix.ts";

const EXPECTED: ExpectedMatrix = {
  original_suite: { clean: "pass", buggy: "pass", fixed: "pass" },
  verification: { clean: "pass", buggy: "fail", fixed: "pass" },
};

function cell(observed: ObservedOutcome): CellObservation {
  return { observed, runs_valid: observed === "incomplete" ? 1 : 3, runs_total: 3, failure_codes: [], detail: "" };
}

function cells(overrides: Partial<Record<`${"original_suite" | "verification"}.${CopyState}`, ObservedOutcome>> = {}): Record<CopyState, InterpretedCells> {
  const pick = (check: "original_suite" | "verification", state: CopyState): CellObservation =>
    cell(overrides[`${check}.${state}`] ?? EXPECTED[check][state]);
  return {
    clean: { original_suite: pick("original_suite", "clean"), verification: pick("verification", "clean") },
    buggy: { original_suite: pick("original_suite", "buggy"), verification: pick("verification", "buggy") },
    fixed: { original_suite: pick("original_suite", "fixed"), verification: pick("verification", "fixed") },
  };
}

describe("evaluateMatrix", () => {
  it("passes when every cell is a valid pass or fail equal to its expectation", () => {
    const { result, matrix } = evaluateMatrix(cells(), EXPECTED);
    expect(result).toBe("passed");
    expect(matrix.verification.buggy.observed).toBe("fail");
    expect(matrix.original_suite.fixed.observed).toBe("pass");
  });

  it("fails when every cell is valid and one differs from its expectation", () => {
    expect(evaluateMatrix(cells({ "original_suite.buggy": "fail" }), EXPECTED).result).toBe("failed");
    expect(evaluateMatrix(cells({ "verification.buggy": "pass" }), EXPECTED).result).toBe("failed");
    expect(evaluateMatrix(cells({ "verification.fixed": "fail" }), EXPECTED).result).toBe("failed");
  });

  it("gives error, never failed, when any cell is error or incomplete, even next to a valid mismatch", () => {
    expect(evaluateMatrix(cells({ "verification.clean": "error" }), EXPECTED).result).toBe("error");
    expect(evaluateMatrix(cells({ "original_suite.fixed": "incomplete" }), EXPECTED).result).toBe("error");
    expect(evaluateMatrix(cells({ "verification.buggy": "pass", "original_suite.clean": "incomplete" }), EXPECTED).result).toBe("error");
  });
});
