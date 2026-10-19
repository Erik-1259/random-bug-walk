// RequestStatus (contract section 8) projected from the request record, its events, the per-case
// evidence, the latest validation run of each case, the heartbeat and the ledger's budget status, with
// an injected clock. Counts come from events only and count distinct candidates.
import type { Attention, AttentionCode, Candidate, CandidateReasonDetail, CandidateStage, Case, Event, HostId, QualificationRecord, RequestState, RequestStatus, StopCode, ValidationRun } from "@rbw/factory-contract";
import { ATTENTION_TEXT, attention as attentionEvent, attentionCleared, candidateEnded, requestFinished } from "./events.ts";
import { CONTRACT_VERSION } from "./capabilities.ts";
import { formatUsd } from "./money.ts";
import type { LedgerStatus, NewEvent, RequestRecordInput } from "./ports.ts";
import type { CandidateInfo } from "./sources.ts";

/** The evidence the loop stores per delivered case: the client-safe case and its qualification record. */
export interface CaseEvidence {
  schema_version: 1;
  case: Case;
  record: QualificationRecord;
}

export interface ProjectionInput {
  request: RequestRecordInput;
  /** Every event of the request, by seq. */
  events: readonly Event[];
  /** The registry's entries by candidate ID (see `candidateIndex`). */
  candidates: ReadonlyMap<string, CandidateInfo>;
  evidence: readonly CaseEvidence[];
  /** The latest validation run of each case, by case ID. */
  validations: Readonly<Record<string, ValidationRun>>;
  budget: Pick<LedgerStatus, "budget_microusd" | "reserved_microusd" | "spent_microusd">;
  last_heartbeat_at: string | null;
  /** A stop record exists. */
  stop_recorded: boolean;
  now: Date;
  /** The `after` query parameter. */
  after: number;
}

export class ProjectionError extends Error {
  constructor(message: string) {
    super(`request status: ${message}`);
    this.name = "ProjectionError";
  }
}

export const MAX_EVENTS_PER_RESPONSE = 200;
export const UNRESPONSIVE_AFTER_MS = 60_000;
export const POLL_AFTER_MS: Readonly<Record<RequestState, number>> = { queued: 1000, starting: 1000, running: 2000, stopping: 2000, finished: 30_000 };

const IN_PROGRESS: ReadonlySet<CandidateStage> = new Set(["selected", "preparing", "checking", "behavior_checks_passed", "requested_criteria_passed", "packaging"]);

