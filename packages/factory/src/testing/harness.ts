// A deterministic fake of the export-verification harness: it runs no copy, produces synthetic copy
// records from a plan per entry, and calls the loop's hooks exactly as the real harness does.
import { CHECK_SET_VALUES, COPY_STATE_VALUES } from "@rbw/factory-contract";
import type { CatalogEntry, CellObservation, CheckSet, CopyRecord, CopyState, HarnessIdentity } from "@rbw/factory-contract";
import type { CellMatrix, HarnessResult, QualifyHarness, QualifyInput } from "../ports.ts";
import { EXPECTED } from "../verdict.ts";
import { SYNTHETIC_SUITE_RUNS, syntheticCopyPlan, syntheticSha } from "./catalog.ts";
import { syntheticCopyRecord } from "./records.ts";
import type { CellPlan } from "./records.ts";

export type { CellPlan } from "./records.ts";

export const FAKE_HARNESS: HarnessIdentity = { name: "rbw-validate", version: "0.0.0-synthetic" };

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

export interface FakeHooks {
  pause?(): Promise<void>;
  workerLost?(): Promise<void>;
  hang?(): Promise<void>;
}

export interface FakeHarnessOptions {
  plan(entry: CatalogEntry): EntryPlan;
  /** The stored parts' hashes (in test mode, the hashes of the synthetic pair builder's bytes). */
  packages(entry: CatalogEntry): { bug_case: string; validator: string };
  now(): Date;
  /** Runs per copy of the original suite; 3 by default. */
  originalSuiteRuns?: number;
  hooks?: FakeHooks;
}

const NOT_RUN: CellObservation = { observed: "incomplete", runs_valid: 0, runs_total: 0, failure_codes: [], detail: "" };

/** The harness's result value from a matrix: passed, failed (all valid, some mismatch) or error. */
export function harnessResultOf(matrix: CellMatrix): HarnessResult["result"] {
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

/** The matrix of a run's records, read state by state with the adapter's `interpret`. */
export function matrixOf(records: readonly CopyRecord[], interpret: (records: CopyRecord[]) => Record<CheckSet, CellObservation>): CellMatrix {
  const byState = (state: CopyState): Record<CheckSet, CellObservation> => {
    const stateRecords = records.filter((record) => record.state === state);
    return stateRecords.length === 0 ? { original_suite: NOT_RUN, verification: NOT_RUN } : interpret(stateRecords);
  };
  return matrixFromCells({ clean: byState("clean"), buggy: byState("buggy"), fixed: byState("fixed") });
}

function matrixFromCells(cells: Record<CopyState, Record<CheckSet, CellObservation>>): CellMatrix {
  const { clean, buggy, fixed } = cells;
  return {
    original_suite: { clean: clean.original_suite, buggy: buggy.original_suite, fixed: fixed.original_suite },
    verification: { clean: clean.verification, buggy: buggy.verification, fixed: fixed.verification },
  };
}

/**
 * The protocol's floor, as the harness applies it to a state's cells: a pass or fail on fewer valid runs
 * than the state's `min_valid_runs` is incomplete, whatever the adapter reported.
 */
export function protocolFloor(cells: Record<CheckSet, CellObservation>, minValidRuns: number): Record<CheckSet, CellObservation> {
  const floor = (cell: CellObservation): CellObservation =>
    (cell.observed === "pass" || cell.observed === "fail") && cell.runs_valid < minValidRuns ? { ...cell, observed: "incomplete", detail: `fewer valid runs than the protocol's ${String(minValidRuns)}` } : cell;
  return { original_suite: floor(cells.original_suite), verification: floor(cells.verification) };
}

export function fakeHarness(options: FakeHarnessOptions): QualifyHarness {
  const suiteRuns = options.originalSuiteRuns ?? SYNTHETIC_SUITE_RUNS;
  return async (input: QualifyInput): Promise<HarnessResult> => {
    const { entry, adapter } = input;
    const plan = options.plan(entry);
    const protocol = adapter.protocol(entry);
    const baseline = adapter.baseline();
    const records: CopyRecord[] = [];
    const checked: Record<CopyState, Record<CheckSet, CellObservation>> = {
      clean: { original_suite: NOT_RUN, verification: NOT_RUN },
      buggy: { original_suite: NOT_RUN, verification: NOT_RUN },
      fixed: { original_suite: NOT_RUN, verification: NOT_RUN },
    };
    let copies = 0;
    let stopped = false;
    states: for (const state of COPY_STATE_VALUES) {
      const cell = plan.states[state];
      const stateRecords: CopyRecord[] = [];
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
        const record = syntheticCopyRecord({
          copy_id: copyPlan.copy_id,
          state,
          cell,
          baseline,
          runs: { original_suite: suiteRuns, verification: protocol.per_state[state].rounds_per_copy },
          image_digest: entry.environment.kit_image_digest,
          started_at: started,
          finished_at: options.now().toISOString(),
          evidence_sha256: syntheticSha(`evidence:${copyPlan.copy_id}`),
        });
        records.push(record);
        stateRecords.push(record);
        await input.onCopy(record);
        if (plan.lost_after_copies === copies) {
          await options.hooks?.workerLost?.();
          await options.hooks?.hang?.();
        }
      }
      // After the state's last copy: the adapter's cells with the protocol's floor, as the harness checks them.
      checked[state] = protocolFloor(adapter.interpret(stateRecords, protocol), protocol.per_state[state].min_valid_runs);
      await input.onCells(state, checked[state]);
    }
    const matrix = matrixFromCells(checked);
    const integrity = plan.integrity ?? "verified";
    return {
      result: integrity === "failed" ? "error" : harnessResultOf(matrix),
      stopped,
      package_sha256: options.packages(entry),
      harness: FAKE_HARNESS,
      matrix: integrity === "failed" ? null : matrix,
      records,
      integrity,
      message: null,
    };
  };
}
