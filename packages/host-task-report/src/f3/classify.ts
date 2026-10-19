// The frozen validity and outcome rules of the F3 check, as a pure function of one trial's
// recorded observation. A trial is valid only when every precondition held and every response was
// the expected one; an invalid trial is never a pass and never a detection. A valid trial passes
// when the report counts every acknowledged completion, fails with the declared code when it
// counts fewer, and is invalid when it counts more.
import { FAILURE_CODE, INVALID_CODES } from "./data.ts";
import type { F3Data, InvalidCode, KindId, Outcome, SendLabel } from "./data.ts";

/** One HTTP request as the trial recorded it. */
export interface RequestView {
  status: number | null;
  /** `error.code` of a JSON error body, or null. */
  error_code: string | null;
  transport_error: boolean;
  settled: boolean;
  request_id: string | null;
  /** Milliseconds from the trial origin, just before the send. */
  sent_ms: number;
  settled_ms: number | null;
  /** The completion body fields of a 201, or null. */
  body: { id: string | null; task_id: string | null; completed_at: string | null } | null;
}

export interface CompletionView extends RequestView {
  label: SendLabel;
  /** The task the request was sent for. */
  task_id: string;
}

/** App-role backends in the database, as the monitor saw them. */
export interface BackendSnapshot {
  app_backends: number;
  lock_waiting: number;
  idle_in_transaction: number;
}

/** A request's start and end in the app's own clock (`ts - duration_ms` and `ts`), from its log line. */
export interface LogTiming {
  start_ms: number;
  end_ms: number;
  status: number;
}

export interface TrialObservation {
  kind: KindId;
  index: number;
  date: string;
  instant: string;
  /** Internal errors of the procedure (error names only); any makes the trial invalid. */
  errors: string[];
  idle: { initial: number; final: number; waited_ms: number };
  setup_ok: boolean;
  precount: number | null;
  /** Null for an ungated kind. */
  gate_ok: boolean | null;
  s1: { l1: number; l2: number; lock_types: string[]; backends: BackendSnapshot } | null;
  s2: { l1: number; l2: number; backends: BackendSnapshot; settled: number } | null;
  s3: { l2: number; all_settled: boolean } | null;
  completions: CompletionView[];
  /** The filler PATCHes; the first is the one gate L1 holds, the one its release frees. */
  patches: RequestView[];
  report: { status: number | null; count: number | null } | null;
  /** Log timing by request ID, for the completions and the freed PATCH. */
  app_log: Record<string, LogTiming>;
  /** Supporting evidence, never graded: a direct read of the date's rows and of x's row. */
  direct: { date_count: number; x_row_present: boolean | null } | null;
}

export interface Classification {
  valid: boolean;
  outcome: Outcome;
  invalid: InvalidCode[];
  acknowledged: number;
  counted: number | null;
}

function expectedStatus(data: F3Data, label: SendLabel): number {
  return label === "unknown" ? data.statuses.unknown : label === "partner" ? data.statuses.partner : data.statuses.x;
}

function completionAsExpected(data: F3Data, view: CompletionView, instant: string): boolean {
  if (view.status !== expectedStatus(data, view.label)) return false;
  if (view.label === "unknown") return view.error_code === data.statuses.unknown_error_code;
  return view.body !== null && view.body.task_id === view.task_id && view.body.completed_at === instant && typeof view.body.id === "string";
}

/** Whether the app's own clock shows each send arriving in order, the last before the freed PATCH ended. */
function logOrder(data: F3Data, observation: TrialObservation): "ok" | "missing" | "order" {
  const timingOf = (id: string | null | undefined): LogTiming | undefined => (id === null || id === undefined ? undefined : observation.app_log[id]);
  const freed = timingOf(observation.patches[0]?.request_id);
  const sends: LogTiming[] = [];
  for (const view of observation.completions) {
    const timing = timingOf(view.request_id);
    if (timing === undefined) return "missing";
    sends.push(timing);
  }
  if (freed === undefined || sends.length === 0) return "missing";
  let previous: LogTiming | null = null;
  for (const timing of sends) {
    if (previous !== null && previous.start_ms > timing.start_ms - data.app_log.send_order_margin_ms) return "order";
    previous = timing;
  }
  if (previous !== null && previous.start_ms > freed.end_ms - data.app_log.freed_end_margin_ms) return "order";
  return "ok";
}

