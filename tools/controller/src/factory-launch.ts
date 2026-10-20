// The web service's two launches, as the judge route launches its controller.
// startFactoryWorker runs after the service took the slot, created the budget and
// recorded the request: it reserves the worker's worst case on the request budget, then creates
// one worker sandbox (pinned image, deterministic name, credentials as create-time environment
// values) and starts the worker command detached. startFactoryValidation runs synchronously in
// the validation POST: slot, then reservation (any refusal records nothing), then the record,
// the request's events and the launch.
//
// Nothing is retried. Only a create the provider refused before anything existed (a 4xx answer,
// other than a timeout, conflict or rate limit, and a by-name lookup that finds nothing) is a
// definite failure: settled at zero, finished, slot released. Every other create or start failure
// is uncertain: the operation goes to uncertain, the request or run finishes with
// needs_reconciliation, the sandbox is stopped on a best-effort basis and the slot stays held.
// Web-safe: no runner, driver or PGlite.
import type { Rates } from "@rbw/envelope";
import type { BusyReason, HarnessIdentity, HostId, PackageHashes, ValidationRun } from "@rbw/factory-contract";
import { utcSeconds } from "@rbw/local-runner/shared";
import {
  EVENT_KEYS,
  ROUTE_ACTOR,
  appendBudgetUpdate,
  busyReason,
  finishLaunch,
  finishValidation,
  finishedEvent,
  stopQuietly,
  usd,
  validationOperation,
  workerOperation,
  zeroSettlement,
} from "./factory-ledger.ts";
import type { FactoryOperation } from "./factory-ledger.ts";
import { FACTORY_PROFILE } from "./factory-profile.ts";
import type { FactoryProfile } from "./factory-profile.ts";
import type { FactoryIdentity, FactoryLedger, FactoryRecords, FactoryRequestRecord, FactoryValidationRecord, WorkerSandboxInstance, WorkerSandboxSdk } from "./factory-ports.ts";

/** How the worker is launched: the image from RBW_FACTORY_WORKER_IMAGE and the credentials it reads. */
export interface WorkerLaunchConfig {
  /** The worker image in VCR pinned by digest: `<repository>@sha256:<64 hex>`. */
  image: string;
  /** DATABASE_URL, VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID, passed as create-time environment values. */
  env: Record<string, string>;
}

export interface FactoryLaunchDeps {
  ledger: FactoryLedger;
  records: FactoryRecords;
  identity: FactoryIdentity;
  sandbox: WorkerSandboxSdk;
  rates: Rates;
  now: () => Date;
  launch: WorkerLaunchConfig;
  log: (line: string) => void;
  profile?: FactoryProfile;
}

/** Where the worker image holds this repository (kit/factory-worker/Dockerfile). */
export const WORKER_REPOSITORY = "/opt/rbw/repo";
const NODE = "/usr/local/bin/node";
/** The image's PATH, which the sandbox does not apply by itself. */
const BASE_ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" };
const PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export class LaunchConfigError extends Error {
  override name = "LaunchConfigError";
}

function checkImage(image: string): void {
  if (!PINNED.test(image)) throw new LaunchConfigError("the factory worker image must be pinned by digest (<repository>@sha256:<digest>)");
}

/** The worker command a sandbox runs, detached: request mode with the worker's deadline, or validation mode (its deadline is in its record). */
export function workerCommandArgs(target: { request_id: string; deadline_at: Date } | { validation_id: string }): string[] {
  const mode = "request_id" in target ? ["--request-id", target.request_id, "--deadline-at", utcSeconds(target.deadline_at.getTime())] : ["--validation-id", target.validation_id];
  return [`${WORKER_REPOSITORY}/tools/controller/src/cli.ts`, "factory-worker", ...mode];
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  if ("response" in error && typeof error.response === "object" && error.response !== null && "status" in error.response && typeof error.response.status === "number") return error.response.status;
  if ("status" in error && typeof error.status === "number") return error.status;
  return null;
}

/** 4xx answers that do not show the provider refused before creating anything. */
const NOT_DEFINITE = new Set([408, 409, 425, 429]);

type Launched = { kind: "launched"; sandbox: string } | { kind: "definite_failure"; detail: string } | { kind: "uncertain"; detail: string };

