// The one lost-worker routine (contract sections 8.1, 8.5 and 11), which
// the status, stop and validation routes call once a heartbeat is older than 180 s or a validation
// run passed 1,800 s. It is idempotent: every append is keyed and every ledger step checks the
// current state first, so concurrent calls give one set of events.
//
// Request: the worker's operation and any in-flight copy's go from launching or running to
// uncertain and are never settled; the factory core's lost-worker events are appended (the
// in-flight candidate ends candidate_incomplete / incomplete_run, attention becomes
// needs_reconciliation, the request finishes operational_error / worker_lost); the budget closes
// worker_lost; the sandboxes are stopped on a best-effort basis; and the slot stays held: only
// reconciliation releases it. The worker_unresponsive attention after 60 s, and its clearing, are
// the core's, appended from the status side; this routine appends neither.
// Validation run: it finishes error; when every one of its sandboxes is confirmed stopped, its
// operation settles at the full worst case (or keeps the cost it was already settled at, by the
// worker or an overlapping call) and the slot is released; otherwise its operation is uncertain,
// attention is needs_reconciliation and the slot stays held. A ledger step another caller took
// first is read back, so overlapping calls settle the run once.
// A finished request or run whose worker went silent while its root still holds the slot (its
// worker exited before it settled or released) is made visible: its open operations go to
// uncertain and attention becomes needs_reconciliation; with nothing left open, the slot is
// released, unless its spend was left for reconciliation, which keeps it held for the operator.
// Web-safe: no runner, driver or PGlite.
import type { Rates } from "@rbw/envelope";
import { canonicalDigest } from "@rbw/schema";
import {
  ROUTE_ACTOR,
  SANDBOX_PROVIDER,
  STOPPED_STATUSES,
  VALIDATION_ATTENTION,
  appendBudgetUpdate,
  appendNeedsReconciliation,
  finishValidation,
  finishedEvent,
  fullSettlement,
  makeUncertain,
  needsReconciliationRaised,
  stopQuietly,
  stoppedByStatus,
  validationOperation,
  validationAttentionKey,
  validationSandboxName,
  workerOperation,
  workerSandboxName,
} from "./factory-ledger.ts";
import type { FactoryOperation } from "./factory-ledger.ts";
import { FACTORY_PROFILE } from "./factory-profile.ts";
import type { FactoryProfile } from "./factory-profile.ts";
import type { FactoryEventBuilders, FactoryIdentity, FactoryLedger, FactoryRecords, FactoryRequestRecord, FactoryValidationRecord, StoredFactoryEvent, ValidationEventInput, WorkerSandboxInstance, WorkerSandboxSdk } from "./factory-ports.ts";

export interface LostDeps {
  ledger: FactoryLedger;
  records: FactoryRecords;
  identity: FactoryIdentity;
  /** The factory core's event module: the lost-worker finish and the attention event, with its keys. */
  events: FactoryEventBuilders;
  sandbox: WorkerSandboxSdk;
  rates: Rates;
  now: () => Date;
  /** Waits between the status reads that confirm a stop (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
  log: (line: string) => void;
  profile?: FactoryProfile;
}

function sleepFor(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export type LostTarget = { request_id: string } | { validation_id: string };
/** alive: not lost yet, nothing done; finished: the request or run already ended some other way. */
export type LostOutcome = { kind: "not_found" } | { kind: "alive" } | { kind: "finished" } | { kind: "finalized"; slot_held: boolean };

async function silentSince(deps: LostDeps, request: FactoryRequestRecord): Promise<Date> {
  const beat = await deps.records.lastHeartbeat({ request_id: request.request_id });
  return beat ?? new Date(request.created_at);
}

interface RootBlockers {
  held: boolean;
  operation_ids: string[];
  /** The root's unconfirmed sandboxes, which can be stopped by name. */
  children: string[];
  /** Whether anything, of any provider, keeps the ledger from releasing the slot. */
  blocked: boolean;
}

/** The root's open operations and unconfirmed child resources, when the root holds the slot. */
async function rootBlockers(deps: LostDeps, root: string): Promise<RootBlockers> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const slot = await deps.ledger.spend.slotStatus({ slot_key: profile.slot_key });
  if (!slot.ok || slot.holder !== root) return { held: false, operation_ids: [], children: [], blocked: false };
  const { operation_ids, child_resources } = slot.release_blockers;
  return {
    held: true,
    operation_ids,
    children: child_resources.filter((child) => child.provider === SANDBOX_PROVIDER).map((child) => child.resource_id),
    blocked: operation_ids.length > 0 || child_resources.length > 0,
  };
}

