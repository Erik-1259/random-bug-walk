// The evaluation of evaluator v2, run on the host side over a copy's record set (copy.json). For
// one copy it checks the copy's identity and source tree against what the evaluator itself expects,
// recomputes every block from its ordered trial outcomes under the protocol file's rule, and maps
// the copy to the contract's two cells: the original suite and the verification checks. For one
// state it combines the copies' cells under the declared protocol, and for a full set of states it
// gives the qualification verdict. Invalid (a copy or instance could not be prepared) and
// incomplete (fewer valid runs than declared, or any identity, tree, rule or replay mismatch) stay
// distinct, and a mismatch with the expected cells counts only on complete evidence. Pure.
import type { CellObservation, CopyRecordStatus, CopyState, ProtocolState, SuiteObservation } from "@rbw/factory-contract";
import { blockStatus } from "../src/f3/block.ts";
import type { BlockRule, BlockStatus } from "../src/f3/block.ts";
import { FAILURE_CODE, KINDS, STATES } from "../src/f3/data.ts";
import type { F3Data, KindId, Outcome } from "../src/f3/data.ts";
import { treeSha256 } from "../src/hash.ts";
import type { StateExpectation } from "./expected.ts";
import { blockRuleV2 } from "./protocol.ts";
import type { ProtocolV2 } from "./protocol.ts";
import type { CopySummaryV2, InstanceRecordV2 } from "./record.ts";

export class EvaluationError extends Error {
  override name = "EvaluationError";
}

/** The contract's expected cells (qualification table): original suite pass on every copy; verification pass, fail, pass. */
export const EXPECTED_CELLS = {
  original_suite: { clean: "pass", buggy: "pass", fixed: "pass" },
  verification: { clean: "pass", buggy: "fail", fixed: "pass" },
} as const;

export interface CopyCells {
  status: CopyRecordStatus;
  original_suite: SuiteObservation;
  verification: CellObservation;
}

export interface CopyEvaluation extends CopyCells {
  /** Why the copy is invalid or incomplete, or why a cell failed; empty for a clean pass. */
  reasons: string[];
}

export interface StateCells {
  original_suite: CellObservation;
  verification: CellObservation;
}

export interface BlockReplay {
  status: BlockStatus;
  problems: string[];
}

function sameRule(a: BlockRule, b: BlockRule): boolean {
  return a.valid_target === b.valid_target && a.max_invalid === b.max_invalid && a.max_top_ups === b.max_top_ups;
}

function sameStatus(a: BlockStatus, b: BlockStatus): boolean {
  const keys = (outcomes: Record<string, number>): string[] => Object.keys(outcomes).filter((key) => (outcomes[key] ?? 0) !== 0).sort();
  return (
    a.state === b.state &&
    a.attempts === b.attempts &&
    a.valid === b.valid &&
    a.invalid === b.invalid &&
    a.top_ups === b.top_ups &&
    a.next_index === b.next_index &&
    keys(a.outcomes).join(",") === keys(b.outcomes).join(",") &&
    keys(a.outcomes).every((key) => a.outcomes[key] === b.outcomes[key])
  );
}

/** Recomputes a block from its ordered outcomes under a rule and compares the recorded status. */
export function replayBlock(rule: BlockRule, outcomes: readonly Outcome[], recorded: BlockStatus | undefined): BlockReplay {
  const problems: string[] = [];
  for (let length = 1; length < outcomes.length; length += 1) {
    if (blockStatus(rule, outcomes.slice(0, length)).next_index === null) {
      problems.push(`trials continue after the rule stops the block at ${String(length)} attempts`);
      break;
    }
  }
  const status = blockStatus(rule, outcomes);
  if (status.state === "running") problems.push(`the block ended at ${String(outcomes.length)} attempts before the rule stops it`);
  if (recorded === undefined) problems.push("the block has no recorded status");
  else if (!sameStatus(recorded, status)) problems.push("the recorded block status differs from the recomputed one");
  return { status, problems };
}

function observation(observed: CellObservation["observed"], runsValid: number, runsTotal: number, codes: string[], detail: string): CellObservation {
  return { observed, runs_valid: runsValid, runs_total: runsTotal, failure_codes: codes, detail };
}

