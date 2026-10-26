// The web service's two launches, as the judge route launches its controller.
// startFactoryWorker runs after the service took the slot, created the budget and
// recorded the request: it reserves the worker's worst case on the request budget, then creates
// one worker sandbox (pinned image, deterministic name, credentials as create-time environment
// values) and starts the worker command detached, under the run-once guard. startFactoryValidation runs synchronously in
// the validation POST: slot, then reservation (any refusal records nothing), then the record,
// the request's events and the launch.
//
// Nothing is retried. Only a create the provider refused before anything existed (a 4xx answer,
// other than a timeout, conflict or rate limit, and a by-name lookup that finds nothing) is a
// definite failure: settled at zero, finished, slot released. Every other create or start failure
// is uncertain: the operation goes to uncertain, the request or run finishes with
// needs_reconciliation, the sandbox is stopped on a best-effort basis and the slot stays held.
//
// A start repeated with the same ID (contract section 7 answers a repeated request start with the
// same body; section 11 has the client send the same validation ID again after a timeout) resumes
// an earlier one that ended part-way from what that start recorded: the
// request's or run's finish, the operation's state, whether the worker began (its first heartbeat
// or its own first event) and what the provider holds under the deterministic sandbox name. A
// prepared operation is launched. A launching one whose create left nothing by that name is created
// under the same name (the name is the provider's replay key: it refuses a second sandbox on it),
// and a sandbox found under the name (also after any start's create was refused on the name: the
// name is the operation's own) is adopted while it runs. A running one whose worker has not
// begun gets the worker command again, under the run-once guard. A sandbox that stopped before its
// worker began, and an operation already uncertain, end the start uncertain: an uncertain operation
// is never launched again. A refused create's end, its zero settlement, its finish and its release
// are completed. Once the worker began, the worker and the routines after it own the operation. A
// recorded finish of the request or run, whoever recorded it (the start, the worker or the
// lost-worker routine), has the writes that follow it completed (completeRequestFinish,
// completeValidationFinish), as the lost-worker routine completes them too. The
// service runs starts of one ID one at a time; starts that overlap anyway still create one sandbox
// and run one worker, and a start that loses a ledger step to another answers replay.
// Web-safe: no runner, driver or PGlite.
import type { Rates } from "@rbw/envelope";
import { VALIDATION_RESULT_VALUES } from "@rbw/factory-contract";
import type { BusyReason, HarnessIdentity, HostId, PackageHashes, Protocol, ValidationMatrix, ValidationRun } from "@rbw/factory-contract";
import { utcSeconds } from "@rbw/local-runner/shared";
import type { OperationState } from "@rbw/spend";
import {
  EVENT_KEYS,
  ROUTE_ACTOR,
  STOPPED_STATUSES,
  appendBudgetUpdate,
  busyReason,
  completeRequestFinish,
  completeValidationFinish,
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
import type {
  FactoryIdentity,
  FactoryLedger,
  FactoryRecords,
  FactoryRequestRecord,
  FactoryValidationRecord,
  ValidationEventInput,
  WorkerSandboxInstance,
  WorkerSandboxSdk,
} from "./factory-ports.ts";
import { runOnceCommand } from "./factory-run-once.ts";

/** The configuration value that names the pinned worker image: `<vcr repository>@sha256:<digest>`. */
export const WORKER_IMAGE_VARIABLE = "RBW_FACTORY_WORKER_IMAGE";

/** How the worker is launched: the image from RBW_FACTORY_WORKER_IMAGE and the credentials it reads. */
export interface WorkerLaunchConfig {
  /** The worker image in VCR pinned by digest: `<repository>@sha256:<64 hex>`. */
  image: string;
  /**
   * DATABASE_URL, VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID, passed as create-time
   * environment values. The launcher sets PATH and HOME itself, and RBW_FACTORY_WORKER_IMAGE to
   * `image` (the worker derives its copies' registry namespace from it); `image` wins over a value
   * here.
   */
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
/**
 * Where the worker command's run-once guard keeps its lock and exit-status marker inside the worker
 * sandbox: the SDK may start a command twice, and a second worker would run the request or the
 * validation run again with a meter of its own.
 */
export const WORKER_RUN_ONCE_DIR = "/tmp/rbw-worker-once";
/** The image's PATH, which the sandbox does not apply by itself. */
const BASE_ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" };
const PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export class LaunchConfigError extends Error {
  override name = "LaunchConfigError";
}

function checkImage(image: string): void {
  if (!PINNED.test(image)) throw new LaunchConfigError("the factory worker image must be pinned by digest (<repository>@sha256:<digest>)");
}

/** The worker command's arguments to node: request mode with the worker's deadline, or validation mode (its deadline is in its record). */
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

type Launched = { kind: "launched"; sandbox: string } | { kind: "definite_failure"; detail: string } | { kind: "uncertain"; detail: string } | { kind: "replay" };

/**
 * The worker command's arguments for a sandbox this start creates, and for one an earlier start
 * created, which ends no later than its timeout from that start (a request worker's deadline).
 */
interface WorkerArgs {
  fresh: string[];
  adopted: string[];
}

/** The sandbox under this name: null when there is none, undefined when the lookup failed. */
async function lookup(deps: FactoryLaunchDeps, name: string): Promise<WorkerSandboxInstance | null | undefined> {
  try {
    return await deps.sandbox.get(name);
  } catch (error) {
    deps.log(`factory: the lookup of ${name} failed (${error instanceof Error ? error.name : "non-error"})`);
    return undefined;
  }
}

/**
 * Whether the ledger recorded the operation running: its running transition records its sandbox as
 * a child resource of the root's hold, which an open operation keeps held.
 */
async function recordedRunning(deps: FactoryLaunchDeps, op: FactoryOperation): Promise<boolean> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const slot = await deps.ledger.spend.slotStatus({ slot_key: profile.slot_key });
  return slot.ok && slot.children.some((child) => child.operation_id === op.operation_id);
}

function live(found: WorkerSandboxInstance | null | undefined): found is WorkerSandboxInstance {
  return found !== null && found !== undefined && !STOPPED_STATUSES.has(found.status);
}

/** Moves the operation to uncertain; replay when another call moved it first. */
async function toUncertain(deps: FactoryLaunchDeps, op: FactoryOperation, from: "launching" | "running", uncertainty: "lost_response" | "unknown_status", detail: string): Promise<Launched> {
  const moved = await deps.ledger.spend.transition({ operation_id: op.operation_id, from_state: from, to_state: "uncertain", actor_role: ROUTE_ACTOR, uncertainty });
  if (!moved.ok && moved.code === "invalid_transition") return { kind: "replay" };
  return { kind: "uncertain", detail };
}

/**
 * prepared → launching → create → running → the detached command. The operation must be prepared.
 * Returns what happened; every ledger step of a failure is taken here.
 */
async function launchSandbox(deps: FactoryLaunchDeps, op: FactoryOperation, size: { vcpus: number; timeout_s: number }, args: WorkerArgs): Promise<Launched> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const launching = await deps.ledger.spend.transition({ operation_id: op.operation_id, from_state: "prepared", to_state: "launching", actor_role: ROUTE_ACTOR, slot_key: profile.slot_key });
  if (!launching.ok) {
    // Another call moved it first: that call launches. Any other refusal leaves it prepared for reconciliation.
    if (launching.code === "invalid_transition") return { kind: "replay" };
    return { kind: "uncertain", detail: `the launch was refused (${launching.code})` };
  }
  return createAndStart(deps, op, size, args);
}