/**
 * prepared → launching → create → running → the detached command. The operation must be prepared.
 * Returns what happened; every ledger step of a failure is taken here.
 */
async function launchSandbox(deps: FactoryLaunchDeps, op: FactoryOperation, size: { vcpus: number; timeout_s: number }, args: string[]): Promise<Launched | { kind: "replay" }> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const { spend } = deps.ledger;
  const launching = await spend.transition({ operation_id: op.operation_id, from_state: "prepared", to_state: "launching", actor_role: ROUTE_ACTOR, slot_key: profile.slot_key });
  if (!launching.ok) {
    // Another call moved it first: that call launches. Any other refusal leaves it prepared for reconciliation.
    if (launching.code === "invalid_transition") return { kind: "replay" };
    return { kind: "uncertain", detail: `the launch was refused (${launching.code})` };
  }
  let instance: WorkerSandboxInstance;
  try {
    instance = await deps.sandbox.create({
      image: deps.launch.image,
      name: op.sandbox_name,
      persistent: false,
      networkPolicy: "allow-all",
      resources: { vcpus: size.vcpus },
      timeout: size.timeout_s * 1000,
      env: { ...BASE_ENV, ...deps.launch.env },
    });
  } catch (error) {
    const status = httpStatus(error);
    let found: WorkerSandboxInstance | null | undefined;
    try {
      found = await deps.sandbox.get(op.sandbox_name);
    } catch (lookup) {
      deps.log(`factory: the lookup of ${op.sandbox_name} failed (${lookup instanceof Error ? lookup.name : "non-error"})`);
      found = undefined;
    }
    const definite = status !== null && status >= 400 && status < 500 && !NOT_DEFINITE.has(status) && found === null;
    if (definite) {
      const ended = await spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "terminal", actor_role: ROUTE_ACTOR, terminal_status: "failed" });
      const settled = ended.ok ? await spend.settle(zeroSettlement(op.envelope, op.operation_id)) : ended;
      if (settled.ok) return { kind: "definite_failure", detail: `the create was refused (${String(status)})` };
      return { kind: "uncertain", detail: `the create was refused (${String(status)}) but the ledger refused its end (${settled.code})` };
    }
    await spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "uncertain", actor_role: ROUTE_ACTOR, uncertainty: "lost_response" });
    if (found !== null && found !== undefined) await stopQuietly(deps.sandbox, op.sandbox_name, deps.log);
    return { kind: "uncertain", detail: `the create failed (${status === null ? (error instanceof Error ? error.name : "non-error") : String(status)})` };
  }
  const running = await spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "running", actor_role: ROUTE_ACTOR, provider_resource_id: instance.name });
  if (!running.ok) {
    await spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "uncertain", actor_role: ROUTE_ACTOR, uncertainty: "unknown_status" });
    await stopQuietly(deps.sandbox, instance.name, deps.log);
    return { kind: "uncertain", detail: `the running transition was refused (${running.code})` };
  }
  try {
    await instance.runCommand({ cmd: NODE, args, cwd: WORKER_REPOSITORY, detached: true });
  } catch (error) {
    await spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "uncertain", actor_role: ROUTE_ACTOR, uncertainty: "unknown_status" });
    await stopQuietly(deps.sandbox, instance.name, deps.log);
    return { kind: "uncertain", detail: `the worker command could not be started (${error instanceof Error ? error.name : "non-error"})` };
  }
  return { kind: "launched", sandbox: instance.name };
}

// The request worker ----------------------------------------------------------------------------

export type WorkerStart = { kind: "launched"; sandbox: string } | { kind: "replay" } | { kind: "refused"; code: string } | { kind: "create_failed" } | { kind: "uncertain"; detail: string };

async function releaseSlot(deps: FactoryLaunchDeps, root: string): Promise<boolean> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const released = await deps.ledger.spend.releaseSlot({ slot_key: profile.slot_key, root_execution_id: root, actor_role: ROUTE_ACTOR, evidence: null, reason: null });
  if (!released.ok) deps.log(`factory: the slot of ${root} was not released (${released.code})`);
  return released.ok;
}

/**
 * Reserves the worker and launches it once per request. A duplicate or concurrent start finds the
 * operation already reserved (replay) and launches nothing; only one caller can move a prepared
 * operation to launching, so a start retried after an earlier one stopped between its reservation
 * and its launch launches it. The request must be recorded first.
 */
