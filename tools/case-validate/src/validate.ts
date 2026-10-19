// validatePair: the harness library entry point. It verifies the two archives, rebuilds the three states
// in a fresh workspace, asks the host adapter for copy plans, checks the host's availability for the
// planned span and drives the copies through the runner and the adapter's collect, then evaluates the matrix.
import { validateContract } from "@rbw/factory-contract/validate";
import type {
  CatalogEntry,
  CellObservation,
  CollectedCopy,
  CopyPlan,
  CopyRecord,
  CopyRoots,
  CopyRunner,
  CopyState,
  HostAdapter,
  HostAvailability,
  HostId,
  InterpretedCells,
  PackageHashes,
  Protocol,
  UnpackedPair,
  ValidationResult,
} from "@rbw/factory-contract";
import { COPY_STATE_VALUES } from "@rbw/factory-contract";
import { sha256Hex } from "@rbw/schema";
import { evaluateMatrix, type CellMatrix } from "./matrix.ts";
import { PairRefused, verifyPair } from "./verify.ts";
import { buildWorkspace } from "./workspace.ts";

export interface ValidatePairInput {
  bug_case: Uint8Array;
  validator: Uint8Array;
  adapters: Partial<Record<HostId, HostAdapter>>;
  runner: CopyRunner;
  now: () => Date;
  /** The run's planned end for the availability check; defaults to now plus every planned copy's time limit. */
  until?: Date;
  /** The directory the fresh workspace is created in; defaults to the system's temporary directory. */
  workdir?: string;
  /** Called before each copy, in the fixed order clean, buggy, fixed; "stop" runs no further copy. */
  beforeCopy?: (plan: CopyPlan) => Promise<"continue" | "stop">;
  /** Called with each copy's record as soon as it is collected (per-copy settlement and events). */
  onCopy?: (record: CopyRecord) => Promise<void>;
  /** Called with a state's two cells after its last copy. */
  onCells?: (state: CopyState, cells: InterpretedCells) => Promise<void>;
}

/**
 * Why a run answered `error`. `export_mismatch` covers every refusal of the pair itself (unreadable or
 * tampered archives, a mismatched or swapped pair, a patch that does not apply or does not reproduce its
 * recorded result); qualification maps it to the candidate reason `export_mismatch`.
 */
export type ValidatePairErrorCode = "export_mismatch" | "unsupported_host" | "host_unavailable" | "adapter_error" | "runner_error" | "cells_invalid" | "stopped";

export interface ValidatePairResult {
  result: ValidationResult;
  stopped: boolean;
  package_sha256: PackageHashes;
  /** Null when the pair was refused before it was bound. */
  pair_sha256: string | null;
  matrix: CellMatrix | null;
  records: CopyRecord[];
  /** Client-safe; never holds check output, failure codes or validator paths. */
  message: string | null;
  /** Evaluator material (may name validator members); never sent to a client. */
  diagnostic: string | null;
  error_code: ValidatePairErrorCode | null;
}

export interface CopyLoopInput {
  adapter: HostAdapter;
  runner: CopyRunner;
  unpacked: UnpackedPair;
  protocol: Protocol;
  plans: Record<CopyState, CopyPlan[]>;
  beforeCopy?: ValidatePairInput["beforeCopy"];
  onCopy?: ValidatePairInput["onCopy"];
  onCells?: ValidatePairInput["onCells"];
}

export interface CopyLoopOutcome {
  /** Null when the loop stopped before every state was interpreted. */
  cells: Record<CopyState, InterpretedCells> | null;
  records: CopyRecord[];
  stopped: boolean;
}

/** A definite failure inside the loop that is not the runner's uncertainty: the run answers `error`. */
export class CopyLoopError extends Error {
  readonly code: "adapter_error" | "runner_error";
  readonly records: readonly CopyRecord[];

  constructor(code: "adapter_error" | "runner_error", message: string, records: readonly CopyRecord[]) {
    super(message);
    this.name = "CopyLoopError";
    this.code = code;
    this.records = records;
  }
}

