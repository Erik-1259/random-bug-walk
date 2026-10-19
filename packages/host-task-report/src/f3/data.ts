// The typed view of data/f3.v1.json, the one data file of the F3 check. Every timing, bound,
// count, expected vector and code the check uses comes from here; nothing retypes a value. The
// file is pinned by data/f3.v1.json.sha256, and loading refuses a file whose codes, kinds or states
// differ from what the code implements. Imports only node: built-ins.
import { fileURLToPath } from "node:url";
import { HashError, isRecord, readPinnedJson } from "../hash.ts";

export const DATA_FILE = fileURLToPath(new URL("../../data/f3.v1.json", import.meta.url));
export const DATA_FORMAT = "rbw.task-report.check-data.v1";

export const KINDS = ["main", "sequential", "valid_partner", "x_alone", "dx_order"] as const;
export type KindId = (typeof KINDS)[number];
export const CONTROL_KINDS: readonly KindId[] = ["sequential", "valid_partner", "x_alone", "dx_order"];

export const SEND_LABELS = ["x", "partner", "unknown"] as const;
export type SendLabel = (typeof SEND_LABELS)[number];

export const STATES = ["clean", "buggy", "fixed"] as const;
export type CodeState = (typeof STATES)[number];

export const FAILURE_CODE = "acknowledged_completion_not_counted";
export type Outcome = "pass" | typeof FAILURE_CODE | "invalid";

/** Invalid-trial codes in the order a classification lists them. */
export const INVALID_CODES = [
  "probe_error",
  "idle_transaction_present",
  "setup_failed",
  "precount_not_zero",
  "gate_failed",
  "p1_not_saturated",
  "p2_not_queued",
  "p3_window_not_held",
  "requests_not_settled",
  "server_error",
  "transport_error",
  "unexpected_status",
  "report_failed",
  "app_log_missing",
  "app_log_order",
  "count_exceeds_acknowledged",
] as const;
export type InvalidCode = (typeof INVALID_CODES)[number];

export interface KindDef {
  forced: boolean;
  /** Completion requests in send order. */
  sends: SendLabel[];
  /** Completions a valid trial of this kind gets acknowledged with 201. */
  acknowledged: number;
}

export interface F3Data {
  sha256: string;
  check: { id: string; version: number; criterion: { id: string; version: number } };
  environment: { db_pool_max: number; app_role: string; gate_role: string; report_time_zone: string; fillers: number };
  gate: { lock_statement: string; lock_timeout_ms: number; idle_in_transaction_session_timeout_ms: number; l1_rows: number; l2_rows: number; lock_type: string };
  timing: {
    gap_send_ms: number;
    post_d_ms: number;
    poll_ms: number;
    saturation_bound_ms: number;
    settle_bound_ms: number;
    patch_bound_ms: number;
    client_timeout_ms: number;
    idle_recheck_wait_ms: number;
    idle_recheck_poll_ms: number;
    app_log_wait_ms: number;
    late_reread_wait_ms: number;
  };
  preconditions: {
    p1: { l1_blocked: number; l2_blocked: number; app_backends: number; lock_waiting: number };
    p2: { blocked: number; app_backends: number; lock_waiting: number; settled: number };
    p3: { l2_blocked_at_least: number };
  };
  app_log: { event: string; send_order_margin_ms: number; freed_end_margin_ms: number };
  dates: { instant_time: string; first: Record<KindId, string>; max_index: number };
  kinds: Record<KindId, KindDef>;
  statuses: { x: number; partner: number; unknown: number; unknown_error_code: string; patch: number; task_create: number; report: number };
  expected: Record<CodeState, Record<KindId, Exclude<Outcome, "invalid">>>;
}

export class DataError extends Error {
  override name = "DataError";
}

function section(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DataError(`${what} must be an object`);
  return value;
}

function int(record: Record<string, unknown>, key: string, what: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DataError(`${what}.${key} must be a non-negative integer`);
  return value;
}

function str(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new DataError(`${what}.${key} must be a non-empty string`);
  return value;
}

function ints<K extends string>(record: Record<string, unknown>, keys: readonly K[], what: string): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = int(record, key, what);
  return out;
}