export async function startFactoryWorker(deps: FactoryLaunchDeps, requestId: string): Promise<WorkerStart> {
  checkImage(deps.launch.image);
  const profile = deps.profile ?? FACTORY_PROFILE;
  const record = await deps.records.request(requestId);
  if (record === null) throw new LaunchConfigError("the request is not recorded");
  // A finished request never gets a worker, whatever its operation's state.
  if (finishedEvent(await deps.records.events(requestId)) !== null) return { kind: "replay" };
  const op = workerOperation({ identity: deps.identity, rates: deps.rates, profile }, record);
  const reserved = await deps.ledger.budgets.reserve(record.budget_key, "request", op.request);
  if (!reserved.ok) {
    // An operation with this identity exists: an earlier start of this request reserved it. Never finish the request over it.
    if (reserved.code === "operation_conflict") return { kind: "replay" };
    await finishLaunch(deps, record, "operational_error", { attention: null });
    await releaseSlot(deps, record.root);
    deps.log(`factory ${requestId} worker reservation refused ${reserved.code}; finished and released`);
    return { kind: "refused", code: reserved.code };
  }
  if (reserved.replay && reserved.state !== "prepared") return { kind: "replay" };
  await appendBudgetUpdate(deps, record, EVENT_KEYS.workerReserved, `Reserved ${usd(reserved.reserved_microusd)} for the worker's worst case.`);
  const deadline = new Date(deps.now().getTime() + profile.worker.timeout_s * 1000);
  const launched = await launchSandbox(deps, op, profile.worker, workerCommandArgs({ request_id: requestId, deadline_at: deadline }));
  return finishWorkerLaunch(deps, record, launched);
}

async function finishWorkerLaunch(deps: FactoryLaunchDeps, record: FactoryRequestRecord, launched: Launched | { kind: "replay" }): Promise<WorkerStart> {
  switch (launched.kind) {
    case "launched":
    case "replay":
      return launched;
    case "definite_failure":
      await appendBudgetUpdate(deps, record, EVENT_KEYS.workerReleased, "The worker never started; its reservation was released.");
      await finishLaunch(deps, record, "operational_error", { attention: null });
      await releaseSlot(deps, record.root);
      deps.log(`factory ${record.request_id} worker create refused: ${launched.detail}; finished and released`);
      return { kind: "create_failed" };
    case "uncertain":
      await finishLaunch(deps, record, "needs_reconciliation", { attention: "The worker's launch outcome is uncertain; its spend needs reconciliation." });
      deps.log(`factory ${record.request_id} worker launch uncertain: ${launched.detail}; slot held`);
      return { kind: "uncertain", detail: launched.detail };
  }
}

// Validation runs -------------------------------------------------------------------------------

export interface ValidationStartArgs {
  request_id: string;
  case_id: string;
  validation_id: string;
  host_id: HostId;
  /** The case's two downloadable parts. */
  package_sha256: PackageHashes;
  harness: HarnessIdentity;
}

export type ValidationStart = { kind: "accepted"; run: ValidationRun } | { kind: "busy"; reason: BusyReason } | { kind: "budget_unavailable" } | { kind: "unavailable"; message: string };

/** The poll interval a client is told while a run is queued or running. */
export const VALIDATION_POLL_MS = 5000;

function runView(args: ValidationStartArgs, finished: { at: Date; message: string; cost_microusd: number | null } | null): ValidationRun {
  return {
    contract_version: "bug-request/1",
    validation_id: args.validation_id,
    case_id: args.case_id,
    state: finished === null ? "queued" : "finished",
    result: finished === null ? null : "error",
    matrix: null,
    package_sha256: args.package_sha256,
    harness: args.harness,
    message: finished?.message ?? null,
    started_at: null,
    finished_at: finished === null ? null : finished.at.toISOString(),
    cost_microusd: finished?.cost_microusd ?? null,
    poll_after_ms: finished === null ? VALIDATION_POLL_MS : 0,
  };
}

const BUDGET_CODES = new Set(["budget_exhausted", "budget_closed", "insufficient_funds"]);