function checkedRecord(plan: CopyPlan, collected: CollectedCopy, record: CopyRecord, records: readonly CopyRecord[]): CopyRecord {
  const fail = (problem: string): never => {
    throw new CopyLoopError("adapter_error", `collect for ${plan.copy_id}: ${problem}`, records);
  };
  const errors = validateContract("CopyRecord", record);
  if (errors.length > 0) fail(`not a valid CopyRecord: ${errors.join(", ")}`);
  if (record.copy_id !== plan.copy_id || record.state !== plan.state) fail("the record names another copy or state");
  if (record.evidence_sha256 !== collected.results_sha256) fail("evidence_sha256 differs from the collected results_sha256");
  if (record.status === "complete" && collected.results_sha256 === null) fail("a copy without results gave a complete record");
  if (collected.outcome !== "ran") {
    // A copy that was not set up is invalid, one that passed its time limit is incomplete, and neither is
    // ever a pass, a fail or a detection.
    const status = collected.outcome === "setup_failed" ? "invalid" : "incomplete";
    const unobserved = (observed: string): boolean => observed === "error" || observed === "incomplete";
    if (record.status !== status || !unobserved(record.original_suite.observed) || !unobserved(record.verification.observed)) {
      fail(`a ${collected.outcome} copy became an observation or has another status than ${status}`);
    }
  }
  return record;
}

/**
 * The copy loop, in the fixed order clean, buggy, fixed: beforeCopy, then
 * runner.run(plan, roots), adapter.collect, onCopy; after a state's last copy, adapter.interpret and
 * onCells. A runner rejection (an uncertain provider outcome) propagates unchanged and no further copy runs;
 * the records collected before it have already reached onCopy.
 */
export async function runCopies(input: CopyLoopInput): Promise<CopyLoopOutcome> {
  const records: CopyRecord[] = [];
  const cells = {} as Record<CopyState, InterpretedCells>;
  for (const state of COPY_STATE_VALUES) {
    const roots: CopyRoots = { app_root: input.unpacked.states[state].root, evaluator_root: input.unpacked.evaluator.root };
    const stateRecords: CopyRecord[] = [];
    for (const plan of input.plans[state]) {
      if (input.beforeCopy !== undefined && (await input.beforeCopy(plan)) === "stop") return { cells: null, records, stopped: true };
      const collected = await input.runner.run(plan, roots);
      const collectedErrors = validateContract("CollectedCopy", collected);
      if (collectedErrors.length > 0 || collected.copy_id !== plan.copy_id) {
        throw new CopyLoopError("runner_error", `the runner returned an invalid collected copy for ${plan.copy_id}: ${collectedErrors.join(", ") || "another copy_id"}`, records);
      }
      let record: CopyRecord;
      try {
        record = await input.adapter.collect(plan, collected);
      } catch (error) {
        throw new CopyLoopError("adapter_error", `collect for ${plan.copy_id} threw: ${error instanceof Error ? error.message : String(error)}`, records);
      }
      records.push(checkedRecord(plan, collected, record, records));
      stateRecords.push(record);
      if (input.onCopy !== undefined) await input.onCopy(record);
    }
    let interpreted: InterpretedCells;
    try {
      interpreted = input.adapter.interpret(stateRecords, input.protocol);
    } catch (error) {
      throw new CopyLoopError("adapter_error", `interpret(${state}) threw: ${error instanceof Error ? error.message : String(error)}`, records);
    }
    const stateCells = withCopyStatus(checkedCells(state, interpreted, input.protocol, records), stateRecords);
    cells[state] = stateCells;
    if (input.onCells !== undefined) await input.onCells(state, stateCells);
  }
  return { cells, records, stopped: false };
}

/**
 * Checks the adapter's two cells and applies the protocol's floor: a pass or fail on fewer valid runs than
 * the state's min_valid_runs is incomplete, whatever the adapter reported.
 */
function checkedCells(state: CopyState, cells: InterpretedCells, protocol: Protocol, records: readonly CopyRecord[]): InterpretedCells {
  const minimum = protocol.per_state[state].min_valid_runs;
  const check = (name: keyof InterpretedCells): CellObservation => {
    const cell = (cells as Partial<InterpretedCells> | null)?.[name];
    const errors = validateContract("CellObservation", cell);
    if (cell === undefined || errors.length > 0 || cell.runs_valid > cell.runs_total) {
      throw new CopyLoopError("adapter_error", `interpret(${state}) gave an invalid ${name} cell: ${errors.join(", ") || "more valid runs than runs"}`, records);
    }
    if ((cell.observed === "pass" || cell.observed === "fail") && cell.runs_valid < minimum) {
      return { ...cell, observed: "incomplete", detail: `fewer valid runs than the protocol's ${String(minimum)}` };
    }
    return cell;
  };
  return { original_suite: check("original_suite"), verification: check("verification") };
}

