// The qualification verdict rule (contract sections 1 and 8.3) and the
// qualification record of the behavioral-qualification route, version 1.
//
// In order: a stopped candidate is incomplete (`stopped`); parts that failed their integrity checks are
// rejected (`export_mismatch`); a harness that ran no cell, an `error` cell or an invalid copy is
// invalid (`setup_failed`); a valid mismatch on complete evidence is rejected with the first reason of
// the contract's table; any other incomplete evidence is incomplete (`incomplete_run`); otherwise the six
// cells matched. Invalid or incomplete evidence is never folded into a rejection.
import { canonicalDigest } from "@rbw/schema";
import { CHECK_SET_VALUES, COPY_STATE_VALUES } from "@rbw/factory-contract";
import type { CandidateReason, CellObservation, CheckSet, CopyRecord, CopyState, ExpectedOutcome, QualificationCell, QualificationRecord } from "@rbw/factory-contract";
import { QUALIFICATION_ROUTE } from "./capabilities.ts";
import type { CellMatrix, HarnessResult } from "./ports.ts";

export const EXPECTED: Readonly<Record<CheckSet, Readonly<Record<CopyState, ExpectedOutcome>>>> = {
  original_suite: { clean: "pass", buggy: "pass", fixed: "pass" },
  verification: { clean: "pass", buggy: "fail", fixed: "pass" },
};

/** The contract's rejection reasons in table order, each with the cell it reads. */
const MISMATCH_REASONS: readonly [CheckSet, CopyState, CandidateReason][] = [
  ["original_suite", "clean", "original_suite_failed_clean"],
  ["original_suite", "buggy", "original_suite_caught_bug"],
  ["original_suite", "fixed", "original_suite_failed_fixed"],
  ["verification", "clean", "checks_failed_clean"],
  ["verification", "fixed", "checks_failed_fixed"],
  ["verification", "buggy", "bug_not_detected"],
];

export type CellVerdict = { kind: "matched" } | { kind: "ended"; verdict: "rejected" | "invalid" | "incomplete"; reason: CandidateReason };

export interface CellVerdictInput {
  matrix: CellMatrix | null;
  records: readonly CopyRecord[];
  stopped: boolean;
  integrity: "verified" | "failed";
}

function cells(matrix: CellMatrix): CellObservation[] {
  return CHECK_SET_VALUES.flatMap((set) => COPY_STATE_VALUES.map((state) => matrix[set][state]));
}

function isValid(cell: CellObservation): boolean {
  return cell.observed === "pass" || cell.observed === "fail";
}

/** A cell the harness never ran (it stopped early after a definite result). */
function notRun(cell: CellObservation): boolean {
  return cell.observed === "incomplete" && cell.runs_total === 0;
}

export function cellVerdict(input: CellVerdictInput): CellVerdict {
  if (input.stopped) return { kind: "ended", verdict: "incomplete", reason: "stopped" };
  if (input.integrity === "failed") return { kind: "ended", verdict: "rejected", reason: "export_mismatch" };
  const { matrix } = input;
  if (matrix === null) return { kind: "ended", verdict: "invalid", reason: "setup_failed" };
  const all = cells(matrix);
  if (all.some((cell) => cell.observed === "error") || input.records.some((record) => record.status === "invalid")) {
    return { kind: "ended", verdict: "invalid", reason: "setup_failed" };
  }
  const incompleteRecord = input.records.some((record) => record.status === "incomplete");
  const complete = !incompleteRecord && all.every((cell) => isValid(cell) || notRun(cell));
  if (complete) {
    for (const [set, state, reason] of MISMATCH_REASONS) {
      const cell = matrix[set][state];
      if (isValid(cell) && cell.observed !== EXPECTED[set][state]) return { kind: "ended", verdict: "rejected", reason };
    }
  }
  if (incompleteRecord || !all.every(isValid)) return { kind: "ended", verdict: "incomplete", reason: "incomplete_run" };
  return { kind: "matched" };
}

export interface RecordInput {
  harness: HarnessResult;
  case_id: string;
  defect_id: string;
  entry_id: string;
  item_key: string | null;
  /** Every criterion of the candidate's bug type, with whether its failure code was observed on the buggy copy. */
  criteria: { criterion_id: string; matched: boolean }[];
  verdict: QualificationRecord["verdict"];
  reason_code: CandidateReason | null;
}

const NO_CELL: CellObservation = { observed: "error", runs_valid: 0, runs_total: 0, failure_codes: [], detail: "" };

function qualificationCell(cell: CellObservation, expected: ExpectedOutcome): QualificationCell {
  return {
    observed: cell.observed,
    runs_valid: cell.runs_valid,
    runs_total: cell.runs_total,
    failure_codes: [...cell.failure_codes],
    detail: cell.detail,
    expected,
    matches_expectation: cell.observed === expected,
  };
}

/** The route's record for one candidate. It holds evaluator material and never reaches a client. */
export function qualificationRecord(input: RecordInput): QualificationRecord {
  const { harness } = input;
  const cellOf = (set: CheckSet, state: CopyState): QualificationCell => qualificationCell(harness.matrix?.[set][state] ?? NO_CELL, EXPECTED[set][state]);
  const set = (name: CheckSet): QualificationRecord["cells"][CheckSet] => ({ clean: cellOf(name, "clean"), buggy: cellOf(name, "buggy"), fixed: cellOf(name, "fixed") });
  return {
    route: { ...QUALIFICATION_ROUTE },
    case_id: input.case_id,
    defect_id: input.defect_id,
    entry_id: input.entry_id,
    item_key: input.item_key,
    cells: { original_suite: set("original_suite"), verification: set("verification") },
    criteria: input.criteria.map((criterion) => ({ ...criterion })),
    export_verification: { bug_case_sha256: harness.package_sha256.bug_case, validator_sha256: harness.package_sha256.validator, harness: { ...harness.harness } },
    verdict: input.verdict,
    reason_code: input.reason_code,
    copy_record_sha256s: harness.records.map((record) => canonicalDigest(record).sha256),
  };
}
