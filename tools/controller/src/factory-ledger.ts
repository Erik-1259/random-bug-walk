// The factory's spend ledger operations, built the way judge-web.ts builds the judge controller's:
// the operation identity, the deterministic sandbox name as the provider
// replay key, the reserve request priced from the factory profile, and the settlements. Also the
// shared steps the launch, worker and lost-worker paths take: the budget_updated event, finishing a
// request or a validation run, and the slot's busy reason. Web-safe: no runner, driver or PGlite.
import { toReserveRequest } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import { VALIDATION_RESULT_VALUES } from "@rbw/factory-contract";
import type { CopyState, HostId, RequestOutcome, StopCode, ValidationMatrix, ValidationResult } from "@rbw/factory-contract";
import { callName, canonicalDigest, operationId, providerCallIdentity } from "@rbw/schema";
import type { OperationState, ReserveRequest, Spend, UsageSettlement } from "@rbw/spend";
import { FACTORY_PROFILE, factoryEnvelope } from "./factory-profile.ts";
import type { FactoryEnvelope, FactoryProfile } from "./factory-profile.ts";
import type { FactoryIdentity, FactoryLedger, FactoryRecords, FactoryRequestRecord, FactoryValidationRecord, StoredFactoryEvent, WorkerSandboxSdk } from "./factory-ports.ts";

export const FACTORY_KIND = { worker: "factory.worker", copy: "factory.copy", validation: "factory.validation" } as const;
export const SANDBOX_PROVIDER = "vercel-sandbox";
/** The ledger actor of the web service's calls and of the worker's. */
export const ROUTE_ACTOR = "factory-route";
export const WORKER_ACTOR = "factory-worker";

// Sandbox names: deterministic, and unique per operation, because Vercel keeps a stopped named
// sandbox and refuses a second create on its name.

export function workerSandboxName(root: string): string {
  return `rbw-fw-${root}`;
}

export function validationSandboxName(root: string): string {
  return `rbw-fv-${root}`;
}

export function copySandboxName(executionId: string): string {
  return `rbw-fc-${executionId}`;
}

/** One factory ledger operation: its identity, its sandbox name and its priced reservation. */
export interface FactoryOperation {
  kind: (typeof FACTORY_KIND)[keyof typeof FACTORY_KIND];
  call_name: string;
  operation_id: string;
  payload_hash: string;
  execution_id: string;
  sandbox_name: string;
  envelope: FactoryEnvelope;
  request: ReserveRequest;
}

interface OperationFields {
  identity: Pick<FactoryIdentity, "project_id">;
  profile: FactoryProfile;
  root: string;
  task_revision: string;
  kind: FactoryOperation["kind"];
  call_name: string;
  execution_id: string;
  parent_execution_id: string | null;
  provider: string;
  sandbox_name: string;
  envelope: FactoryEnvelope;
  payload: Record<string, unknown>;
}

/** The operation ID depends on the identity only, so it can be found again without the payload. */
function operation(fields: OperationFields): FactoryOperation {
  const identity = providerCallIdentity({
    project_id: fields.identity.project_id,
    project_policy_sha256: fields.profile.profile_sha256,
    root_execution_id: fields.root,
    batch_id: fields.root,
    task_revision: fields.task_revision,
    kind: fields.kind,
    runtime_profile_sha256: fields.envelope.runtime_profile_sha256,
    attempt_ordinal: 1,
    call_name: fields.call_name,
  });
  const id = operationId(identity).sha256;
  const payload = canonicalDigest({ ...fields.payload, sandbox_name: fields.sandbox_name, envelope: fields.envelope.lines }).sha256;
  const request = toReserveRequest(fields.envelope, {
    operation_id: id,
    payload_hash: payload,
    attempt_ordinal: 1,
    previous_operation_id: null,
    project_id: fields.identity.project_id,
    project_policy_sha256: fields.profile.profile_sha256,
    batch_id: fields.root,
    task_revision: fields.task_revision,
    root_execution_id: fields.root,
    execution_id: fields.execution_id,
    parent_execution_id: fields.parent_execution_id,
    kind: fields.kind,
    call_name: fields.call_name,
    provider: fields.provider,
    provider_replay_key: fields.sandbox_name,
    pool_key: fields.profile.pool_key,
    allocation_key: null,
  });
  return { kind: fields.kind, call_name: fields.call_name, operation_id: id, payload_hash: payload, execution_id: fields.execution_id, sandbox_name: fields.sandbox_name, envelope: fields.envelope, request };
}

