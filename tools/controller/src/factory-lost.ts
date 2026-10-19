// The one lost-worker routine (contract sections 8.1, 8.5 and 11), which
// the status, stop and validation routes call once a heartbeat is older than 180 s or a validation
// run passed 1,800 s. It is idempotent: every append is keyed and every ledger step checks the
// current state first, so concurrent calls give one set of events.
//
// Request: the worker's operation and any in-flight copy's go from launching or running to
// uncertain and are never settled; the in-flight candidate ends candidate_incomplete
// (incomplete_run); attention becomes needs_reconciliation; the request finishes
// operational_error / worker_lost; the budget closes worker_lost; the sandboxes are stopped on a
// best-effort basis; and the slot stays held: only reconciliation releases it.
// Validation run: it finishes error; when every one of its sandboxes is confirmed stopped, its
// operation settles at the full worst case and the slot is released; otherwise its operation is
// uncertain, attention is needs_reconciliation and the slot stays held.
// Web-safe: no runner, driver or PGlite.
import type { Rates } from "@rbw/envelope";
import { canonicalDigest } from "@rbw/schema";
import {
  EVENT_KEYS,
  ROUTE_ACTOR,
  SANDBOX_PROVIDER,
  STOPPED_STATUSES,
  appendBudgetUpdate,
  finishRequest,
  finishValidation,
  finishedEvent,
  fullSettlement,
  makeUncertain,
  stopQuietly,
  validationOperation,
  validationSandboxName,
  workerOperation,
  workerSandboxName,
} from "./factory-ledger.ts";
import { FACTORY_PROFILE } from "./factory-profile.ts";
import type { FactoryProfile } from "./factory-profile.ts";
import type { FactoryIdentity, FactoryLedger, FactoryRecords, FactoryRequestRecord, FactoryValidationRecord, StoredFactoryEvent, WorkerSandboxSdk } from "./factory-ports.ts";

export interface LostDeps {
  ledger: FactoryLedger;
  records: FactoryRecords;
  identity: FactoryIdentity;
  sandbox: WorkerSandboxSdk;
  rates: Rates;
  now: () => Date;
  log: (line: string) => void;
  profile?: FactoryProfile;
}

export type LostTarget = { request_id: string } | { validation_id: string };
/** alive: not lost yet, nothing done; finished: the request or run already ended some other way. */
export type LostOutcome = { kind: "not_found" } | { kind: "alive" } | { kind: "finished" } | { kind: "finalized"; slot_held: boolean };


const CANDIDATE_END: ReadonlySet<string> = new Set(["candidate_rejected", "candidate_invalid", "candidate_incomplete", "candidate_skipped", "case_delivered"]);

/** The candidate selected last that has not ended, if any. */
function inFlightCandidate(events: readonly StoredFactoryEvent[]): StoredFactoryEvent | null {
  const ended = new Set(events.filter((event) => CANDIDATE_END.has(event.type)).map((event) => event.candidate_id));
  return events.filter((event) => event.type === "candidate_selected" && !ended.has(event.candidate_id)).at(-1) ?? null;
}

async function silentSince(deps: LostDeps, request: FactoryRequestRecord): Promise<{ since: Date; label: string }> {
  const beat = await deps.records.lastHeartbeat({ request_id: request.request_id });
  return beat === null ? { since: new Date(request.created_at), label: "none" } : { since: beat, label: beat.toISOString() };
}

/** The root's open operations and unconfirmed child resources, when the root holds the slot. */
async function rootBlockers(deps: LostDeps, root: string): Promise<{ held: boolean; operation_ids: string[]; children: string[] }> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const slot = await deps.ledger.spend.slotStatus({ slot_key: profile.slot_key });
  if (!slot.ok || slot.holder !== root) return { held: false, operation_ids: [], children: [] };
  return {
    held: true,
    operation_ids: slot.release_blockers.operation_ids,
    children: slot.release_blockers.child_resources.filter((child) => child.provider === SANDBOX_PROVIDER).map((child) => child.resource_id),
  };
}

/**
 * Appends attention{worker_unresponsive} once the worker has been silent for 60 s (contract
 * section 8.1), keyed by its last heartbeat. Returns whether the request is unresponsive.
 */
