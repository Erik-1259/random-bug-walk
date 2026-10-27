// The worker's real wiring on the real spend ledger (PGlite with every migration): the factory
// core's request loop, the harness (validatePair) and the package tooling over a prepared directory,
// the request budgets and factory records, and the copy meter's glue around the docker backend's
// copy runner. The host is the package tooling's synthetic one, exported under the factory's
// identity functions, and its copies run as local Node processes (factory-wiring-fakes.ts): nothing
// here is real host or container evidence.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleFinalValidator, exportCase, inspectValidator, packArchive, pairSha256, preparedObjectName, unpackArchive, writePrepared } from "@rbw/case-package";
import type { PreparedIndex } from "@rbw/case-package";
import { syntheticProtocol } from "@rbw/case-package/synthetic";
import { HARNESS_IDENTITY } from "@rbw/case-validate";
import { CASE_IDENTITY } from "@rbw/case-validate/factory-prepare";
import type * as Factory from "@rbw/factory";
import type { CaseEvidence, LedgerStatus, RunRequestDeps } from "@rbw/factory";
import type { CatalogEntry, CollectedCopy, CopyPlan, CopyRunner, HostAdapter, Protocol } from "@rbw/factory-contract";
import { canonicalDigest, encodeCanonical, sha256Hex } from "@rbw/schema";
import { factoryWorkerCommand } from "../../src/factory-cli.ts";
import { DockerCopyUncertain, createDockerCopyRunner } from "../../src/factory-docker-runner.ts";
import { startFactoryValidation, startFactoryWorker, validationRunView } from "../../src/factory-launch.ts";
import type { FactoryLaunchDeps } from "../../src/factory-launch.ts";
import { FACTORY_IDENTITY, makeUncertain } from "../../src/factory-ledger.ts";
import { CopyMeter } from "../../src/factory-meter.ts";
import type { FactoryRequestRecord, StoredFactoryEvent } from "../../src/factory-ports.ts";
import { HELD_INTERFACES, MISSING_MODULES, loadFactoryWiring } from "../../src/factory-wiring.ts";
import { CREDENTIALS, FakeWorkerSandbox, PROTOCOL, WORKER_IMAGE, copyPlan, copyRoots } from "./factory-fakes.ts";
import { acceptSyntheticRequest, localProcessRunner, scratch, syntheticHost, syntheticWiring, wiringWorld } from "./factory-wiring-fakes.ts";
import type { LocalProcessRunner, SyntheticHost, WiringWorld } from "./factory-wiring-fakes.ts";

/** Called with each ledger status the wiring hands the request loop, before the loop reads it. */
const ledgerProbe = vi.hoisted(() => ({ read: null as ((status: LedgerStatus) => Promise<void>) | null }));

// The factory core as it is; only the request loop's ledger reads also pass through the probe.
vi.mock("@rbw/factory", async (importOriginal) => {
  const actual = await importOriginal<typeof Factory>();
  return {
    ...actual,
    runRequest: (deps: RunRequestDeps) =>
      actual.runRequest({
        ...deps,
        ledger: {
          ...deps.ledger,
          async status() {
            const status = await deps.ledger.status();
            await ledgerProbe.read?.(status);
            return status;
          },
        },
      }),
  };
});

let w: WiringWorld;
let host: SyntheticHost;
let sandbox: FakeWorkerSandbox;
let out: string[];

beforeEach(async () => {
  w = await wiringWorld();
  host = await syntheticHost();
  sandbox = new FakeWorkerSandbox();
  out = [];
});

afterEach(async () => {
  ledgerProbe.read = null;
  await w.pglite.close();
});

function launchDeps(): FactoryLaunchDeps {
  return { ledger: w.db.ledger, records: w.db.factoryRecords, identity: FACTORY_IDENTITY, sandbox, rates: w.rates, now: w.clock.now, launch: { image: WORKER_IMAGE, env: CREDENTIALS }, log: (line) => w.logs.push(line) };
}

