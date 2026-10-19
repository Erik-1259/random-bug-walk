// A deterministic fake of the export-verification harness: it runs no copy, produces synthetic copy
// records from a plan per entry, and calls the loop's hooks exactly as the real harness does.
import { CHECK_SET_VALUES, COPY_STATE_VALUES } from "@rbw/factory-contract";
import type { CatalogEntry, CellObservation, CheckSet, CopyRecord, CopyRecordStatus, CopyState, HarnessIdentity, ObservedOutcome } from "@rbw/factory-contract";
import type { CellMatrix, HarnessResult, QualifyHarness, QualifyInput } from "../ports.ts";
import { EXPECTED } from "../verdict.ts";
import { syntheticCopyPlan, syntheticSha } from "./catalog.ts";

export const FAKE_HARNESS: HarnessIdentity = { name: "rbw-validate", version: "0.0.0-synthetic" };

/** What one copy of a state observes. */
export interface CellPlan {
  original_suite: ObservedOutcome;
  verification: ObservedOutcome;
  /** Failure codes the verification checks report on this copy. */
  failure_codes?: string[];
}

export type StatePlan = Record<CopyState, CellPlan>;

export interface EntryPlan {
  states: StatePlan;
  integrity?: "verified" | "failed";
  /** Reject with an uncertain provider outcome when this copy (from 1) would start. */
  uncertain_at_copy?: number;
  /** Await `hooks.pause` while this copy (from 1) is in flight. */
  pause_at_copy?: number;
  /** After this many copies, call `hooks.workerLost` and await `hooks.hang`. */
  lost_after_copies?: number;
}

/** Every cell as the qualification table expects, with `codes` reported on the buggy copy. */
export function qualifyingPlan(codes: string[]): StatePlan {
  return {
    clean: { original_suite: "pass", verification: "pass" },
    buggy: { original_suite: "pass", verification: "fail", failure_codes: codes },
    fixed: { original_suite: "pass", verification: "pass" },
  };
}

export class UncertainOutcomeError extends Error {
  constructor(message = "the provider's answer to a sandbox create was lost; its outcome is uncertain") {
    super(message);
    this.name = "UncertainOutcomeError";
  }
}

export interface FakeHarnessOptions {
  plan(entry: CatalogEntry): EntryPlan;
  /** The stored parts' hashes (in test mode, the hashes of the synthetic pair builder's bytes). */
  packages(entry: CatalogEntry): { bug_case: string; validator: string };
  now(): Date;
  /** Runs per copy for each check set; the original suite runs 3 rounds by default. */
  originalSuiteRuns?: number;
  hooks?: {
    pause?(): Promise<void>;
    workerLost?(): Promise<void>;
    hang?(): Promise<void>;
  };
}

function observation(observed: ObservedOutcome, runs: number, codes: string[]): CellObservation {
  const valid = observed === "error" ? 0 : observed === "incomplete" ? Math.max(runs - 1, 0) : runs;
  return { observed, runs_valid: valid, runs_total: runs, failure_codes: observed === "fail" ? codes : [], detail: `synthetic detail: ${observed}` };
}

function statusOf(cell: CellPlan): CopyRecordStatus {
  if (cell.original_suite === "error" || cell.verification === "error") return "invalid";
  if (cell.original_suite === "incomplete" || cell.verification === "incomplete") return "incomplete";
  return "complete";
}

const NOT_RUN: CellObservation = { observed: "incomplete", runs_valid: 0, runs_total: 0, failure_codes: [], detail: "" };

function resultOf(matrix: CellMatrix): HarnessResult["result"] {
  let mismatch = false;
  for (const set of CHECK_SET_VALUES) {
    for (const state of COPY_STATE_VALUES) {
      const observed = matrix[set][state].observed;
      if (observed !== "pass" && observed !== "fail") return "error";
      if (observed !== EXPECTED[set][state]) mismatch = true;
    }
  }
  return mismatch ? "failed" : "passed";
}

export function fakeHarness(options: FakeHarnessOptions): QualifyHarness {
  const suiteRuns = options.originalSuiteRuns ?? 3;
  return async (input: QualifyInput): Promise<HarnessResult> => {
    const { entry, adapter } = input;
    const plan = options.plan(entry);
    const protocol = adapter.protocol(entry);
    const baseline = adapter.baseline();
    const records: CopyRecord[] = [];
    let copies = 0;
    let stopped = false;
    states: for (const state of COPY_STATE_VALUES) {
      const cell = plan.states[state];
      for (let n = 1; n <= protocol.per_state[state].copies; n += 1) {
        const copyPlan = syntheticCopyPlan(entry, state, n);
        if ((await input.beforeCopy(copyPlan)) === "stop") {
          stopped = true;
          break states;
        }
        copies += 1;
        if (plan.uncertain_at_copy === copies) throw new UncertainOutcomeError();
        const started = options.now().toISOString();
        if (plan.pause_at_copy === copies) await options.hooks?.pause?.();
        const verificationRuns = protocol.per_state[state].rounds_per_copy;
        const record: CopyRecord = {
          copy_id: copyPlan.copy_id,
          state,
          status: statusOf(cell),
          original_suite: {
            ...observation(cell.original_suite, suiteRuns, []),
            executed: baseline.original_suite.test_count,
            expected: baseline.original_suite.test_count,
            failing_test_ids: cell.original_suite === "fail" ? ["synthetic-test-01"] : [],
            suite_sha256: baseline.original_suite.sha256,
          },
          verification: observation(cell.verification, verificationRuns, cell.failure_codes ?? []),
          image_digest: entry.environment.kit_image_digest,
          architecture: "amd64",
          started_at: started,
          finished_at: options.now().toISOString(),
          evidence_sha256: syntheticSha(`evidence:${copyPlan.copy_id}`),
        };
        records.push(record);
        await input.onCopy(record);
        if (plan.lost_after_copies === copies) {
          await options.hooks?.workerLost?.();
          await options.hooks?.hang?.();
        }
      }
    }
    const byState = (state: CopyState): Record<CheckSet, CellObservation> => {
      const stateRecords = records.filter((record) => record.state === state);
      return stateRecords.length === 0 ? { original_suite: NOT_RUN, verification: NOT_RUN } : adapter.interpret(stateRecords, protocol);
    };
    const clean = byState("clean");
    const buggy = byState("buggy");
    const fixed = byState("fixed");
    const matrix: CellMatrix = {
      original_suite: { clean: clean.original_suite, buggy: buggy.original_suite, fixed: fixed.original_suite },
      verification: { clean: clean.verification, buggy: buggy.verification, fixed: fixed.verification },
    };
    const integrity = plan.integrity ?? "verified";
    const packages = options.packages(entry);
    return {
      result: integrity === "failed" ? "error" : resultOf(matrix),
      stopped,
      package_sha256: packages,
      harness: FAKE_HARNESS,
      matrix: integrity === "failed" ? null : matrix,
      records,
      integrity,
      message: null,
    };
  };
}