/**
 * create → running → the detached command, for an operation in launching. A create the provider
 * refuses on the name (409) means another start's create under the operation's name took effect
 * first, and the sandbox it made is adopted while it runs, whichever start sent its create first.
 */
async function createAndStart(deps: FactoryLaunchDeps, op: FactoryOperation, size: { vcpus: number; timeout_s: number }, args: WorkerArgs): Promise<Launched> {
  const { spend } = deps.ledger;
  let instance: WorkerSandboxInstance;
  try {
    instance = await deps.sandbox.create({
      image: deps.launch.image,
      name: op.sandbox_name,
      persistent: false,
      networkPolicy: "allow-all",
      resources: { vcpus: size.vcpus },
      timeout: size.timeout_s * 1000,
      env: { ...BASE_ENV, ...deps.launch.env, [WORKER_IMAGE_VARIABLE]: deps.launch.image },
    });
  } catch (error) {
    const status = httpStatus(error);
    const found = await lookup(deps, op.sandbox_name);
    const definite = status !== null && status >= 400 && status < 500 && !NOT_DEFINITE.has(status) && found === null;
    if (definite) {
      const ended = await spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "terminal", actor_role: ROUTE_ACTOR, terminal_status: "failed" });
      const settled = ended.ok ? await spend.settle(zeroSettlement(op.envelope, op.operation_id)) : ended;
      if (settled.ok) return { kind: "definite_failure", detail: `the create was refused (${String(status)})` };
      return { kind: "uncertain", detail: `the create was refused (${String(status)}) but the ledger refused its end (${settled.code})` };
    }
    if (status === 409 && live(found)) return startCommand(deps, op, found, args.adopted);
    const moved = await spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "uncertain", actor_role: ROUTE_ACTOR, uncertainty: "lost_response" });
    // Another start adopted the sandbox under this name and runs its worker: nothing is stopped.
    if (!moved.ok && moved.code === "invalid_transition" && moved.current_state === "running") return { kind: "replay" };
    if (found !== null && found !== undefined) await stopQuietly(deps.sandbox, op.sandbox_name, deps.log);
    return { kind: "uncertain", detail: `the create failed (${status === null ? (error instanceof Error ? error.name : "non-error") : String(status)})` };
  }
  return startCommand(deps, op, instance, args.fresh);
}