/** Releases the root's hold; whether the root still holds the slot afterwards (another caller may have released it first). */
async function release(deps: LostDeps, root: string): Promise<boolean> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const released = await deps.ledger.spend.releaseSlot({ slot_key: profile.slot_key, root_execution_id: root, actor_role: ROUTE_ACTOR, evidence: null, reason: null });
  return released.ok ? false : (await rootBlockers(deps, root)).held;
}

/**
 * A finished request or run whose root still holds the slot after its worker went silent: its
 * worker exited before it settled or released. Nothing open and nothing left for reconciliation:
 * the slot is released. Spend left for reconciliation (`reconciliation`), with nothing open: the
 * slot stays held for the operator. Otherwise every launching or running operation goes to
 * uncertain (never settled), attention is raised once (the `raise` step answers whether it
 * appended), the sandboxes are stopped on a best-effort basis and the slot stays held for
 * reconciliation. A hold already uncertain and noted is left as it is.
 */
async function strandedHold(deps: LostDeps, root: string, sandboxes: readonly string[], reconciliation: boolean, raise: () => Promise<boolean>): Promise<LostOutcome> {
  const { spend } = deps.ledger;
  const blockers = await rootBlockers(deps, root);
  if (!blockers.held) return { kind: "finished" };
  if (!blockers.blocked) {
    if (reconciliation) return { kind: "finished" };
    return { kind: "finalized", slot_held: await release(deps, root) };
  }
  let moved = false;
  for (const id of blockers.operation_ids) {
    const status = await spend.operationStatus({ operation_id: id });
    if (status.ok && (status.state === "launching" || status.state === "running")) {
      await makeUncertain(spend, id, ROUTE_ACTOR);
      moved = true;
    }
  }
  const raised = await raise();
  if (!moved && !raised) return { kind: "finished" };
  if (moved) for (const name of new Set([...sandboxes, ...blockers.children])) await stopQuietly(deps.sandbox, name, deps.log);
  deps.log(`factory: ${root} finished but its worker stopped before releasing; slot held for reconciliation`);
  return { kind: "finalized", slot_held: true };
}

async function finalizeRequest(deps: LostDeps, requestId: string): Promise<LostOutcome> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const request = await deps.records.request(requestId);
  if (request === null) return { kind: "not_found" };
  const events = await deps.records.events(requestId);
  const finished = finishedEvent(events);
  const ours = finished !== null && finished.data.stop_code === "worker_lost";
  const silent = deps.now().getTime() - (await silentSince(deps, request)).getTime() >= profile.heartbeat.lost_after_s * 1000;
  if (finished !== null && !ours) {
    if (!silent) return { kind: "finished" };
    return strandedHold(deps, request.root, [workerSandboxName(request.root)], needsReconciliationRaised(events), async () => {
      if (needsReconciliationRaised(await deps.records.events(requestId))) return false;
      return (await deps.records.appendEvent(requestId, deps.events.attention("needs_reconciliation", deps.now()), deps.now())).kind === "appended";
    });
  }
  if (!ours && !silent) return { kind: "alive" };

  // The ledger first: the worker's and any in-flight copy's operation become uncertain, never settled.
  const workerId = workerOperation({ identity: deps.identity, rates: deps.rates, profile }, request).operation_id;
  const blockers = await rootBlockers(deps, request.root);
  for (const id of new Set([workerId, ...blockers.operation_ids])) await makeUncertain(deps.ledger.spend, id, ROUTE_ACTOR);

  // Then the core's lost-worker events, in the contract's order, each keyed so that a repeated call replays it.
  let finishedHere = ours;
  for (const event of deps.events.lostWorker({ events, now: deps.now() })) {
    const appended = await deps.records.appendEvent(requestId, event, deps.now());
    if (event.type === "request_finished") finishedHere = appended.kind === "appended" || appended.kind === "replay";
  }
  if (!finishedHere) return { kind: "finished" };
  const closed = await deps.ledger.budgets.close(request.budget_key, "worker_lost");
  if (!closed.ok) throw new Error(`the budget close was refused (${closed.code})`);

  // Best effort: stop what may still run. The slot stays held until reconciliation.
  await stopQuietly(deps.sandbox, workerSandboxName(request.root), deps.log);
  for (const child of blockers.children) await stopQuietly(deps.sandbox, child, deps.log);
  deps.log(`factory ${requestId} worker lost: finished worker_lost; slot held for reconciliation`);
  const after = await rootBlockers(deps, request.root);
  return { kind: "finalized", slot_held: after.held };
}

