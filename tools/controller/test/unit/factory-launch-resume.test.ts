// The resume rule of the two launches (contract sections 7, 8.5 and 11): a start of a request or a
// validation run that an earlier start of the same ID began and did not finish (the process ended
// after any one of its steps) resumes from what that start recorded. One row per interruption point
// and start kind. The earlier start is interrupted by a step that takes effect and then never
// answers, as a stopped process leaves it; the retry runs with the same records, ledger and provider.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StopCode } from "@rbw/factory-contract";
import type { OperationState, Spend } from "@rbw/spend";
import { validationOperation, validationSandboxName, workerOperation, workerSandboxName } from "../../src/factory-ledger.ts";
import { LaunchConfigError, WORKER_RUN_ONCE_DIR, startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps, ValidationStartArgs, WorkerStart } from "../../src/factory-launch.ts";
import type { FactoryBudgets, FactoryRecords, FactoryRequestRecord, HeartbeatTarget, WorkerSandboxInstance, WorkerSandboxSdk } from "../../src/factory-ports.ts";
import { CASE_ID, CREDENTIALS, PROTOCOL, SyntheticApiError, WORKER_IMAGE, acceptRequest, factoryWorld, slotHolder, syntheticUuid } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";

let w: FactoryWorld;

beforeEach(async () => {
  w = await factoryWorld();
});

afterEach(async () => {
  await w.close();
});

function deps(): FactoryLaunchDeps {
  return { ledger: w.ledger, records: w.records, identity: w.identity, sandbox: w.sandbox, rates: w.rates, now: w.clock.now, launch: { image: WORKER_IMAGE, env: CREDENTIALS }, log: (line) => w.logs.push(line) };
}

/**
 * Where the earlier start ended. `create_lost`: the create was sent and never took effect (nothing by
 * its name); `create_stopped` and `running_gone`: the sandbox it created stopped before any worker
 * ran in it; `command_lost`: the worker command was sent and never took effect; `command_sent`: it
 * took effect and the worker has not yet written a heartbeat; `worker_started`: the worker wrote its
 * first heartbeat. The `definite_`, `refused_` and `uncertain_` points end the start's failure paths
 * (a create refused before anything existed, a refused worker reservation, a create whose outcome is
 * unknown) after the named step. `launching_refused`: not an interruption; the earlier start finished
 * after the ledger refused the launching transition.
 */
const POINTS = [
  "after_slot",
  "after_record",
  "after_reservation",
  "after_started_event",
  "after_reserved_event",
  "after_launching",
  "create_lost",
  "create_live",
  "create_stopped",
  "after_running",
  "running_gone",
  "command_lost",
  "command_sent",
  "worker_started",
  "definite_after_terminal",
  "definite_after_settle",
  "definite_after_finish",
  "refused_after_finish",
  "uncertain_after_transition",
  "uncertain_after_finish",
  "launching_refused",
] as const;
type Point = (typeof POINTS)[number];

const NEVER: Promise<never> = new Promise<never>(() => undefined);

const TRANSITION_POINTS: Partial<Record<Point, OperationState>> = {
  after_launching: "launching",
  after_running: "running",
  running_gone: "running",
  definite_after_terminal: "terminal",
  uncertain_after_transition: "uncertain",
};
const FINISH_POINTS: ReadonlySet<Point> = new Set(["definite_after_finish", "refused_after_finish", "uncertain_after_finish"]);

interface Earlier {
  deps: FactoryLaunchDeps;
  /** Resolves when the earlier start reached its interruption point. */
  reached: Promise<void>;
  hit: () => boolean;
}

function stopSandbox(name: string): void {
  const instance = w.sandbox.sandboxes.get(name);
  if (instance === undefined) throw new Error(`synthetic: no sandbox ${name}`);
  instance.status = "stopped";
}