/** launching → running for this sandbox, then the detached command. */
async function startCommand(deps: FactoryLaunchDeps, op: FactoryOperation, instance: WorkerSandboxInstance, args: string[]): Promise<Launched> {
  const { spend } = deps.ledger;
  const running = await spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "running", actor_role: ROUTE_ACTOR, provider_resource_id: instance.name });
  if (!running.ok) {
    // Another start recorded the same sandbox running and starts its worker.
    if (running.code === "invalid_transition" && running.current_state === "running") return { kind: "replay" };
    await spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "uncertain", actor_role: ROUTE_ACTOR, uncertainty: "unknown_status" });
    await stopQuietly(deps.sandbox, instance.name, deps.log);
    return { kind: "uncertain", detail: `the running transition was refused (${running.code})` };
  }
  return runWorkerCommand(deps, op, instance, args);
}

/** The detached worker command in a running operation's sandbox. */
async function runWorkerCommand(deps: FactoryLaunchDeps, op: FactoryOperation, instance: WorkerSandboxInstance, args: string[]): Promise<Launched> {
  try {
    // Under the run-once guard, so a start the SDK replays, or a resumed start sends again, runs no second worker.
    const guarded = runOnceCommand("rbw-worker", WORKER_RUN_ONCE_DIR, [NODE, ...args]);
    await instance.runCommand({ cmd: guarded.cmd, args: guarded.args, cwd: WORKER_REPOSITORY, detached: true });
  } catch (error) {
    await deps.ledger.spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "uncertain", actor_role: ROUTE_ACTOR, uncertainty: "unknown_status" });
    await stopQuietly(deps.sandbox, instance.name, deps.log);
    return { kind: "uncertain", detail: `the worker command could not be started (${error instanceof Error ? error.name : "non-error"})` };
  }
  return { kind: "launched", sandbox: instance.name };
}

/**
 * Resumes the launch an earlier start left in `state`, which this start found on its reservation
 * or its record. A lookup that fails leaves the operation as it is, for a later start or the
 * lost-worker routine.
 */