/**
 * Stops the sandbox unless it no longer runs or is already stopping (an overlapping call or its
 * worker stopped it), then confirms by status, within the copy runner's bound, that it stopped. A
 * failed stop is logged and the status still decides, as in the copy runner.
 */
async function confirmedStopped(deps: LostDeps, name: string): Promise<boolean> {
  const errorName = (error: unknown): string => (error instanceof Error ? error.name : "non-error");
  let found: WorkerSandboxInstance | null;
  try {
    found = await deps.sandbox.get(name);
  } catch (error) {
    deps.log(`factory: ${name} could not be confirmed stopped (${errorName(error)})`);
    return false;
  }
  if (found === null || STOPPED_STATUSES.has(found.status)) return true;
  if (found.status !== "stopping") {
    try {
      await found.stop();
    } catch (error) {
      deps.log(`factory: the stop of ${name} failed (${errorName(error)}); checking its status`);
    }
  }
  return stoppedByStatus(
    () => deps.sandbox.get(name),
    deps.sleep ?? sleepFor,
    (error) => {
      deps.log(`factory: a status read of ${name} failed (${errorName(error)})`);
    },
  );
}

async function finalizeValidation(deps: LostDeps, validationId: string): Promise<LostOutcome> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const validation: FactoryValidationRecord | null = await deps.records.validation(validationId);
  if (validation === null) return { kind: "not_found" };
  const request = await deps.records.request(validation.request_id);
  if (request === null) return { kind: "not_found" };
  const now = deps.now().getTime();
  const beat = await deps.records.lastHeartbeat({ validation_id: validationId });
  const accepted = Date.parse(validation.accepted_at);
  const silentMs = now - (beat === null ? accepted : beat.getTime());
  const done = await finishedRecord(deps, validationId);
  if (done !== undefined) {
    if (silentMs < profile.heartbeat.lost_after_s * 1000) return { kind: "finished" };
    return strandedHold(deps, validation.root, [validationSandboxName(validation.root)], done.data.cost_microusd === null, async () => {
      const key = validationAttentionKey(validationId);
      if ((await deps.records.events(request.request_id)).some((event) => event.event_key === key)) return false;
      await appendNeedsReconciliation(deps, request.request_id, VALIDATION_ATTENTION, key);
      return true;
    });
  }
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
  const message = silentMs >= profile.heartbeat.lost_after_s * 1000 ? "The validation run stopped sending heartbeats." : "The validation run did not finish within 1,800 s.";
  const cost = await settledCost(spend, op, allStopped);
  const after = await rootBlockers(deps, validation.root);
  if (cost !== null && allStopped && !after.blocked) {
    // Settled, here, by a concurrent call or by the worker itself, and every sandbox of the run confirmed
    // stopped (a run the worker settled has no blocker left in the ledger, so only the stop confirmation
    // shows it ended): the run finishes error with that cost,
    // unless the worker recorded its own finish first, which stands; one that left its spend for
    // reconciliation keeps the slot held.
    const finish = await finishValidation(deps, request, validation, { result: "error", matrix: null, message, cost_microusd: Number(cost) });
    if (finish.cost_microusd === null) return { kind: "finalized", slot_held: true };
    return { kind: "finalized", slot_held: after.held ? await release(deps, validation.root) : false };
  }
  // Not settled, or a sandbox of the run is still unconfirmed: its spend needs reconciliation.
  if (cost === null) await makeUncertain(spend, op.operation_id, ROUTE_ACTOR);
  await finishValidation(deps, request, validation, { result: "error", matrix: null, message, cost_microusd: null });
  deps.log(`factory validation ${validationId} lost: finished error; slot held for reconciliation`);
  return { kind: "finalized", slot_held: true };
}