interface SuiteTally {
  valid: number;
  failed: boolean;
  executed: number;
  failing: Set<string>;
  notes: string[];
}

function tallySuite(protocol: ProtocolV2, instances: readonly InstanceRecordV2[]): SuiteTally {
  const tally: SuiteTally = { valid: 0, failed: false, executed: 0, failing: new Set(), notes: [] };
  const required = protocol.required_passed;
  for (const instance of instances) {
    const name = `instance ${String(instance.instance)}`;
    const suite = instance.suite;
    if (suite === null) {
      tally.notes.push(`${name}: the original suite did not run`);
      continue;
    }
    const allRan = suite.tests_expected === required && suite.passed + suite.failed.length === required;
    if (suite.verdict === "passed" && allRan && suite.failed.length === 0) {
      tally.valid += 1;
      tally.executed += required;
    } else if (suite.verdict === "failed" && allRan && suite.failed.length > 0) {
      tally.valid += 1;
      tally.executed += required;
      tally.failed = true;
      for (const id of suite.failed) tally.failing.add(id);
      tally.notes.push(`${name}: ${String(suite.failed.length)} original tests failed`);
    } else {
      tally.notes.push(`${name}: the original suite run is not valid (${suite.verdict}, ${String(suite.passed)} of ${String(required)} passed)`);
    }
  }
  return tally;
}

interface ChecksTally {
  valid: number;
  outcomes: Record<KindId, Outcome[]>;
  notes: string[];
}

function tallyChecks(protocol: ProtocolV2, instances: readonly InstanceRecordV2[]): ChecksTally {
  const outcomes = {} as Record<KindId, Outcome[]>;
  for (const kind of KINDS) outcomes[kind] = [];
  const tally: ChecksTally = { valid: 0, outcomes, notes: [] };
  for (const instance of instances) {
    const name = `instance ${String(instance.instance)}`;
    if (instance.failure !== null) {
      tally.notes.push(`${name}: ${instance.failure.detail}`);
      continue;
    }
    const problems: string[] = [];
    const replays: Partial<Record<KindId, BlockStatus>> = {};
    for (const kind of KINDS) {
      const trials = instance.trials[kind];
      if (trials === undefined) {
        problems.push(`no ${kind} block`);
        continue;
      }
      const replay = replayBlock(blockRuleV2(protocol, kind), trials, instance.blocks[kind]);
      problems.push(...replay.problems.map((problem) => `${kind}: ${problem}`));
      if (replay.status.state !== "complete") problems.push(`${kind}: the block is ${replay.status.state} (${String(replay.status.valid)} valid, ${String(replay.status.invalid)} invalid)`);
      replays[kind] = replay.status;
    }
    if (problems.length > 0) {
      tally.notes.push(...problems.map((problem) => `${name}: ${problem}`));
      continue;
    }
    tally.valid += 1;
    for (const kind of KINDS) for (const outcome of instance.trials[kind] ?? []) if (outcome !== "invalid") outcomes[kind].push(outcome);
  }
  return tally;
}

/** The verification cell's result over every valid trial: the declared code only for the buggy vector's exact pattern. */
function checksResult(protocol: ProtocolV2, data: F3Data, outcomes: Record<KindId, Outcome[]>): { observed: "pass" | "fail"; codes: string[]; detail: string } {
  const buggy = data.expected.buggy;
  const detail = KINDS.map((kind) => {
    const counts: Record<string, number> = {};
    for (const outcome of outcomes[kind]) counts[outcome] = (counts[outcome] ?? 0) + 1;
    return `${kind} ${Object.entries(counts).map(([outcome, n]) => `${outcome} ${String(n)}`).join(", ") || "none"}`;
  }).join("; ");
  const allPass = KINDS.every((kind) => outcomes[kind].every((outcome) => outcome === "pass"));
  if (allPass) return { observed: "pass", codes: [], detail };
  const signature = KINDS.every((kind) => outcomes[kind].length > 0 && outcomes[kind].every((outcome) => outcome === buggy[kind]));
  if (signature) return { observed: "fail", codes: [protocol.verification_codes.declared], detail };
  const detecting = KINDS.filter((kind) => buggy[kind] === FAILURE_CODE);
  const codes: string[] = [];
  const someDetected = detecting.some((kind) => outcomes[kind].includes(FAILURE_CODE));
  if (detecting.some((kind) => outcomes[kind].includes("pass")) && someDetected) codes.push(protocol.verification_codes.inconsistent);
  if (KINDS.some((kind) => buggy[kind] === "pass" && outcomes[kind].includes(FAILURE_CODE))) codes.push(protocol.verification_codes.control);
  if (codes.length === 0) codes.push(protocol.verification_codes.inconsistent);
  return { observed: "fail", codes, detail };
}