function sameList(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses and checks the data file's value. */
export function parseData(value: unknown, sha256: string): F3Data {
  const root = section(value, "data");
  if (root.format !== DATA_FORMAT) throw new DataError(`the data file is not ${DATA_FORMAT}`);
  const check = section(root.check, "check");
  const criterion = section(check.criterion, "check.criterion");
  const environment = section(root.environment, "environment");
  const gate = section(root.gate, "gate");
  const timing = section(root.timing, "timing");
  const pre = section(root.preconditions, "preconditions");
  const appLog = section(root.app_log, "app_log");
  const dates = section(root.dates, "dates");
  const first = section(dates.first, "dates.first");
  const kinds = section(root.kinds, "kinds");
  const statuses = section(root.statuses, "statuses");
  const outcome = section(root.outcome, "outcome");
  const expected = section(root.expected, "expected");

  if (!sameList(root.invalid_codes, INVALID_CODES)) throw new DataError("invalid_codes differ from the codes this check implements");
  if (outcome.pass !== "pass" || outcome.failure_code !== FAILURE_CODE || outcome.invalid !== "invalid") throw new DataError("outcome codes differ from this check's");
  if (!sameList(Object.keys(kinds), KINDS) || !sameList(Object.keys(first), KINDS)) throw new DataError("kinds differ from this check's");
  if (!sameList(Object.keys(expected), STATES)) throw new DataError("expected states differ from this check's");

  const kindDefs = {} as Record<KindId, KindDef>;
  const firstDates = {} as Record<KindId, string>;
  for (const kind of KINDS) {
    const def = section(kinds[kind], `kinds.${kind}`);
    const sends = def.sends;
    if (!Array.isArray(sends) || sends.length === 0 || !sends.every((label) => (SEND_LABELS as readonly unknown[]).includes(label))) throw new DataError(`kinds.${kind}.sends is malformed`);
    if (typeof def.forced !== "boolean") throw new DataError(`kinds.${kind}.forced must be a boolean`);
    const labels = sends as SendLabel[];
    if (!labels.includes("x") || new Set(labels).size !== labels.length) throw new DataError(`kinds.${kind}.sends must hold x once and no label twice`);
    const acknowledged = int(def, "acknowledged", `kinds.${kind}`);
    if (acknowledged !== labels.filter((label) => label !== "unknown").length) throw new DataError(`kinds.${kind}.acknowledged differs from its sends`);
    kindDefs[kind] = { forced: def.forced, sends: [...labels], acknowledged };
    const date = first[kind];
    if (typeof date !== "string" || !DATE.test(date)) throw new DataError(`dates.first.${kind} is not a date`);
    firstDates[kind] = date;
  }
  const expectedVectors = {} as Record<CodeState, Record<KindId, Exclude<Outcome, "invalid">>>;
  for (const state of STATES) {
    const vector = section(expected[state], `expected.${state}`);
    if (!sameList(Object.keys(vector), KINDS)) throw new DataError(`expected.${state} differs from the kinds`);
    const out = {} as Record<KindId, Exclude<Outcome, "invalid">>;
    for (const kind of KINDS) {
      const value = vector[kind];
      if (value !== "pass" && value !== FAILURE_CODE) throw new DataError(`expected.${state}.${kind} is not an outcome`);
      out[kind] = value;
    }
    expectedVectors[state] = out;
  }
  const p1 = section(pre.p1, "preconditions.p1");
  const p2 = section(pre.p2, "preconditions.p2");
  const p3 = section(pre.p3, "preconditions.p3");
  const data: F3Data = {
    sha256,
    check: { id: str(check, "id", "check"), version: int(check, "version", "check"), criterion: { id: str(criterion, "id", "check.criterion"), version: int(criterion, "version", "check.criterion") } },
    environment: {
      ...ints(environment, ["db_pool_max", "fillers"], "environment"),
      app_role: str(environment, "app_role", "environment"),
      gate_role: str(environment, "gate_role", "environment"),
      report_time_zone: str(environment, "report_time_zone", "environment"),
    },
    gate: {
      ...ints(gate, ["lock_timeout_ms", "idle_in_transaction_session_timeout_ms", "l1_rows", "l2_rows"], "gate"),
      lock_statement: str(gate, "lock_statement", "gate"),
      lock_type: str(gate, "lock_type", "gate"),
    },
    timing: ints(
      timing,
      [
        "gap_send_ms",
        "post_d_ms",
        "poll_ms",
        "saturation_bound_ms",
        "settle_bound_ms",
        "patch_bound_ms",
        "client_timeout_ms",
        "idle_recheck_wait_ms",
        "idle_recheck_poll_ms",
        "app_log_wait_ms",
        "late_reread_wait_ms",
      ],
      "timing",
    ),
    preconditions: {
      p1: ints(p1, ["l1_blocked", "l2_blocked", "app_backends", "lock_waiting"], "preconditions.p1"),
      p2: ints(p2, ["blocked", "app_backends", "lock_waiting", "settled"], "preconditions.p2"),
      p3: ints(p3, ["l2_blocked_at_least"], "preconditions.p3"),
    },
    app_log: { event: str(appLog, "event", "app_log"), ...ints(appLog, ["send_order_margin_ms", "freed_end_margin_ms"], "app_log") },
    dates: { instant_time: str(dates, "instant_time", "dates"), first: firstDates, max_index: int(dates, "max_index", "dates") },
    kinds: kindDefs,
    statuses: {
      ...ints(statuses, ["x", "partner", "unknown", "patch", "task_create", "report"], "statuses"),
      unknown_error_code: str(statuses, "unknown_error_code", "statuses"),
    },
    expected: expectedVectors,
  };
  if (data.gate.l1_rows + data.gate.l2_rows !== data.environment.fillers || data.environment.fillers !== data.environment.db_pool_max) {
    throw new DataError("the gates must hold exactly one filler per pool connection");
  }
  if (data.preconditions.p1.l1_blocked !== data.gate.l1_rows || data.preconditions.p1.l2_blocked !== data.gate.l2_rows) throw new DataError("P1 must equal the gate rows");
  if (!/^T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.dates.instant_time)) throw new DataError("dates.instant_time is malformed");
  return data;
}

export function loadData(path: string = DATA_FILE): F3Data {
  try {
    const { value, sha256 } = readPinnedJson(path);
    return parseData(value, sha256);
  } catch (error) {
    if (error instanceof HashError) throw new DataError(error.message);
    throw error;
  }
}

/** The UTC date of a trial: the kind's first date plus index - 1 days. */
export function trialDate(data: F3Data, kind: KindId, index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > data.dates.max_index) throw new DataError(`trial index ${String(index)} is outside 1-${String(data.dates.max_index)}`);
  const first = Date.parse(`${data.dates.first[kind]}T00:00:00.000Z`);
  return new Date(first + (index - 1) * 86_400_000).toISOString().slice(0, 10);
}

export function trialInstant(data: F3Data, date: string): string {
  return `${date}${data.dates.instant_time}`;
}