/**
 * Starts a validation run in the POST (contract section 11): the factory
 * slot under the validation root, then the host's validation worst case reserved on the request
 * budget with the validation role. Busy or a refused reservation records nothing (the slot taken
 * here is released). Then the run is recorded, validation_started and budget_updated are appended,
 * and its worker is launched.
 */
export async function startFactoryValidation(deps: FactoryLaunchDeps, args: ValidationStartArgs): Promise<ValidationStart> {
  checkImage(deps.launch.image);
  const profile = deps.profile ?? FACTORY_PROFILE;
  const { spend, budgets } = deps.ledger;
  const request = await deps.records.request(args.request_id);
  if (request === null) return { kind: "unavailable", message: "The request is not recorded." };
  const root = deps.identity.validationRoot(args.validation_id);
  const existing = await deps.records.validation(args.validation_id);
  if (existing !== null) {
    if (existing.request_id === args.request_id && existing.case_id === args.case_id) return { kind: "accepted", run: runView(args, null) };
    return { kind: "unavailable", message: "The validation ID is already used." };
  }

  const slot = await spend.acquireSlot({ slot_key: profile.slot_key, root_execution_id: root, actor_role: ROUTE_ACTOR });
  if (!slot.ok) {
    if (slot.code === "slot_held") return { kind: "busy", reason: await busyReason({ spend, records: deps.records }, profile.slot_key) };
    return { kind: "unavailable", message: `The factory slot could not be taken (${slot.code}).` };
  }
  const record: FactoryValidationRecord = {
    validation_id: args.validation_id,
    request_id: args.request_id,
    case_id: args.case_id,
    host_id: args.host_id,
    root,
    accepted_at: deps.now().toISOString(),
    package_sha256: args.package_sha256,
  };
  const op = validationOperation({ identity: deps.identity, rates: deps.rates, profile }, record);
  let reserved: Awaited<ReturnType<typeof budgets.reserve>>;
  try {
    reserved = await budgets.reserve(request.budget_key, "validation", op.request);
  } catch (error) {
    // The reservation's outcome is unknown. The ledger refuses the release while an operation of this root exists.
    await releaseSlot(deps, root);
    throw error;
  }
  if (!reserved.ok) {
    await releaseSlot(deps, root);
    if (BUDGET_CODES.has(reserved.code)) return { kind: "budget_unavailable" };
    return { kind: "unavailable", message: reserved.code === "pool_halted" ? "The spend ledger is halted." : `The reservation was refused (${reserved.code}).` };
  }
  if (reserved.replay && reserved.state !== "prepared") return { kind: "unavailable", message: "An earlier start of this validation needs reconciliation." };

  const recorded = await deps.records.recordValidation(record);
  if (recorded === "conflict") throw new LaunchConfigError("the validation record conflicts with an existing one");
  await deps.records.appendEvent(
    args.request_id,
    { event_key: `validation:${args.validation_id}:started`, type: "validation_started", host_id: args.host_id, candidate_id: null, item_key: null, case_id: args.case_id, message: "Validation run started.", data: { validation_id: args.validation_id } },
    deps.now(),
  );
  await appendBudgetUpdate(deps, request, `validation:${args.validation_id}:reserved`, `Reserved ${usd(reserved.reserved_microusd)} for a validation run's worst case.`);

  const launched = await launchSandbox(deps, op, profile.validation.worker, workerCommandArgs({ validation_id: args.validation_id }));
  if (launched.kind === "launched" || launched.kind === "replay") return { kind: "accepted", run: runView(args, null) };
  if (launched.kind === "definite_failure") {
    const text = "The validation run could not be started.";
    await finishValidation(deps, request, record, { result: "error", matrix: null, message: text, cost_microusd: 0, uncertain: false });
    await releaseSlot(deps, root);
    return { kind: "accepted", run: runView(args, { at: deps.now(), message: text, cost_microusd: 0 }) };
  }
  const text = "The validation run's launch outcome is uncertain; its spend needs reconciliation.";
  await finishValidation(deps, request, record, { result: "error", matrix: null, message: text, cost_microusd: null, uncertain: true });
  deps.log(`factory validation ${args.validation_id} launch uncertain: ${launched.detail}; slot held`);
  return { kind: "accepted", run: runView(args, { at: deps.now(), message: text, cost_microusd: null }) };
}