/** One copy's cells. `expect` names the copy and state a plan asked for, when there is a plan. */
export function evaluateCopyV2(protocol: ProtocolV2, data: F3Data, expectation: StateExpectation, copy: CopySummaryV2, expect?: { copy_id: string; state: CopyState }): CopyEvaluation {
  if (protocol.data_sha256 !== data.sha256) throw new EvaluationError("the protocol pins another data file");
  const state = copy.state;
  const declared = protocol.states[state].instances;
  const minValid = protocol.min_valid_instances[state];
  const identity: string[] = [];
  if (expect !== undefined && copy.copy_id !== expect.copy_id) identity.push("the record set is another copy's");
  if (expect !== undefined && copy.state !== expect.state) identity.push(`the copy ran the ${copy.state} state, not ${expect.state}`);
  if (copy.purpose !== "counted") identity.push("a smoke copy is never counted");
  if (copy.entry_id !== expectation.entry_id) identity.push("the copy names another catalog entry");
  if (copy.catalog_sha256 !== expectation.catalog_sha256) identity.push("the copy ran another catalog");
  if (copy.baseline_id !== protocol.baseline_id || copy.baseline_id !== expectation.baseline_id) identity.push("the copy ran another baseline");
  if (copy.data_sha256 !== protocol.data_sha256) identity.push("the copy ran another data file");
  if (copy.protocol_sha256 !== protocol.sha256) identity.push("the copy ran another protocol");
  const recomputed = treeSha256(copy.source_files);
  if (recomputed !== copy.source_tree_sha256) identity.push("the recorded source tree hash differs from the recorded file hashes");
  if (recomputed !== expectation.trees[state]) identity.push(`the copy ran another source tree than the ${state} state's`);
  if (copy.expected_source_tree_sha256 !== expectation.trees[state]) identity.push("the copy expected another source tree for its state");
  for (const kind of KINDS) if (!sameRule(copy.rules[kind], blockRuleV2(protocol, kind))) identity.push(`the record's ${kind} rule differs from the protocol's`);

  const setup: string[] = [];
  if (copy.invalid_reason !== null) setup.push(`the copy is invalid: ${copy.invalid_reason}`);
  for (const instance of copy.instances) if (instance.failure?.kind === "setup") setup.push(`instance ${String(instance.instance)}: ${instance.failure.detail}`);

  const runsTotal = copy.instances.length;
  const suite = tallySuite(protocol, copy.instances);
  const checks = tallyChecks(protocol, copy.instances);
  const suiteObservation = (observed: CellObservation["observed"], codes: string[], detail: string): SuiteObservation => ({
    ...observation(observed, suite.valid, runsTotal, codes, detail),
    executed: suite.executed,
    expected: protocol.required_passed * runsTotal,
    failing_test_ids: [...suite.failing].sort(),
    suite_sha256: expectation.suite_sha256,
  });

  if (setup.length > 0) {
    const detail = setup.join("; ");
    return { status: "invalid", original_suite: suiteObservation("error", [], detail), verification: observation("error", checks.valid, runsTotal, [], detail), reasons: [...setup, ...identity] };
  }
  if (identity.length > 0) {
    const detail = identity.join("; ");
    return { status: "incomplete", original_suite: suiteObservation("incomplete", [], detail), verification: observation("incomplete", checks.valid, runsTotal, [], detail), reasons: identity };
  }
  const countNote = runsTotal === declared ? [] : [`expected ${String(declared)} instances, found ${String(runsTotal)}`];
  const reasons: string[] = [];

  let suiteCell: SuiteObservation;
  if (runsTotal !== declared || suite.valid < minValid) {
    reasons.push(...countNote, ...suite.notes);
    suiteCell = suiteObservation("incomplete", [], [...countNote, ...suite.notes].join("; ") || "too few valid original-suite runs");
  } else if (suite.failed) {
    reasons.push(...suite.notes);
    suiteCell = suiteObservation("fail", [protocol.verification_codes.original_suite], suite.notes.join("; "));
  } else {
    suiteCell = suiteObservation("pass", [], `${String(suite.valid)} of ${String(runsTotal)} runs passed ${String(protocol.required_passed)} of ${String(protocol.required_passed)}`);
  }

  let checksCell: CellObservation;
  if (runsTotal !== declared || checks.valid < minValid) {
    reasons.push(...countNote, ...checks.notes);
    checksCell = observation("incomplete", checks.valid, runsTotal, [], [...countNote, ...checks.notes].join("; ") || "too few valid checks runs");
  } else {
    const result = checksResult(protocol, data, checks.outcomes);
    if (result.observed === "fail") reasons.push(`verification failed: ${result.codes.join(", ")}`);
    checksCell = observation(result.observed, checks.valid, runsTotal, result.codes, `${String(checks.valid)} of ${String(runsTotal)} instances valid; ${result.detail}`);
  }

  const incomplete = suiteCell.observed === "incomplete" || checksCell.observed === "incomplete";
  return { status: incomplete ? "incomplete" : "complete", original_suite: suiteCell, verification: checksCell, reasons: [...new Set(reasons)] };
}