async function resumeLaunch(deps: FactoryLaunchDeps, op: FactoryOperation, state: OperationState, size: { vcpus: number; timeout_s: number }, args: WorkerArgs, workerStarted: () => Promise<boolean>): Promise<Launched> {
  if (state === "prepared") return launchSandbox(deps, op, size, args);
  // Once the worker began, it and the routines after it (its settlement, the lost-worker routine) own the operation.
  if (await workerStarted()) return { kind: "replay" };
  switch (state) {
    case "launching": {
      const found = await lookup(deps, op.sandbox_name);
      if (found === undefined) return { kind: "replay" };
      if (found === null) return createAndStart(deps, op, size, args);
      if (STOPPED_STATUSES.has(found.status)) return toUncertain(deps, op, "launching", "lost_response", `the sandbox an earlier start created is ${found.status}`);
      return startCommand(deps, op, found, args.adopted);
    }
    case "running": {
      const found = await lookup(deps, op.sandbox_name);
      if (found === undefined) return { kind: "replay" };
      if (live(found)) return runWorkerCommand(deps, op, found, args.adopted);
      return toUncertain(deps, op, "running", "unknown_status", "the sandbox stopped before its worker started");
    }
    case "terminal": {
      // A create refused before anything existed ends here, never recorded running and with nothing under its
      // name; any other end (the lost-worker routine's) is the routine's that ended it, which settles it.
      if (await recordedRunning(deps, op)) return { kind: "replay" };
      const found = await lookup(deps, op.sandbox_name);
      if (found !== null) return { kind: "replay" };
      const settled = await deps.ledger.spend.settle(zeroSettlement(op.envelope, op.operation_id));
      if (settled.ok) return { kind: "definite_failure", detail: "an earlier start's refused create was settled" };
      return { kind: "uncertain", detail: `the ledger refused the refused create's settlement (${settled.code})` };
    }
    case "reconciled": {
      const status = await deps.ledger.spend.operationStatus({ operation_id: op.operation_id });
      if (status.ok && status.settled_microusd === 0n && !(await recordedRunning(deps, op))) return { kind: "definite_failure", detail: "an earlier start's refused create was settled" };
      return { kind: "replay" };
    }
    case "uncertain":
      // Never launched again: the start ends uncertain, with what may still run stopped.
      await stopQuietly(deps.sandbox, op.sandbox_name, deps.log);
      return { kind: "uncertain", detail: "an earlier start left the launch uncertain" };
  }
}

// The request worker ----------------------------------------------------------------------------

/**
 * `replay`: this start launched nothing: an earlier or concurrent start launched the worker or
 * left it uncertain and finished, the worker began, the request finished (the start's own finish is
 * completed), or what the provider holds could not be read and is left for a later start.
 */
export type WorkerStart = { kind: "launched"; sandbox: string } | { kind: "replay" } | { kind: "refused"; code: string } | { kind: "create_failed" } | { kind: "uncertain"; detail: string };

async function releaseSlot(deps: FactoryLaunchDeps, root: string): Promise<boolean> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const released = await deps.ledger.spend.releaseSlot({ slot_key: profile.slot_key, root_execution_id: root, actor_role: ROUTE_ACTOR, evidence: null, reason: null });
  if (!released.ok) deps.log(`factory: the slot of ${root} was not released (${released.code})`);
  return released.ok;
}

/**
 * Reserves the worker and launches it once per request. A duplicate or concurrent start finds the
 * operation already reserved and resumes the launch from its state (the file's header): only one
 * caller can move a prepared operation to launching, so overlapping starts launch one worker. The
 * request must be recorded first.
 */
export async function startFactoryWorker(deps: FactoryLaunchDeps, requestId: string): Promise<WorkerStart> {
  checkImage(deps.launch.image);
  const profile = deps.profile ?? FACTORY_PROFILE;
  const record = await deps.records.request(requestId);
  if (record === null) throw new LaunchConfigError("the request is not recorded");
  const events = await deps.records.events(requestId);
  // A finished request never gets a worker, whatever its operation's state; the writes that follow its finish are completed.
  if (finishedEvent(events) !== null) {
    await completeRequestFinish(deps, record, events);
    return { kind: "replay" };
  }
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
  const timeoutMs = profile.worker.timeout_s * 1000;
  const args: WorkerArgs = {
    fresh: workerCommandArgs({ request_id: requestId, deadline_at: new Date(deps.now().getTime() + timeoutMs) }),
    // The request was recorded before any create, so its time bounds an earlier start's sandbox's end.
    adopted: workerCommandArgs({ request_id: requestId, deadline_at: new Date(Date.parse(record.created_at) + timeoutMs) }),
  };
  if (reserved.state === "prepared") await appendBudgetUpdate(deps, record, EVENT_KEYS.workerReserved, `Reserved ${usd(reserved.reserved_microusd)} for the worker's worst case.`);
  const started = async (): Promise<boolean> => events.some((event) => event.type === "worker_started") || (await deps.records.lastHeartbeat({ request_id: requestId })) !== null;
  const launched = await resumeLaunch(deps, op, reserved.state, profile.worker, args, started);
  return finishWorkerLaunch(deps, record, launched);
}

