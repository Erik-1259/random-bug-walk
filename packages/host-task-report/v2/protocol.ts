// The declared repetition protocol of evaluator v2 (v2/protocol/f3-repeatability.v2.json): the same
// data file, original-suite rule, states, instance counts and block rules as version 1, under a new
// identity, plus what version 2 adds: the minimum valid instances per state, the codes the
// verification cell reports and the IDs of the rules the evaluation applies. The shared part is
// checked by version 1's parser, so both versions refuse the same malformed values. Imports only
// node: built-ins.
import { fileURLToPath } from "node:url";
import { HashError, isRecord, readPinnedJson } from "../src/hash.ts";
import { FAILURE_CODE, STATES } from "../src/f3/data.ts";
import type { CodeState, KindId } from "../src/f3/data.ts";
import type { BlockRule } from "../src/f3/block.ts";
import { PROTOCOL_FORMAT, ProtocolError, parseProtocol } from "../src/protocol.ts";
import type { Protocol } from "../src/protocol.ts";

export const PROTOCOL_V2_FILE = fileURLToPath(new URL("./protocol/f3-repeatability.v2.json", import.meta.url));
export const PROTOCOL_V2_FORMAT = "rbw.task-report.protocol.v2";
export const PROTOCOL_V2_ID = "f3-repeatability";
export const PROTOCOL_V2_VERSION = 2;

/** The rules the version 2 evaluation applies, in the order the protocol file lists them. */
export const VALID_TRIAL_RULES = [
  "task-report.f3.v2.copy-identity",
  "task-report.f3.v2.source-tree",
  "task-report.f3.v2.protocol-block-rules",
  "task-report.f3.v2.block-replay",
  "task-report.f3.v2.original-suite-complete",
  "task-report.f3.v2.invalid-trial-not-counted",
  "task-report.f3.v2.every-instance-valid",
] as const;

export interface VerificationCodes {
  /** The check's own failure code: every valid trial matched the buggy vector. */
  declared: string;
  /** A detection kind showed both outcomes, or one passed while another detected. */
  inconsistent: string;
  /** A control showed the failure. */
  control: string;
  /** An original-suite run had failing tests. */
  original_suite: string;
}

export interface ProtocolV2 extends Protocol {
  min_valid_instances: Record<CodeState, number>;
  verification_codes: VerificationCodes;
  valid_trial_rules: string[];
}

export { ProtocolError };

function sameList(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

export function parseProtocolV2(value: unknown, sha256: string): ProtocolV2 {
  if (!isRecord(value) || value.format !== PROTOCOL_V2_FORMAT) throw new ProtocolError(`the protocol is not ${PROTOCOL_V2_FORMAT}`);
  if (value.protocol_id !== PROTOCOL_V2_ID || value.version !== PROTOCOL_V2_VERSION) throw new ProtocolError(`the protocol is not ${PROTOCOL_V2_ID} version ${String(PROTOCOL_V2_VERSION)}`);
  const states = value.states;
  const codes = value.verification_codes;
  if (!isRecord(states) || !isRecord(codes)) throw new ProtocolError("the protocol is missing a section");
  // The shared part goes through version 1's parser unchanged, without version 2's per-state field.
  const shared: Record<string, unknown> = { ...value, format: PROTOCOL_FORMAT, states: {} };
  const minValid = {} as Record<CodeState, number>;
  for (const state of STATES) {
    const entry = states[state];
    if (!isRecord(entry)) throw new ProtocolError(`states.${state} is missing`);
    const { min_valid_instances: min, ...rest } = entry;
    if (typeof min !== "number" || !Number.isSafeInteger(min) || min < 1 || typeof rest.instances !== "number" || min > rest.instances) {
      throw new ProtocolError(`states.${state}.min_valid_instances must be 1 to the state's instances`);
    }
    minValid[state] = min;
    (shared.states as Record<string, unknown>)[state] = rest;
  }
  const base = parseProtocol(shared, sha256);
  const code = (key: keyof VerificationCodes): string => {
    const item = codes[key];
    if (typeof item !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(item)) throw new ProtocolError(`verification_codes.${key} must be a code`);
    return item;
  };
  const verification: VerificationCodes = { declared: code("declared"), inconsistent: code("inconsistent"), control: code("control"), original_suite: code("original_suite") };
  if (verification.declared !== FAILURE_CODE) throw new ProtocolError("verification_codes.declared differs from the check's failure code");
  if (new Set(Object.values(verification)).size !== 4) throw new ProtocolError("verification_codes must be four different codes");
  if (!sameList(value.valid_trial_rules, VALID_TRIAL_RULES)) throw new ProtocolError("valid_trial_rules differ from the rules this evaluation applies");
  return { ...base, min_valid_instances: minValid, verification_codes: verification, valid_trial_rules: [...VALID_TRIAL_RULES] };
}

export function loadProtocolV2(path: string = PROTOCOL_V2_FILE): ProtocolV2 {
  try {
    const { value, sha256 } = readPinnedJson(path);
    return parseProtocolV2(value, sha256);
  } catch (error) {
    if (error instanceof HashError) throw new ProtocolError(error.message);
    throw error;
  }
}

/** The protocol's rule for a block kind: the main rule for main, the control rule for every control. */
export function blockRuleV2(protocol: ProtocolV2, kind: KindId): BlockRule {
  return kind === "main" ? protocol.blocks.main : protocol.blocks.control;
}