/** The protocol's per-state counts in the contract's terms: one instance is one round. */
export function perStateV2(protocol: ProtocolV2, state: CopyState): ProtocolState {
  return { copies: protocol.states[state].copies, rounds_per_copy: protocol.states[state].instances, min_valid_runs: protocol.min_valid_instances[state] };
}

function consistent(copy: CopyCells): boolean {
  const cells = [copy.original_suite.observed, copy.verification.observed];
  const valid = cells.every((cell) => cell === "pass" || cell === "fail");
  if (copy.status === "complete") return valid;
  if (copy.status === "invalid") return cells.includes("error");
  return !cells.includes("error") && cells.includes("incomplete");
}

function strip(cell: CellObservation): CellObservation {
  return { observed: cell.observed, runs_valid: cell.runs_valid, runs_total: cell.runs_total, failure_codes: [...cell.failure_codes], detail: cell.detail };
}

/**
 * Combines the cells of one state's copies under the declared counts. `min_valid_runs` counts
 * valid runs over all of the state's copies.
 */
export function aggregateState(perState: ProtocolState, state: CopyState, copies: readonly (CopyCells & { state: CopyState })[]): StateCells {
  const cell = (pick: (copy: CopyCells) => CellObservation): CellObservation => {
    if (copies.length === 0) return observation("incomplete", 0, 0, [], "no copy record for the state");
    const cells = copies.map((copy): CellObservation => {
      if (copy.state !== state) return observation("incomplete", 0, pick(copy).runs_total, [], `a record of the ${copy.state} state`);
      if (!consistent(copy)) return observation("incomplete", 0, pick(copy).runs_total, [], `the record's status ${copy.status} contradicts its cells`);
      return strip(pick(copy));
    });
    const runsValid = cells.reduce((sum, item) => sum + item.runs_valid, 0);
    const runsTotal = cells.reduce((sum, item) => sum + item.runs_total, 0);
    const detail = cells.map((item) => item.detail).filter((text) => text !== "").join(" | ");
    if (cells.some((item) => item.observed === "error")) return observation("error", runsValid, runsTotal, [], detail);
    if (copies.length !== perState.copies) return observation("incomplete", runsValid, runsTotal, [], `expected ${String(perState.copies)} copies, found ${String(copies.length)}${detail === "" ? "" : ` | ${detail}`}`);
    if (cells.some((item) => item.observed === "incomplete")) return observation("incomplete", runsValid, runsTotal, [], detail);
    if (runsTotal !== perState.copies * perState.rounds_per_copy || runsValid < perState.min_valid_runs) {
      return observation("incomplete", runsValid, runsTotal, [], `expected ${String(perState.copies * perState.rounds_per_copy)} runs with at least ${String(perState.min_valid_runs)} valid, found ${String(runsValid)} of ${String(runsTotal)}`);
    }
    // A failure code holds for the state only when every copy reports it, so a copy that passed or
    // failed differently never lends its code to the others.
    if (cells.some((item) => item.observed === "fail")) {
      const codes = cells.reduce<string[]>((common, item) => common.filter((code) => item.failure_codes.includes(code)), [...(cells[0]?.failure_codes ?? [])]);
      return observation("fail", runsValid, runsTotal, [...new Set(codes)].sort(), detail);
    }
    return observation("pass", runsValid, runsTotal, [], detail);
  };
  return { original_suite: cell((copy) => copy.original_suite), verification: cell((copy) => copy.verification) };
}