export interface OperationContext {
  identity: Pick<FactoryIdentity, "project_id">;
  rates: Rates;
  profile?: FactoryProfile;
}

/**
 * The request worker's operation: its execution is the request root. The payload does not name the
 * worker image, so a start retried after a redeploy with another image replays instead of conflicting.
 */
export function workerOperation(ctx: OperationContext, request: Pick<FactoryRequestRecord, "root" | "interpretation_sha256">): FactoryOperation {
  const profile = ctx.profile ?? FACTORY_PROFILE;
  return operation({
    identity: ctx.identity,
    profile,
    root: request.root,
    task_revision: request.interpretation_sha256,
    kind: FACTORY_KIND.worker,
    call_name: callName(FACTORY_KIND.worker, request.root),
    execution_id: request.root,
    parent_execution_id: null,
    provider: SANDBOX_PROVIDER,
    sandbox_name: workerSandboxName(request.root),
    envelope: factoryEnvelope(ctx.rates, { kind: "worker" }, profile),
    payload: {},
  });
}

/** A validation run's operation: its worker and its copies (as many as its package's protocol declares), reserved together on the request budget. */
export function validationOperation(ctx: OperationContext, validation: Pick<FactoryValidationRecord, "root" | "case_id" | "host_id" | "copies">): FactoryOperation {
  const profile = ctx.profile ?? FACTORY_PROFILE;
  return operation({
    identity: ctx.identity,
    profile,
    root: validation.root,
    task_revision: validation.case_id,
    kind: FACTORY_KIND.validation,
    call_name: callName(FACTORY_KIND.validation, validation.root),
    execution_id: validation.root,
    parent_execution_id: null,
    provider: SANDBOX_PROVIDER,
    sandbox_name: validationSandboxName(validation.root),
    envelope: factoryEnvelope(ctx.rates, { kind: "validation", host: validation.host_id, copies: validation.copies }, profile),
    payload: { host_id: validation.host_id, copies: validation.copies },
  });
}

export interface CopyIdentity {
  /** Whose copy: a request candidate's (under the request root) or a validation run's (under the validation root). */
  kind: "request" | "validation";
  root: string;
  task_revision: string;
  /** The candidate_id, or the case_id of a validation run. */
  subject: string;
  state: CopyState;
  /** 1-based, per subject and state, in the order the copies run. */
  n: number;
  host: HostId;
  provider: string;
}

/** What a copy's operation needs of the identity module: the project ID and the copy's execution ID. */
export interface CopyOperationContext extends OperationContext {
  identity: Pick<FactoryIdentity, "project_id" | "copyExecutionId">;
}

/** A copy's execution ID, from the identity module; its parent is the root. */
export function copyExecution(identity: Pick<FactoryIdentity, "copyExecutionId">, copy: Pick<CopyIdentity, "kind" | "root" | "subject" | "state" | "n">): string {
  return identity.copyExecutionId({ kind: copy.kind, root: copy.root, subject_id: copy.subject, state: copy.state, n: copy.n });
}

export function copyOperation(ctx: CopyOperationContext, copy: CopyIdentity): FactoryOperation {
  const profile = ctx.profile ?? FACTORY_PROFILE;
  const execution = copyExecution(ctx.identity, copy);
  return operation({
    identity: ctx.identity,
    profile,
    root: copy.root,
    task_revision: copy.task_revision,
    kind: FACTORY_KIND.copy,
    call_name: callName(FACTORY_KIND.copy, copy.subject, `${copy.state}-${String(copy.n)}`),
    execution_id: execution,
    parent_execution_id: copy.root,
    provider: copy.provider,
    sandbox_name: copySandboxName(execution),
    envelope: factoryEnvelope(ctx.rates, { kind: "copy", host: copy.host }, profile),
    payload: { subject: copy.subject, state: copy.state, n: copy.n, host: copy.host },
  });
}

// Settlements ---------------------------------------------------------------------------------

