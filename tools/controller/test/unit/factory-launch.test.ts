import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import { validationOperation, workerOperation, workerSandboxName } from "../../src/factory-ledger.ts";
import { startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps, ValidationStartArgs } from "../../src/factory-launch.ts";
import type { WorkerSandboxCreateParams } from "../../src/factory-ports.ts";
import { CASE_ID, CREDENTIALS, SyntheticApiError, WORKER_IMAGE, acceptRequest, factoryWorld, operationState, slotHolder, syntheticUuid } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";

let w: FactoryWorld;

beforeEach(async () => {
  w = await factoryWorld();
});

afterEach(async () => {
  await w.close();
});

function deps(overrides: Partial<FactoryLaunchDeps> = {}): FactoryLaunchDeps {
  return {
    ledger: w.ledger,
    records: w.records,
    identity: w.identity,
    sandbox: w.sandbox,
    rates: w.rates,
    now: w.clock.now,
    launch: { image: WORKER_IMAGE, env: CREDENTIALS },
    log: (line) => w.logs.push(line),
    ...overrides,
  };
}

function workerOp(record: { root: string; interpretation_sha256: string }) {
  return workerOperation({ identity: w.identity, rates: w.rates }, record, WORKER_IMAGE);
}

describe("startFactoryWorker", () => {
  it("reserves the worker's worst case on the request budget, then creates one pinned worker sandbox and starts the worker detached", async () => {
    const record = await acceptRequest(w);
    const started = await startFactoryWorker(deps(), record.request_id);
    expect(started).toEqual({ kind: "launched", sandbox: workerSandboxName(record.root) });

    const op = workerOp(record);
    expect(await operationState(w, op.operation_id)).toBe("running");
    const status = await w.ledger.budgets.status(record.budget_key);
    expect(status.ok && status.open_microusd).toBe(BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd));

    const create = w.sandbox.calls.find((call) => call.action === "create");
    const params = create?.detail as WorkerSandboxCreateParams;
    expect(params.name).toBe(`rbw-fw-${record.root}`);
    expect(params.image).toBe(WORKER_IMAGE);
    expect(params.networkPolicy).toBe("allow-all");
    expect(params.timeout).toBe(FACTORY_PROFILE.worker.timeout_s * 1000);
    expect(params.resources.vcpus).toBe(FACTORY_PROFILE.worker.vcpus);
    expect(params.env).toMatchObject(CREDENTIALS);
    const run = w.sandbox.calls.find((call) => call.action === "run")?.detail as { args: string[]; detached: boolean };
    expect(run.detached).toBe(true);
    expect(run.args.slice(1, 4)).toEqual(["factory-worker", "--request-id", record.request_id]);
    expect(run.args).toContain("--deadline-at");
    // The credentials reach the sandbox as environment values, never as command arguments.
    expect(JSON.stringify(run.args)).not.toContain(CREDENTIALS.VERCEL_TOKEN);

    const events = await w.records.events(record.request_id);
    expect(events.map((event) => event.type)).toEqual(["request_accepted", "budget_updated"]);
    expect(events[1]?.data).toEqual({ reserved_microusd: FACTORY_PROFILE.prices.worker_worst_case_microusd, spent_microusd: 0, remaining_microusd: 1_500_000 - FACTORY_PROFILE.prices.worker_worst_case_microusd });
  });

  it("launches one worker for duplicate and concurrent starts of one request", async () => {
    const record = await acceptRequest(w);
    let open: () => void = () => undefined;
    w.sandbox.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pending = [startFactoryWorker(deps(), record.request_id), startFactoryWorker(deps(), record.request_id), startFactoryWorker(deps(), record.request_id)];
    await new Promise((resolve) => setTimeout(resolve, 50));
    open();
    const results = await Promise.all(pending);
    const again = await startFactoryWorker(deps(), record.request_id);
    expect(w.sandbox.count("create")).toBe(1);
    expect(w.sandbox.count("run")).toBe(1);
    expect(results.filter((result) => result.kind === "launched")).toHaveLength(1);
    expect([...results, again].filter((result) => result.kind !== "launched").every((result) => result.kind === "replay")).toBe(true);
    expect((await w.records.events(record.request_id)).filter((event) => event.type === "budget_updated")).toHaveLength(1);
  });

  it("refuses a worker image that is not pinned by digest, before reserving anything", async () => {
    const record = await acceptRequest(w);
    await expect(startFactoryWorker(deps({ launch: { image: "synthetic/rbw-factory-worker:latest", env: CREDENTIALS } }), record.request_id)).rejects.toThrow(/digest/);
    expect(await operationState(w, workerOp(record).operation_id)).toBeNull();
    expect(w.sandbox.count("create")).toBe(0);
  });

  it("finishes the request operational_error and releases the slot at once when the worker reservation is refused", async () => {
    const record = await acceptRequest(w, { budget: 100_000 });
    const started = await startFactoryWorker(deps(), record.request_id);
    expect(started).toEqual({ kind: "refused", code: "budget_exhausted" });
    expect(w.sandbox.count("create")).toBe(0);
    expect(await slotHolder(w)).toBeNull();
    const events = await w.records.events(record.request_id);
    expect(events.at(-1)?.type).toBe("request_finished");
    expect(events.at(-1)?.data).toEqual({ outcome: "operational_error", stop_code: "operational_error" });
    expect(w.budgets.closes).toEqual([{ budget_key: record.budget_key, cause: "operational_error" }]);
  });

  it("treats a create refused before anything existed (4xx, nothing by that name) as definite: settled at zero, finished, slot released", async () => {
    const record = await acceptRequest(w);
    w.sandbox.createError = new SyntheticApiError(400);
    const started = await startFactoryWorker(deps(), record.request_id);
    expect(started).toEqual({ kind: "create_failed" });
    const op = workerOp(record);
    const status = await w.spend.operationStatus({ operation_id: op.operation_id });
    expect(status.ok && status.state).toBe("reconciled");
    expect(status.ok && status.settled_microusd).toBe(0n);
    expect(await slotHolder(w)).toBeNull();
    const events = await w.records.events(record.request_id);
    expect(events.at(-1)?.data).toEqual({ outcome: "operational_error", stop_code: "operational_error" });
    expect(events.some((event) => event.type === "attention")).toBe(false);
  });

  it("records an uncertain create (5xx) as uncertain, holds the slot and never retries it", async () => {
    const record = await acceptRequest(w);
    w.sandbox.createError = new SyntheticApiError(503);
    const started = await startFactoryWorker(deps(), record.request_id);
    expect(started.kind).toBe("uncertain");
    const op = workerOp(record);
    expect(await operationState(w, op.operation_id)).toBe("uncertain");
    expect(await slotHolder(w)).toBe(record.root);
    const events = await w.records.events(record.request_id);
    expect(events.slice(-2).map((event) => [event.type, event.data])).toEqual([
      ["attention", { code: "needs_reconciliation" }],
      ["request_finished", { outcome: "operational_error", stop_code: "needs_reconciliation" }],
    ]);
    w.sandbox.createError = null;
    expect((await startFactoryWorker(deps(), record.request_id)).kind).toBe("replay");
    expect(w.sandbox.count("create")).toBe(1);
  });

  it("treats a 4xx create whose name lookup finds a sandbox, or a network error, as uncertain and stops what it can", async () => {
    const record = await acceptRequest(w);
    w.sandbox.createError = new SyntheticApiError(400);
    w.sandbox.createdAnyway = true;
    expect((await startFactoryWorker(deps(), record.request_id)).kind).toBe("uncertain");
    expect(w.sandbox.count("stop")).toBe(1);
    expect(await slotHolder(w)).toBe(record.root);

    const w2 = await factoryWorld();
    try {
      const other = await acceptRequest(w2);
      w2.sandbox.createError = new TypeError("fetch failed");
      const started = await startFactoryWorker({ ...deps(), ledger: w2.ledger, records: w2.records, identity: w2.identity, sandbox: w2.sandbox, now: w2.clock.now }, other.request_id);
      expect(started.kind).toBe("uncertain");
    } finally {
      await w2.close();
    }
  });

  it("leaves the worker uncertain when its command cannot be started after the create", async () => {
    const record = await acceptRequest(w);
    w.sandbox.failRun = true;
    expect((await startFactoryWorker(deps(), record.request_id)).kind).toBe("uncertain");
    expect(await operationState(w, workerOp(record).operation_id)).toBe("uncertain");
    expect(w.sandbox.count("stop")).toBe(1);
    expect(await slotHolder(w)).toBe(record.root);
  });
});

