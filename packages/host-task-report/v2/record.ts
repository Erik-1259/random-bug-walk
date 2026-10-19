// copy.json of evaluator v2: what one copy recorded, written by v2/copy.ts in the copy and read by
// the host-side evaluation. Beside version 1's fields it names the copy, the catalog entry, the
// catalog's SHA-256 and the tree the copy expected for its state, and keeps every block's trial
// outcomes in the order they ran, so the evaluation can recompute each block under the protocol's
// rule instead of trusting a recorded count. The parser treats the file as untrusted input.
import { isRecord, isSha256 } from "../src/hash.ts";
import { FAILURE_CODE, KINDS, STATES } from "../src/f3/data.ts";
import type { CodeState, KindId, Outcome } from "../src/f3/data.ts";
import type { BlockRule, BlockStatus } from "../src/f3/block.ts";

export const COPY_V2_FORMAT = "rbw.task-report.copy.v2";
/** The record set's file, relative to the copy's results directory. */
export const COPY_V2_FILE = "copy.json";

export interface SuiteRunV2 {
  verdict: "passed" | "failed" | "invalid" | "refused";
  tests_expected: number;
  passed: number;
  /** The IDs of the expected tests that failed. */
  failed: string[];
}

export interface InstanceFailure {
  /** setup: the instance or its suite could not be prepared; run: it ended early. */
  kind: "setup" | "run";
  detail: string;
}

export interface InstanceRecordV2 {
  instance: number;
  failure: InstanceFailure | null;
  suite: SuiteRunV2 | null;
  /** Each block's trial outcomes in the order the trials ran (index 1 first). */
  trials: Partial<Record<KindId, Outcome[]>>;
  /** Each block's status as the copy computed it; the evaluation recomputes and compares it. */
  blocks: Partial<Record<KindId, BlockStatus>>;
}

export interface PhaseEntryV2 {
  name: string;
  ok: boolean;
  duration_ms: number;
  detail: string | null;
}

export interface CopySummaryV2 {
  format: typeof COPY_V2_FORMAT;
  copy_id: string;
  state: CodeState;
  purpose: "counted" | "smoke";
  entry_id: string;
  catalog_sha256: string;
  /** The tree the copy expected for its state, from its own catalog and baseline files. */
  expected_source_tree_sha256: string;
  baseline_id: string;
  data_sha256: string;
  protocol_sha256: string;
  /** The tree hash of /workspace/app as the copy found it (node_modules skipped). */
  source_tree_sha256: string;
  source_files: Record<string, string>;
  rules: Record<KindId, BlockRule>;
  /** Why the copy could not run its instances, or null. */
  invalid_reason: string | null;
  instances: InstanceRecordV2[];
  started_at: string;
  ended_at: string | null;
  phases: PhaseEntryV2[];
}

export class RecordError extends Error {
  override name = "RecordError";
}

const OUTCOMES: readonly Outcome[] = ["pass", FAILURE_CODE, "invalid"];
const SUITE_VERDICTS: readonly SuiteRunV2["verdict"][] = ["passed", "failed", "invalid", "refused"];
const BLOCK_STATES: readonly BlockStatus["state"][] = ["running", "complete", "incomplete"];

function section(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RecordError(`${what} must be an object`);
  return value;
}

function text(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new RecordError(`${what}.${key} must be a string`);
  return value;
}

function nullableText(record: Record<string, unknown>, key: string, what: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") throw new RecordError(`${what}.${key} must be a string or null`);
  return value;
}

function count(record: Record<string, unknown>, key: string, what: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RecordError(`${what}.${key} must be a non-negative integer`);
  return value;
}

function hash(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (!isSha256(value)) throw new RecordError(`${what}.${key} must be a SHA-256`);
  return value;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, what: string): T {
  const found = values.find((item) => item === value);
  if (found === undefined) throw new RecordError(`${what} has an unknown value`);
  return found;
}

function kindKeys(record: Record<string, unknown>, what: string): KindId[] {
  const keys = Object.keys(record);
  for (const key of keys) if (!(KINDS as readonly string[]).includes(key)) throw new RecordError(`${what} has an unknown kind`);
  return keys as KindId[];
}

function rule(value: unknown, what: string): BlockRule {
  const record = section(value, what);
  return { valid_target: count(record, "valid_target", what), max_invalid: count(record, "max_invalid", what), max_top_ups: count(record, "max_top_ups", what) };
}

function blockStatusOf(value: unknown, what: string): BlockStatus {
  const record = section(value, what);
  const outcomes = section(record.outcomes, `${what}.outcomes`);
  const counted: Record<string, number> = {};
  for (const [key, item] of Object.entries(outcomes)) {
    oneOf(OUTCOMES, key, `${what}.outcomes`);
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw new RecordError(`${what}.outcomes must hold counts`);
    counted[key] = item;
  }
  const next = record.next_index;
  if (next !== null && (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1)) throw new RecordError(`${what}.next_index must be a positive integer or null`);
  return {
    state: oneOf(BLOCK_STATES, record.state, `${what}.state`),
    attempts: count(record, "attempts", what),
    valid: count(record, "valid", what),
    invalid: count(record, "invalid", what),
    top_ups: count(record, "top_ups", what),
    next_index: next,
    outcomes: counted,
  };
}

