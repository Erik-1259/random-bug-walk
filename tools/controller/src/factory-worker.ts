// The factory worker: what the `factory-worker` command runs inside its sandbox (or locally with
// the docker runner). In request mode it heartbeats, appends worker_started and runs the factory
// core's request loop (injected as `orchestrate`) with a copy meter for every copy, a checkpoint
// for stops between copies, a fenced event appender and `settleWorker`. The loop appends every
// other request event (contract order: the worker settled, its budget_updated, request_finished)
// and settles the worker through `settleWorker`; afterwards this code only releases the slot (the
// ledger refuses while any operation of the request is open or uncertain, and a finish whose
// attention is needs_reconciliation keeps it held, both for reconciliation; a failed release is
// left to the lost-worker routine). A loop that ends without finishing the request has exited before
// finishing: nothing is settled, finished or released here, and the lost-worker routine finishes
// it worker_lost once the heartbeat is old (contract section 8.1).
// In validation mode it runs the standalone harness (injected as `validate`) on the case's two
// parts with copies recorded under the run's own operation, inside 1,800 s of the accepted POST,
// then settles the run (its worker in full, its copies as measured), finishes it and releases the
// slot, or, when any copy is uncertain, leaves the run's operation uncertain and the slot held.
//
// The fence: once the request (or run) was finished by someone else, such as the lost-worker
// routine, the worker's next checkpoint answers `fenced`, no copy starts, no event other than the
// contract's late ones is appended, and nothing is settled or released.
import type { Rates } from "@rbw/envelope";
import type { EventType, StopCode, ValidationMatrix, ValidationResult } from "@rbw/factory-contract";
import { STOP_CODE_VALUES } from "@rbw/factory-contract";
import {
  EVENT_KEYS,
  WORKER_ACTOR,
  finishValidation,
  finishedEvent,
  fullSettlement,
  makeUncertain,
  needsReconciliationRaised,
  validationOperation,
  validationSettlement,
  workerOperation,
} from "./factory-ledger.ts";
import { CopyMeter } from "./factory-meter.ts";
import { FACTORY_PROFILE } from "./factory-profile.ts";
import type { FactoryProfile } from "./factory-profile.ts";
import type { AppendOutcome, FactoryEventInput, FactoryIdentity, FactoryLedger, FactoryRecords, FactoryRequestRecord, FactoryValidationRecord, HeartbeatTarget, WorkerSandboxSdk } from "./factory-ports.ts";

export interface WorkerDeps {
  ledger: FactoryLedger;
  records: FactoryRecords;
  identity: FactoryIdentity;
  rates: Rates;
  now: () => Date;
  log: (line: string) => void;
  /** The copies' provider: `vercel-sandbox` hosted, `docker` for local proofs. */
  provider: "vercel-sandbox" | "docker";
  /** The worker's own sandbox, stopped on a best-effort basis by the command after the run. */
  sandbox?: WorkerSandboxSdk;
  profile?: FactoryProfile;
  /** Overrides the profile's heartbeat interval (tests). */
  heartbeat_ms?: number;
}

export class WorkerInputError extends Error {
  override name = "WorkerInputError";
}

export interface Heartbeat {
  stop(): Promise<void>;
}

/**
 * Writes a heartbeat now and then every `intervalMs` until stopped, one write at a time. A failed
 * write is logged and the next one is still made: a missed heartbeat is what the lost-worker rule
 * measures.
 */
export function startHeartbeat(records: FactoryRecords, target: HeartbeatTarget, now: () => Date, intervalMs: number, log: (line: string) => void): Heartbeat {
  let chain: Promise<void> = Promise.resolve();
  const beat = (): void => {
    chain = chain.then(
      () =>
        records.recordHeartbeat(target, now()).catch((error: unknown) => {
          log(`factory: a heartbeat write failed (${error instanceof Error ? error.name : "non-error"})`);
        }),
      () => undefined,
    );
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await chain;
    },
  };
}

export type Checkpoint = "continue" | "stop" | "fenced";

