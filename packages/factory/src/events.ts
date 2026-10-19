// Event construction (contract section 8.4): the fixed message texts and the deterministic event keys.
// Messages come only from fixed templates, host labels, catalog IDs and amounts; no check output,
// observation detail or failure code ever enters one.
//
// Event keys, unique per request:
//   host:<host_id>:preparing | host:<host_id>:ready
//   cand:<candidate_id>:selected | :reserved | :copy-<n>:budget | :check:<check_set>:<copy>
//   cand:<candidate_id>:behavior | :criteria | :package | :delivered | :end | :settled
//   source:<bug_type_id>:<source_id>:exhausted
//   run:attention:<code> | run:worker-settled | run:finished
//   heartbeat:<n>:raise | heartbeat:<n>:clear  (worker_unresponsive, appended from the status side)
//   lost:candidate-end | lost:attention | lost:finished  (the lost-worker finish)
import type { AttentionCode, BugTypeId, CandidateReason, CheckSet, CopyState, HostId, ObservedOutcome, RequestOutcome, StopCode } from "@rbw/factory-contract";
import { budgetRoom } from "./budget.ts";
import { formatUsd } from "./money.ts";
import type { LedgerStatus, NewEvent } from "./ports.ts";
import type { CandidateInfo } from "./sources.ts";
import { HOST_PRESENTATION } from "./sources.ts";

export const OUTCOME_OF: Readonly<Record<StopCode, RequestOutcome>> = {
  fulfilled: "fulfilled",
  budget_exhausted: "stopped_at_limit",
  time_limit: "stopped_at_limit",
  candidate_limit: "stopped_at_limit",
  sources_exhausted: "sources_exhausted",
  cancelled_by_user: "cancelled",
  worker_lost: "operational_error",
  needs_reconciliation: "operational_error",
  operational_error: "operational_error",
};

const OUTCOME_TEXT: Readonly<Record<RequestOutcome, string>> = {
  fulfilled: "fulfilled",
  stopped_at_limit: "stopped at limit",
  sources_exhausted: "sources exhausted",
  cancelled: "cancelled",
  operational_error: "operational error",
};

const CHECK_SET_TEXT: Readonly<Record<CheckSet, string>> = { original_suite: "Original suite", verification: "Verification checks" };
const COPY_TEXT: Readonly<Record<CopyState, string>> = { clean: "clean copy", buggy: "buggy copy", fixed: "reference-fixed copy" };

export const REASON_TEXT: Readonly<Record<CandidateReason, string>> = {
  original_suite_failed_clean: "Rejected: the original suite failed on the clean copy.",
  original_suite_caught_bug: "Rejected: the original suite failed on the buggy copy, so it already catches this bug.",
  original_suite_failed_fixed: "Rejected: the original suite failed on the reference-fixed copy.",
  checks_failed_clean: "Rejected: the verification checks failed on the clean copy.",
  checks_failed_fixed: "Rejected: the verification checks failed on the reference-fixed copy.",
  bug_not_detected: "Rejected: the verification checks passed on the buggy copy, so the bug was not detected.",
  wrong_failure: "Rejected: the buggy copy reported a failure code that belongs to no criterion of an item with an unfilled unit.",
  export_mismatch: "Rejected: the exported package parts failed their integrity checks or did not reproduce the matrix.",
  setup_failed: "Invalid: a copy could not be prepared or run. This is not reproduction.",
  incomplete_run: "Incomplete: a run ended early or too many runs were invalid. This is not reproduction.",
  stopped: "Incomplete: the request stopped while this candidate was in progress. It is not delivered.",
  duplicate_defect: "Skipped: this entry plants a defect this request already tried.",
  no_budget_for_candidate: "Skipped: the remaining budget or the factory pool cannot cover this candidate's worst case.",
};