export type StateVerdictV2 = "met" | "not_met" | "invalid" | "incomplete";

export interface StateEvaluationV2 {
  state: CopyState;
  verdict: StateVerdictV2;
  cells: StateCells;
  reasons: string[];
}

export interface ProtocolEvaluationV2 {
  verdict: "qualified" | "not_qualified" | "invalid" | "incomplete";
  states: StateEvaluationV2[];
}

/** A state's verdict from its cells: met when both match, not met on a valid mismatch, otherwise invalid or incomplete. */
export function stateVerdict(protocol: ProtocolV2, state: CopyState, cells: StateCells): StateVerdictV2 {
  const observed = [cells.original_suite.observed, cells.verification.observed];
  if (observed.includes("error")) return "invalid";
  if (observed.includes("incomplete")) return "incomplete";
  const suiteMatches = cells.original_suite.observed === EXPECTED_CELLS.original_suite[state];
  const checksMatch = cells.verification.observed === EXPECTED_CELLS.verification[state] && (state !== "buggy" || cells.verification.failure_codes.includes(protocol.verification_codes.declared));
  return suiteMatches && checksMatch ? "met" : "not_met";
}

/** The verdict over the clean, buggy and fixed copies' record sets (smoke copies left out): a mismatch counts only when every state's evidence is complete. */
export function evaluateProtocolV2(protocol: ProtocolV2, data: F3Data, expectation: StateExpectation, copies: readonly CopySummaryV2[]): ProtocolEvaluationV2 {
  if (protocol.data_sha256 !== data.sha256) throw new EvaluationError("the protocol pins another data file");
  const states = STATES.map((state): StateEvaluationV2 => {
    // As in version 1, a smoke copy is never counted: it is left out, not held against the state.
    const evaluations = copies.filter((copy) => copy.state === state && copy.purpose === "counted").map((copy) => ({ state, ...evaluateCopyV2(protocol, data, expectation, copy) }));
    const cells = aggregateState(perStateV2(protocol, state), state, evaluations);
    const reasons = [...new Set(evaluations.flatMap((evaluation) => evaluation.reasons))];
    if (evaluations.length !== protocol.states[state].copies) reasons.unshift(`expected ${String(protocol.states[state].copies)} counted copy, found ${String(evaluations.length)}`);
    return { state, verdict: stateVerdict(protocol, state, cells), cells, reasons };
  });
  return { verdict: overallVerdict(states.map((state) => state.verdict)), states };
}

/** The result over the states' verdicts: qualified when all are met, not qualified on a mismatch with every state's evidence complete, otherwise invalid or incomplete. */
export function overallVerdict(verdicts: readonly StateVerdictV2[]): ProtocolEvaluationV2["verdict"] {
  if (verdicts.length === 0) return "incomplete";
  if (verdicts.every((item) => item === "met")) return "qualified";
  if (verdicts.every((item) => item === "met" || item === "not_met")) return "not_qualified";
  return verdicts.includes("invalid") ? "invalid" : "incomplete";
}