function suiteOf(value: unknown, what: string): SuiteRunV2 | null {
  if (value === null) return null;
  const record = section(value, what);
  const failed = record.failed;
  if (!Array.isArray(failed) || !failed.every((item) => typeof item === "string")) throw new RecordError(`${what}.failed must be a list of test IDs`);
  return { verdict: oneOf(SUITE_VERDICTS, record.verdict, `${what}.verdict`), tests_expected: count(record, "tests_expected", what), passed: count(record, "passed", what), failed: [...failed] };
}

function instanceOf(value: unknown, what: string): InstanceRecordV2 {
  const record = section(value, what);
  let failure: InstanceFailure | null = null;
  if (record.failure !== null) {
    const item = section(record.failure, `${what}.failure`);
    failure = { kind: oneOf(["setup", "run"], item.kind, `${what}.failure.kind`), detail: text(item, "detail", `${what}.failure`) };
  }
  const trialsRecord = section(record.trials, `${what}.trials`);
  const trials: Partial<Record<KindId, Outcome[]>> = {};
  for (const kind of kindKeys(trialsRecord, `${what}.trials`)) {
    const list = trialsRecord[kind];
    if (!Array.isArray(list)) throw new RecordError(`${what}.trials.${kind} must be a list`);
    trials[kind] = list.map((item) => oneOf(OUTCOMES, item, `${what}.trials.${kind}`));
  }
  const blocksRecord = section(record.blocks, `${what}.blocks`);
  const blocks: Partial<Record<KindId, BlockStatus>> = {};
  for (const kind of kindKeys(blocksRecord, `${what}.blocks`)) blocks[kind] = blockStatusOf(blocksRecord[kind], `${what}.blocks.${kind}`);
  const number = record.instance;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new RecordError(`${what}.instance must be a positive integer`);
  return { instance: number, failure, suite: suiteOf(record.suite, `${what}.suite`), trials, blocks };
}

/** Parses a copy.json value of evaluator v2; throws RecordError for anything malformed. */
export function parseCopySummaryV2(value: unknown): CopySummaryV2 {
  const root = section(value, "copy");
  if (root.format !== COPY_V2_FORMAT) throw new RecordError(`the record set is not ${COPY_V2_FORMAT}`);
  const files = section(root.source_files, "copy.source_files");
  const sourceFiles: Record<string, string> = {};
  for (const [path, item] of Object.entries(files)) {
    if (!isSha256(item)) throw new RecordError("copy.source_files must map paths to SHA-256 values");
    sourceFiles[path] = item;
  }
  const rulesRecord = section(root.rules, "copy.rules");
  const rules = {} as Record<KindId, BlockRule>;
  for (const kind of KINDS) rules[kind] = rule(rulesRecord[kind], `copy.rules.${kind}`);
  kindKeys(rulesRecord, "copy.rules");
  if (!Array.isArray(root.instances)) throw new RecordError("copy.instances must be a list");
  if (!Array.isArray(root.phases)) throw new RecordError("copy.phases must be a list");
  const phases = root.phases.map((item: unknown, index: number): PhaseEntryV2 => {
    const what = `copy.phases[${String(index)}]`;
    const phase = section(item, what);
    if (typeof phase.ok !== "boolean") throw new RecordError(`${what}.ok must be a boolean`);
    return { name: text(phase, "name", what), ok: phase.ok, duration_ms: count(phase, "duration_ms", what), detail: nullableText(phase, "detail", what) };
  });
  return {
    format: COPY_V2_FORMAT,
    copy_id: text(root, "copy_id", "copy"),
    state: oneOf(STATES, root.state, "copy.state"),
    purpose: oneOf(["counted", "smoke"], root.purpose, "copy.purpose"),
    entry_id: text(root, "entry_id", "copy"),
    catalog_sha256: hash(root, "catalog_sha256", "copy"),
    expected_source_tree_sha256: hash(root, "expected_source_tree_sha256", "copy"),
    baseline_id: text(root, "baseline_id", "copy"),
    data_sha256: hash(root, "data_sha256", "copy"),
    protocol_sha256: hash(root, "protocol_sha256", "copy"),
    source_tree_sha256: hash(root, "source_tree_sha256", "copy"),
    source_files: sourceFiles,
    rules,
    invalid_reason: nullableText(root, "invalid_reason", "copy"),
    instances: root.instances.map((item: unknown, index: number) => instanceOf(item, `copy.instances[${String(index)}]`)),
    started_at: text(root, "started_at", "copy"),
    ended_at: nullableText(root, "ended_at", "copy"),
    phases,
  };
}