/** The factory-worker command on the docker backend with the synthetic wiring, as a worker sandbox runs it. */
function worker(args: string[], runner: CopyRunner, packagesDir = host.packagesDir): Promise<number> {
  return factoryWorkerCommand([...args, "--backend", "docker"], {
    env: { DATABASE_URL: "postgres://synthetic.invalid/db", RBW_FACTORY_PACKAGES_DIR: packagesDir },
    out: (line) => out.push(line),
    log: (line) => w.logs.push(line),
    now: w.clock.now,
    load: () => Promise.resolve({ ok: true, wiring: syntheticWiring(w, host, runner) }),
  });
}

/** A request accepted and launched as the web service does, then its worker run with `runner`. */
async function runRequest(runner: CopyRunner, packagesDir = host.packagesDir): Promise<{ code: number; record: FactoryRequestRecord; events: StoredFactoryEvent[] }> {
  const record = await acceptSyntheticRequest(w, host.registry);
  expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
  const code = await worker(["--request-id", record.request_id, "--deadline-at", new Date(w.clock.ms + 3_600_000).toISOString()], runner, packagesDir);
  return { code, record, events: await w.db.factoryRecords.events(record.request_id) };
}

async function slotHolder(): Promise<string | null> {
  const slot = await w.db.spend.slotStatus({ slot_key: "factory" });
  if (!slot.ok) throw new Error("synthetic: the slot status was refused");
  return slot.holder;
}

/** The request budget, the factory pool and the ledger's halt as the database records them now. */
async function recordedLedger(record: FactoryRequestRecord): Promise<{ budget: bigint; open: bigint; settled: bigint; poolAvailable: bigint; halted: boolean }> {
  const budget = await w.db.ledger.budgets.status(record.budget_key);
  const pool = await w.db.spend.poolStatus({ pool_key: "factory" });
  const halt = await w.db.spend.haltStatus();
  if (!budget.ok || !pool.ok || !halt.ok) throw new Error("synthetic: a ledger read was refused");
  return { budget: budget.budget_microusd, open: budget.open_microusd, settled: budget.settled_microusd, poolAvailable: pool.available_microusd, halted: halt.halted };
}

/** Pairs each ledger status the request loop reads with what the database records at that read. */
function probeLedger(record: FactoryRequestRecord): [LedgerStatus, LedgerStatus][] {
  const reads: [LedgerStatus, LedgerStatus][] = [];
  ledgerProbe.read = async (status) => {
    const recorded = await recordedLedger(record);
    reads.push([
      status,
      { budget_microusd: Number(recorded.budget), reserved_microusd: Number(recorded.open), spent_microusd: Number(recorded.settled), halted: recorded.halted, pool_available_microusd: Number(recorded.poolAvailable), pool_halted: recorded.halted },
    ]);
  };
  return reads;
}

async function evidenceOf(record: FactoryRequestRecord): Promise<CaseEvidence> {
  const evidence = await w.db.factoryRecords.readEvidence(record.request_id, host.prepared.case_id);
  if (evidence === null) throw new Error("synthetic: no evidence was recorded for the case");
  return evidence;
}

/** A copy of the prepared directory with its index entry edited, and an object added. */
async function editedPackages(edit: (index: PreparedIndex) => PreparedIndex, object?: Uint8Array): Promise<string> {
  const dir = await scratch("packages");
  const index = JSON.parse(await readFile(join(host.packagesDir, "index.json"), "utf8")) as PreparedIndex;
  for (const sha of [host.prepared.bug_case_sha256, host.prepared.validator_core_sha256]) await writeFile(join(dir, preparedObjectName(sha)), await readFile(join(host.packagesDir, preparedObjectName(sha))));
  if (object !== undefined) await writeFile(join(dir, preparedObjectName(sha256Hex(object))), object);
  await writeFile(join(dir, "index.json"), encodeCanonical(edit(index)));
  return dir;
}

function endedReasons(events: readonly StoredFactoryEvent[]): unknown[] {
  return events.filter((event) => event.type.startsWith("candidate_") && event.type !== "candidate_selected").map((event) => [event.type, event.data.reason]);
}