/** What the factory core's request loop is given. It appends its events through `append`. */
export interface RequestHooks {
  request: FactoryRequestRecord;
  profile: FactoryProfile;
  /** The worker sandbox's end: no copy starts unless it ends, with its margin, before this. */
  deadline: Date;
  now: () => Date;
  /** Runs each copy: reserve, launch, settle; one at a time; refuses after a stop or a fence. */
  meter: CopyMeter;
  /** Before each candidate and between copies: `stop` after a recorded stop, `fenced` once the request was finished elsewhere. */
  checkpoint(): Promise<Checkpoint>;
  /** The fenced appender: refuses every event but the contract's late ones once the request was finished elsewhere. */
  append(event: FactoryEventInput): Promise<AppendOutcome>;
  /**
   * The core's `settleWorker` port: ends the worker's operation, settles it at its full worst case
   * (it cannot measure its own sandbox's end) and closes the request budget with the stop code. It
   * appends no event: the loop appends the budget_updated and request_finished that follow.
   * Repeating it with the same stop code changes nothing. It rejects when the ledger refuses or
   * fails, and then leaves the worker's operation uncertain where it was still running.
   */
  settleWorker(stop: StopCode): Promise<void>;
}

/** The factory core's request loop: it finishes the request itself, through `append` and `settleWorker`. */
export type Orchestrate = (hooks: RequestHooks) => Promise<void>;

/**
 * finished: the loop finished the request; fenced: someone else finished it; unfinished: the loop
 * ended without finishing it, which the lost-worker routine finishes worker_lost.
 */
export type WorkerOutcome = { kind: "finished"; stop_code: StopCode; slot_released: boolean } | { kind: "fenced" } | { kind: "unfinished" };

/** Contract section 8.4: the only event types allowed after request_finished. */
const LATE_TYPES: ReadonlySet<EventType> = new Set(["budget_updated", "attention", "attention_cleared", "validation_started", "validation_finished"]);

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "non-error";
}

/**
 * Releases the slot after the finish, on a best-effort basis: a refusal or a failed call is logged
 * and the slot stays held, which the lost-worker routine releases once this worker is silent.
 */
async function releaseSlot(deps: WorkerDeps, root: string): Promise<boolean> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  try {
    const released = await deps.ledger.spend.releaseSlot({ slot_key: profile.slot_key, root_execution_id: root, actor_role: WORKER_ACTOR, evidence: null, reason: null });
    if (!released.ok) deps.log(`factory: the slot stays held (${released.code})`);
    return released.ok;
  } catch (error) {
    deps.log(`factory: the slot release failed (${errorText(error)}); the slot stays held`);
    return false;
  }
}

function stopCodeOf(value: unknown): StopCode | null {
  return STOP_CODE_VALUES.find((code) => code === value) ?? null;
}

/** settleWorker: the worker's operation ended and settled in full, then the budget closed with the stop code. */
async function settleWorkerOperation(deps: WorkerDeps, record: FactoryRequestRecord, stop: StopCode): Promise<void> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const { spend, budgets } = deps.ledger;
  const op = workerOperation({ identity: deps.identity, rates: deps.rates, profile }, record);
  try {
    const status = await spend.operationStatus({ operation_id: op.operation_id });
    if (!status.ok) throw new Error(`the worker's operation is unknown (${status.code})`);
    if (status.state === "running") {
      const ended = await spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "terminal", actor_role: WORKER_ACTOR, terminal_status: "completed" });
      if (!ended.ok) throw new Error(`the worker's end was refused (${ended.code})`);
    }
    if (status.state === "running" || status.state === "terminal") {
      const settled = await spend.settle(fullSettlement(op.envelope, op.operation_id));
      if (!settled.ok) throw new Error(`the worker's settlement was refused (${settled.code})`);
    } else if (status.state !== "reconciled") {
      throw new Error(`the worker's operation is ${status.state}, so it was not settled`);
    }
    const closed = await budgets.close(record.budget_key, stop);
    if (!closed.ok) throw new Error(`the budget close was refused (${closed.code})`);
  } catch (error) {
    try {
      await makeUncertain(spend, op.operation_id, WORKER_ACTOR);
    } catch (moveError) {
      deps.log(`factory ${record.request_id} the worker's operation could not be moved to uncertain (${errorText(moveError)})`);
    }
    throw error;
  }
}

