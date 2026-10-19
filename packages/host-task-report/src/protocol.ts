// The declared repetition protocol of the F3 check (protocol/f3-repeatability.v1.json) and its
// evaluation over the copy records of the clean, buggy and fixed states. The protocol pins the
// data file's SHA-256; records made under another data file, protocol or baseline are never
// counted, and smoke copies are never counted. Imports only node: built-ins.
import { fileURLToPath } from "node:url";
import { HashError, isRecord, readPinnedJson } from "./hash.ts";
import { blockMatches } from "./f3/block.ts";
import type { BlockRule, BlockStatus } from "./f3/block.ts";
import { KINDS, STATES } from "./f3/data.ts";
import type { CodeState, F3Data, KindId } from "./f3/data.ts";

export const PROTOCOL_FILE = fileURLToPath(new URL("../protocol/f3-repeatability.v1.json", import.meta.url));
export const PROTOCOL_FORMAT = "rbw.task-report.protocol.v1";
export const INSTANCE_ORDER = ["original_suite", ...KINDS, "late_reread"] as const;

export interface Protocol {
  sha256: string;
  protocol_id: string;
  version: number;
  baseline_id: string;
  data_sha256: string;
  required_passed: number;
  states: Record<CodeState, { copies: number; instances: number }>;
  blocks: { main: BlockRule; control: BlockRule };
}

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

function rule(value: unknown, what: string): BlockRule {
  if (!isRecord(value)) throw new ProtocolError(`${what} must be an object`);
  const out = { valid_target: value.valid_target, max_invalid: value.max_invalid, max_top_ups: value.max_top_ups };
  for (const [key, item] of Object.entries(out)) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw new ProtocolError(`${what}.${key} must be a non-negative integer`);
  }
  if ((out.valid_target as number) < 1) throw new ProtocolError(`${what}.valid_target must be at least 1`);
  return out as BlockRule;
}

export function parseProtocol(value: unknown, sha256: string): Protocol {
  if (!isRecord(value) || value.format !== PROTOCOL_FORMAT) throw new ProtocolError(`the protocol is not ${PROTOCOL_FORMAT}`);
  const check = value.check;
  const suite = value.original_suite;
  const states = value.states;
  const blocks = value.blocks;
  if (!isRecord(check) || !isRecord(suite) || !isRecord(states) || !isRecord(blocks)) throw new ProtocolError("the protocol is missing a section");
  if (typeof check.data_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(check.data_sha256)) throw new ProtocolError("check.data_sha256 is not a SHA-256");
  const order = value.instance_order;
  if (!Array.isArray(order) || order.join(",") !== INSTANCE_ORDER.join(",")) throw new ProtocolError("instance_order differs from the order the copy runs");
  if (suite.on_every_instance !== true || suite.before_checks !== true || suite.required_verdict !== "passed") throw new ProtocolError("the original suite must pass on every instance before the checks");
  if (typeof suite.required_passed !== "number" || !Number.isSafeInteger(suite.required_passed)) throw new ProtocolError("original_suite.required_passed must be an integer");
  const parsedStates = {} as Record<CodeState, { copies: number; instances: number }>;
  for (const state of STATES) {
    const entry = states[state];
    if (!isRecord(entry) || entry.copies !== 1 || typeof entry.instances !== "number" || !Number.isSafeInteger(entry.instances) || entry.instances < 1 || entry.instances > 9) {
      throw new ProtocolError(`states.${state} must declare one copy and 1-9 instances`);
    }
    parsedStates[state] = { copies: 1, instances: entry.instances };
  }
  if (typeof value.protocol_id !== "string" || typeof value.version !== "number" || typeof value.baseline_id !== "string") throw new ProtocolError("the protocol is missing its identity");
  return {
    sha256,
    protocol_id: value.protocol_id,
    version: value.version,
    baseline_id: value.baseline_id,
    data_sha256: check.data_sha256,
    required_passed: suite.required_passed,
    states: parsedStates,
    blocks: { main: rule(blocks.main, "blocks.main"), control: rule(blocks.control, "blocks.control") },
  };
}

export function loadProtocol(path: string = PROTOCOL_FILE): Protocol {
  try {
    const { value, sha256 } = readPinnedJson(path);
    return parseProtocol(value, sha256);
  } catch (error) {
    if (error instanceof HashError) throw new ProtocolError(error.message);
    throw error;
  }
}

export function blockRule(protocol: Protocol, kind: KindId): BlockRule {
  return kind === "main" ? protocol.blocks.main : protocol.blocks.control;
}

// ---- records -----------------------------------------------------------------------------------