function lineCost(quantity: bigint, price: { microusd: number; per_units: number }): number {
  return Number((quantity * BigInt(price.microusd) + BigInt(price.per_units) - 1n) / BigInt(price.per_units));
}

function settlement(envelope: FactoryEnvelope, operationId: string, quantities: Record<string, bigint>, evidence: { key: string; sha256: string } | null): UsageSettlement {
  return {
    schema_version: 1,
    operation_id: operationId,
    runtime_profile_sha256: envelope.runtime_profile_sha256,
    rate_sheet_sha256: envelope.rate_sheet_sha256,
    reserved_microusd: Number(envelope.reserved_microusd),
    service_lines: envelope.lines.map((line) => {
      if (line.price === null) throw new Error("a checked price is missing");
      const quantity = quantities[line.unit] ?? 0n;
      return { service: line.service, unit: line.unit, actual_quantity: Number(quantity), actual_microusd: lineCost(quantity, line.price), retained_microusd: 0 };
    }),
    usage_state: "known",
    terminal_evidence_key: evidence?.key ?? null,
    terminal_evidence_sha256: evidence?.sha256 ?? null,
  };
}

/** Every line at its whole limit: a worker cannot measure its own sandbox's end, and a lost validation whose sandboxes were confirmed stopped settles its worst case. */
export function fullSettlement(envelope: FactoryEnvelope, operationId: string): UsageSettlement {
  return settlement(envelope, operationId, Object.fromEntries(envelope.lines.map((line) => [line.unit, BigInt(line.limit)])), null);
}

/** What one sandbox used: whether it was created, and how long it lived (create call to confirmed stop). */
export interface SandboxUsage {
  launched: boolean;
  lifetime_ms: number;
  /** The vCPUs a copy sandbox was created with; absent, its host's whole copy size is settled. */
  vcpus?: number;
}

function measured(size: { vcpus: number; memory_gb: number }, usage: SandboxUsage): Record<string, bigint> {
  const seconds = usage.launched ? BigInt(Math.ceil(Math.max(0, usage.lifetime_ms) / 1000)) : 0n;
  return { vcpu_second: BigInt(size.vcpus) * seconds, memory_gb_second: BigInt(size.memory_gb) * seconds, creation: usage.launched ? 1n : 0n };
}

function addQuantities(a: Record<string, bigint>, b: Record<string, bigint>): Record<string, bigint> {
  const out: Record<string, bigint> = { ...a };
  for (const [unit, value] of Object.entries(b)) out[unit] = (out[unit] ?? 0n) + value;
  return out;
}

/** A copy's settlement from its measured lifetime, at its host's copy size. */
export function copySettlementFor(envelope: FactoryEnvelope, operationId: string, host: HostId, usage: SandboxUsage, evidence: { key: string; sha256: string } | null, profile: FactoryProfile = FACTORY_PROFILE): UsageSettlement {
  return settlement(envelope, operationId, measured(copySize(host, usage, profile), usage), evidence);
}

/** A copy sandbox's size: the vCPUs it was created with (2 GB of memory each), or its host's whole copy size when unknown. */
function copySize(host: HostId, usage: SandboxUsage, profile: FactoryProfile): { vcpus: number; memory_gb: number } {
  const limits = profile.copy[host];
  if (usage.vcpus !== undefined && Number.isSafeInteger(usage.vcpus) && usage.vcpus > 0 && usage.vcpus <= limits.vcpus) return { vcpus: usage.vcpus, memory_gb: Math.min(2 * usage.vcpus, limits.memory_mb / 1024) };
  return { vcpus: limits.vcpus, memory_gb: limits.memory_mb / 1024 };
}

/**
 * A validation run's settlement: its worker at the whole window (it cannot measure its own end) and
 * each copy it created at its measured lifetime.
 */
export function validationSettlement(envelope: FactoryEnvelope, operationId: string, host: HostId, copies: readonly SandboxUsage[], profile: FactoryProfile = FACTORY_PROFILE): UsageSettlement {
  const worker = profile.validation.worker;
  let quantities = measured(worker, { launched: true, lifetime_ms: (worker.timeout_s + profile.shutdown_seconds) * 1000 });
  for (const copy of copies) quantities = addQuantities(quantities, measured(copySize(host, copy, profile), copy));
  return settlement(envelope, operationId, quantities, null);
}