describe("the worker's wiring", () => {
  it("is loaded whole: nothing missing, nothing held", async () => {
    expect((await loadFactoryWiring()).ok).toBe(true);
    expect(MISSING_MODULES).toEqual([]);
    expect(HELD_INTERFACES).toEqual([]);
  });
});

describe("a request on the synthetic pair", () => {
  it("verifies the exported pair through the harness, then stores and delivers the case with its evidence", async () => {
    const runner = localProcessRunner(await scratch("copies"));
    const { code, record, events } = await runRequest(runner);
    expect(out).toEqual([`request=${record.request_id} stop_code=fulfilled slot_released=true`]);
    expect(code).toBe(0);
    // Export verification ran the entry's three copies, one per state, through the docker backend's meter.
    expect(runner.plans.map((plan) => plan.state)).toEqual(["clean", "buggy", "fixed"]);
    expect(endedReasons(events)).toEqual([]);
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === "check_finished")).toHaveLength(6);
    expect(types.indexOf("package_ready")).toBeGreaterThan(-1);
    expect(types.indexOf("package_ready")).toBeLessThan(types.indexOf("case_delivered"));
    expect(types.at(-1)).toBe("request_finished");
    const delivered = events.find((event) => event.type === "case_delivered");
    expect(delivered?.case_id).toBe(host.prepared.case_id);

    // The stored parts are what export verification ran on: the bug case, and the validator core plus
    // this qualification record as its evidence member, bound by pair_sha256.
    const evidence = await evidenceOf(record);
    const validator = assembleFinalValidator(host.core, evidence.record);
    const packages = evidence.case.packages;
    expect(packages.bug_case.sha256).toBe(host.prepared.bug_case_sha256);
    expect(packages.validator.sha256).toBe(sha256Hex(validator));
    expect(packages.validator.size_bytes).toBe(validator.length);
    expect(inspectValidator(validator)).toEqual({ core_sha256: host.prepared.validator_core_sha256, evidence_sha256: evidence.case.qualification.record_sha256 });
    expect(packages.pair_sha256).toBe(pairSha256({ bug_case_sha256: packages.bug_case.sha256, validator_sha256: packages.validator.sha256, case_id: host.prepared.case_id }));
    expect(packages.bug_case.filename).toBe(`rbw-bug-case-${host.prepared.case_id.slice(0, 12)}-v1.tar.gz`);
    expect(evidence.record.export_verification).toEqual({ bug_case_sha256: host.prepared.bug_case_sha256, validator_sha256: host.prepared.validator_core_sha256, harness: HARNESS_IDENTITY });
    expect(events.find((event) => event.type === "package_ready")?.data).toMatchObject({ bug_case_sha256: packages.bug_case.sha256, validator_sha256: packages.validator.sha256 });

    // The candidate's copies and the worker settled, the budget closed with the stop code, the slot released.
    const budget = await w.db.ledger.budgets.status(record.budget_key);
    expect(budget.ok && budget.open_microusd).toBe(0n);
    expect(budget.ok && budget.closed).toEqual({ cause: "fulfilled" });
    expect(await slotHolder()).toBeNull();
  });

  it("rejects a tampered validator core as export_mismatch, before any copy runs", async () => {
    // One check of the core changed: its manifest no longer lists the bytes the core holds.
    const tampered = packArchive(unpackArchive(host.core).map((member) => (member.path === "checks/verify.js" ? { path: member.path, bytes: new TextEncoder().encode("// changed\n") } : member)));
    const dir = await editedPackages((index) => ({ ...index, entries: index.entries.map((entry) => ({ ...entry, validator_core_sha256: sha256Hex(tampered), validator_core_size_bytes: tampered.length })) }), tampered);
    const runner = localProcessRunner(await scratch("copies"));
    const { record, events } = await runRequest(runner, dir);
    expect(endedReasons(events)).toEqual([["candidate_rejected", "export_mismatch"]]);
    expect(runner.plans).toHaveLength(0);
    expect(events.some((event) => event.type === "case_delivered")).toBe(false);
    expect(out).toEqual([`request=${record.request_id} stop_code=sources_exhausted slot_released=true`]);
  });

  it("rejects a prepared package whose case ID is not the entry's as export_mismatch, before any copy runs", async () => {
    const dir = await editedPackages((index) => ({ ...index, entries: index.entries.map((entry) => ({ ...entry, case_id: "f".repeat(64) })) }));
    const runner = localProcessRunner(await scratch("copies"));
    const { events } = await runRequest(runner, dir);
    expect(endedReasons(events)).toEqual([["candidate_rejected", "export_mismatch"]]);
    expect(runner.plans).toHaveLength(0);
    expect(w.logs.some((line) => line.includes("the prepared package's case ID is not the entry's"))).toBe(true);
  });

  it("finishes needs_reconciliation when a copy's runner rejects, with the slot held and the copy's operation uncertain", async () => {
    const runner: LocalProcessRunner = {
      plans: [],
      run(plan) {
        runner.plans.push(plan);
        return Promise.reject(new Error("synthetic: the provider's outcome is unknown"));
      },
    };
    const { code, record, events } = await runRequest(runner);
    expect(out).toEqual([`request=${record.request_id} stop_code=needs_reconciliation slot_released=false`]);
    expect(code).toBe(1);
    expect(runner.plans).toHaveLength(1);
    expect(endedReasons(events)).toEqual([["candidate_incomplete", "incomplete_run"]]);
    expect(events.some((event) => event.type === "attention" && event.data.code === "needs_reconciliation")).toBe(true);
    expect(await slotHolder()).toBe(record.root);
    const budget = await w.db.spend.budgetStatus({ budget_key: record.budget_key });
    expect(budget.ok && budget.operations.filter((operation) => operation.state === "uncertain").map((operation) => operation.kind)).toEqual(["factory.copy"]);
  });

  it("ends the request operational_error, running and delivering nothing, when an event differs from the one recorded under its key", async () => {
    const record = await acceptSyntheticRequest(w, host.registry);
    // Recorded under the key the core appends the host's preparation with, with other content.
    const other = await w.db.factoryRecords.appendEvent(record.request_id, { event_key: "host:task-report:preparing", type: "host_preparing", host_id: "task-report", candidate_id: null, item_key: null, case_id: null, message: "synthetic: another message", data: {} }, w.clock.now());
    expect(other.kind).toBe("appended");
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
    const runner = localProcessRunner(await scratch("copies"));
    const code = await worker(["--request-id", record.request_id, "--deadline-at", new Date(w.clock.ms + 3_600_000).toISOString()], runner);
    // The conflicting append rejects; the core's loop ends the request as an operational error.
    expect(out).toEqual([`request=${record.request_id} stop_code=operational_error slot_released=true`]);
    expect(code).toBe(0);
    expect(runner.plans).toHaveLength(0);
    const types = (await w.db.factoryRecords.events(record.request_id)).map((event) => event.type);
    expect(types).not.toContain("candidate_selected");
    expect(types).not.toContain("case_delivered");
    expect(w.logs.some((line) => line.includes("the event host:task-report:preparing differs from the one recorded under its key"))).toBe(true);
  });

  it("ends the request operational_error, running and delivering nothing, when the store refuses an event", async () => {
    const record = await acceptSyntheticRequest(w, host.registry);
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
    const records = w.db.factoryRecords;
    // The store refuses the host's preparation event, as it refuses an event it no longer allows.
    w.db = { ...w.db, factoryRecords: { ...records, appendEvent: (id, event, at) => (event.event_key === "host:task-report:preparing" ? Promise.resolve({ kind: "refused", reason: "event_not_allowed" }) : records.appendEvent(id, event, at)) } };
    const runner = localProcessRunner(await scratch("copies"));
    const code = await worker(["--request-id", record.request_id, "--deadline-at", new Date(w.clock.ms + 3_600_000).toISOString()], runner);
    // The refused append rejects; the core's loop ends the request as an operational error.
    expect(out).toEqual([`request=${record.request_id} stop_code=operational_error slot_released=true`]);
    expect(code).toBe(0);
    expect(runner.plans).toHaveLength(0);
    const types = (await records.events(record.request_id)).map((event) => event.type);
    expect(types).not.toContain("host_preparing");
    expect(types).not.toContain("candidate_selected");
    expect(types).not.toContain("case_delivered");
    expect(w.logs.some((line) => line.includes("the event host:task-report:preparing was refused (event_not_allowed)"))).toBe(true);
  });
});