/** The earlier start's dependencies: the step at `point` takes effect and then never answers. */
function interrupted(point: Point, target: HeartbeatTarget, sandboxName: string): Earlier {
  let reachedPoint = false;
  let signal: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const end = <T>(): Promise<T> => {
    reachedPoint = true;
    signal();
    return NEVER;
  };
  const after = async <T>(call: Promise<T>, effect: () => void | Promise<void> = () => undefined): Promise<T> => {
    await call;
    await effect();
    return end<T>();
  };
  const spend = w.spend;
  const budgets = w.budgets;
  const records = w.records;
  const sandbox = w.sandbox;

  const ledgerSpend: Spend = {
    ...spend,
    acquireSlot: (request) => (point === "after_slot" ? after(spend.acquireSlot(request)) : spend.acquireSlot(request)),
    transition: (request) => {
      if (point === "launching_refused" && request.to_state === "launching") return Promise.resolve({ ok: false as const, code: "pool_halted" as const });
      if (TRANSITION_POINTS[point] === request.to_state) {
        return after(spend.transition(request), () => {
          if (point === "running_gone") stopSandbox(sandboxName);
        });
      }
      return spend.transition(request);
    },
    settle: (request) => (point === "definite_after_settle" ? after(spend.settle(request)) : spend.settle(request)),
  };
  const ledgerBudgets: FactoryBudgets = {
    reserve: (key, role, request) => (point === "after_reservation" ? after(budgets.reserve(key, role, request)) : budgets.reserve(key, role, request)),
    close: (key, cause) => budgets.close(key, cause),
    status: (key) => budgets.status(key),
  };
  const store: FactoryRecords = {
    request: (id) => records.request(id),
    appendEvent: (id, event, at) => {
      const here =
        (point === "after_started_event" && event.type === "validation_started") ||
        (point === "after_reserved_event" && event.type === "budget_updated" && event.event_key.endsWith(":reserved")) ||
        (FINISH_POINTS.has(point) && event.type === "request_finished");
      return here ? after(records.appendEvent(id, event, at)) : records.appendEvent(id, event, at);
    },
    events: (id) => records.events(id),
    recordHeartbeat: (beat, at) => records.recordHeartbeat(beat, at),
    lastHeartbeat: (beat) => records.lastHeartbeat(beat),
    stopRequested: (id) => records.stopRequested(id),
    recordValidation: (record) => (point === "after_record" ? after(records.recordValidation(record)) : records.recordValidation(record)),
    validation: (id) => records.validation(id),
    appendValidationEvent: (id, event, at) => (FINISH_POINTS.has(point) && event.type === "finished" ? after(records.appendValidationEvent(id, event, at)) : records.appendValidationEvent(id, event, at)),
    validationEvents: (id) => records.validationEvents(id),
    rootOwner: (root) => records.rootOwner(root),
  };
  const instance = (created: WorkerSandboxInstance): WorkerSandboxInstance => ({
    get name() {
      return created.name;
    },
    get status() {
      return created.status;
    },
    runCommand: (params) => {
      if (point === "command_lost") return end();
      if (point === "command_sent") return after(created.runCommand(params));
      if (point === "worker_started") return after(created.runCommand(params), () => records.recordHeartbeat(target, w.clock.now()));
      return created.runCommand(params);
    },
    stop: () => created.stop(),
  });
  const provider: WorkerSandboxSdk = {
    create: async (params) => {
      if (point === "create_lost") return end();
      if (point === "create_live") return after(sandbox.create(params));
      if (point === "create_stopped") {
        return after(sandbox.create(params), () => {
          stopSandbox(params.name);
        });
      }
      return instance(await sandbox.create(params));
    },
    get: (name) => sandbox.get(name),
  };
  return { deps: { ...deps(), ledger: { spend: ledgerSpend, budgets: ledgerBudgets }, records: store, sandbox: provider }, reached, hit: () => reachedPoint };
}

/** The provider's answer to the earlier start's create, and its budget. */
function conditions(point: Point): { createError: Error | null; budget: number } {
  if (point.startsWith("definite_")) return { createError: new SyntheticApiError(400), budget: 1_500_000 };
  if (point.startsWith("uncertain_")) return { createError: new SyntheticApiError(503), budget: 1_500_000 };
  if (point === "refused_after_finish") return { createError: null, budget: 100_000 };
  return { createError: null, budget: 1_500_000 };
}

/** Runs the earlier start up to its interruption point (or, for launching_refused, to its end). */
async function runEarlier(point: Point, start: (earlier: FactoryLaunchDeps) => Promise<unknown>, target: HeartbeatTarget, sandboxName: string): Promise<void> {
  const earlier = interrupted(point, target, sandboxName);
  const call = start(earlier.deps);
  if (point === "launching_refused") {
    await call;
    return;
  }
  await Promise.race([earlier.reached, call.then(() => undefined)]);
  expect(earlier.hit(), `the earlier start reached ${point}`).toBe(true);
}

interface Runs {
  creates: number;
  sandboxes: number;
  runs: number;
}

function providerCalls(): Runs {
  const runs = w.sandbox.calls.filter((call) => call.action === "run");
  // Every worker command is started under the run-once guard, so a re-sent command runs no second worker.
  for (const run of runs) {
    const detail = run.detail as { cmd: string; args: string[] };
    expect([detail.cmd, detail.args[2], detail.args[3]]).toEqual(["sh", "rbw-worker", WORKER_RUN_ONCE_DIR]);
  }
  return { creates: w.sandbox.count("create"), sandboxes: w.sandbox.sandboxes.size, runs: runs.length };
}