/** Runs one request to its end. */
export async function runFactoryWorker(deps: WorkerDeps, args: { request_id: string; deadline: Date; orchestrate: Orchestrate }): Promise<WorkerOutcome> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const id = args.request_id;
  const record = await deps.records.request(id);
  if (record === null) throw new WorkerInputError("the request is not recorded");
  const heartbeat = startHeartbeat(deps.records, { request_id: id }, deps.now, deps.heartbeat_ms ?? profile.heartbeat.interval_s * 1000, deps.log);
  try {
    let fence = false;
    // Set by the appender once the loop recorded request_finished itself (a holder: the loop sets it inside a callback).
    const own = { finished: false };
    const fenced = async (): Promise<boolean> => {
      if (!fence && !own.finished && finishedEvent(await deps.records.events(id)) !== null) fence = true;
      return fence;
    };
    if (await fenced()) return { kind: "fenced" };
    await deps.records.appendEvent(id, { event_key: EVENT_KEYS.workerStarted, type: "worker_started", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "The worker started.", data: {} }, deps.now());

    const checkpoint = async (): Promise<Checkpoint> => {
      if (await fenced()) return "fenced";
      return (await deps.records.stopRequested(id)) ? "stop" : "continue";
    };
    const append = async (event: FactoryEventInput): Promise<AppendOutcome> => {
      if (!LATE_TYPES.has(event.type) && (await fenced())) return { kind: "refused", reason: "the request was finished elsewhere" };
      const appended = await deps.records.appendEvent(id, event, deps.now());
      if (event.type === "request_finished" && (appended.kind === "appended" || appended.kind === "replay")) own.finished = true;
      return appended;
    };
    const settleWorker = async (stop: StopCode): Promise<void> => {
      if (await fenced()) throw new Error("the request was finished elsewhere; its worker is left for reconciliation");
      await settleWorkerOperation(deps, record, stop);
    };
    const meter = new CopyMeter({
      ledger: deps.ledger,
      identity: deps.identity,
      rates: deps.rates,
      now: deps.now,
      root: record.root,
      kind: "request",
      task_revision: record.interpretation_sha256,
      budget_key: record.budget_key,
      provider: deps.provider,
      deadline: args.deadline,
      margin_s: profile.copy_launch_margin_s,
      mode: { kind: "own_operation", role: "request" },
      beforeLaunch: async () => (await checkpoint()) === "continue",
      log: deps.log,
      profile,
    });

    try {
      await args.orchestrate({ request: record, profile, deadline: args.deadline, now: deps.now, meter, checkpoint, append, settleWorker });
    } catch (error) {
      deps.log(`factory ${id} the request loop failed (${errorText(error)})`);
    }
    if (await fenced()) return { kind: "fenced" };
    const events = own.finished ? await deps.records.events(id) : [];
    const finished = finishedEvent(events);
    const stop = finished === null ? null : stopCodeOf(finished.data.stop_code);
    if (stop === null) {
      deps.log(`factory ${id} the request loop ended without finishing the request; it is left for the lost-worker finish`);
      return { kind: "unfinished" };
    }
    // Spend the loop left for reconciliation (contract section 8.5) keeps the slot held for the operator.
    if (needsReconciliationRaised(events)) {
      deps.log(`factory ${id} finished ${stop} with spend that needs reconciliation; slot held`);
      return { kind: "finished", stop_code: stop, slot_released: false };
    }
    return { kind: "finished", stop_code: stop, slot_released: await releaseSlot(deps, record.root) };
  } finally {
    await heartbeat.stop();
  }
}

export interface ValidationHooks {
  validation: FactoryValidationRecord;
  request: FactoryRequestRecord;
  /** accepted_at + 1,800 s: no copy starts unless its timeout and shutdown allowance end by this. */
  deadline: Date;
  now: () => Date;
  /** Runs each copy as a child resource of the run's operation, one at a time. */
  meter: CopyMeter;
  checkpoint(): Promise<Checkpoint>;
}

export interface ValidationRunResult {
  result: ValidationResult;
  matrix: ValidationMatrix | null;
  message: string | null;
}

export type Validate = (hooks: ValidationHooks) => Promise<ValidationRunResult>;

export type ValidationOutcome = { kind: "finished"; result: ValidationResult; slot_released: boolean } | { kind: "fenced" };