/** A launch that never created anything settles at zero. */
export function zeroSettlement(envelope: FactoryEnvelope, operationId: string): UsageSettlement {
  return settlement(envelope, operationId, {}, null);
}

// Shared steps ---------------------------------------------------------------------------------

export function usd(microusd: number | bigint): string {
  const value = typeof microusd === "bigint" ? Number(microusd) : microusd;
  return `$${(value / 1_000_000).toFixed(2)}`;
}

export interface StepDeps {
  ledger: FactoryLedger;
  records: FactoryRecords;
  now: () => Date;
  log: (line: string) => void;
}

/** Appends budget_updated with the budget's current totals, under the given event key. */
export async function appendBudgetUpdate(deps: StepDeps, request: Pick<FactoryRequestRecord, "request_id" | "budget_key">, eventKey: string, message: string): Promise<void> {
  const status = await deps.ledger.budgets.status(request.budget_key);
  if (!status.ok) throw new Error(`the budget status was refused (${status.code})`);
  await deps.records.appendEvent(
    request.request_id,
    {
      event_key: eventKey,
      type: "budget_updated",
      host_id: null,
      candidate_id: null,
      item_key: null,
      case_id: null,
      message,
      data: { reserved_microusd: Number(status.open_microusd), spent_microusd: Number(status.settled_microusd), remaining_microusd: Number(status.available_microusd) },
    },
    deps.now(),
  );
}

/**
 * The keys of the request events this code appends with its own content: worker_started, the start
 * reservation's budget_updated, and the finish of a start whose worker never ran (a refused
 * reservation, a refused create or an uncertain launch), for which the factory core's loop never
 * runs. The lost-worker finish and every other request event take the core's keys and content
 * (FactoryEventBuilders), so there is one key table.
 */
export const EVENT_KEYS = {
  workerStarted: "worker_started",
  workerReserved: "worker:reserved",
  workerReleased: "worker:settled",
  launchAttention: "attention:needs_reconciliation",
  launchFinish: "finish",
} as const;

const FINISH_MESSAGES: Record<RequestOutcome, string> = {
  fulfilled: "Request finished: fulfilled.",
  stopped_at_limit: "Request finished: stopped at a limit.",
  sources_exhausted: "Request finished: sources exhausted.",
  cancelled: "Request finished: cancelled.",
  operational_error: "Request finished: operational error.",
};

/** The outcome each stop code belongs to (contract section 8.1). */
export function outcomeOf(stop: StopCode): RequestOutcome {
  switch (stop) {
    case "fulfilled":
      return "fulfilled";
    case "budget_exhausted":
    case "time_limit":
    case "candidate_limit":
      return "stopped_at_limit";
    case "sources_exhausted":
      return "sources_exhausted";
    case "cancelled_by_user":
      return "cancelled";
    case "worker_lost":
    case "needs_reconciliation":
    case "operational_error":
      return "operational_error";
  }
}

export async function appendNeedsReconciliation(deps: StepDeps, requestId: string, message: string, key: string): Promise<void> {
  await deps.records.appendEvent(requestId, { event_key: key, type: "attention", host_id: null, candidate_id: null, item_key: null, case_id: null, message, data: { code: "needs_reconciliation" } }, deps.now());
}

/** Whether the request's attention is needs_reconciliation now: its last attention change raised that code. */
export function needsReconciliationRaised(events: readonly StoredFactoryEvent[]): boolean {
  let current: unknown = null;
  for (const event of events) {
    if (event.type === "attention") current = event.data.code;
    else if (event.type === "attention_cleared" && event.data.code === current) current = null;
  }
  return current === "needs_reconciliation";
}

/**
 * Finishes a request whose worker never ran: attention first when its spend needs reconciliation,
 * then request_finished, then the budget closed with the stop code. Returns false when another
 * writer already finished the request with other content. A refused close (the budget is already
 * closed with another cause) is logged: the finish stands, so the caller still releases the slot.
 */