export async function noteWorkerUnresponsive(deps: LostDeps, requestId: string): Promise<boolean> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const request = await deps.records.request(requestId);
  if (request === null) return false;
  if (finishedEvent(await deps.records.events(requestId)) !== null) return false;
  const silent = await silentSince(deps, request);
  if (deps.now().getTime() - silent.since.getTime() < profile.heartbeat.unresponsive_after_s * 1000) return false;
  await deps.records.appendEvent(
    requestId,
    { event_key: EVENT_KEYS.unresponsive(silent.label), type: "attention", host_id: null, candidate_id: null, item_key: null, case_id: null, message: `No heartbeat from the worker for ${String(profile.heartbeat.unresponsive_after_s)} s.`, data: { code: "worker_unresponsive" } },
    deps.now(),
  );
  return true;
}

async function finalizeRequest(deps: LostDeps, requestId: string): Promise<LostOutcome> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const request = await deps.records.request(requestId);
  if (request === null) return { kind: "not_found" };
  const events = await deps.records.events(requestId);
  const finished = finishedEvent(events);
  const ours = finished !== null && finished.data.stop_code === "worker_lost";
  if (finished !== null && !ours) return { kind: "finished" };
  if (!ours) {
    const silent = await silentSince(deps, request);
    if (deps.now().getTime() - silent.since.getTime() < profile.heartbeat.lost_after_s * 1000) return { kind: "alive" };
  }

  // The ledger first: the worker's and any in-flight copy's operation become uncertain, never settled.
  const workerId = workerOperation({ identity: deps.identity, rates: deps.rates, profile }, request).operation_id;
  const blockers = await rootBlockers(deps, request.root);
  for (const id of new Set([workerId, ...blockers.operation_ids])) await makeUncertain(deps.ledger.spend, id, ROUTE_ACTOR);

  // Then the events, in the contract's order, each keyed so that a repeated call replays it.
  await noteWorkerUnresponsive(deps, requestId);
  const candidate = inFlightCandidate(events);
  if (candidate !== null && candidate.candidate_id !== null) {
    await deps.records.appendEvent(
      requestId,
      {
        event_key: EVENT_KEYS.candidateEnd(candidate.candidate_id),
        type: "candidate_incomplete",
        host_id: candidate.host_id,
        candidate_id: candidate.candidate_id,
        item_key: null,
        case_id: null,
        message: "Incomplete: the worker stopped responding before this candidate's checks finished. It is not reproduction and was not retried.",
        data: { reason: "incomplete_run" },
      },
      deps.now(),
    );
  }
  const done = await finishRequest(deps, request, "worker_lost", { attention: "The worker stopped responding; the spend of the worker and of any sandbox run in progress is uncertain and needs reconciliation." });
  if (!done) return { kind: "finished" };

  // Best effort: stop what may still run. The slot stays held until reconciliation.
  await stopQuietly(deps.sandbox, workerSandboxName(request.root), deps.log);
  for (const child of blockers.children) await stopQuietly(deps.sandbox, child, deps.log);
  deps.log(`factory ${requestId} worker lost: finished worker_lost; slot held for reconciliation`);
  const after = await rootBlockers(deps, request.root);
  return { kind: "finalized", slot_held: after.held };
}

async function confirmedStopped(deps: LostDeps, name: string): Promise<boolean> {
  try {
    let found = await deps.sandbox.get(name);
    if (found !== null && !STOPPED_STATUSES.has(found.status)) {
      await found.stop();
      found = await deps.sandbox.get(name);
    }
    return found === null || STOPPED_STATUSES.has(found.status);
  } catch (error) {
    deps.log(`factory: ${name} could not be confirmed stopped (${error instanceof Error ? error.name : "non-error"})`);
    return false;
  }
}