/** Runs one validation run to its end. */
export async function runFactoryValidation(deps: WorkerDeps, args: { validation_id: string; validate: Validate }): Promise<ValidationOutcome> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const id = args.validation_id;
  const validation = await deps.records.validation(id);
  if (validation === null) throw new WorkerInputError("the validation run is not recorded");
  const request = await deps.records.request(validation.request_id);
  if (request === null) throw new WorkerInputError("the validation run's request is not recorded");
  const heartbeat = startHeartbeat(deps.records, { validation_id: id }, deps.now, deps.heartbeat_ms ?? profile.heartbeat.interval_s * 1000, deps.log);
  try {
    let fence = false;
    const fenced = async (): Promise<boolean> => {
      if (!fence && (await deps.records.validationEvents(id)).some((event) => event.type === "finished")) fence = true;
      return fence;
    };
    if (await fenced()) return { kind: "fenced" };
    await deps.records.appendValidationEvent(id, { event_key: "running", type: "running", data: { started_at: deps.now().toISOString() } }, deps.now());
    const deadline = new Date(Date.parse(validation.accepted_at) + profile.validation.max_run_s * 1000);
    const op = validationOperation({ identity: deps.identity, rates: deps.rates, profile }, validation);
    const checkpoint = async (): Promise<Checkpoint> => ((await fenced()) ? "fenced" : "continue");
    const meter = new CopyMeter({
      ledger: deps.ledger,
      identity: deps.identity,
      rates: deps.rates,
      now: deps.now,
      root: validation.root,
      kind: "validation",
      task_revision: validation.case_id,
      budget_key: request.budget_key,
      provider: deps.provider,
      deadline,
      // The margin leaves the run time to confirm its last copy's stop, settle and finish inside the window.
      margin_s: profile.validation.finish_margin_s,
      mode: { kind: "child_of", operation_id: op.operation_id, max_copies: validation.copies },
      beforeLaunch: async () => (await checkpoint()) === "continue",
      log: deps.log,
      profile,
    });

    let result: ValidationRunResult;
    try {
      result = await args.validate({ validation, request, deadline, now: deps.now, meter, checkpoint });
    } catch (error) {
      deps.log(`factory validation ${id} the harness failed (${errorText(error)})`);
      result = { result: "error", matrix: null, message: "The validation run failed before it finished." };
    }
    if (await fenced()) return { kind: "fenced" };

    const { spend } = deps.ledger;
    // A finish another writer recorded first (the lost-worker routine) stands: this worker then stops as fenced.
    if (meter.uncertain) {
      await makeUncertain(spend, op.operation_id, WORKER_ACTOR);
      const finish = await finishValidation(deps, request, validation, { result: "error", matrix: result.matrix, message: "A copy's outcome is uncertain; the run's spend needs reconciliation.", cost_microusd: null });
      return finish.ours ? { kind: "finished", result: "error", slot_released: false } : { kind: "fenced" };
    }
    let settled: Awaited<ReturnType<typeof spend.settle>>;
    try {
      const ended = await spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "terminal", actor_role: WORKER_ACTOR, terminal_status: result.result === "error" ? "failed" : "completed" });
      if (!ended.ok) {
        deps.log(`factory validation ${id} the run's operation was not ended (${ended.code})`);
        return { kind: "fenced" };
      }
      settled = await spend.settle(validationSettlement(op.envelope, op.operation_id, validation.host_id, meter.usage, profile));
    } catch (error) {
      // Whether the end or the settlement took effect is unknown, so it is never tried again: the run's
      // finish records no cost, which keeps the slot held and leaves the lost-worker routine (it settles
      // only a run with no recorded finish) nothing to settle; reconciliation settles it.
      deps.log(`factory validation ${id} a ledger call failed while the run was settled (${errorText(error)}); it needs reconciliation`);
      try {
        await makeUncertain(spend, op.operation_id, WORKER_ACTOR);
      } catch (moveError) {
        deps.log(`factory validation ${id} the run's operation could not be moved to uncertain (${errorText(moveError)})`);
      }
      const finish = await finishValidation(deps, request, validation, { result: "error", matrix: result.matrix, message: "The run's spend could not be settled; it needs reconciliation.", cost_microusd: null });
      return finish.ours ? { kind: "finished", result: "error", slot_released: false } : { kind: "fenced" };
    }
    if (!settled.ok) {
      deps.log(`factory validation ${id} the run's settlement was refused (${settled.code})`);
      const finish = await finishValidation(deps, request, validation, { result: "error", matrix: result.matrix, message: "The run's spend could not be settled; it needs reconciliation.", cost_microusd: null });
      return finish.ours ? { kind: "finished", result: "error", slot_released: false } : { kind: "fenced" };
    }
    // Contract section 11: a run still going after 1,800 s finishes error, so a harness, a settlement or
    // a database that answered late cannot record a pass or a fail past the window.
    const final: ValidationRunResult = deps.now().getTime() > deadline.getTime() ? { result: "error", matrix: result.matrix, message: "The validation run did not finish within 1,800 s." } : result;
    const finish = await finishValidation(deps, request, validation, { ...final, cost_microusd: Number(settled.settled_microusd) });
    if (!finish.ours) return { kind: "fenced" };
    return { kind: "finished", result: final.result, slot_released: await releaseSlot(deps, validation.root) };
  } finally {
    await heartbeat.stop();
  }
}