export async function finishLaunch(deps: StepDeps, request: Pick<FactoryRequestRecord, "request_id" | "budget_key">, stop: StopCode, options: { attention: string | null }): Promise<boolean> {
  if (options.attention !== null) await appendNeedsReconciliation(deps, request.request_id, options.attention, EVENT_KEYS.launchAttention);
  const outcome = outcomeOf(stop);
  const finished = await deps.records.appendEvent(
    request.request_id,
    { event_key: EVENT_KEYS.launchFinish, type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: FINISH_MESSAGES[outcome], data: { outcome, stop_code: stop } },
    deps.now(),
  );
  if (finished.kind === "conflict" || finished.kind === "refused") return false;
  const closed = await deps.ledger.budgets.close(request.budget_key, stop);
  if (!closed.ok) deps.log(`factory ${request.request_id} the budget close was refused (${closed.code}); the finish stands`);
  return true;
}

export function finishedEvent(events: readonly StoredFactoryEvent[]): StoredFactoryEvent | null {
  return events.find((event) => event.type === "request_finished") ?? null;
}

/** The request's attention when a validation run's spend needs reconciliation, keyed by the run. */
export const VALIDATION_ATTENTION = "A validation run's sandbox outcome is uncertain; its spend needs reconciliation.";

export function validationAttentionKey(validationId: string): string {
  return `validation:${validationId}:attention`;
}

const RESULT_MESSAGES: Record<ValidationResult, string> = {
  passed: "Validation run finished: passed.",
  failed: "Validation run finished: failed.",
  error: "Validation run finished: error.",
};

/**
 * The matrix a run that finished `error` may carry (contract section 11, revision 2's ValidationRun
 * rule): none, or one with a cell that observed error or incomplete. A complete pass and fail
 * matrix, such as a passed harness's whose settlement then failed, is dropped.
 */
function errorMatrix(matrix: ValidationMatrix | null): ValidationMatrix | null {
  if (matrix === null) return null;
  const cells = [matrix.original_suite, matrix.verification].flatMap((set) => [set.clean, set.buggy, set.fixed]);
  return cells.some((cell) => cell.observed === "error" || cell.observed === "incomplete") ? matrix : null;
}

/**
 * A validation run's finish as recorded: its result and settled cost (null while its spend needs
 * reconciliation), and whether this call's finish is the one recorded or another writer's came first.
 */
export interface ValidationFinish {
  result: ValidationResult;
  cost_microusd: number | null;
  ours: boolean;
}

/**
 * Finishes a validation run: its finished record, then, from the finish that record holds (this
 * call's, or the one another writer, such as the worker or an overlapping lost-worker call, recorded
 * first), the request's attention when its spend is uncertain (no settled cost), validation_finished
 * and budget_updated, so the request's history always says what the run's record says. Every append
 * is keyed by the validation ID. Rejects when the finish is refused or no recorded finish can be read.
 */
export async function finishValidation(
  deps: StepDeps,
  request: Pick<FactoryRequestRecord, "request_id" | "budget_key">,
  validation: Pick<FactoryValidationRecord, "validation_id" | "case_id" | "host_id">,
  result: { result: ValidationResult; matrix: ValidationMatrix | null; message: string | null; cost_microusd: number | null },
): Promise<ValidationFinish> {
  const id = validation.validation_id;
  const matrix = result.result === "error" ? errorMatrix(result.matrix) : result.matrix;
  const appended = await deps.records.appendValidationEvent(
    id,
    { event_key: "finished", type: "finished", data: { result: result.result, matrix, message: result.message, cost_microusd: result.cost_microusd, finished_at: deps.now().toISOString() } },
    deps.now(),
  );
  if (appended.kind === "refused") throw new Error(`the validation run's finish was refused (${appended.reason})`);
  let finish: ValidationFinish = { result: result.result, cost_microusd: result.cost_microusd, ours: true };
  if (appended.kind === "conflict") {
    const recorded = (await deps.records.validationEvents(id)).find((event) => event.type === "finished");
    const recordedResult = VALIDATION_RESULT_VALUES.find((value) => value === recorded?.data.result);
    const cost = recorded?.data.cost_microusd;
    if (recordedResult === undefined || (cost !== null && typeof cost !== "number")) throw new Error("the validation run's finish conflicts with a record that cannot be read");
    finish = { result: recordedResult, cost_microusd: cost, ours: false };
  }
  const uncertain = finish.cost_microusd === null;
  if (uncertain) await appendNeedsReconciliation(deps, request.request_id, VALIDATION_ATTENTION, validationAttentionKey(id));
  await deps.records.appendEvent(
    request.request_id,
    { event_key: `validation:${id}:finished`, type: "validation_finished", host_id: validation.host_id, candidate_id: null, item_key: null, case_id: validation.case_id, message: RESULT_MESSAGES[finish.result], data: { validation_id: id, result: finish.result } },
    deps.now(),
  );
  await appendBudgetUpdate(deps, request, `validation:${id}:settled`, uncertain ? "A validation run's reservation stays held until reconciliation." : `A validation run settled at ${usd(finish.cost_microusd ?? 0)}.`);
  return finish;
}