/**
 * Applies the copies' statuses, whatever the adapter interpreted: a state with an invalid copy observes
 * `error` in both cells, and one with an incomplete copy at least `incomplete`, so neither is ever a pass or
 * a fail. The adapter's run counts are kept.
 */
function withCopyStatus(cells: InterpretedCells, stateRecords: readonly CopyRecord[]): InterpretedCells {
  const invalid = stateRecords.filter((record) => record.status === "invalid").length;
  const incomplete = stateRecords.filter((record) => record.status === "incomplete").length;
  if (invalid === 0 && incomplete === 0) return cells;
  const observed = invalid > 0 ? "error" : "incomplete";
  const detail = invalid > 0
    ? `${String(invalid)} of ${String(stateRecords.length)} copies are invalid`
    : `${String(incomplete)} of ${String(stateRecords.length)} copies are incomplete`;
  const apply = (cell: CellObservation): CellObservation =>
    cell.observed === "error" || cell.observed === observed ? cell : { ...cell, observed, detail };
  return { original_suite: apply(cells.original_suite), verification: apply(cells.verification) };
}

class PlanError extends Error {}

/** Calls the adapter before any copy runs; a throw is an adapter error, never a rejection of the run. */
function beforeCopies<T>(name: string, call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw new PlanError(`${name} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function planCopies(adapter: HostAdapter, unpacked: UnpackedPair, protocol: Protocol): Record<CopyState, CopyPlan[]> {
  const plans = {} as Record<CopyState, CopyPlan[]>;
  const copyIds = new Set<string>();
  const evaluator = new Map(unpacked.evaluator.files.map((file) => [file.path, file.sha256]));
  for (const state of COPY_STATE_VALUES) {
    const statePlans = beforeCopies(`copyPlans(${state})`, () => adapter.copyPlans(state, unpacked, protocol));
    const copies = protocol.per_state[state].copies;
    if (!Array.isArray(statePlans) || statePlans.length !== copies) {
      throw new PlanError(`copyPlans(${state}) did not return the protocol's ${String(copies)} copies`);
    }
    const tree = new Map(unpacked.states[state].files.map((file) => [file.path, file.sha256]));
    for (const plan of statePlans) {
      const errors = validateContract("CopyPlan", plan);
      if (errors.length > 0) throw new PlanError(`a ${state} plan is not a valid CopyPlan: ${errors.join(", ")}`);
      if (plan.state !== state || plan.host_id !== adapter.host_id) throw new PlanError(`a ${state} plan names another state or host`);
      if (copyIds.has(plan.copy_id)) throw new PlanError(`copy_id ${plan.copy_id} appears twice`);
      copyIds.add(plan.copy_id);
      // The plan may only place files of the harness-built tree, unchanged: the adapter applies no patch.
      if (!plan.files.every((file) => tree.get(file.path) === file.sha256)) throw new PlanError(`a ${state} plan places a file that is not in the ${state} tree`);
      if (!plan.evaluator_files.every((file) => evaluator.get(file.path) === file.sha256)) throw new PlanError(`a ${state} plan places an evaluator file that is not in the validator package`);
    }
    plans[state] = statePlans;
  }
  return plans;
}

function isAvailability(value: unknown): value is HostAvailability {
  if (typeof value !== "object" || value === null) return false;
  const { available, reason } = value as { available?: unknown; reason?: unknown };
  return typeof available === "boolean" && (reason === null || typeof reason === "string");
}

function entryOf(adapter: HostAdapter, entryId: string): CatalogEntry | null {
  return beforeCopies("catalog()", () => adapter.catalog()).find((entry) => entry.entry_id === entryId) ?? null;
}

/**
 * Runs the standalone harness on one bug case and one validator package. Resolves `passed`, `failed` or
 * `error` (contract section 11); every refusal, every adapter fault and every invalid or incomplete copy or cell is
 * `error`. Rejects only when the runner rejects (an uncertain provider outcome) or one of the caller's own
 * callbacks throws: the records collected before it have been passed to onCopy, no further copy runs, and
 * the error is rethrown unchanged.
 */