export interface SuiteSummary {
  verdict: "passed" | "failed" | "invalid" | "refused";
  tests_expected: number;
  passed: number;
}

export interface InstanceSummary {
  instance: number;
  /** The instance phase that failed, or null when the instance became ready and was stopped. */
  failure: string | null;
  suite: SuiteSummary | null;
  blocks: Partial<Record<KindId, BlockStatus>>;
}

export interface CopySummary {
  state: CodeState;
  purpose: "counted" | "smoke";
  /** Why the copy could not run its instances (for example changed dependency manifests), or null. */
  invalid_reason: string | null;
  baseline_id: string;
  data_sha256: string;
  protocol_sha256: string;
  source_tree_sha256: string;
  instances: InstanceSummary[];
}

export type StateVerdict = "met" | "not_met" | "incomplete";

export interface StateEvaluation {
  state: CodeState;
  verdict: StateVerdict;
  reasons: string[];
}

export interface ProtocolEvaluation {
  verdict: "qualified" | "not_qualified" | "incomplete";
  states: StateEvaluation[];
}

/** Evaluates one state's copies against the protocol: a definitive mismatch first, then incompleteness. */
export function evaluateState(protocol: Protocol, data: F3Data, state: CodeState, copies: readonly CopySummary[]): StateEvaluation {
  const missed: string[] = [];
  const incomplete: string[] = [];
  const own = copies.filter((copy) => copy.state === state && copy.purpose === "counted");
  if (own.length !== protocol.states[state].copies) {
    incomplete.push(`expected ${String(protocol.states[state].copies)} counted copy, found ${String(own.length)}`);
  }
  for (const copy of own) {
    if (copy.data_sha256 !== protocol.data_sha256 || copy.data_sha256 !== data.sha256) incomplete.push("the copy ran another data file");
    if (copy.protocol_sha256 !== protocol.sha256) incomplete.push("the copy ran another protocol");
    if (copy.baseline_id !== protocol.baseline_id) incomplete.push("the copy ran another baseline");
    if (copy.invalid_reason !== null) incomplete.push(`the copy is invalid: ${copy.invalid_reason}`);
    if (copy.instances.length !== protocol.states[state].instances) incomplete.push(`expected ${String(protocol.states[state].instances)} instances, found ${String(copy.instances.length)}`);
    for (const instance of copy.instances) {
      const name = `instance ${String(instance.instance)}`;
      if (instance.suite !== null && instance.suite.verdict === "failed") missed.push(`${name}: the original suite failed`);
      else if (instance.suite?.verdict !== "passed" || instance.suite.passed !== protocol.required_passed || instance.suite.tests_expected !== protocol.required_passed) {
        incomplete.push(`${name}: the original suite did not pass ${String(protocol.required_passed)} of ${String(protocol.required_passed)}`);
      }
      if (instance.failure !== null) incomplete.push(`${name}: ${instance.failure}`);
      for (const kind of KINDS) {
        const status = instance.blocks[kind];
        const expected = data.expected[state][kind];
        if (status === undefined) {
          incomplete.push(`${name}: no ${kind} block`);
          continue;
        }
        const other = Object.keys(status.outcomes).filter((outcome) => outcome !== expected);
        if (other.length > 0) {
          missed.push(`${name}: ${kind} had valid trials other than ${expected} (${other.map((outcome) => `${outcome} ${String(status.outcomes[outcome] ?? 0)}`).join(", ")})`);
        } else if (!blockMatches(status, expected)) {
          incomplete.push(`${name}: the ${kind} block is ${status.state} (${String(status.valid)} valid, ${String(status.invalid)} invalid)`);
        }
        const target = (kind === "main" ? protocol.blocks.main : protocol.blocks.control).valid_target;
        if (status.state === "complete" && status.valid < target) incomplete.push(`${name}: the ${kind} block has fewer valid trials than the protocol's target`);
      }
    }
  }
  if (missed.length > 0) return { state, verdict: "not_met", reasons: missed };
  if (incomplete.length > 0) return { state, verdict: "incomplete", reasons: incomplete };
  return { state, verdict: "met", reasons: [] };
}

export function evaluateProtocol(protocol: Protocol, data: F3Data, copies: readonly CopySummary[]): ProtocolEvaluation {
  if (protocol.data_sha256 !== data.sha256) throw new ProtocolError("the protocol pins another data file");
  const states = STATES.map((state) => evaluateState(protocol, data, state, copies));
  const verdict = states.some((state) => state.verdict === "not_met") ? "not_qualified" : states.every((state) => state.verdict === "met") ? "qualified" : "incomplete";
  return { verdict, states };
}