/** Sandbox statuses that mean it no longer runs. */
export const STOPPED_STATUSES: ReadonlySet<string> = new Set(["stopped", "failed", "aborted"]);

/** Stops a sandbox by name on a best-effort basis: a failure is logged, never thrown. */
export async function stopQuietly(sandbox: WorkerSandboxSdk, name: string, log: (line: string) => void): Promise<void> {
  try {
    const found = await sandbox.get(name);
    if (found !== null && !STOPPED_STATUSES.has(found.status)) await found.stop();
  } catch (error) {
    log(`factory: the best-effort stop of ${name} failed (${error instanceof Error ? error.name : "non-error"})`);
  }
}

/**
 * Whether a root's request or validation run has finished, and whether it left its spend for
 * reconciliation: the request's attention is needs_reconciliation, or the run finished with no cost.
 */
export async function rootFinish(records: Pick<FactoryRecords, "rootOwner" | "events" | "validationEvents">, root: string): Promise<{ finished: boolean; reconciliation: boolean }> {
  const owner = await records.rootOwner(root);
  if (owner === null) return { finished: false, reconciliation: false };
  if (owner.validation_id !== null) {
    const finished = (await records.validationEvents(owner.validation_id)).find((event) => event.type === "finished");
    return { finished: finished !== undefined, reconciliation: finished?.data.cost_microusd === null };
  }
  const events = await records.events(owner.request_id);
  return { finished: finishedEvent(events) !== null, reconciliation: needsReconciliationRaised(events) };
}

/**
 * Why the factory slot is busy (contract section 8.5). needs_reconciliation, which a client must not
 * retry, when the holder's root has an uncertain operation, or when its request or validation run
 * has finished while the slot is still held and either something of the root is still open (an
 * operation not settled, such as a reservation whose launch was refused while prepared, or an
 * unconfirmed sandbox) or its spend was left for reconciliation. Otherwise active: the holder
 * runs, or it finished cleanly and its worker, or the lost-worker routine, is about to release it.
 */
export async function busyReason(deps: { spend: Spend; records: Pick<FactoryRecords, "rootOwner" | "events" | "validationEvents"> }, slotKey: string): Promise<"active" | "needs_reconciliation"> {
  const slot = await deps.spend.slotStatus({ slot_key: slotKey });
  if (!slot.ok || slot.holder === null) return "active";
  const blockers = slot.release_blockers;
  for (const id of blockers.operation_ids) {
    const status = await deps.spend.operationStatus({ operation_id: id });
    if (status.ok && status.state === "uncertain") return "needs_reconciliation";
  }
  const owner = await rootFinish(deps.records, slot.holder);
  if (!owner.finished) return "active";
  return owner.reconciliation || blockers.operation_ids.length > 0 || blockers.child_resources.length > 0 ? "needs_reconciliation" : "active";
}

/** Moves an operation to uncertain from launching or running; any other state is left as it is. Returns its state afterwards. */
export async function makeUncertain(spend: Spend, operationId: string, actor: string): Promise<OperationState | null> {
  const status = await spend.operationStatus({ operation_id: operationId });
  if (!status.ok) return null;
  if (status.state !== "launching" && status.state !== "running") return status.state;
  const moved = await spend.transition({ operation_id: operationId, from_state: status.state, to_state: "uncertain", actor_role: actor, uncertainty: status.state === "launching" ? "lost_response" : "unknown_status" });
  if (moved.ok) return "uncertain";
  return moved.code === "invalid_transition" ? (moved.current_state ?? null) : status.state;
}