async function opStatus(operationId: string): Promise<{ state: OperationState; settled: bigint } | null> {
  const status = await w.spend.operationStatus({ operation_id: operationId });
  return status.ok ? { state: status.state, settled: status.settled_microusd } : null;
}

// Requests -------------------------------------------------------------------------------------

interface RequestRow {
  point: Point;
  /** The retry's answer; `any` where either is right (a re-sent guarded command or not). */
  result: WorkerStart["kind"] | "rejects" | "any";
  op: OperationState | null;
  slot: "held" | "released";
  stop: StopCode | null;
  closed: StopCode | null;
  creates: number;
  /** Whether a worker command reached the request's sandbox; `once` when exactly one may. */
  worker: "runs" | "once" | "none";
}

const REQUEST_ROWS: RequestRow[] = [
  { point: "after_slot", result: "rejects", op: null, slot: "held", stop: null, closed: null, creates: 0, worker: "none" },
  { point: "after_record", result: "launched", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "after_reservation", result: "launched", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "after_reserved_event", result: "launched", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "after_launching", result: "launched", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "create_lost", result: "launched", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "create_live", result: "launched", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "create_stopped", result: "uncertain", op: "uncertain", slot: "held", stop: "needs_reconciliation", closed: "needs_reconciliation", creates: 1, worker: "none" },
  { point: "after_running", result: "launched", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "running_gone", result: "uncertain", op: "uncertain", slot: "held", stop: "needs_reconciliation", closed: "needs_reconciliation", creates: 1, worker: "none" },
  { point: "command_lost", result: "launched", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "command_sent", result: "any", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "runs" },
  { point: "worker_started", result: "replay", op: "running", slot: "held", stop: null, closed: null, creates: 1, worker: "once" },
  { point: "definite_after_terminal", result: "create_failed", op: "reconciled", slot: "released", stop: "operational_error", closed: "operational_error", creates: 1, worker: "none" },
  { point: "definite_after_settle", result: "create_failed", op: "reconciled", slot: "released", stop: "operational_error", closed: "operational_error", creates: 1, worker: "none" },
  { point: "definite_after_finish", result: "replay", op: "reconciled", slot: "released", stop: "operational_error", closed: "operational_error", creates: 1, worker: "none" },
  { point: "refused_after_finish", result: "replay", op: null, slot: "released", stop: "operational_error", closed: "operational_error", creates: 0, worker: "none" },
  { point: "uncertain_after_transition", result: "uncertain", op: "uncertain", slot: "held", stop: "needs_reconciliation", closed: "needs_reconciliation", creates: 1, worker: "none" },
  { point: "uncertain_after_finish", result: "replay", op: "uncertain", slot: "held", stop: "needs_reconciliation", closed: "needs_reconciliation", creates: 1, worker: "none" },
  { point: "launching_refused", result: "replay", op: "prepared", slot: "held", stop: "needs_reconciliation", closed: "needs_reconciliation", creates: 0, worker: "none" },
];

describe("startFactoryWorker resumes an interrupted start from what it recorded", () => {
  it("has a row for every interruption point but the validation run's own record steps", () => {
    expect(REQUEST_ROWS.map((row) => row.point)).toEqual(POINTS.filter((point) => point !== "after_started_event"));
  });

  it.each(REQUEST_ROWS)("$point", async (row) => {
    const requestId = syntheticUuid("7100");
    const root = w.identity.requestRoot(requestId);
    const { createError, budget } = conditions(row.point);
    let record: FactoryRequestRecord | null = null;
    if (row.point === "after_slot") {
      // The service took the slot and ended before it recorded the request.
      expect((await w.spend.acquireSlot({ slot_key: "factory", root_execution_id: root, actor_role: "factory-route" })).ok).toBe(true);
    } else {
      record = await acceptRequest(w, { requestId, budget });
      if (row.point !== "after_record") {
        w.sandbox.createError = createError;
        await runEarlier(row.point, (earlier) => startFactoryWorker(earlier, requestId), { request_id: requestId }, workerSandboxName(root));
        w.sandbox.createError = null;
      }
    }

    if (row.result === "rejects") {
      await expect(startFactoryWorker(deps(), requestId)).rejects.toThrow(LaunchConfigError);
    } else {
      const retried = await startFactoryWorker(deps(), requestId);
      if (row.result !== "any") expect(retried.kind).toBe(row.result);
    }

    const op = record === null ? null : await opStatus(workerOperation({ identity: w.identity, rates: w.rates }, record).operation_id);
    expect(op?.state ?? null).toBe(row.op);
    if (row.op === "reconciled") expect(op?.settled).toBe(0n);
    expect(await slotHolder(w)).toBe(row.slot === "held" ? root : null);
    const events = w.records.eventLog.get(requestId) ?? [];
    const finishes = events.filter((event) => event.type === "request_finished");
    expect(finishes.map((event) => event.data.stop_code)).toEqual(row.stop === null ? [] : [row.stop]);
    if (row.stop === "needs_reconciliation") expect(events.filter((event) => event.type === "attention").map((event) => event.data.code)).toEqual(["needs_reconciliation"]);
    expect(w.budgets.closes.map((close) => close.cause)).toEqual(row.closed === null ? [] : [row.closed]);
    expect(events.filter((event) => event.event_key === "worker:reserved").length).toBeLessThanOrEqual(1);

    const calls = providerCalls();
    expect(calls.creates).toBe(row.creates);
    expect(calls.sandboxes).toBeLessThanOrEqual(1);
    if (row.worker === "none") expect(calls.runs).toBe(0);
    else if (row.worker === "once") expect(calls.runs).toBe(1);
    else expect(calls.runs).toBeGreaterThanOrEqual(1);
    if (row.worker !== "none") expect(w.sandbox.sandboxes.get(workerSandboxName(root))?.status).toBe("running");
  });
});