export const ENDED_TYPE: Readonly<Record<CandidateReason, "candidate_rejected" | "candidate_invalid" | "candidate_incomplete" | "candidate_skipped">> = {
  original_suite_failed_clean: "candidate_rejected",
  original_suite_caught_bug: "candidate_rejected",
  original_suite_failed_fixed: "candidate_rejected",
  checks_failed_clean: "candidate_rejected",
  checks_failed_fixed: "candidate_rejected",
  bug_not_detected: "candidate_rejected",
  wrong_failure: "candidate_rejected",
  export_mismatch: "candidate_rejected",
  setup_failed: "candidate_invalid",
  incomplete_run: "candidate_incomplete",
  stopped: "candidate_incomplete",
  duplicate_defect: "candidate_skipped",
  no_budget_for_candidate: "candidate_skipped",
};

export const ATTENTION_TEXT: Readonly<Record<AttentionCode, string>> = {
  needs_reconciliation: "An operation's outcome is uncertain, so its spend needs reconciliation by an operator. No replacement work was started.",
  worker_unresponsive: "No heartbeat from the worker for more than 60 s.",
};

/** What an event needs to name a candidate. */
export type CandidateRef = Pick<CandidateInfo, "candidate_id" | "host_id">;

const NO_LINKS = { host_id: null, candidate_id: null, item_key: null, case_id: null } as const;

function candidateLinks(candidate: CandidateRef): { host_id: HostId; candidate_id: string; item_key: null; case_id: null } {
  return { host_id: candidate.host_id, candidate_id: candidate.candidate_id, item_key: null, case_id: null };
}

export function hostPreparing(host: HostId, baselineId: string, at: string): NewEvent {
  return { event_key: `host:${host}:preparing`, at, type: "host_preparing", ...NO_LINKS, host_id: host, message: `Preparing ${HOST_PRESENTATION[host].name} at its pinned baseline.`, data: { baseline_id: baselineId } };
}

export function hostReady(host: HostId, baselineId: string, at: string): NewEvent {
  const label = HOST_PRESENTATION[host].name;
  return { event_key: `host:${host}:ready`, at, type: "host_ready", ...NO_LINKS, host_id: host, message: `${label.charAt(0).toUpperCase()}${label.slice(1)} is ready.`, data: { baseline_id: baselineId } };
}

export function candidateSelected(candidate: CandidateInfo, at: string): NewEvent {
  return {
    event_key: `cand:${candidate.candidate_id}:selected`,
    at,
    type: "candidate_selected",
    ...candidateLinks(candidate),
    message: `Selected catalog entry ${candidate.entry_id}.`,
    data: { source_id: candidate.source_id, entry_id: candidate.entry_id },
  };
}

export function checkFinished(candidate: CandidateInfo, checkSet: CheckSet, copy: CopyState, cell: { observed: ObservedOutcome; runs_valid: number; runs_total: number }, at: string): NewEvent {
  return {
    event_key: `cand:${candidate.candidate_id}:check:${checkSet}:${copy}`,
    at,
    type: "check_finished",
    ...candidateLinks(candidate),
    message: `${CHECK_SET_TEXT[checkSet]} on the ${COPY_TEXT[copy]}: ${cell.observed} (${String(cell.runs_valid)} of ${String(cell.runs_total)} runs valid).`,
    data: { check_set: checkSet, copy, outcome: cell.observed, runs_valid: cell.runs_valid, runs_total: cell.runs_total },
  };
}

export function behaviorChecksPassed(candidate: CandidateInfo, at: string): NewEvent {
  return { event_key: `cand:${candidate.candidate_id}:behavior`, at, type: "behavior_checks_passed", ...candidateLinks(candidate), message: "All six cells matched their expected outcomes in export verification.", data: {} };
}

export function requestedCriteriaPassed(candidate: CandidateInfo, itemKey: string, criterionIds: readonly string[], at: string): NewEvent {
  return {
    event_key: `cand:${candidate.candidate_id}:criteria`,
    at,
    type: "requested_criteria_passed",
    ...candidateLinks(candidate),
    item_key: itemKey,
    message: `The observed failure matches the criteria of item ${itemKey}.`,
    data: { criterion_ids: [...criterionIds] },
  };
}