async function finalizeValidation(deps: LostDeps, validationId: string): Promise<LostOutcome> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const validation: FactoryValidationRecord | null = await deps.records.validation(validationId);
  if (validation === null) return { kind: "not_found" };
  const request = await deps.records.request(validation.request_id);
  if (request === null) return { kind: "not_found" };
  const log = await deps.records.validationEvents(validationId);
  if (log.some((event) => event.type === "finished")) return { kind: "finished" };
  const now = deps.now().getTime();
  const beat = await deps.records.lastHeartbeat({ validation_id: validationId });
  const accepted = Date.parse(validation.accepted_at);
  const silentMs = now - (beat === null ? accepted : beat.getTime());
  const overMs = now - accepted - profile.validation.max_run_s * 1000;
  if (silentMs < profile.heartbeat.lost_after_s * 1000 && overMs <= 0) return { kind: "alive" };

  const op = validationOperation({ identity: deps.identity, rates: deps.rates, profile }, validation);
  const { spend } = deps.ledger;
  const blockers = await rootBlockers(deps, validation.root);
  const names = [validationSandboxName(validation.root), ...blockers.children.filter((name) => name !== validationSandboxName(validation.root))];
  let allStopped = true;
  for (const name of names) {
    const stopped = await confirmedStopped(deps, name);
    allStopped &&= stopped;
    if (stopped && name !== validationSandboxName(validation.root) && blockers.children.includes(name)) {
      const evidence = { key: `factory/${validation.root}/stops/${name}.json`, sha256: canonicalDigest({ resource_id: name, confirmed: "lost_finish" }).sha256 };
      const child = await spend.confirmChild({ slot_key: profile.slot_key, root_execution_id: validation.root, provider: SANDBOX_PROVIDER, resource_id: name, terminal_status: "failed", evidence, actor_role: ROUTE_ACTOR });
      if (!child.ok) allStopped = false;
    }
  }
  const status = await spend.operationStatus({ operation_id: op.operation_id });
  const message = silentMs >= profile.heartbeat.lost_after_s * 1000 ? "The validation run stopped sending heartbeats." : "The validation run did not finish within 1,800 s.";
  if (allStopped && status.ok && status.state === "running") {
    const ended = await spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "terminal", actor_role: ROUTE_ACTOR, terminal_status: "failed" });
    const settled = ended.ok ? await spend.settle(fullSettlement(op.envelope, op.operation_id)) : ended;
    if (settled.ok) {
      await finishValidation(deps, request, validation, { result: "error", matrix: null, message, cost_microusd: Number(settled.settled_microusd), uncertain: false });
      const released = await spend.releaseSlot({ slot_key: profile.slot_key, root_execution_id: validation.root, actor_role: ROUTE_ACTOR, evidence: null, reason: null });
      return { kind: "finalized", slot_held: !released.ok };
    }
  }
  await makeUncertain(spend, op.operation_id, ROUTE_ACTOR);
  await finishValidation(deps, request, validation, { result: "error", matrix: null, message, cost_microusd: null, uncertain: true });
  deps.log(`factory validation ${validationId} lost: finished error; slot held for reconciliation`);
  return { kind: "finalized", slot_held: true };
}

/** The web service's finalizeLost: one routine for a request and for a validation run. */
export async function finalizeLostWorker(deps: LostDeps, target: LostTarget): Promise<LostOutcome> {
  return "request_id" in target ? finalizeRequest(deps, target.request_id) : finalizeValidation(deps, target.validation_id);
}

export type ReconciliationOutcome = { kind: "released" } | { kind: "blocked"; operation_ids: string[] } | { kind: "not_held" } | { kind: "not_found" };

/**
 * After an operator reconciled every uncertain operation of a request or validation run: appends
 * budget_updated, clears needs_reconciliation unless the budget is overrun (contract section 8.5),
 * and releases the slot. Refuses while any operation or child resource of the root is still open.
 */
export async function completeReconciliation(deps: LostDeps, target: LostTarget): Promise<ReconciliationOutcome> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  let request: FactoryRequestRecord | null;
  let root: string;
  if ("request_id" in target) {
    request = await deps.records.request(target.request_id);
    if (request === null) return { kind: "not_found" };
    root = request.root;
  } else {
    const validation = await deps.records.validation(target.validation_id);
    if (validation === null) return { kind: "not_found" };
    request = await deps.records.request(validation.request_id);
    if (request === null) return { kind: "not_found" };
    root = validation.root;
  }
  const blockers = await rootBlockers(deps, root);
  if (!blockers.held) return { kind: "not_held" };
  if (blockers.operation_ids.length > 0 || blockers.children.length > 0) return { kind: "blocked", operation_ids: blockers.operation_ids };
  const released = await deps.ledger.spend.releaseSlot({ slot_key: profile.slot_key, root_execution_id: root, actor_role: ROUTE_ACTOR, evidence: null, reason: null });
  if (!released.ok) return { kind: "blocked", operation_ids: released.blocking_operation_ids ?? [] };
  await appendBudgetUpdate(deps, request, `reconciled:${root}:budget`, "Reconciled spend settled.");
  const totals = await deps.ledger.budgets.status(request.budget_key);
  const overrun = totals.ok && totals.available_microusd < 0n;
  if (!overrun) {
    await deps.records.appendEvent(
      request.request_id,
      { event_key: `reconciled:${root}:attention_cleared`, type: "attention_cleared", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Reconciliation finished; the factory is available again.", data: { code: "needs_reconciliation" } },
      deps.now(),
    );
  }
  return { kind: "released" };
}