async function finishWorkerLaunch(deps: FactoryLaunchDeps, record: FactoryRequestRecord, launched: Launched): Promise<WorkerStart> {
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
  /**
   * The protocol inside the case's delivered validator package (what the harness runs): its copies
   * in all price the run's reservation and cap the copies it starts.
   */
  protocol: Pick<Protocol, "per_state">;
}

/** The total copies a protocol declares; LaunchConfigError when a state's count is not a positive whole number. */
function protocolCopies(protocol: Pick<Protocol, "per_state">): number {
  const counts = [protocol.per_state.clean.copies, protocol.per_state.buggy.copies, protocol.per_state.fixed.copies];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 1)) throw new LaunchConfigError("the validator package's protocol must declare a positive whole number of copies for each state");
  return counts.reduce((total, count) => total + count, 0);
}

export type ValidationStart = { kind: "accepted"; run: ValidationRun } | { kind: "busy"; reason: BusyReason } | { kind: "budget_unavailable" } | { kind: "unavailable"; message: string };

/** The poll interval a client is told while a run is queued or running. */
export const VALIDATION_POLL_MS = 5000;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isMatrix(value: unknown): value is ValidationMatrix {
  return typeof value === "object" && value !== null && "original_suite" in value && "verification" in value;
}

/**
 * The ValidationRun of a recorded run as its record and events stand (contract section 11): queued
 * until its worker appended running, running until the run's finish was recorded, then that finish
 * with its result, matrix, message and settled cost. The package hashes and the harness identity are
 * the ones recorded at the run's start, whatever a later caller runs.
 */
export function validationRunView(record: Pick<FactoryValidationRecord, "validation_id" | "case_id" | "package_sha256" | "harness">, events: readonly (ValidationEventInput & { at: string })[]): ValidationRun {
  const running = events.find((event) => event.type === "running");
  const finished = events.find((event) => event.type === "finished");
  const result = VALIDATION_RESULT_VALUES.find((value) => value === finished?.data.result) ?? null;
  const done = finished !== undefined && result !== null ? finished : null;
  const cost = done?.data.cost_microusd;
  return {
    contract_version: "bug-request/1",
    validation_id: record.validation_id,
    case_id: record.case_id,
    state: done !== null ? "finished" : running !== undefined ? "running" : "queued",
    result: done === null ? null : result,
    matrix: done !== null && isMatrix(done.data.matrix) ? done.data.matrix : null,
    package_sha256: record.package_sha256,
    harness: record.harness,
    message: done === null ? null : text(done.data.message),
    started_at: text(running?.data.started_at),
    finished_at: done === null ? null : (text(done.data.finished_at) ?? done.at),
    cost_microusd: typeof cost === "number" ? cost : null,
    poll_after_ms: done === null ? VALIDATION_POLL_MS : 0,
  };
}

const BUDGET_CODES = new Set(["budget_exhausted", "budget_closed", "insufficient_funds"]);

/** The request's validation_started and the run's reservation's budget_updated, each keyed by the run. */
async function appendValidationStarted(deps: FactoryLaunchDeps, request: FactoryRequestRecord, record: FactoryValidationRecord, reservedMicrousd: bigint): Promise<void> {
  const id = record.validation_id;
  await deps.records.appendEvent(
    request.request_id,
    { event_key: `validation:${id}:started`, type: "validation_started", host_id: record.host_id, candidate_id: null, item_key: null, case_id: record.case_id, message: "Validation run started.", data: { validation_id: id } },
    deps.now(),
  );
  await appendBudgetUpdate(deps, request, `validation:${id}:reserved`, `Reserved ${usd(reservedMicrousd)} for a validation run's worst case.`);
}