describe("the request loop's ledger status", () => {
  it("is the request budget and the factory pool as recorded, and budget_updated reports the budget's amounts", async () => {
    const record = await acceptSyntheticRequest(w, host.registry);
    const reads = probeLedger(record);
    // The amounts the database records once the candidate is reserved, read as its first copy starts.
    const atFirstCopy: Awaited<ReturnType<typeof recordedLedger>>[] = [];
    const local = localProcessRunner(await scratch("copies"));
    const runner: CopyRunner = {
      async run(plan, roots) {
        if (atFirstCopy.length === 0) atFirstCopy.push(await recordedLedger(record));
        return local.run(plan, roots);
      },
    };
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
    const code = await worker(["--request-id", record.request_id, "--deadline-at", new Date(w.clock.ms + 3_600_000).toISOString()], runner);
    expect(out).toEqual([`request=${record.request_id} stop_code=fulfilled slot_released=true`]);
    expect(code).toBe(0);

    expect(reads.length).toBeGreaterThan(1);
    for (const [status, recorded] of reads) expect(status).toEqual(recorded);
    expect(reads.every(([status]) => status.budget_microusd === 1_500_000 && !status.halted && !status.pool_halted)).toBe(true);

    const [first] = atFirstCopy;
    if (first === undefined) throw new Error("synthetic: no copy ran");
    const { budget, open, settled } = first;
    expect([budget, open > 0n]).toEqual([1_500_000n, true]);
    const events = await w.db.factoryRecords.events(record.request_id);
    const candidate = events.find((event) => event.type === "candidate_selected")?.candidate_id;
    const reservation = events.find((event) => event.event_key === `cand:${String(candidate)}:reserved`);
    expect(reservation?.type).toBe("budget_updated");
    expect(reservation?.data).toEqual({ reserved_microusd: Number(open), spent_microusd: Number(settled), remaining_microusd: Number(budget - open - settled) });
  });

  it("stops the request operational_error before selecting a candidate once the ledger records a halt", async () => {
    const record = await acceptSyntheticRequest(w, host.registry);
    expect((await startFactoryWorker(launchDeps(), record.request_id)).kind).toBe("launched");
    // The worker's operation reconciled with usage above its open amount, which records an over-envelope
    // observation and halts new work.
    const operations = await w.db.spend.budgetOperations({ budget_key: record.budget_key });
    const operation = operations.ok ? operations.operations[0] : undefined;
    if (operation === undefined) throw new Error("synthetic: the worker's operation is not recorded");
    expect(await makeUncertain(w.db.spend, operation.operation_id, "factory-worker")).toBe("uncertain");
    const slot = await w.db.spend.slotStatus({ slot_key: "factory" });
    const reconciled = await w.db.spend.reconcile({
      schema_version: 1,
      operation_id: operation.operation_id,
      previous_state: "uncertain",
      evidence: [{ key: "synthetic/reconcile/worker", sha256: "f".repeat(64) }],
      provider_resource_ids: slot.ok ? slot.children.filter((child) => child.operation_id === operation.operation_id).map((child) => child.resource_id) : [],
      recorded_at: w.clock.now().toISOString(),
      actor_role: "operator",
      decision: "confirm_stopped_incomplete",
      retained_microusd: Number(operation.open_microusd) + 1,
      released_microusd: 0,
      reason: "synthetic over-envelope reconciliation",
    });
    expect(reconciled.ok && reconciled.over_envelope).toBe(true);
    expect((await recordedLedger(record)).halted).toBe(true);
    const reads = probeLedger(record);
    const runner = localProcessRunner(await scratch("copies"));
    const code = await worker(["--request-id", record.request_id, "--deadline-at", new Date(w.clock.ms + 3_600_000).toISOString()], runner);
    expect(out).toEqual([`request=${record.request_id} stop_code=operational_error slot_released=true`]);
    expect(code).toBe(0);
    expect(runner.plans).toHaveLength(0);
    expect(reads.length).toBeGreaterThan(0);
    for (const [status, recorded] of reads) expect(status).toEqual(recorded);
    expect(reads.every(([status]) => status.halted && status.pool_halted)).toBe(true);
    const types = (await w.db.factoryRecords.events(record.request_id)).map((event) => event.type);
    expect(types).not.toContain("candidate_selected");
    expect(types.at(-1)).toBe("request_finished");
  });
});