// Validation runs -------------------------------------------------------------------------------

interface ValidationRow {
  point: Point;
  state: "queued" | "finished";
  /** The finished run's cost: null while its spend needs reconciliation. */
  cost: number | null;
  op: OperationState;
  slot: "held" | "released";
  creates: number;
  worker: "runs" | "once" | "none";
}

const VALIDATION_ROWS: ValidationRow[] = [
  { point: "after_slot", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "after_record", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "after_reservation", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "after_started_event", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "after_reserved_event", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "after_launching", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "create_lost", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "create_live", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "create_stopped", state: "finished", cost: null, op: "uncertain", slot: "held", creates: 1, worker: "none" },
  { point: "after_running", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "running_gone", state: "finished", cost: null, op: "uncertain", slot: "held", creates: 1, worker: "none" },
  { point: "command_lost", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "command_sent", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "runs" },
  { point: "worker_started", state: "queued", cost: null, op: "running", slot: "held", creates: 1, worker: "once" },
  { point: "definite_after_terminal", state: "finished", cost: 0, op: "reconciled", slot: "released", creates: 1, worker: "none" },
  { point: "definite_after_settle", state: "finished", cost: 0, op: "reconciled", slot: "released", creates: 1, worker: "none" },
  { point: "definite_after_finish", state: "finished", cost: 0, op: "reconciled", slot: "released", creates: 1, worker: "none" },
  { point: "uncertain_after_transition", state: "finished", cost: null, op: "uncertain", slot: "held", creates: 1, worker: "none" },
  { point: "uncertain_after_finish", state: "finished", cost: null, op: "uncertain", slot: "held", creates: 1, worker: "none" },
  { point: "launching_refused", state: "finished", cost: null, op: "prepared", slot: "held", creates: 0, worker: "none" },
];