describe("startFactoryValidation", () => {
  async function finishedRequest(budget = 1_500_000) {
    const record = await acceptRequest(w, { budget });
    // The request ran and finished: its slot is released and its budget closed.
    const released = await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: record.root, actor_role: "factory-worker", evidence: null, reason: null });
    expect(released.ok).toBe(true);
    await w.budgets.close(record.budget_key, "fulfilled");
    await w.records.appendEvent(record.request_id, { event_key: "finish", type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request finished: fulfilled.", data: { outcome: "fulfilled", stop_code: "fulfilled" } }, w.clock.now());
    return record;
  }

  function args(requestId: string, validationId = syntheticUuid("7000")): ValidationStartArgs {
    return { request_id: requestId, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" } };
  }

  it("takes the slot, reserves the host's validation worst case on the request budget after it closed, records the run and launches its worker", async () => {
    const record = await finishedRequest();
    const a = args(record.request_id);
    const started = await startFactoryValidation(deps(), a);
    expect(started.kind).toBe("accepted");
    if (started.kind !== "accepted") return;
    expect(started.run.validation_id).toBe(a.validation_id);
    expect(started.run.state).toBe("queued");
    expect(started.run.cost_microusd).toBeNull();
    const root = w.identity.validationRoot(a.validation_id);
    expect(await slotHolder(w)).toBe(root);
    const op = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report" }, WORKER_IMAGE);
    const status = await w.spend.operationStatus({ operation_id: op.operation_id });
    expect(status.ok && status.state).toBe("running");
    expect(status.ok && status.reserved_microusd).toBe(BigInt(FACTORY_PROFILE.prices.validation_worst_case_microusd["task-report"]));
    const budget = await w.ledger.budgets.status(record.budget_key);
    expect(budget.ok && budget.open_microusd).toBe(BigInt(FACTORY_PROFILE.prices.validation_worst_case_microusd["task-report"]));
    expect((await w.records.validation(a.validation_id))?.root).toBe(root);
    expect(w.records.types(record.request_id).slice(-2)).toEqual(["validation_started", "budget_updated"]);
    const create = w.sandbox.calls.find((call) => call.action === "create")?.detail as WorkerSandboxCreateParams;
    expect(create.name).toBe(`rbw-fv-${root}`);
    expect(create.timeout).toBe(FACTORY_PROFILE.validation.worker.timeout_s * 1000);
    const run = w.sandbox.calls.find((call) => call.action === "run")?.detail as { args: string[] };
    expect(run.args.slice(1, 4)).toEqual(["factory-worker", "--validation-id", a.validation_id]);
    // A request-role reserve on the closed budget is still refused.
    const refused = await w.ledger.budgets.reserve(record.budget_key, "request", workerOp(record).request);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.code).toBe("budget_closed");
  });

  it("answers busy while the request holds the slot, recording and reserving nothing", async () => {
    const record = await acceptRequest(w);
    await startFactoryWorker(deps(), record.request_id);
    const a = args(record.request_id);
    expect(await startFactoryValidation(deps(), a)).toEqual({ kind: "busy", reason: "active" });
    expect(await w.records.validation(a.validation_id)).toBeNull();
    expect(w.budgets.refusals).toEqual([]);
    expect(w.records.types(record.request_id)).not.toContain("validation_started");
    expect(await slotHolder(w)).toBe(record.root);
  });

  it("answers busy needs_reconciliation when the slot's holder has an uncertain operation", async () => {
    const record = await acceptRequest(w);
    w.sandbox.createError = new SyntheticApiError(500);
    await startFactoryWorker(deps(), record.request_id);
    expect(await startFactoryValidation(deps(), args(record.request_id))).toEqual({ kind: "busy", reason: "needs_reconciliation" });
  });

  it("answers budget_unavailable when the remaining budget cannot cover the worst case, releasing the slot and recording nothing", async () => {
    const record = await finishedRequest(500_000);
    const a = args(record.request_id);
    expect(await startFactoryValidation(deps(), a)).toEqual({ kind: "budget_unavailable" });
    expect(await slotHolder(w)).toBeNull();
    expect(await w.records.validation(a.validation_id)).toBeNull();
    expect(w.records.types(record.request_id)).not.toContain("validation_started");
    expect(w.sandbox.count("create")).toBe(0);
  });

  it("finishes the run error, settles zero and releases the slot when its worker create is refused definitely", async () => {
    const record = await finishedRequest();
    w.sandbox.createError = new SyntheticApiError(422);
    const a = args(record.request_id);
    const started = await startFactoryValidation(deps(), a);
    expect(started.kind).toBe("accepted");
    if (started.kind !== "accepted") return;
    expect(started.run.state).toBe("finished");
    expect(started.run.result).toBe("error");
    expect(started.run.cost_microusd).toBe(0);
    expect(await slotHolder(w)).toBeNull();
    expect(w.records.types(record.request_id).slice(-4)).toEqual(["validation_started", "budget_updated", "validation_finished", "budget_updated"]);
    const finished = (await w.records.events(record.request_id)).find((event) => event.type === "validation_finished");
    expect(finished?.data).toEqual({ validation_id: a.validation_id, result: "error" });
  });

  it("keeps an uncertain validation launch held for reconciliation", async () => {
    const record = await finishedRequest();
    w.sandbox.createError = new SyntheticApiError(504);
    const a = args(record.request_id);
    const started = await startFactoryValidation(deps(), a);
    expect(started.kind === "accepted" && started.run.result).toBe("error");
    expect(started.kind === "accepted" && started.run.cost_microusd).toBeNull();
    expect(await slotHolder(w)).toBe(w.identity.validationRoot(a.validation_id));
    const attention = (await w.records.events(record.request_id)).filter((event) => event.type === "attention");
    expect(attention.map((event) => event.data)).toEqual([{ code: "needs_reconciliation" }]);
  });
});