/** A launch's end for a validation run: a refused create finishes it error at zero and releases the slot; an uncertain one finishes it error for reconciliation. */
async function finishValidationLaunch(deps: FactoryLaunchDeps, request: FactoryRequestRecord, record: FactoryValidationRecord, launched: Launched): Promise<void> {
  if (launched.kind === "definite_failure") {
    await finishValidation(deps, request, record, { result: "error", matrix: null, message: "The validation run could not be started.", cost_microusd: 0 });
    await releaseSlot(deps, record.root);
  } else if (launched.kind === "uncertain") {
    await finishValidation(deps, request, record, { result: "error", matrix: null, message: "The validation run's launch outcome is uncertain; its spend needs reconciliation.", cost_microusd: null });
    deps.log(`factory validation ${record.validation_id} launch uncertain: ${launched.detail}; slot held`);
  }
}

/**
 * A repeated start of a recorded run. A finished run, whoever recorded its finish (its launch, its
 * worker or the lost-worker routine), has the writes that follow it completed: the request's events
 * from its recorded finish and, for a settled one, the slot release. An unfinished run resumes its launch.
 */
async function resumeValidation(deps: FactoryLaunchDeps, request: FactoryRequestRecord, record: FactoryValidationRecord): Promise<ValidationStart> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const id = record.validation_id;
  const runEvents = await deps.records.validationEvents(id);
  const started = async (): Promise<boolean> => runEvents.some((event) => event.type === "running") || (await deps.records.lastHeartbeat({ validation_id: id })) !== null;
  if (runEvents.some((event) => event.type === "finished")) {
    await completeValidationFinish(deps, request, record);
  } else {
    const op = validationOperation({ identity: deps.identity, rates: deps.rates, profile }, record);
    const status = await deps.ledger.spend.operationStatus({ operation_id: op.operation_id });
    if (!status.ok) return { kind: "unavailable", message: `The validation run's reservation could not be read (${status.code}).` };
    if (status.state === "prepared") await appendValidationStarted(deps, request, record, status.reserved_microusd);
    const args = workerCommandArgs({ validation_id: id });
    const launched = await resumeLaunch(deps, op, status.state, profile.validation.worker, { fresh: args, adopted: args }, started);
    await finishValidationLaunch(deps, request, record, launched);
  }
  return { kind: "accepted", run: validationRunView(record, await deps.records.validationEvents(id)) };
}

/**
 * Starts a validation run in the POST (contract section 11): the factory
 * slot under the validation root, then the run's worst case, priced for the copies its package's
 * protocol declares, reserved on the request budget with the validation role. Busy or a refused reservation records nothing (the slot taken
 * here is released). Then the run is recorded, validation_started and budget_updated are appended,
 * and its worker is launched. A repeated start of a recorded run resumes it (the file's header) and
 * answers the run as recorded.
 */
export async function startFactoryValidation(deps: FactoryLaunchDeps, args: ValidationStartArgs): Promise<ValidationStart> {
  checkImage(deps.launch.image);
  const copies = protocolCopies(args.protocol);
  const profile = deps.profile ?? FACTORY_PROFILE;
  const { spend, budgets } = deps.ledger;
  const request = await deps.records.request(args.request_id);
  if (request === null) return { kind: "unavailable", message: "The request is not recorded." };
  const root = deps.identity.validationRoot(args.validation_id);
  const existing = await deps.records.validation(args.validation_id);
  if (existing !== null) {
    if (existing.request_id === args.request_id && existing.case_id === args.case_id) return resumeValidation(deps, request, existing);
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
    harness: args.harness,
    copies,
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
  await appendValidationStarted(deps, request, record, reserved.reserved_microusd);

  const commandArgs = workerCommandArgs({ validation_id: args.validation_id });
  await finishValidationLaunch(deps, request, record, await launchSandbox(deps, op, profile.validation.worker, { fresh: commandArgs, adopted: commandArgs }));
  return { kind: "accepted", run: validationRunView(record, await deps.records.validationEvents(args.validation_id)) };
}
