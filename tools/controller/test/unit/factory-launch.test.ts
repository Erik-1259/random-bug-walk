import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateContract } from "@rbw/factory-contract/validate";
import { FACTORY_PROFILE } from "../../src/factory-profile.ts";
import { validationOperation, workerOperation, workerSandboxName } from "../../src/factory-ledger.ts";
import { WORKER_REPOSITORY, WORKER_RUN_ONCE_DIR, startFactoryValidation, startFactoryWorker } from "../../src/factory-launch.ts";
import { RUN_ONCE_SCRIPT } from "../../src/factory-run-once.ts";
import { copyRegistryFrom } from "../../src/factory-sandbox-runner.ts";
import { runFactoryValidation } from "../../src/factory-worker.ts";
import type { FactoryLaunchDeps, ValidationStartArgs } from "../../src/factory-launch.ts";
import type { WorkerSandboxCreateParams } from "../../src/factory-ports.ts";
import { CASE_ID, CREDENTIALS, PROTOCOL, SyntheticApiError, VALIDATION_3_MICROUSD, WORKER_IMAGE, acceptRequest, factoryWorld, operationState, simulateWorkerStart, slotHolder, syntheticUuid } from "./factory-fakes.ts";
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
  return workerOperation({ identity: w.identity, rates: w.rates }, record);
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
    expect(run.args.slice(6, 9)).toEqual(["factory-worker", "--request-id", record.request_id]);
    expect(run.args).toContain("--deadline-at");
    // The credentials reach the sandbox as environment values, never as command arguments.
    expect(JSON.stringify(run.args)).not.toContain(CREDENTIALS.VERCEL_TOKEN);

    const events = await w.records.events(record.request_id);
    expect(events.map((event) => event.type)).toEqual(["request_accepted", "budget_updated"]);
    expect(events[1]?.data).toEqual({ reserved_microusd: FACTORY_PROFILE.prices.worker_worst_case_microusd, spent_microusd: 0, remaining_microusd: 1_500_000 - FACTORY_PROFILE.prices.worker_worst_case_microusd });
  });

  it("gives the worker sandbox its own image reference as RBW_FACTORY_WORKER_IMAGE, over any value in launch.env", async () => {
    const record = await acceptRequest(w);
    const stale = `synthetic-team/other-project/rbw-factory-worker@sha256:${"cd".repeat(32)}`;
    expect((await startFactoryWorker(deps({ launch: { image: WORKER_IMAGE, env: { ...CREDENTIALS, RBW_FACTORY_WORKER_IMAGE: stale } } }), record.request_id)).kind).toBe("launched");
    const params = w.sandbox.calls.find((call) => call.action === "create")?.detail as WorkerSandboxCreateParams;
    expect(params.env.RBW_FACTORY_WORKER_IMAGE).toBe(WORKER_IMAGE);
    // The worker reads its copy registry namespace from that value.
    expect(copyRegistryFrom(params.env.RBW_FACTORY_WORKER_IMAGE)).toBe("synthetic-team/synthetic-project");
  });

  it("starts the worker command under the run-once guard, so a start the SDK replays runs one worker", { timeout: 20_000 }, async () => {
    const record = await acceptRequest(w);
    expect((await startFactoryWorker(deps(), record.request_id)).kind).toBe("launched");
    const run = w.sandbox.calls.find((call) => call.action === "run")?.detail as { cmd: string; args: string[]; cwd: string };
    expect([run.cmd, ...run.args.slice(0, 4)]).toEqual(["sh", "-c", RUN_ONCE_SCRIPT, "rbw-worker", WORKER_RUN_ONCE_DIR]);
    expect(run.args.slice(4, 9)).toEqual(["/usr/local/bin/node", `${WORKER_REPOSITORY}/tools/controller/src/cli.ts`, "factory-worker", "--request-id", record.request_id]);
    expect(run.cwd).toBe(WORKER_REPOSITORY);
    // The started guard, started twice as a replayed start is (a local lock directory and a counting command in place of the worker): one run.
    const base = mkdtempSync(join(tmpdir(), "rbw-worker-once-test-"));
    const count = join(base, "count");
    const start = (): Promise<number | null> =>
      new Promise((resolve, reject) => {
        const child = spawn(run.cmd, [...run.args.slice(0, 3), join(base, "once"), "sh", "-c", 'echo ran >> "$1"; sleep 1', "synthetic-worker", count], { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", resolve);
      });
    expect(await Promise.all([start(), start()])).toEqual([0, 0]);
    expect(readFileSync(count, "utf8")).toBe("ran\n");
  });

  it("launches one worker for duplicate and concurrent starts of one request", async () => {
    const record = await acceptRequest(w);
    simulateWorkerStart(w);
    let open: () => void = () => undefined;
    w.sandbox.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pending = [startFactoryWorker(deps(), record.request_id), startFactoryWorker(deps(), record.request_id), startFactoryWorker(deps(), record.request_id)];
    await new Promise((resolve) => setTimeout(resolve, 50));
    open();
    const results = await Promise.all(pending);
    const creates = w.sandbox.count("create");
    const again = await startFactoryWorker(deps(), record.request_id);
    // A start that overlaps one still creating finds nothing under the name and creates under it too: the
    // provider refuses that second create on the name, so one sandbox exists. A start after the worker began sends none.
    expect(w.sandbox.sandboxes.size).toBe(1);
    expect(w.sandbox.count("create")).toBe(creates);
    expect(w.sandbox.count("stop")).toBe(0);
    expect(w.sandbox.count("run")).toBe(1);
    expect(results.filter((result) => result.kind === "launched")).toHaveLength(1);
    expect([...results, again].filter((result) => result.kind !== "launched").every((result) => result.kind === "replay")).toBe(true);
    expect((await w.records.events(record.request_id)).filter((event) => event.type === "budget_updated")).toHaveLength(1);
  });

  it("launches a worker whose reservation an earlier start made but never launched", async () => {
    const record = await acceptRequest(w);
    const reserved = await w.ledger.budgets.reserve(record.budget_key, "request", workerOp(record).request);
    expect(reserved.ok && reserved.state).toBe("prepared");
    expect(await startFactoryWorker(deps(), record.request_id)).toEqual({ kind: "launched", sandbox: workerSandboxName(record.root) });
    expect(w.sandbox.count("create")).toBe(1);
  });

  it("never launches a worker for a request that already finished, even with its operation still prepared", async () => {
    const record = await acceptRequest(w);
    expect((await w.ledger.budgets.reserve(record.budget_key, "request", workerOp(record).request)).ok).toBe(true);
    await w.records.appendEvent(record.request_id, { event_key: "finish", type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request finished: operational error.", data: { outcome: "operational_error", stop_code: "needs_reconciliation" } }, w.clock.now());
    expect(await startFactoryWorker(deps(), record.request_id)).toEqual({ kind: "replay" });
    expect(w.sandbox.count("create")).toBe(0);
    expect(await operationState(w, workerOp(record).operation_id)).toBe("prepared");
  });

  it("never finishes a request over a conflicting or replayed worker operation, such as a start after a redeploy with another image", async () => {
    const record = await acceptRequest(w);
    simulateWorkerStart(w);
    expect((await startFactoryWorker(deps(), record.request_id)).kind).toBe("launched");
    const other = `synthetic-team/synthetic-project/rbw-factory-worker@sha256:${"cd".repeat(32)}`;
    expect(await startFactoryWorker(deps({ launch: { image: other, env: CREDENTIALS } }), record.request_id)).toEqual({ kind: "replay" });

    expect(w.records.types(record.request_id)).not.toContain("request_finished");
    expect(w.sandbox.count("create")).toBe(1);

    const w2 = await factoryWorld();
    try {
      const second = await acceptRequest(w2);
      const op = workerOperation({ identity: w2.identity, rates: w2.rates }, second);
      expect((await w2.spend.reserve({ ...op.request, payload_hash: "9".repeat(64) })).ok).toBe(true);
      const started = await startFactoryWorker({ ...deps(), ledger: w2.ledger, records: w2.records, identity: w2.identity, sandbox: w2.sandbox, now: w2.clock.now }, second.request_id);
      expect(started).toEqual({ kind: "replay" });
      expect(w2.records.types(second.request_id)).not.toContain("request_finished");
      expect(w2.budgets.closes).toEqual([]);
      expect(w2.sandbox.count("create")).toBe(0);
    } finally {
      await w2.close();
    }
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

  it("treats a 409 or 429 create with nothing found by its name as uncertain, never definite: the slot stays held", async () => {
    for (const code of [409, 429]) {
      const world = await factoryWorld();
      try {
        const record = await acceptRequest(world);
        world.sandbox.createError = new SyntheticApiError(code);
        const started = await startFactoryWorker({ ...deps(), ledger: world.ledger, records: world.records, identity: world.identity, sandbox: world.sandbox, now: world.clock.now }, record.request_id);
        expect(started.kind).toBe("uncertain");
        expect(await operationState(world, workerOperation({ identity: world.identity, rates: world.rates }, record).operation_id)).toBe("uncertain");
        const slot = await world.spend.slotStatus({ slot_key: "factory" });
        expect(slot.ok && slot.holder).toBe(record.root);
        expect((await world.records.events(record.request_id)).at(-1)?.data).toEqual({ outcome: "operational_error", stop_code: "needs_reconciliation" });
      } finally {
        await world.close();
      }
    }
  });

  it("answers busy needs_reconciliation after a worker launch whose launching transition was refused, which leaves its reservation prepared", async () => {
    const record = await acceptRequest(w);
    const transition = w.spend.transition.bind(w.spend);
    w.ledger.spend = { ...w.spend, transition: (request) => (request.to_state === "launching" ? Promise.resolve({ ok: false as const, code: "pool_halted" as const }) : transition(request)) };
    expect((await startFactoryWorker(deps(), record.request_id)).kind).toBe("uncertain");
    w.ledger.spend = w.spend;
    expect(await operationState(w, workerOp(record).operation_id)).toBe("prepared");
    expect(w.sandbox.count("create")).toBe(0);
    expect(await slotHolder(w)).toBe(record.root);
    const validation = { request_id: record.request_id, case_id: CASE_ID, validation_id: syntheticUuid("7010"), host_id: "task-report" as const, package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate" as const, version: "1" }, protocol: PROTOCOL };
    expect(await startFactoryValidation(deps(), validation)).toEqual({ kind: "busy", reason: "needs_reconciliation" });
  });

  it("still releases the slot when the budget close is refused after a refused worker reservation", async () => {
    const record = await acceptRequest(w, { budget: 100_000 });
    w.ledger.budgets = { reserve: (key, role, request) => w.budgets.reserve(key, role, request), close: () => Promise.resolve({ ok: false as const, code: "idempotency_conflict" }), status: (key) => w.budgets.status(key) };
    expect(await startFactoryWorker(deps(), record.request_id)).toEqual({ kind: "refused", code: "budget_exhausted" });
    expect(await slotHolder(w)).toBeNull();
    expect(w.records.types(record.request_id).at(-1)).toBe("request_finished");
    expect(w.logs.some((line) => line.includes("idempotency_conflict"))).toBe(true);
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
    return { request_id: requestId, case_id: CASE_ID, validation_id: validationId, host_id: "task-report", package_sha256: { bug_case: "d".repeat(64), validator: "e".repeat(64) }, harness: { name: "rbw-validate", version: "1" }, protocol: PROTOCOL };
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
    const op = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report", copies: 3 });
    const status = await w.spend.operationStatus({ operation_id: op.operation_id });
    expect(status.ok && status.state).toBe("running");
    expect(status.ok && status.reserved_microusd).toBe(BigInt(VALIDATION_3_MICROUSD));
    const budget = await w.ledger.budgets.status(record.budget_key);
    expect(budget.ok && budget.open_microusd).toBe(BigInt(VALIDATION_3_MICROUSD));
    expect((await w.records.validation(a.validation_id))?.root).toBe(root);
    expect(w.records.types(record.request_id).slice(-2)).toEqual(["validation_started", "budget_updated"]);
    const create = w.sandbox.calls.find((call) => call.action === "create")?.detail as WorkerSandboxCreateParams;
    expect(create.name).toBe(`rbw-fv-${root}`);
    expect(create.timeout).toBe(FACTORY_PROFILE.validation.worker.timeout_s * 1000);
    const run = w.sandbox.calls.find((call) => call.action === "run")?.detail as { cmd: string; args: string[] };
    expect([run.cmd, ...run.args.slice(0, 4)]).toEqual(["sh", "-c", RUN_ONCE_SCRIPT, "rbw-worker", WORKER_RUN_ONCE_DIR]);
    expect(run.args.slice(6, 9)).toEqual(["factory-worker", "--validation-id", a.validation_id]);
    // A request-role reserve on the closed budget is still refused.
    const refused = await w.ledger.budgets.reserve(record.budget_key, "request", workerOp(record).request);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.code).toBe("budget_closed");
  });

  it("gives the validation worker sandbox its own image reference as RBW_FACTORY_WORKER_IMAGE", async () => {
    const record = await finishedRequest();
    expect((await startFactoryValidation(deps(), args(record.request_id))).kind).toBe("accepted");
    const params = w.sandbox.calls.find((call) => call.action === "create")?.detail as WorkerSandboxCreateParams;
    expect(params.env).toMatchObject({ ...CREDENTIALS, RBW_FACTORY_WORKER_IMAGE: WORKER_IMAGE });
  });

  it("answers a repeated start of one run with the existing run, reserving and launching nothing more, and refuses its ID on another case", async () => {
    const record = await finishedRequest();
    const a = args(record.request_id);
    expect((await startFactoryValidation(deps(), a)).kind).toBe("accepted");
    const again = await startFactoryValidation(deps(), a);
    expect(again.kind === "accepted" && [again.run.validation_id, again.run.state]).toEqual([a.validation_id, "queued"]);
    expect(w.sandbox.count("create")).toBe(1);
    const budget = await w.ledger.budgets.status(record.budget_key);
    expect(budget.ok && budget.open_microusd).toBe(BigInt(VALIDATION_3_MICROUSD));
    expect(w.records.types(record.request_id).filter((type) => type === "validation_started")).toHaveLength(1);
    expect(await startFactoryValidation(deps(), { ...a, case_id: "f".repeat(64) })).toEqual({ kind: "unavailable", message: "The validation ID is already used." });
  });

  it("answers a repeated start with the stored run as it stands: running once its worker started, then its finish", async () => {
    const record = await finishedRequest();
    const a = args(record.request_id);
    expect((await startFactoryValidation(deps(), a)).kind).toBe("accepted");
    const startedAt = w.clock.now().toISOString();
    await w.records.appendValidationEvent(a.validation_id, { event_key: "running", type: "running", data: { started_at: startedAt } }, w.clock.now());
    const running = await startFactoryValidation(deps(), a);
    if (running.kind !== "accepted") throw new Error("synthetic: the repeated start was not accepted");
    expect([running.run.state, running.run.started_at, running.run.result, running.run.finished_at]).toEqual(["running", startedAt, null, null]);
    expect(validateContract("ValidationRun", running.run)).toEqual([]);

    w.clock.advance(60_000);
    const finished = await runFactoryValidation(
      { ledger: w.ledger, records: w.records, identity: w.identity, rates: w.rates, now: w.clock.now, log: (line) => w.logs.push(line), provider: "vercel-sandbox" },
      { validation_id: a.validation_id, validate: () => Promise.resolve({ result: "error", matrix: null, message: "synthetic: no cell could run" }) },
    );
    expect(finished.kind).toBe("finished");
    const again = await startFactoryValidation(deps(), a);
    if (again.kind !== "accepted") throw new Error("synthetic: the repeated start was not accepted");
    const stored = (await w.records.validationEvents(a.validation_id)).find((event) => event.type === "finished")?.data;
    expect(again.run).toMatchObject({ state: "finished", result: "error", matrix: null, message: "synthetic: no cell could run", started_at: startedAt, finished_at: stored?.finished_at, cost_microusd: stored?.cost_microusd, poll_after_ms: 0 });
    expect(typeof again.run.cost_microusd).toBe("number");
    expect(validateContract("ValidationRun", again.run)).toEqual([]);
    expect(w.sandbox.count("create")).toBe(1);
  });

  it("records the harness identity accepted at the run's start and answers every start with it, also after a harness version change", async () => {
    const record = await finishedRequest();
    const a = args(record.request_id);
    const first = await startFactoryValidation(deps(), a);
    expect(first.kind === "accepted" && first.run.harness).toEqual({ name: "rbw-validate", version: "1" });
    expect((await w.records.validation(a.validation_id))?.harness).toEqual({ name: "rbw-validate", version: "1" });
    // A redeploy moved the service to a newer harness; the run's worker was started with the one recorded.
    const again = await startFactoryValidation(deps(), { ...a, harness: { name: "rbw-validate", version: "2" } });
    if (again.kind !== "accepted") throw new Error("synthetic: the repeated start was not accepted");
    expect(again.run.harness).toEqual({ name: "rbw-validate", version: "1" });
    expect(validateContract("ValidationRun", again.run)).toEqual([]);
    expect(w.sandbox.count("create")).toBe(1);
  });

  it("refuses a worker image that is not pinned by digest before taking the slot", async () => {
    const record = await finishedRequest();
    const a = args(record.request_id);
    await expect(startFactoryValidation(deps({ launch: { image: "synthetic/rbw-factory-worker:latest", env: CREDENTIALS } }), a)).rejects.toThrow(/digest/);
    expect(await slotHolder(w)).toBeNull();
    expect(await w.records.validation(a.validation_id)).toBeNull();
    expect(w.budgets.budgets.get(record.budget_key)?.operations).toEqual([]);
  });

  it("records and launches nothing over a run's reservation that an earlier start already moved past prepared", async () => {
    const record = await finishedRequest();
    const a = args(record.request_id);
    const root = w.identity.validationRoot(a.validation_id);
    const op = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report", copies: 3 });
    // An earlier start took the slot, reserved and began the launch, and its record never landed.
    expect((await w.spend.acquireSlot({ slot_key: "factory", root_execution_id: root, actor_role: "factory-route" })).ok).toBe(true);
    expect((await w.ledger.budgets.reserve(record.budget_key, "validation", op.request)).ok).toBe(true);
    expect((await w.spend.transition({ operation_id: op.operation_id, from_state: "prepared", to_state: "launching", actor_role: "factory-route", slot_key: "factory" })).ok).toBe(true);
    expect(await startFactoryValidation(deps(), a)).toEqual({ kind: "unavailable", message: "An earlier start of this validation needs reconciliation." });
    expect(await w.records.validation(a.validation_id)).toBeNull();
    expect(w.records.types(record.request_id)).not.toContain("validation_started");
    expect(w.sandbox.count("create")).toBe(0);
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