export async function validatePair(input: ValidatePairInput): Promise<ValidatePairResult> {
  const packageSha256: PackageHashes = { bug_case: sha256Hex(input.bug_case), validator: sha256Hex(input.validator) };
  const error = (code: ValidatePairErrorCode, message: string, diagnostic: string | null, pair: string | null): ValidatePairResult => ({
    result: "error",
    stopped: false,
    package_sha256: packageSha256,
    pair_sha256: pair,
    matrix: null,
    records: [],
    message,
    diagnostic,
    error_code: code,
  });

  let verified;
  try {
    verified = verifyPair(input.bug_case, input.validator);
  } catch (refusal) {
    if (refusal instanceof PairRefused) return error("export_mismatch", refusal.message, refusal.diagnostic, null);
    throw refusal;
  }
  const { manifest } = verified.validator;
  const adapter = input.adapters[manifest.host_id];
  if (adapter?.host_id !== manifest.host_id) {
    return error("unsupported_host", "no host adapter is registered for the package's host", `host_id ${manifest.host_id}`, verified.pair_sha256);
  }

  let workspace;
  try {
    workspace = await buildWorkspace(verified, input.workdir);
  } catch (refusal) {
    if (refusal instanceof PairRefused) return error("export_mismatch", refusal.message, refusal.diagnostic, verified.pair_sha256);
    throw refusal;
  }
  try {
    const protocol = manifest.protocol;
    let plans: Record<CopyState, CopyPlan[]>;
    let availability: HostAvailability | null = null;
    try {
      plans = planCopies(adapter, workspace.unpacked, protocol);
      const check = adapter.availability?.bind(adapter);
      if (check !== undefined) {
        const entry = entryOf(adapter, manifest.entry_id);
        if (entry === null) return error("host_unavailable", "the host no longer lists the package's catalog entry", `entry_id ${manifest.entry_id}`, verified.pair_sha256);
        const from = input.now();
        const plannedSeconds = COPY_STATE_VALUES.reduce((sum, state) => sum + plans[state].reduce((total, plan) => total + plan.limits.timeout_s, 0), 0);
        const until = input.until ?? new Date(from.getTime() + plannedSeconds * 1000);
        const answer: unknown = beforeCopies("availability()", () => check(entry, from.toISOString(), until.toISOString()));
        if (!isAvailability(answer)) throw new PlanError("availability() did not answer { available, reason }");
        availability = answer;
      }
    } catch (planError) {
      if (planError instanceof PlanError) return error("adapter_error", "the host adapter could not plan the copies", planError.message, verified.pair_sha256);
      throw planError;
    }
    if (availability !== null && !availability.available) {
      return error("host_unavailable", `the host is unavailable for the run's planned span: ${availability.reason ?? "no reason given"}`, null, verified.pair_sha256);
    }
    let loop: CopyLoopOutcome;
    try {
      loop = await runCopies({
        adapter,
        runner: input.runner,
        unpacked: workspace.unpacked,
        protocol,
        plans,
        ...(input.beforeCopy === undefined ? {} : { beforeCopy: input.beforeCopy }),
        ...(input.onCopy === undefined ? {} : { onCopy: input.onCopy }),
        ...(input.onCells === undefined ? {} : { onCells: input.onCells }),
      });
    } catch (loopError) {
      // Only CopyLoopError is answered here; a runner rejection propagates unchanged.
      if (!(loopError instanceof CopyLoopError)) throw loopError;
      const message = loopError.code === "runner_error" ? "the copy runner returned an invalid result" : "the host adapter could not read or evaluate the copies";
      return { ...error(loopError.code, message, loopError.message, verified.pair_sha256), records: [...loopError.records] };
    }
    if (loop.stopped || loop.cells === null) {
      return { ...error("stopped", "the run was stopped before every copy finished", null, verified.pair_sha256), stopped: loop.stopped, records: loop.records };
    }
    const { result, matrix } = evaluateMatrix(loop.cells, manifest.expected);
    return {
      result,
      stopped: false,
      package_sha256: packageSha256,
      pair_sha256: verified.pair_sha256,
      matrix,
      records: loop.records,
      message: result === "error" ? "at least one cell could not be observed validly" : null,
      diagnostic: null,
      error_code: result === "error" ? "cells_invalid" : null,
    };
  } finally {
    await workspace.dispose();
  }
}