interface CandidateFold {
  candidate_id: string;
  host_id: HostId | null;
  stage: CandidateStage;
  reason: CandidateReasonDetail | null;
  item_key: string | null;
  case_id: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface Fold {
  candidates: Map<string, CandidateFold>;
  explored: Set<string>;
  behaviorPassed: Set<string>;
  criteriaPassed: Set<string>;
  packagesReady: Set<string>;
  /** Delivered cases in order. */
  delivered: { item_key: string; case_id: string }[];
  workerStarted: boolean;
  stopRequested: boolean;
  finished: { stop_code: StopCode; outcome: RequestStatus["outcome"] } | null;
  attention: AttentionCode | null;
  raisedUnresponsive: number;
}

function fold(events: readonly Event[]): Fold {
  const state: Fold = {
    candidates: new Map(),
    explored: new Set(),
    behaviorPassed: new Set(),
    criteriaPassed: new Set(),
    packagesReady: new Set(),
    delivered: [],
    workerStarted: false,
    stopRequested: false,
    finished: null,
    attention: null,
    raisedUnresponsive: 0,
  };
  const candidate = (event: Event): CandidateFold => {
    const found = event.candidate_id === null ? undefined : state.candidates.get(event.candidate_id);
    if (found === undefined) throw new ProjectionError(`event ${String(event.seq)} names a candidate that was never selected`);
    return found;
  };
  const advance = (entry: CandidateFold, stage: CandidateStage): void => {
    if (IN_PROGRESS.has(entry.stage)) entry.stage = stage;
  };
  for (const event of events) {
    switch (event.type) {
      case "worker_started":
        state.workerStarted = true;
        break;
      case "candidate_selected": {
        if (event.candidate_id === null) throw new ProjectionError(`event ${String(event.seq)} selects no candidate`);
        state.candidates.set(event.candidate_id, { candidate_id: event.candidate_id, host_id: event.host_id, stage: "selected", reason: null, item_key: null, case_id: null, started_at: event.at, finished_at: null });
        state.explored.add(event.candidate_id);
        break;
      }
      case "check_finished":
        advance(candidate(event), "checking");
        break;
      case "behavior_checks_passed": {
        const entry = candidate(event);
        advance(entry, "behavior_checks_passed");
        state.behaviorPassed.add(entry.candidate_id);
        break;
      }
      case "requested_criteria_passed": {
        const entry = candidate(event);
        advance(entry, "requested_criteria_passed");
        entry.item_key = event.item_key;
        state.criteriaPassed.add(entry.candidate_id);
        break;
      }
      case "package_ready": {
        const entry = candidate(event);
        advance(entry, "packaging");
        entry.case_id = event.case_id;
        state.packagesReady.add(entry.candidate_id);
        break;
      }
      case "case_delivered": {
        const entry = candidate(event);
        if (event.item_key === null || event.case_id === null) throw new ProjectionError(`event ${String(event.seq)} delivers no case to an item`);
        entry.stage = "qualified";
        entry.item_key = event.item_key;
        entry.case_id = event.case_id;
        entry.finished_at = event.at;
        state.delivered.push({ item_key: event.item_key, case_id: event.case_id });
        break;
      }
      case "candidate_rejected":
      case "candidate_invalid":
      case "candidate_incomplete":
      case "candidate_skipped": {
        const entry = candidate(event);
        entry.stage = event.type === "candidate_rejected" ? "rejected" : event.type === "candidate_invalid" ? "invalid" : event.type === "candidate_incomplete" ? "incomplete" : "skipped";
        entry.reason = { code: event.data.reason, message: event.message };
        entry.item_key = null;
        entry.case_id = null;
        entry.finished_at = event.at;
        if (event.type === "candidate_skipped") {
          entry.started_at = null;
          state.explored.delete(entry.candidate_id);
        }
        break;
      }
      case "stop_requested":
        state.stopRequested = true;
        break;
      case "attention":
        state.attention = event.data.code;
        if (event.data.code === "worker_unresponsive") state.raisedUnresponsive += 1;
        break;
      case "attention_cleared":
        if (state.attention === event.data.code) state.attention = null;
        break;
      case "request_finished":
        state.finished = { stop_code: event.data.stop_code, outcome: event.data.outcome };
        break;
      default:
        break;
    }
  }
  return state;
}

function stopMessage(code: StopCode, delivered: number, requested: number, remainingMicrousd: number): string {
  const counts = `${String(delivered)} of ${String(requested)} requested ${requested === 1 ? "case was" : "cases were"} delivered.`;
  switch (code) {
    case "fulfilled":
      return "Every requested case was delivered.";
    case "budget_exhausted":
      return `The remaining budget of ${formatUsd(remainingMicrousd)} cannot cover another candidate's worst case. ${counts}`;
    case "time_limit":
      return `The request reached its wall-clock limit. ${counts}`;
    case "candidate_limit":
      return `The request reached its candidate limit. ${counts}`;
    case "sources_exhausted":
      return `Every eligible catalog entry was tried. ${counts}`;
    case "cancelled_by_user":
      return `Stopped by the user. ${counts} Every delivered case stays available.`;
    case "worker_lost":
      return "The worker stopped responding. No replacement work was started.";
    case "needs_reconciliation":
      return "An operation's outcome became uncertain, so the request stopped instead of retrying.";
    case "operational_error":
      return "An execution or accounting problem stopped the request.";
  }
}

function stateOf(folded: Fold, stopRecorded: boolean, lastHeartbeat: string | null): RequestState {
  if (folded.finished !== null) return "finished";
  if (folded.stopRequested || stopRecorded) return "stopping";
  if (folded.workerStarted) return "running";
  return lastHeartbeat === null ? "queued" : "starting";
}

function heartbeatAge(lastHeartbeat: string | null, createdAt: string, now: Date): number {
  return now.getTime() - Date.parse(lastHeartbeat ?? createdAt);
}

export function projectStatus(input: ProjectionInput): RequestStatus {
  const { request } = input;
  const interpretation = request.interpretation;
  const folded = fold(input.events);
  const state = stateOf(folded, input.stop_recorded, input.last_heartbeat_at);

  const candidates: Candidate[] = [...folded.candidates.values()].map((entry) => {
    const info = input.candidates.get(entry.candidate_id);
    if (info === undefined) throw new ProjectionError(`candidate ${entry.candidate_id} is not in the host registry`);
    return {
      candidate_id: entry.candidate_id,
      defect_id: info.defect_id,
      host_id: info.host_id,
      bug_type_id: info.bug_type_id,
      source_id: info.source_id,
      entry_id: info.entry_id,
      stage: entry.stage,
      reason: entry.reason,
      item_key: entry.item_key,
      case_id: entry.case_id,
      started_at: entry.started_at,
      finished_at: entry.finished_at,
    };
  });

  const evidence = new Map(input.evidence.map((entry) => [entry.case.case_id, entry]));
  const cases: Case[] = folded.delivered.map(({ case_id }) => {
    const found = evidence.get(case_id);
    if (found === undefined) throw new ProjectionError(`delivered case ${case_id} has no stored evidence`);
    return { ...structuredClone(found.case), validation: input.validations[case_id] ?? null };
  });

  const items = interpretation.items.map((item) => {
    const caseIds = folded.delivered.filter((delivered) => delivered.item_key === item.item_key).map((delivered) => delivered.case_id);
    return { item_key: item.item_key, bug_type_id: item.bug_type_id, description: item.description, requested: item.quantity, delivered: caseIds.length, missing: Math.max(item.quantity - caseIds.length, 0), case_ids: caseIds };
  });
  const typeTotals = interpretation.type_totals.map((total) => {
    const ofType = items.filter((item) => item.bug_type_id === total.bug_type_id);
    return {
      bug_type_id: total.bug_type_id,
      requested: ofType.reduce((sum, item) => sum + item.requested, 0),
      delivered: ofType.reduce((sum, item) => sum + item.delivered, 0),
      missing: ofType.reduce((sum, item) => sum + item.missing, 0),
    };
  });
  const requested = items.reduce((sum, item) => sum + item.requested, 0);
  const delivered = items.reduce((sum, item) => sum + item.delivered, 0);
  const missing = items.reduce((sum, item) => sum + item.missing, 0);

  const committed = input.budget.reserved_microusd + input.budget.spent_microusd;
  const remaining = input.budget.budget_microusd - committed;

  let attention: Attention | null = folded.attention === null ? null : { code: folded.attention, message: ATTENTION_TEXT[folded.attention] };
  if (attention === null && state !== "finished" && heartbeatAge(input.last_heartbeat_at, request.created_at, input.now) > UNRESPONSIVE_AFTER_MS) {
    attention = { code: "worker_unresponsive", message: ATTENTION_TEXT.worker_unresponsive };
  }

  const after = input.events.filter((event) => event.seq > input.after);
  const page = after.slice(0, MAX_EVENTS_PER_RESPONSE);
  const createdMs = Date.parse(request.created_at);

  return {
    contract_version: CONTRACT_VERSION,
    request_id: request.request_id,
    created_at: request.created_at,
    updated_at: input.events.at(-1)?.at ?? request.created_at,
    state,
    outcome: folded.finished?.outcome ?? null,
    stop_reason: folded.finished === null ? null : { code: folded.finished.stop_code, message: stopMessage(folded.finished.stop_code, delivered, requested, remaining) },
    delivery: delivered === 0 ? "none" : missing === 0 ? "complete" : "partial",
    attention,
    interpretation: structuredClone(interpretation),
    budget: {
      budget_microusd: input.budget.budget_microusd,
      reserved_microusd: input.budget.reserved_microusd,
      spent_microusd: input.budget.spent_microusd,
      committed_microusd: committed,
      remaining_microusd: remaining,
      overrun: committed > input.budget.budget_microusd,
    },
    limits: {
      max_wall_clock_s: interpretation.limits.max_wall_clock_s,
      deadline_at: new Date(createdMs + interpretation.limits.max_wall_clock_s * 1000).toISOString(),
      max_candidates: interpretation.limits.max_candidates,
      candidates_started: candidates.filter((candidate) => candidate.started_at !== null).length,
    },
    funnel: {
      candidates_explored: folded.explored.size,
      behavior_checks_passed: folded.behaviorPassed.size,
      requested_criteria_passed: folded.criteriaPassed.size,
      packages_ready: folded.packagesReady.size,
    },
    items,
    type_totals: typeTotals,
    candidates,
    cases,
    events: page.map((event) => structuredClone(event)),
    next_after: page.at(-1)?.seq ?? input.after,
    last_heartbeat_at: input.last_heartbeat_at,
    poll_after_ms: after.length > page.length ? 0 : POLL_AFTER_MS[state],
  };
}

/**
 * The attention event the status side appends when the worker's heartbeat age crosses 60 s, or the
 * clearing event once a heartbeat arrives again (contract section 8.1). Null when nothing changes.
 * Keys: heartbeat:<n>:raise and heartbeat:<n>:clear, so repeated polls append each change once.
 */
export function workerAttentionEvent(input: { events: readonly Event[]; last_heartbeat_at: string | null; created_at: string; now: Date }): NewEvent | null {
  const folded = fold(input.events);
  if (folded.finished !== null) return null;
  const stale = heartbeatAge(input.last_heartbeat_at, input.created_at, input.now) > UNRESPONSIVE_AFTER_MS;
  const at = input.now.toISOString();
  if (stale && folded.attention === null) return attentionEvent("worker_unresponsive", at, `heartbeat:${String(folded.raisedUnresponsive + 1)}:raise`);
  if (!stale && folded.attention === "worker_unresponsive") return attentionCleared("worker_unresponsive", at, `heartbeat:${String(folded.raisedUnresponsive)}:clear`);
  return null;
}

/**
 * The events of the lost-worker finish (contract section 8.1; the hosted worker's supervisor appends them once
 * the heartbeat is older than 180 s): the candidate in flight becomes incomplete and is never retried,
 * attention becomes needs_reconciliation, and the request finishes `operational_error` / `worker_lost`.
 * Empty for a request that already finished. The keys make a repeated finish a replay.
 */
export function lostWorkerEvents(input: { events: readonly Event[]; now: Date }): NewEvent[] {
  const folded = fold(input.events);
  if (folded.finished !== null) return [];
  const at = input.now.toISOString();
  const out: NewEvent[] = [];
  const inFlight = [...folded.candidates.values()].find((entry) => IN_PROGRESS.has(entry.stage));
  if (inFlight !== undefined && inFlight.host_id !== null) {
    out.push(
      candidateEnded(
        { candidate_id: inFlight.candidate_id, host_id: inFlight.host_id },
        "incomplete_run",
        at,
        "Incomplete: the worker stopped responding before this candidate's checks finished. It is not reproduction and was not retried.",
        "lost:candidate-end",
      ),
    );
  }
  out.push(attentionEvent("needs_reconciliation", at, "lost:attention"));
  out.push(requestFinished("worker_lost", at, "lost:finished"));
  return out;
}
