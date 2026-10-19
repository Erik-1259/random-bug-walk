// Synthetic copy records: what one copy of a state observes under a cell plan. The fake harness and the
// fake adapter's `collect` build their records here, so both paths give identical records.
import type { BaselineIdentity, CellObservation, CopyRecord, CopyRecordStatus, CopyState, ObservedOutcome } from "@rbw/factory-contract";

/** What one copy of a state observes. */
export interface CellPlan {
  original_suite: ObservedOutcome;
  verification: ObservedOutcome;
  /** Failure codes the verification checks report on this copy. */
  failure_codes?: string[];
}

export function syntheticObservation(observed: ObservedOutcome, runs: number, codes: readonly string[]): CellObservation {
  const valid = observed === "error" ? 0 : observed === "incomplete" ? Math.max(runs - 1, 0) : runs;
  return { observed, runs_valid: valid, runs_total: runs, failure_codes: observed === "fail" ? [...codes] : [], detail: `synthetic detail: ${observed}` };
}

export function syntheticStatus(cell: CellPlan): CopyRecordStatus {
  if (cell.original_suite === "error" || cell.verification === "error") return "invalid";
  if (cell.original_suite === "incomplete" || cell.verification === "incomplete") return "incomplete";
  return "complete";
}

export interface SyntheticRecordInput {
  copy_id: string;
  state: CopyState;
  cell: CellPlan;
  baseline: BaselineIdentity;
  /** Runs per copy of the original suite and of the verification checks. */
  runs: { original_suite: number; verification: number };
  image_digest: string;
  started_at: string;
  finished_at: string;
  evidence_sha256: string | null;
}

export function syntheticCopyRecord(input: SyntheticRecordInput): CopyRecord {
  const { cell, baseline } = input;
  return {
    copy_id: input.copy_id,
    state: input.state,
    status: syntheticStatus(cell),
    original_suite: {
      ...syntheticObservation(cell.original_suite, input.runs.original_suite, []),
      executed: baseline.original_suite.test_count,
      expected: baseline.original_suite.test_count,
      failing_test_ids: cell.original_suite === "fail" ? ["synthetic-test-01"] : [],
      suite_sha256: baseline.original_suite.sha256,
    },
    verification: syntheticObservation(cell.verification, input.runs.verification, cell.failure_codes ?? []),
    image_digest: input.image_digest,
    architecture: "amd64",
    started_at: input.started_at,
    finished_at: input.finished_at,
    evidence_sha256: input.evidence_sha256,
  };
}

/** A copy that never ran its checks: invalid after a setup failure, incomplete after a timeout. */
export function unrunCopyRecord(input: Omit<SyntheticRecordInput, "cell" | "runs"> & { outcome: "setup_failed" | "timed_out" }): CopyRecord {
  const observed: ObservedOutcome = input.outcome === "setup_failed" ? "error" : "incomplete";
  const cell: CellObservation = { observed, runs_valid: 0, runs_total: 0, failure_codes: [], detail: `synthetic detail: ${input.outcome}` };
  return {
    copy_id: input.copy_id,
    state: input.state,
    status: input.outcome === "setup_failed" ? "invalid" : "incomplete",
    original_suite: { ...cell, executed: 0, expected: input.baseline.original_suite.test_count, failing_test_ids: [], suite_sha256: input.baseline.original_suite.sha256 },
    verification: { ...cell },
    image_digest: input.image_digest,
    architecture: "amd64",
    started_at: input.started_at,
    finished_at: input.finished_at,
    evidence_sha256: input.evidence_sha256,
  };
}