describe("a validation run of the delivered case", () => {
  async function delivered(): Promise<{ record: FactoryRequestRecord; evidence: CaseEvidence }> {
    const { record } = await runRequest(localProcessRunner(await scratch("copies")));
    return { record, evidence: await evidenceOf(record) };
  }

  async function validate(record: FactoryRequestRecord, validator: string, runner: CopyRunner, bugCase = host.prepared.bug_case_sha256): Promise<{ id: string; code: number }> {
    const id = randomUUID();
    const started = await startFactoryValidation(launchDeps(), { request_id: record.request_id, case_id: host.prepared.case_id, validation_id: id, host_id: "task-report", package_sha256: { bug_case: bugCase, validator }, harness: HARNESS_IDENTITY, protocol: syntheticProtocol() });
    expect(started.kind).toBe("accepted");
    return { id, code: await worker(["--validation-id", id], runner) };
  }

  it("rebuilds the delivered validator from the core and the recorded evidence, and passes on the two parts", async () => {
    const { record, evidence } = await delivered();
    const runner = localProcessRunner(await scratch("validation"));
    const { id, code } = await validate(record, evidence.case.packages.validator.sha256, runner);
    expect(out.at(-1)).toBe(`validation=${id} result=passed slot_released=true`);
    expect(code).toBe(0);
    expect(runner.plans.map((plan) => plan.state)).toEqual(["clean", "buggy", "fixed"]);
    const run = await w.db.factoryRecords.validation(id);
    if (run === null) throw new Error("synthetic: the run is not recorded");
    const view = validationRunView(run, await w.db.factoryRecords.validationEvents(id));
    expect(view.result).toBe("passed");
    expect(view.matrix?.verification.buggy).toEqual({ expected: "fail", observed: "fail", runs_valid: 2, runs_total: 2, matches_expectation: true });
    expect(view.matrix?.original_suite.clean.matches_expectation).toBe(true);
    expect(await slotHolder()).toBeNull();
  });

  /**
   * Package version 2 of the synthetic entry written into the host's prepared directory, as a later
   * `case-package prepare` does after a catalog revision that changed only the entry's protocol (not
   * part of the case ID): the index names version 2's core under the same case ID, and version 1's
   * archives stay.
   */
  async function prepareNewerVersion(): Promise<void> {
    const [entry] = host.adapter.catalog();
    if (entry === undefined) throw new Error("synthetic: the synthetic catalog is empty");
    const base = host.adapter.protocol(entry);
    const copies = { copies: 2, rounds_per_copy: 2, min_valid_runs: 2 };
    const changed = { protocol_id: base.protocol_id, version: base.version, per_state: { clean: copies, buggy: copies, fixed: copies }, valid_trial_rules: base.valid_trial_rules };
    const protocol: Protocol = { ...changed, sha256: canonicalDigest(changed).sha256 };
    const revised: CatalogEntry = { ...entry, verification: { ...entry.verification, protocol_id: protocol.protocol_id, protocol_sha256: protocol.sha256 } };
    const adapter: HostAdapter = {
      ...host.adapter,
      catalog: () => [revised],
      protocol: () => protocol,
      bugCaseInputs: () => host.adapter.bugCaseInputs(entry),
      validatorInputs: async () => ({ ...(await host.adapter.validatorInputs(entry)), protocol }),
    };
    const v2 = await exportCase({ adapter, entry: revised, identity: CASE_IDENTITY, license: "MIT", scan: null, package_version: 2 });
    const index = await writePrepared(host.packagesDir, [v2]);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({ case_id: host.prepared.case_id, package_version: 2 });
    expect(index.entries[0]?.validator_core_sha256).not.toBe(host.prepared.validator_core_sha256);
  }

  it("rebuilds the delivered validator from the core its record verified after a newer package version is prepared into the same directory", async () => {
    const { record, evidence } = await delivered();
    await prepareNewerVersion();
    const runner = localProcessRunner(await scratch("validation"));
    const { id, code } = await validate(record, evidence.case.packages.validator.sha256, runner);
    expect(out.at(-1)).toBe(`validation=${id} result=passed slot_released=true`);
    expect(code).toBe(0);
    expect(runner.plans.map((plan) => plan.state)).toEqual(["clean", "buggy", "fixed"]);
  });

  it("answers error without running a copy when the core its record verified is not in the prepared directory", async () => {
    const { record, evidence } = await delivered();
    await prepareNewerVersion();
    // The index and the bug case as prepared now, without version 1's validator core.
    const dir = await scratch("packages");
    for (const name of ["index.json", preparedObjectName(host.prepared.bug_case_sha256)]) await writeFile(join(dir, name), await readFile(join(host.packagesDir, name)));
    const runner = localProcessRunner(await scratch("validation"));
    const id = randomUUID();
    expect((await startFactoryValidation(launchDeps(), { request_id: record.request_id, case_id: host.prepared.case_id, validation_id: id, host_id: "task-report", package_sha256: { bug_case: host.prepared.bug_case_sha256, validator: evidence.case.packages.validator.sha256 }, harness: HARNESS_IDENTITY, protocol: syntheticProtocol() })).kind).toBe("accepted");
    await worker(["--validation-id", id], runner, dir);
    expect(out.at(-1)).toBe(`validation=${id} result=error slot_released=true`);
    expect(runner.plans).toHaveLength(0);
    expect(w.logs.some((line) => line.includes("the prepared directory has no archive of the validator core the case's record verified"))).toBe(true);
  });

  it("answers error without running a copy when the rebuilt validator is not the one the run was started with", async () => {
    const { record } = await delivered();
    const runner = localProcessRunner(await scratch("validation"));
    const { id } = await validate(record, "e".repeat(64), runner);
    expect(out.at(-1)).toBe(`validation=${id} result=error slot_released=true`);
    expect(runner.plans).toHaveLength(0);
    const run = await w.db.factoryRecords.validation(id);
    if (run === null) throw new Error("synthetic: the run is not recorded");
    expect(validationRunView(run, await w.db.factoryRecords.validationEvents(id)).message).toBe("The rebuilt validator is not the case's delivered validator.");
  });
});