export function classifyTrial(data: F3Data, observation: TrialObservation): Classification {
  const kind = data.kinds[observation.kind];
  const found = new Set<InvalidCode>();
  const pre = data.preconditions;
  if (observation.errors.length > 0) found.add("probe_error");
  if (observation.idle.final > 0) found.add("idle_transaction_present");
  if (!observation.setup_ok) found.add("setup_failed");
  if (observation.precount !== 0) found.add("precount_not_zero");
  const sendsMatch = observation.completions.length === kind.sends.length && observation.completions.every((view, index) => view.label === kind.sends[index]);
  // A trial that stopped before its sends carries the code of the step that stopped it.
  if (observation.completions.length > 0 && !sendsMatch) found.add("probe_error");

  // The gate and P1-P3 are judged only when the setup held, each only when the step before it held,
  // so a trial carries the code of the first precondition that failed.
  const setupHeld = found.size === 0;
  if (kind.forced && setupHeld) {
    const s1 = observation.s1;
    const p1 =
      s1 !== null &&
      s1.l1 === pre.p1.l1_blocked &&
      s1.l2 === pre.p1.l2_blocked &&
      s1.lock_types.includes(data.gate.lock_type) &&
      s1.backends.app_backends === pre.p1.app_backends &&
      s1.backends.lock_waiting === pre.p1.lock_waiting;
    const s2 = observation.s2;
    const p2 =
      s2 !== null &&
      s2.l1 + s2.l2 === pre.p2.blocked &&
      s2.backends.app_backends === pre.p2.app_backends &&
      s2.backends.lock_waiting === pre.p2.lock_waiting &&
      s2.settled === pre.p2.settled;
    const s3 = observation.s3;
    const p3 = s3 !== null && s3.all_settled && s3.l2 >= pre.p3.l2_blocked_at_least;
    if (observation.gate_ok !== true) found.add("gate_failed");
    else if (!p1) found.add("p1_not_saturated");
    else if (!p2) found.add("p2_not_queued");
    else if (!p3) found.add("p3_window_not_held");
    if (observation.gate_ok === true && observation.patches.length !== data.environment.fillers) found.add("probe_error");
  } else if (!kind.forced && (observation.gate_ok !== null || observation.patches.length > 0)) {
    found.add("probe_error");
  }
  if (observation.completions.length === 0 && found.size === 0) found.add("probe_error");

  const requests: RequestView[] = [...observation.completions, ...observation.patches];
  if (requests.some((view) => !view.settled)) found.add("requests_not_settled");
  if (requests.some((view) => view.status !== null && view.status >= 500) || (observation.report?.status ?? 0) >= 500) found.add("server_error");
  if (requests.some((view) => view.transport_error)) found.add("transport_error");
  const unexpected =
    observation.completions.some((view) => view.settled && !view.transport_error && !completionAsExpected(data, view, observation.instant)) ||
    observation.patches.some((view) => view.settled && !view.transport_error && view.status !== data.statuses.patch);
  if (unexpected) found.add("unexpected_status");
  const report = observation.report;
  const counted = report !== null && report.status === data.statuses.report && typeof report.count === "number" ? report.count : null;
  if (counted === null) found.add("report_failed");

  if (kind.forced && found.size === 0) {
    const order = logOrder(data, observation);
    if (order === "missing") found.add("app_log_missing");
    else if (order === "order") found.add("app_log_order");
  }

  const acknowledged = observation.completions.filter((view) => view.label !== "unknown" && view.status === data.statuses.x).length;
  if (counted !== null && counted > acknowledged) found.add("count_exceeds_acknowledged");

  const invalid = INVALID_CODES.filter((code) => found.has(code));
  if (invalid.length > 0) return { valid: false, outcome: "invalid", invalid, acknowledged, counted };
  return { valid: true, outcome: counted === acknowledged ? "pass" : FAILURE_CODE, invalid, acknowledged, counted };
}