export function packageReady(candidate: CandidateInfo, itemKey: string, caseId: string, hashes: { bug_case_sha256: string; validator_sha256: string }, at: string): NewEvent {
  return {
    event_key: `cand:${candidate.candidate_id}:package`,
    at,
    type: "package_ready",
    ...candidateLinks(candidate),
    item_key: itemKey,
    case_id: caseId,
    message: "Both package parts are stored and ready for download.",
    data: { bug_case_sha256: hashes.bug_case_sha256, validator_sha256: hashes.validator_sha256 },
  };
}

export function caseDelivered(candidate: CandidateInfo, itemKey: string, caseId: string, at: string): NewEvent {
  return { event_key: `cand:${candidate.candidate_id}:delivered`, at, type: "case_delivered", ...candidateLinks(candidate), item_key: itemKey, case_id: caseId, message: `Case delivered for item ${itemKey}.`, data: {} };
}

export function candidateEnded(candidate: CandidateRef, reason: CandidateReason, at: string, message: string = REASON_TEXT[reason], key = `cand:${candidate.candidate_id}:end`): NewEvent {
  return { event_key: key, at, type: ENDED_TYPE[reason], ...candidateLinks(candidate), message, data: { reason } };
}

export function sourceExhausted(host: HostId, bugTypeId: BugTypeId, sourceId: string, at: string): NewEvent {
  return {
    event_key: `source:${bugTypeId}:${sourceId}:exhausted`,
    at,
    type: "source_exhausted",
    ...NO_LINKS,
    host_id: host,
    message: `Every entry in ${sourceId} was tried.`,
    data: { bug_type_id: bugTypeId, source_id: sourceId },
  };
}

export function budgetUpdated(key: string, status: Pick<LedgerStatus, "budget_microusd" | "reserved_microusd" | "spent_microusd">, message: string, at: string): NewEvent {
  return {
    event_key: key,
    at,
    type: "budget_updated",
    ...NO_LINKS,
    message,
    data: { reserved_microusd: status.reserved_microusd, spent_microusd: status.spent_microusd, remaining_microusd: budgetRoom(status) },
  };
}

/** The message of a budget change: what was reserved or settled, from the amounts before and after. */
export function budgetMessage(before: Pick<LedgerStatus, "reserved_microusd" | "spent_microusd">, after: Pick<LedgerStatus, "reserved_microusd" | "spent_microusd">, subject: string): string {
  const reserved = after.reserved_microusd - before.reserved_microusd;
  const spent = after.spent_microusd - before.spent_microusd;
  if (spent > 0) return `Settled ${formatUsd(spent)} for ${subject} and released the rest of its reservation.`;
  if (reserved > 0) return `Reserved ${formatUsd(reserved)} for ${subject}.`;
  if (reserved < 0) return `Released ${formatUsd(-reserved)} reserved for ${subject}.`;
  return `Budget updated for ${subject}.`;
}

export function attention(code: AttentionCode, at: string, key = `run:attention:${code}`): NewEvent {
  return { event_key: key, at, type: "attention", ...NO_LINKS, message: ATTENTION_TEXT[code], data: { code } };
}

export function attentionCleared(code: AttentionCode, at: string, key: string): NewEvent {
  return { event_key: key, at, type: "attention_cleared", ...NO_LINKS, message: code === "worker_unresponsive" ? "The worker's heartbeat resumed." : "The uncertain spend was reconciled.", data: { code } };
}

export function requestFinished(stopCode: StopCode, at: string, key = "run:finished"): NewEvent {
  const outcome = OUTCOME_OF[stopCode];
  return { event_key: key, at, type: "request_finished", ...NO_LINKS, message: `Request finished: ${OUTCOME_TEXT[outcome]}.`, data: { outcome, stop_code: stopCode } };
}