describe("the docker copy runner's meter glue", () => {
  function meterFor(record: FactoryRequestRecord, deadlineMs: number): CopyMeter {
    return new CopyMeter({
      ledger: w.db.ledger,
      identity: FACTORY_IDENTITY,
      rates: w.rates,
      now: w.clock.now,
      root: record.root,
      kind: "request",
      task_revision: record.interpretation_sha256,
      budget_key: record.budget_key,
      provider: "docker",
      deadline: new Date(deadlineMs),
      margin_s: 120,
      mode: { kind: "own_operation", role: "request" },
      log: (line) => w.logs.push(line),
    });
  }

  /** A docker runner stand-in: each copy "runs" for 95 s and brings back no results. */
  function stub(): CopyRunner & { plans: CopyPlan[] } {
    const runner = {
      plans: [] as CopyPlan[],
      run(plan: CopyPlan): Promise<CollectedCopy> {
        runner.plans.push(plan);
        const startedAt = w.clock.now().toISOString();
        w.clock.advance(95_000);
        return Promise.resolve({ copy_id: plan.copy_id, outcome: "ran", exit_code: 0, results_dir: null, image_digest: plan.image.digest ?? "", architecture: "amd64", started_at: startedAt, finished_at: w.clock.now().toISOString(), results_sha256: null });
      },
    };
    return runner;
  }

  const SUBJECT = "a".repeat(64);

  it("runs a reserved copy once through the docker runner and settles its measured lifetime", async () => {
    const record = await acceptSyntheticRequest(w, host.registry, 3_000_000);
    const meter = meterFor(record, w.clock.ms + 3_600_000);
    expect((await meter.reserveCandidate({ candidate_id: SUBJECT, host_id: "task-report", protocol: PROTOCOL })).kind).toBe("reserved");
    const inner = stub();
    const runner = createDockerCopyRunner({ runner: inner, meter, subject: SUBJECT, now: () => w.clock.ms, log: (line) => w.logs.push(line) });
    const collected = await runner.run(copyPlan(), copyRoots().roots);
    expect(collected.outcome).toBe("ran");
    expect(inner.plans).toHaveLength(1);
    const budget = await w.db.ledger.budgets.status(record.budget_key);
    // 95 s at 4 vCPU and 8 GB, as a sandbox copy of that size settles; the two unused copies stay reserved.
    expect(budget.ok && budget.settled_microusd).toBe(17_989n);
    expect(budget.ok && budget.open_microusd).toBe(2n * 147_682n);
  });

  it("reports a copy the meter does not start as the sandbox runner does, without running it", async () => {
    const record = await acceptSyntheticRequest(w, host.registry, 3_000_000);
    const inner = stub();
    // No reservation for the candidate: setup_failed.
    const unreserved = createDockerCopyRunner({ runner: inner, meter: meterFor(record, w.clock.ms + 3_600_000), subject: SUBJECT, now: () => w.clock.ms, log: (line) => w.logs.push(line) });
    expect((await unreserved.run(copyPlan(), copyRoots().roots)).outcome).toBe("setup_failed");
    // A copy that would not end before the deadline: timed_out.
    const late = meterFor(record, w.clock.ms + 600_000);
    expect((await late.reserveCandidate({ candidate_id: SUBJECT, host_id: "task-report", protocol: PROTOCOL })).kind).toBe("reserved");
    const lateRunner = createDockerCopyRunner({ runner: inner, meter: late, subject: SUBJECT, now: () => w.clock.ms, log: (line) => w.logs.push(line) });
    expect((await lateRunner.run(copyPlan(), copyRoots().roots)).outcome).toBe("timed_out");
    expect(inner.plans).toHaveLength(0);
  });

  it("rejects when the docker runner rejects, and starts no later copy", async () => {
    const record = await acceptSyntheticRequest(w, host.registry, 3_000_000);
    const meter = meterFor(record, w.clock.ms + 3_600_000);
    expect((await meter.reserveCandidate({ candidate_id: SUBJECT, host_id: "task-report", protocol: PROTOCOL })).kind).toBe("reserved");
    const calls: string[] = [];
    const failing: CopyRunner = {
      run(plan) {
        calls.push(plan.copy_id);
        return Promise.reject(new Error("synthetic: the docker command failed in an unexpected way"));
      },
    };
    const runner = createDockerCopyRunner({ runner: failing, meter, subject: SUBJECT, now: () => w.clock.ms, log: (line) => w.logs.push(line) });
    await expect(runner.run(copyPlan(), copyRoots().roots)).rejects.toThrow(DockerCopyUncertain);
    await expect(runner.run(copyPlan({ state: "fixed", copy_id: "synthetic-copy-fixed-01" }), copyRoots().roots)).rejects.toThrow(DockerCopyUncertain);
    expect(calls).toEqual(["synthetic-copy-buggy-01"]);
    expect(meter.uncertain).toBe(true);
  });
});