async function finishedRecord(deps: LostDeps, validationId: string): Promise<(ValidationEventInput & { seq: number; at: string }) | undefined> {
  return (await deps.records.validationEvents(validationId)).find((event) => event.type === "finished");
}

/**
 * The run's settled cost, or null while it cannot be settled. Once every sandbox of the run is
 * confirmed stopped, a running operation is ended and an ended one settled at the full worst case;
 * each step that another caller (a concurrent call, or the worker) took first is read back instead,
 * so overlapping calls settle once and all see the same cost.
 */
async function settledCost(spend: FactoryLedger["spend"], op: FactoryOperation, allStopped: boolean): Promise<bigint | null> {
  let status = await spend.operationStatus({ operation_id: op.operation_id });
  if (!status.ok) return null;
  if (allStopped && status.state === "running") {
    await spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "terminal", actor_role: ROUTE_ACTOR, terminal_status: "failed" });
    status = await spend.operationStatus({ operation_id: op.operation_id });
    if (!status.ok) return null;
  }
  if (allStopped && status.state === "terminal") {
    const settled = await spend.settle(fullSettlement(op.envelope, op.operation_id));
    if (settled.ok) return settled.settled_microusd;
    status = await spend.operationStatus({ operation_id: op.operation_id });
    if (!status.ok) return null;
  }
  return status.state === "reconciled" ? status.settled_microusd : null;
}

/** The web service's finalizeLost: one routine for a request and for a validation run. */
export async function finalizeLostWorker(deps: LostDeps, target: LostTarget): Promise<LostOutcome> {
  return "request_id" in target ? finalizeRequest(deps, target.request_id) : finalizeValidation(deps, target.validation_id);
}

export type ReconciliationOutcome = { kind: "released" } | { kind: "blocked"; operation_ids: string[] } | { kind: "not_held" } | { kind: "not_found" };

/** Appends attention_cleared under `key` unless it is there already or the budget is overrun (contract section 8.5); whether it appended. */
async function clearAttention(deps: LostDeps, request: FactoryRequestRecord, key: string, events: readonly StoredFactoryEvent[]): Promise<boolean> {
  if (events.some((event) => event.event_key === key)) return false;
  const totals = await deps.ledger.budgets.status(request.budget_key);
  if (totals.ok && totals.available_microusd < 0n) return false;
  const appended = await deps.records.appendEvent(
    request.request_id,
    { event_key: key, type: "attention_cleared", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Reconciliation finished; the factory is available again.", data: { code: "needs_reconciliation" } },
    deps.now(),
  );
  return appended.kind === "appended";
}

/**
 * After an operator reconciled every uncertain operation of a request or validation run: appends
 * budget_updated, releases the slot and clears needs_reconciliation unless the budget is overrun
 * (contract section 8.5). Refuses while any operation or child resource of the root is still open.
 * The budget event comes first and marks the completion as begun, so a call interrupted after the
 * release (a failed write) is finished by the next call instead of answering not_held for good.
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
  const begun = `reconciled:${root}:budget`;
  const cleared = `reconciled:${root}:attention_cleared`;
  const blockers = await rootBlockers(deps, root);
  if (!blockers.held) {
    const events = await deps.records.events(request.request_id);
    if (!events.some((event) => event.event_key === begun)) return { kind: "not_held" };
    return (await clearAttention(deps, request, cleared, events)) ? { kind: "released" } : { kind: "not_held" };
  }
  if (blockers.operation_ids.length > 0 || blockers.children.length > 0) return { kind: "blocked", operation_ids: blockers.operation_ids };
  await appendBudgetUpdate(deps, request, begun, "Reconciled spend settled.");
  const released = await deps.ledger.spend.releaseSlot({ slot_key: profile.slot_key, root_execution_id: root, actor_role: ROUTE_ACTOR, evidence: null, reason: null });
  if (!released.ok) return { kind: "blocked", operation_ids: released.blocking_operation_ids ?? [] };
  await clearAttention(deps, request, cleared, await deps.records.events(request.request_id));
  return { kind: "released" };
}
