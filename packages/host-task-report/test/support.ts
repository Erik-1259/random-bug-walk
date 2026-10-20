// Synthetic trial observations for the classification, block and protocol tests. Every ID, date
// and time here is made up; nothing comes from a run.
import type { CompletionView, LogTiming, RequestView, TrialObservation } from "../src/f3/classify.ts";
import type { BlockStatus } from "../src/f3/block.ts";
import { trialDate, trialInstant } from "../src/f3/data.ts";
import type { F3Data, KindId, SendLabel } from "../src/f3/data.ts";
import type { CopySummary, InstanceSummary } from "../src/protocol.ts";

export const TASK_Y = "00000000-0000-4000-8000-0000000000a1";
export const TASK_P = "00000000-0000-4000-8000-0000000000a2";
export const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";

function view(status: number, requestId: string, sentMs: number): RequestView {
  return { status, error_code: null, transport_error: false, settled: true, request_id: requestId, sent_ms: sentMs, settled_ms: sentMs + 300, body: null };
}

function completion(data: F3Data, label: SendLabel, instant: string, position: number): CompletionView {
  const task = label === "x" ? TASK_Y : label === "partner" ? TASK_P : UNKNOWN;
  const status = label === "unknown" ? data.statuses.unknown : data.statuses.x;
  const base = view(status, `req-${label}`, 10 + position * data.timing.gap_send_ms);
  return {
    ...base,
    label,
    task_id: task,
    error_code: label === "unknown" ? data.statuses.unknown_error_code : null,
    body: label === "unknown" ? null : { id: `00000000-0000-4000-8000-00000000c00${String(position)}`, task_id: task, completed_at: instant },
  };
}

/** A valid trial of the kind, as a correct app gives it: everything held, the report counts every 201. */
export function validObservation(data: F3Data, kind: KindId, index = 1): TrialObservation {
  const def = data.kinds[kind];
  const date = trialDate(data, kind, index);
  const instant = trialInstant(data, date);
  const completions = def.sends.map((label, position) => completion(data, label, instant, position));
  const patches = def.forced ? Array.from({ length: data.environment.fillers }, (_, i) => view(data.statuses.patch, `req-patch-${String(i + 1)}`, 0)) : [];
  const appLog: Record<string, LogTiming> = {};
  if (def.forced) {
    const clock = Date.parse("2030-01-01T00:00:00.000Z");
    completions.forEach((item, position) => {
      appLog[item.request_id ?? ""] = { start_ms: clock + 10 + position * 155, end_ms: clock + 330, status: item.status ?? 0 };
    });
    appLog["req-patch-1"] = { start_ms: clock, end_ms: clock + 330, status: 200 };
  }
  const full = { app_backends: 10, lock_waiting: 10, idle_in_transaction: 0 };
  return {
    kind,
    index,
    date,
    instant,
    errors: [],
    idle: { initial: 0, final: 0, waited_ms: 0 },
    setup_ok: true,
    precount: 0,
    gate_ok: def.forced ? true : null,
    s1: def.forced ? { l1: 1, l2: 9, lock_types: ["transactionid"], backends: full } : null,
    s2: def.forced ? { l1: 1, l2: 9, backends: full, settled: 0 } : null,
    s3: def.forced ? { l2: 9, all_settled: true } : null,
    completions,
    patches,
    report: { status: data.statuses.report, count: def.acknowledged },
    app_log: appLog,
    direct: { date_count: def.acknowledged, x_row_present: true },
  };
}

export function block(rule: { valid_target: number }, outcomes: Record<string, number>, invalid = 0, state: BlockStatus["state"] = "complete"): BlockStatus {
  const valid = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
  return { state, attempts: valid + invalid, valid, invalid, top_ups: Math.max(0, valid + invalid - rule.valid_target), next_index: null, outcomes };
}

/** An instance whose suite passed and whose blocks all completed with the given main outcome. */
export function instance(number: number, main: string, controls = "pass", mainValid = 20, controlValid = 5): InstanceSummary {
  const kinds: KindId[] = ["main", "sequential", "valid_partner", "x_alone", "dx_order"];
  const blocks: Partial<Record<KindId, BlockStatus>> = {};
  for (const kind of kinds) {
    const valid = kind === "main" ? mainValid : controlValid;
    blocks[kind] = block({ valid_target: valid }, { [kind === "main" ? main : controls]: valid });
  }
  return { instance: number, failure: null, suite: { verdict: "passed", tests_expected: 193, passed: 193 }, blocks };
}

export function copy(state: CopySummary["state"], dataSha: string, protocolSha: string, instances: InstanceSummary[]): CopySummary {
  return {
    state,
    purpose: "counted",
    invalid_reason: null,
    baseline_id: "task-report@ca4a71f",
    data_sha256: dataSha,
    protocol_sha256: protocolSha,
    source_tree_sha256: "0".repeat(64),
    instances,
  };
}