describe("startFactoryValidation resumes an interrupted start from what it recorded", () => {
  it("has a row for every interruption point but the request's refused reservation", () => {
    expect(VALIDATION_ROWS.map((row) => row.point)).toEqual(POINTS.filter((point) => point !== "refused_after_finish"));
  });

  it.each(VALIDATION_ROWS)("$point", async (row) => {
    // The request ran and finished: its slot is released and its budget closed.
    const request = await acceptRequest(w);
    expect((await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: request.root, actor_role: "factory-worker", evidence: null, reason: null })).ok).toBe(true);
    await w.budgets.close(request.budget_key, "fulfilled");
    await w.records.appendEvent(request.request_id, { event_key: "finish", type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request finished: fulfilled.", data: { outcome: "fulfilled", stop_code: "fulfilled" } }, w.clock.now());

    const validationId = syntheticUuid("7200");
    const root = w.identity.validationRoot(validationId);
    const args: ValidationStartArgs = { request_id: request.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol: PROTOCOL };
    w.sandbox.createError = conditions(row.point).createError;
    await runEarlier(row.point, (earlier) => startFactoryValidation(earlier, args), { validation_id: validationId }, validationSandboxName(root));
    w.sandbox.createError = null;

    const retried = await startFactoryValidation(deps(), args);
    if (retried.kind !== "accepted") throw new Error(`synthetic: the retried start answered ${retried.kind}`);
    expect(retried.run.state).toBe(row.state);
    expect(retried.run.result).toBe(row.state === "finished" ? "error" : null);
    expect(retried.run.cost_microusd).toBe(row.state === "finished" ? row.cost : null);

    const op = await opStatus(validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report", copies: 3 }).operation_id);
    expect(op?.state).toBe(row.op);
    if (row.op === "reconciled") expect(op?.settled).toBe(0n);
    expect(await slotHolder(w)).toBe(row.slot === "held" ? root : null);

    // The request's history says what the run's record says, each event once.
    const keys = (w.records.eventLog.get(request.request_id) ?? []).map((event) => event.event_key);
    const count = (key: string): number => keys.filter((item) => item === key).length;
    expect(count(`validation:${validationId}:started`)).toBe(1);
    expect(count(`validation:${validationId}:reserved`)).toBe(1);
    expect(count(`validation:${validationId}:finished`)).toBe(row.state === "finished" ? 1 : 0);
    expect(count(`validation:${validationId}:attention`)).toBe(row.state === "finished" && row.cost === null ? 1 : 0);
    expect(keys.indexOf(`validation:${validationId}:started`)).toBeLessThan(keys.indexOf(`validation:${validationId}:reserved`));

    const calls = providerCalls();
    expect(calls.creates).toBe(row.creates);
    expect(calls.sandboxes).toBeLessThanOrEqual(1);
    if (row.worker === "none") expect(calls.runs).toBe(0);
    else if (row.worker === "once") expect(calls.runs).toBe(1);
    else expect(calls.runs).toBeGreaterThanOrEqual(1);
    if (row.worker !== "none") expect(w.sandbox.sandboxes.get(validationSandboxName(root))?.status).toBe("running");
  });
});

describe("a start repeated after another routine ended the operation", () => {
  it("leaves a run's operation that was recorded running, then ended by the lost-worker routine, to that routine's settlement", async () => {
    const request = await acceptRequest(w);
    expect((await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: request.root, actor_role: "factory-worker", evidence: null, reason: null })).ok).toBe(true);
    const validationId = syntheticUuid("7300");
    const root = w.identity.validationRoot(validationId);
    const args: ValidationStartArgs = { request_id: request.request_id, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol: PROTOCOL };
    await runEarlier("after_running", (earlier) => startFactoryValidation(earlier, args), { validation_id: validationId }, validationSandboxName(root));
    const op = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report", copies: 3 });
    // The lost-worker routine confirmed the sandbox stopped and ended the operation, and stopped before it settled;
    // the provider no longer lists the sandbox.
    expect((await w.spend.transition({ operation_id: op.operation_id, from_state: "running", to_state: "terminal", actor_role: "factory-route", terminal_status: "failed" })).ok).toBe(true);
    w.sandbox.sandboxes.delete(validationSandboxName(root));

    const retried = await startFactoryValidation(deps(), args);
    expect(retried.kind === "accepted" && retried.run.state).toBe("queued");
    expect((await opStatus(op.operation_id))?.state).toBe("terminal");
    expect(await slotHolder(w)).toBe(root);
    expect(w.sandbox.count("create")).toBe(1);
  });
});

// Starts that overlap -------------------------------------------------------------------------

async function until(condition: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let tries = 0; tries < 500; tries += 1) {
    if (await condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

describe("a resumed start that overlaps the earlier one", () => {
  it("creates one sandbox and runs one worker when the earlier start's create is still in flight", async () => {
    const record = await acceptRequest(w);
    let open: () => void = () => undefined;
    w.sandbox.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const op = workerOperation({ identity: w.identity, rates: w.rates }, record);
    const first = startFactoryWorker(deps(), record.request_id);
    // The earlier start moved its operation to launching and is waiting for its create.
    expect(await until(async () => (await opStatus(op.operation_id))?.state === "launching" && w.sandbox.count("create") === 1)).toBe(true);
    const second = startFactoryWorker(deps(), record.request_id);
    // The later start finds nothing by the name yet and sends its own create, which the provider refuses on the name.
    const sent = await until(() => w.sandbox.count("create") === 2);
    open();
    const results = await Promise.all([first, second]);
    expect(sent).toBe(true);

    expect(results.map((result) => result.kind).sort()).toEqual(["launched", "replay"]);
    expect((await opStatus(op.operation_id))?.state).toBe("running");
    const calls = providerCalls();
    expect([calls.sandboxes, calls.runs]).toEqual([1, 1]);
    expect(w.sandbox.calls.filter((call) => call.action === "stop")).toEqual([]);
    expect(w.records.types(record.request_id)).not.toContain("request_finished");
    expect(await slotHolder(w)).toBe(record.root);
  });
});
