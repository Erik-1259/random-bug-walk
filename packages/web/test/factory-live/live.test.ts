// Live mode's ports through the handlers, on the real spend ledger (PGlite with every migration, the
// factory pool and the factory slot key, as the local bootstrap leaves them), the factory core, the
// worker's real launch and lost-worker functions with a fake Sandbox SDK, and a prepared packages
// directory holding the package tooling's synthetic task-report entry, exported under the factory's
// identity functions. The worker itself does not run: a test appends what it would record through
// the factory records port. Nothing here is real host, harness or Sandbox evidence.
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { assembleFinalValidator, exportCase, packageFilename, pairSha256, parseValidatorManifest, preparedObjectName, readPreparedIndex, unpackArchive, VALIDATOR_MANIFEST, writePrepared } from "@rbw/case-package";
import type { PreparedCase, PreparedEntry, PreparedIndex } from "@rbw/case-package";
import { syntheticAdapter } from "@rbw/case-package/synthetic";
import { CASE_IDENTITY } from "@rbw/case-validate/factory-prepare";
import { HARNESS_IDENTITY } from "@rbw/case-validate/version";
import { FACTORY_IDENTITY, FACTORY_PROFILE, factoryDatabaseOver, parseRateSheet, validationWorstCase } from "@rbw/controller/factory-web";
import type { FactoryDatabase, FactoryEventInput, WorkerSandboxCreateParams, WorkerSandboxInstance, WorkerSandboxSdk, WorkerSandboxStatus } from "@rbw/controller/factory-web";
import { budgetKey, candidateId, qualificationRecord } from "@rbw/factory";
import type { CaseEvidence, CellMatrix } from "@rbw/factory";
import type { CatalogEntry, CellObservation, HostAdapter, Interpretation, Protocol, RequestInput } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";
import { migrate } from "@rbw/spend";
import * as casePackage from "@rbw/case-package";
import * as factoryLocal from "@rbw/controller/factory-local";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCapabilities, getPackage, getRequestStatus, getValidationRun, postInterpretation, postSession, postStart, postStop, postValidation } from "../../src/factory-server/handlers.ts";
import { NOT_PREPARED } from "../../src/factory-server/live/hosts.ts";
import { createLiveServer } from "../../src/factory-server/live/server.ts";
import type { LiveDeps } from "../../src/factory-server/live/server.ts";
import { STOP_MESSAGE } from "../../src/factory-server/live/status.ts";
import { localBackend, packageTools } from "../../src/factory-server/live/tools.ts";
import type { LocalBackend, PackageTools } from "../../src/factory-server/live/tools.ts";
import type { FactoryServer } from "../../src/factory-server/ports.ts";
import { contractBody, FULFILLED, OTHER_REQUEST_ID, PASSCODE, readJson, request, REQUEST_ID, sha256, START, VALIDATION_ID } from "../factory-server/support.ts";

const RATES = parseRateSheet(readFileSync(new URL("../../../envelope/rate-sheets/v1.json", import.meta.url)));
const IMAGE = `synthetic.invalid/rbw-factory-worker@sha256:${"a".repeat(64)}`;
const LAUNCH_ENV = { DATABASE_URL: "postgres://synthetic.invalid/factory" };
const OTHER_VALIDATION_ID = "00000000-0000-4000-8000-0000000002a2";
const LATER_VALIDATION_ID = "00000000-0000-4000-8000-0000000002a3";
const WORKER_WORST_CASE = BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd);
/** Stands for evaluator material in the qualification record's cells; no JSON response may hold it. */
const SENTINEL = "synthetic-evaluator-detail-7f3a";

// The fake Sandbox SDK ---------------------------------------------------------------------------

class FakeInstance implements WorkerSandboxInstance {
  readonly name: string;
  status: WorkerSandboxStatus = "running";
  readonly runs: string[][] = [];

  constructor(name: string) {
    this.name = name;
  }

  runCommand(params: { cmd: string; args: string[] }): Promise<unknown> {
    this.runs.push(params.args);
    return Promise.resolve({ detached: true });
  }

  stop(): Promise<unknown> {
    this.status = "stopped";
    return Promise.resolve(undefined);
  }
}

class FakeSandbox implements WorkerSandboxSdk {
  readonly creates: WorkerSandboxCreateParams[] = [];
  readonly sandboxes = new Map<string, FakeInstance>();

  create(params: WorkerSandboxCreateParams): Promise<WorkerSandboxInstance> {
    this.creates.push(params);
    if (this.sandboxes.has(params.name)) return Promise.reject(Object.assign(new Error("synthetic: name taken"), { response: { status: 409 } }));
    const instance = new FakeInstance(params.name);
    this.sandboxes.set(params.name, instance);
    return Promise.resolve(instance);
  }

  get(name: string): Promise<WorkerSandboxInstance | null> {
    return Promise.resolve(this.sandboxes.get(name) ?? null);
  }
}

// The synthetic host and its prepared directory ---------------------------------------------------

interface Host {
  adapter: HostAdapter;
  entry: CatalogEntry;
  dir: string;
  index: PreparedIndex;
  prepared: PreparedEntry;
  bugCase: Uint8Array;
  core: Uint8Array;
  exported: PreparedCase;
}

let host: Host;

beforeAll(async () => {
  const work = await mkdtemp(join(tmpdir(), "rbw-web-live-"));
  const adapter = syntheticAdapter({ workdir: join(work, "adapter") });
  const [entry] = adapter.catalog();
  if (entry === undefined) throw new Error("synthetic: the synthetic catalog is empty");
  const exported = await exportCase({ adapter, entry, identity: CASE_IDENTITY, license: "MIT", scan: null });
  const dir = join(work, "packages");
  const index = await writePrepared(dir, [exported]);
  const [prepared] = index.entries;
  if (prepared === undefined) throw new Error("synthetic: nothing was prepared");
  host = { adapter, entry, dir, index, prepared, bugCase: exported.bug_case.bytes, core: exported.validator_core.bytes, exported };
});

// The world --------------------------------------------------------------------------------------

interface World {
  pglite: PGlite;
  db: FactoryDatabase;
  sandbox: FakeSandbox;
  clock: { ms: number };
  logs: string[];
  server: FactoryServer;
}

let w: World;

function ok(result: { ok: boolean; code?: string }): void {
  if (!result.ok) throw new Error(`synthetic: refused (${result.code ?? "no code"})`);
}

async function world(options: { poolCap?: number; without?: "pool" | "slot"; deps?: Partial<LiveDeps> } = {}): Promise<World> {
  const clock = { ms: START };
  const now = (): Date => new Date(clock.ms);
  const pglite = await PGlite.create();
  await migrate(pglite, { schema: "public" });
  const db = factoryDatabaseOver({ client: pglite, now });
  if (options.without !== "pool") ok(await db.spend.createPool({ pool_key: "factory", cap_microusd: options.poolCap ?? 40_000_000, allocations: [], actor_role: "owner", reason: "synthetic factory pool" }));
  if (options.without !== "slot") ok(await db.spend.createSlotKey({ slot_key: "factory", actor_role: "owner", reason: "synthetic factory slot" }));
  const sandbox = new FakeSandbox();
  const logs: string[] = [];
  const server = createLiveServer({
    passcode: PASSCODE,
    database: () => Promise.resolve(db),
    launch: { sandbox, config: { image: IMAGE, env: LAUNCH_ENV } },
    adapters: [host.adapter],
    prepared: { dir: host.dir, index: host.index },
    rates: RATES,
    now,
    log: (line) => logs.push(line),
    ...options.deps,
  });
  return { pglite, db, sandbox, clock, logs, server };
}

beforeEach(async () => {
  w = await world();
});

afterEach(async () => {
  await w.pglite.close();
});

// Helpers ----------------------------------------------------------------------------------------

function input(budget = 1_500_000, items: RequestInput["items"] = [{ item_key: "item-1", bug_type_id: "concurrency", quantity: 1, description: null, difficulty: "source_inferable_allowed" }]): RequestInput {
  return { hosts: ["task-report"], items, budget_microusd: budget };
}

async function interpret(body: RequestInput, server = w.server): Promise<Interpretation> {
  return contractBody("Interpretation", await postInterpretation(request("/api/factory/interpretations", { body, session: false }), server));
}

async function start(requestId = REQUEST_ID, body = input(), server = w.server): Promise<Response> {
  const interpretation = await interpret(body, server);
  return postStart(request("/api/factory/requests", { body: { request_id: requestId, input: body, interpretation_sha256: interpretation.interpretation_sha256 } }), server);
}

async function status(requestId = REQUEST_ID): Promise<Response> {
  return getRequestStatus(request(`/api/factory/requests/${requestId}`), w.server, { request_id: requestId });
}

async function append(requestId: string, event: FactoryEventInput): Promise<void> {
  const appended = await w.db.factoryRecords.appendEvent(requestId, event, new Date(w.clock.ms));
  if (appended.kind !== "appended") throw new Error(`synthetic: the append of ${event.event_key} answered ${appended.kind}`);
}

const NO_LINKS = { host_id: null, candidate_id: null, item_key: null, case_id: null };

async function budget(requestId = REQUEST_ID): Promise<{ cap: bigint; open: bigint; settled: bigint }> {
  const found = await w.db.ledger.budgets.status(budgetKey(requestId));
  if (!found.ok) throw new Error(`synthetic: the budget read was refused (${found.code})`);
  return { cap: found.budget_microusd, open: found.open_microusd, settled: found.settled_microusd };
}

async function slotHolder(): Promise<string | null> {
  const slot = await w.db.spend.slotStatus({ slot_key: "factory" });
  if (!slot.ok) throw new Error("synthetic: the slot read was refused");
  return slot.holder;
}

/** The request accepted as step 7 records it, without the slot or a launch, as after its worker finished. */
async function acceptWithoutSlot(requestId = REQUEST_ID): Promise<void> {
  const interpretation = await interpret(input());
  const root = FACTORY_IDENTITY.requestRoot(requestId);
  ok(
    await w.db.records.acceptRequest({
      budget: { budget_key: budgetKey(requestId), root_execution_id: root, pool_key: "factory", cap_microusd: 1_500_000, pool_required_microusd: FACTORY_PROFILE.prices.worker_worst_case_microusd, actor_role: "factory-route" },
      request: { request_id: requestId, request_sha256: sha256(Buffer.from(requestId)), interpretation, interpretation_sha256: interpretation.interpretation_sha256, budget_key: budgetKey(requestId), root_execution_id: root, factory_profile_sha256: FACTORY_PROFILE.profile_sha256 },
      accepted_message: "Request accepted.",
    }),
  );
}

/** A matrix whose every cell carries the sentinel as its evaluator detail. */
function sentinelMatrix(): CellMatrix {
  const cell = (observed: "pass" | "fail"): CellObservation => ({ observed, runs_valid: 1, runs_total: 1, failure_codes: observed === "fail" ? [SENTINEL] : [], detail: SENTINEL });
  return { original_suite: { clean: cell("pass"), buggy: cell("pass"), fixed: cell("pass") }, verification: { clean: cell("pass"), buggy: cell("fail"), fixed: cell("pass") } };
}

/** The delivered case's evidence as the worker records it: the client-safe case over the prepared bytes, and its record. */
function caseEvidence(requestId: string): CaseEvidence {
  const caseId = host.prepared.case_id;
  const record = qualificationRecord({
    harness: { result: "passed", stopped: false, package_sha256: { bug_case: host.prepared.bug_case_sha256, validator: host.prepared.validator_core_sha256 }, harness: HARNESS_IDENTITY, matrix: sentinelMatrix(), records: [], integrity: "verified", message: null },
    case_id: caseId,
    defect_id: host.prepared.defect_id,
    entry_id: host.entry.entry_id,
    item_key: "item-1",
    criteria: [],
    verdict: "accepted",
    reason_code: null,
  });
  const validator = assembleFinalValidator(host.core, record);
  const template = FULFILLED.cases.find((item) => item.host_id === "task-report");
  if (template === undefined) throw new Error("synthetic: the fixture has no task-report case");
  const version = host.prepared.package_version;
  const path = (part: string): string => `/api/factory/requests/${requestId}/cases/${caseId}/packages/${part}`;
  return {
    schema_version: 1,
    record,
    case: {
      ...structuredClone(template),
      case_id: caseId,
      defect_id: host.prepared.defect_id,
      item_key: "item-1",
      packages: {
        package_version: version,
        pair_sha256: pairSha256({ bug_case_sha256: sha256(host.bugCase), validator_sha256: sha256(validator), case_id: caseId }),
        bug_case: { ...template.packages.bug_case, filename: packageFilename("bug_case", caseId, version), size_bytes: host.bugCase.length, sha256: sha256(host.bugCase), download_path: path("bug-case") },
        validator: { ...template.packages.validator, filename: packageFilename("validator", caseId, version), size_bytes: validator.length, sha256: sha256(validator), download_path: path("validator") },
      },
      validation: null,
      provenance: { origin: "live_request", request_id: requestId, source_id: host.entry.source_id, entry_id: host.entry.entry_id },
    },
  };
}

/** What the worker records up to the package (and, with `deliver`, the delivery) of the synthetic entry. */
async function packageCase(requestId: string, deliver: boolean): Promise<CaseEvidence> {
  const evidence = caseEvidence(requestId);
  const caseId = evidence.case.case_id;
  const cid = candidateId(host.entry);
  const on = { host_id: "task-report" as const, candidate_id: cid };
  await append(requestId, { ...NO_LINKS, event_key: "worker_started", type: "worker_started", message: "The worker started.", data: {} });
  await append(requestId, { ...NO_LINKS, ...on, event_key: `cand:${cid}:selected`, type: "candidate_selected", message: `Selected catalog entry ${host.entry.entry_id}.`, data: { source_id: host.entry.source_id, entry_id: host.entry.entry_id } });
  for (const set of ["original_suite", "verification"] as const) {
    for (const copy of ["clean", "buggy", "fixed"] as const) {
      const outcome = set === "verification" && copy === "buggy" ? "fail" : "pass";
      await append(requestId, { ...NO_LINKS, ...on, event_key: `cand:${cid}:check:${set}:${copy}`, type: "check_finished", message: `Synthetic ${set} on the ${copy} copy: ${outcome}.`, data: { check_set: set, copy, outcome, runs_valid: 1, runs_total: 1 } });
    }
  }
  await append(requestId, { ...NO_LINKS, ...on, event_key: `cand:${cid}:behavior`, type: "behavior_checks_passed", message: "All six cells matched their expected outcomes in export verification.", data: {} });
  await append(requestId, { ...NO_LINKS, ...on, item_key: "item-1", event_key: `cand:${cid}:criteria`, type: "requested_criteria_passed", message: "The observed failure matches the criteria of item item-1.", data: { criterion_ids: ["concurrency.lost-acknowledged-change"] } });
  const packages = evidence.case.packages;
  await append(requestId, { ...on, item_key: "item-1", case_id: caseId, event_key: `cand:${cid}:package`, type: "package_ready", message: "Both package parts are stored and ready for download.", data: { bug_case_sha256: packages.bug_case.sha256, validator_sha256: packages.validator.sha256 } });
  expect(await w.db.factoryRecords.recordEvidence({ request_id: requestId, case_id: caseId, evidence, sha256: canonicalDigest(evidence).sha256 })).toBe("recorded");
  if (deliver) await append(requestId, { ...on, item_key: "item-1", case_id: caseId, event_key: `cand:${cid}:delivered`, type: "case_delivered", message: "Case delivered for item item-1.", data: {} });
  return evidence;
}

/** The request's finish as its worker records it once every requested case is delivered. */
async function finishFulfilled(requestId: string): Promise<void> {
  await append(requestId, { ...NO_LINKS, event_key: "run:finished", type: "request_finished", message: "Request finished: fulfilled.", data: { outcome: "fulfilled", stop_code: "fulfilled" } });
}

function download(requestId: string, caseId: string, part: string): Promise<Response> {
  return getPackage(request(`/api/factory/requests/${requestId}/cases/${caseId}/packages/${part}`), w.server, { request_id: requestId, case_id: caseId, part });
}

function validate(requestId: string, caseId: string, validationId = VALIDATION_ID): Promise<Response> {
  return postValidation(request(`/api/factory/requests/${requestId}/cases/${caseId}/validations`, { body: { validation_id: validationId } }), w.server, { request_id: requestId, case_id: caseId });
}

/** The protocol's copies in all, from the validator core's manifest. */
function coreCopies(): number {
  const manifest = unpackArchive(host.core).find((member) => member.path === VALIDATOR_MANIFEST);
  if (manifest === undefined) throw new Error("synthetic: the core has no manifest");
  const { clean, buggy, fixed } = parseValidatorManifest(manifest.bytes).protocol.per_state;
  return clean.copies + buggy.copies + fixed.copies;
}

/** The synthetic protocol with two copies per state, so a core built with it prices a validation run differently. */
function twoCopyProtocol(adapter: HostAdapter): Protocol {
  const base = adapter.protocol(host.entry);
  const copies = { copies: 2, rounds_per_copy: 2, min_valid_runs: 2 };
  const changed = { protocol_id: base.protocol_id, version: base.version, per_state: { clean: copies, buggy: copies, fixed: copies }, valid_trial_rules: base.valid_trial_rules };
  return { ...changed, sha256: canonicalDigest(changed).sha256 };
}

interface PreparedDir {
  dir: string;
  index: PreparedIndex;
}

/**
 * A new prepared directory holding the synthetic entry as first prepared, then package version 2 of it
 * written into the same directory, as a later `case-package prepare` does after a catalog revision that
 * changed only the entry's protocol (not part of the case ID): the index names version 2's core under
 * the same case ID, and version 1's archives stay.
 */
async function newerVersionDir(): Promise<PreparedDir> {
  const dir = await mkdtemp(join(tmpdir(), "rbw-web-live-v2-"));
  await writePrepared(dir, [host.exported]);
  const protocol = twoCopyProtocol(host.adapter);
  const entry: CatalogEntry = { ...host.entry, verification: { ...host.entry.verification, protocol_id: protocol.protocol_id, protocol_sha256: protocol.sha256 } };
  const adapter: HostAdapter = {
    ...host.adapter,
    catalog: () => [entry],
    protocol: () => protocol,
    bugCaseInputs: () => host.adapter.bugCaseInputs(host.entry),
    validatorInputs: async () => ({ ...(await host.adapter.validatorInputs(host.entry)), protocol }),
  };
  const v2 = await exportCase({ adapter, entry, identity: CASE_IDENTITY, license: "MIT", scan: null, package_version: 2 });
  const index = await writePrepared(dir, [v2]);
  expect(index.entries).toHaveLength(1);
  expect(index.entries[0]).toMatchObject({ case_id: host.prepared.case_id, package_version: 2 });
  expect(index.entries[0]?.validator_core_sha256).not.toBe(host.prepared.validator_core_sha256);
  return { dir, index: await readPreparedIndex(dir) };
}

/** A new live server over the world's database, as after a restart, reading the given prepared directory. */
function restartedServer(prepared: PreparedDir): FactoryServer {
  return createLiveServer({ passcode: PASSCODE, database: () => Promise.resolve(w.db), launch: { sandbox: w.sandbox, config: { image: IMAGE, env: LAUNCH_ENV } }, adapters: [host.adapter], prepared, rates: RATES, now: () => new Date(w.clock.ms), log: (line) => w.logs.push(line) });
}

// Tests ------------------------------------------------------------------------------------------

describe("the modules live mode loads by name", () => {
  it("are the package tooling's root entry and the controller's local backend, with the calls live mode makes", async () => {
    // This directory's type check holds the real modules to the interfaces the app's type check sees.
    const tools: PackageTools = casePackage;
    const backend: LocalBackend = factoryLocal;
    expect((await packageTools()).readPreparedIndex).toBe(tools.readPreparedIndex);
    expect((await localBackend()).localWorkerSandbox).toBe(backend.localWorkerSandbox);
  });
});

describe("session and capabilities", () => {
  it("signs in with the judges' passcode", async () => {
    expect((await postSession(request("/api/factory/session", { body: { passcode: PASSCODE }, session: false }), w.server)).status).toBe(204);
  });

  it("offers task-report concurrency from the prepared entry, with the factory profile's limits", async () => {
    const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), w.server));
    expect(capabilities.service).toEqual({ state: "available", code: null, message: null });
    expect(capabilities.limits).toEqual(FACTORY_PROFILE.limits);
    expect(capabilities.combinations.find((item) => item.host_id === "task-report" && item.bug_type_id === "concurrency")).toMatchObject({ status: "supported", reason: null });
  });

  it("answers not_configured without a database, and without a complete launch, and opens no database for it", async () => {
    let opened = 0;
    const database = (): Promise<FactoryDatabase> => {
      opened += 1;
      return Promise.resolve(w.db);
    };
    const launch = { sandbox: w.sandbox, config: { image: IMAGE, env: LAUNCH_ENV } };
    for (const deps of [{ database: null, launch }, { database, launch: null }]) {
      const server = createLiveServer({ passcode: PASSCODE, ...deps, adapters: [host.adapter], prepared: { dir: host.dir, index: host.index }, rates: RATES, now: () => new Date(w.clock.ms), log: () => undefined });
      const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), server));
      expect(capabilities.service).toEqual({ state: "unavailable", code: "not_configured", message: "The factory service is not configured." });
    }
    expect(opened).toBe(0);
  });

  it("answers not_configured on a ledger without the factory pool, and on one without the factory slot key", async () => {
    for (const without of ["pool", "slot"] as const) {
      const other = await world({ without });
      try {
        expect(await other.server.ports.ledgerState(), without).toEqual({ configured: false, halted: false });
        const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), other.server));
        expect(capabilities.service.code, without).toBe("not_configured");
      } finally {
        await other.pglite.close();
      }
    }
  });

  it("answers a start 503 before anything is recorded while the launch configuration is incomplete", async () => {
    const server = createLiveServer({ passcode: PASSCODE, database: () => Promise.resolve(w.db), launch: null, adapters: [host.adapter], prepared: { dir: host.dir, index: host.index }, rates: RATES, now: () => new Date(w.clock.ms), log: () => undefined });
    const response = await start(REQUEST_ID, input(), server);
    expect(response.status).toBe(503);
    expect(await w.db.factoryRecords.request(REQUEST_ID)).toBeNull();
    expect(await slotHolder()).toBeNull();
    expect(w.sandbox.creates).toHaveLength(0);
  });

  it("answers a host absent from the prepared index unsupported, and an unreadable index offers nothing", async () => {
    const otherEntryIndex: PreparedIndex = { ...host.index, entries: host.index.entries.map((entry) => ({ ...entry, entry_id: "synthetic-other-entry" })) };
    const staleIndex: PreparedIndex = { ...host.index, entries: host.index.entries.map((entry) => ({ ...entry, case_id: "0".repeat(64) })) };
    for (const prepared of [null, { dir: host.dir, index: otherEntryIndex }, { dir: host.dir, index: staleIndex }]) {
      const server = (await world({ deps: { prepared } })).server;
      const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), server));
      expect(capabilities.combinations.find((item) => item.host_id === "task-report" && item.bug_type_id === "concurrency")).toMatchObject({ status: "unsupported", reason: NOT_PREPARED });
      const interpretation = await interpret(input(), server);
      expect(interpretation.startable).toBe(false);
      expect(interpretation.items[0]?.eligible_sources).toEqual([]);
    }
  });
});

describe("interpretations", () => {
  it("interprets the request form's item-1 and item-2 against the prepared entry", async () => {
    const interpretation = await interpret(
      input(2_000_000, [
        { item_key: "item-1", bug_type_id: "concurrency", quantity: 1, description: null, difficulty: "source_inferable_allowed" },
        { item_key: "item-2", bug_type_id: "concurrency", quantity: 1, description: "an acknowledged change is lost when requests overlap", difficulty: "source_inferable_allowed" },
      ]),
    );
    expect(interpretation.items.map((item) => item.item_key)).toEqual(["item-1", "item-2"]);
    expect(interpretation.items.map((item) => item.eligible_sources)).toEqual([
      [{ host_id: "task-report", source_id: host.entry.source_id, entries: 1 }],
      [{ host_id: "task-report", source_id: host.entry.source_id, entries: 1 }],
    ]);
  });
});

describe("starts", () => {
  it("accepts a start with 202: the budget at the requested cap, the worker's worst case reserved, the slot under the request root and one launch", async () => {
    const response = await start();
    expect(response.status).toBe(202);
    const body = await contractBody("RequestStatus", response);
    expect(body).toMatchObject({ request_id: REQUEST_ID, state: "queued", budget: { budget_microusd: 1_500_000, reserved_microusd: Number(WORKER_WORST_CASE), spent_microusd: 0 } });
    expect(body.events.map((event) => [event.type, event.message])).toEqual([
      ["request_accepted", "Request accepted."],
      ["budget_updated", expect.stringContaining("worker's worst case") as string],
    ]);
    expect(await budget()).toEqual({ cap: 1_500_000n, open: WORKER_WORST_CASE, settled: 0n });
    expect(await slotHolder()).toBe(FACTORY_IDENTITY.requestRoot(REQUEST_ID));
    expect(w.sandbox.creates).toHaveLength(1);
    expect(w.sandbox.creates[0]).toMatchObject({ image: IMAGE, env: expect.objectContaining(LAUNCH_ENV) as unknown });
    expect(await w.server.ports.slotHolder()).toEqual({ request_id: REQUEST_ID });
  });

  it("answers an identical repeat 200 with nothing new, and a different body under the same ID idempotency_conflict", async () => {
    expect((await start()).status).toBe(202);
    const repeat = await start();
    expect(repeat.status).toBe(200);
    expect((await contractBody("RequestStatus", repeat)).request_id).toBe(REQUEST_ID);
    expect(w.sandbox.creates).toHaveLength(1);
    expect(await budget()).toEqual({ cap: 1_500_000n, open: WORKER_WORST_CASE, settled: 0n });
    const conflict = await start(REQUEST_ID, input(1_200_000));
    expect(conflict.status).toBe(409);
    expect((await readJson(conflict)).error).toMatchObject({ code: "idempotency_conflict" });
    expect(await budget()).toEqual({ cap: 1_500_000n, open: WORKER_WORST_CASE, settled: 0n });
  });

  it("runs concurrent identical starts one at a time under the request lock: one 202, the others 200, one launch", async () => {
    const interpretation = await interpret(input());
    const body = { request_id: REQUEST_ID, input: input(), interpretation_sha256: interpretation.interpretation_sha256 };
    const responses = await Promise.all([1, 2, 3].map(() => postStart(request("/api/factory/requests", { body }), w.server)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 202]);
    expect(w.sandbox.creates).toHaveLength(1);
    expect(await budget()).toEqual({ cap: 1_500_000n, open: WORKER_WORST_CASE, settled: 0n });
  });

  it("answers a second request ID busy (active) while the first holds the slot, and records nothing for it", async () => {
    expect((await start()).status).toBe(202);
    const second = await start(OTHER_REQUEST_ID);
    expect(second.status).toBe(409);
    expect((await readJson(second)).error).toMatchObject({ code: "busy", retryable: true, details: { reason: "active" } });
    expect(await w.db.factoryRecords.request(OTHER_REQUEST_ID)).toBeNull();
    expect(await slotHolder()).toBe(FACTORY_IDENTITY.requestRoot(REQUEST_ID));
    expect(w.sandbox.creates).toHaveLength(1);
  });

  it("answers budget_unavailable when the pool cannot cover the budget, and records nothing", async () => {
    await w.pglite.close();
    w = await world({ poolCap: 1_000_000 });
    const response = await start();
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toMatchObject({ code: "budget_unavailable" });
    expect(await w.db.factoryRecords.request(REQUEST_ID)).toBeNull();
    expect(await slotHolder()).toBeNull();
  });

  it("answers budget_unavailable when the pool covered the budget at step 5 but not the worker's worst case at step 7, releasing the slot and recording nothing", async () => {
    await w.pglite.close();
    w = await world({ poolCap: Number(WORKER_WORST_CASE) - 1 });
    // The pool read at step 5 covers the budget; by step 7 the pool holds less than the worker's worst case.
    let held: string | null = null;
    const live = w.server.ports;
    const poolAvailable = (): Promise<number> => Promise.resolve(40_000_000);
    const acquireSlot: typeof live.acquireSlot = async (root) => {
      const taken = await live.acquireSlot(root);
      held = await slotHolder();
      return taken;
    };
    w.server = { ...w.server, ports: { ...live, poolAvailable, acquireSlot } };
    const response = await start(REQUEST_ID, input(1_000_000));
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toMatchObject({ code: "budget_unavailable" });
    expect(held).toBe(FACTORY_IDENTITY.requestRoot(REQUEST_ID));
    expect(await slotHolder()).toBeNull();
    expect(await w.server.ports.slotHolder()).toBeNull();
    expect(await w.db.factoryRecords.request(REQUEST_ID)).toBeNull();
    expect(w.sandbox.creates).toHaveLength(0);
  });

  it("shows a halted ledger in capabilities and answers a start unavailable, with nothing recorded", async () => {
    expect((await start()).status).toBe(202);
    // The worker's operation reconciled above its open amount records an over-envelope observation, which halts new work.
    const operations = await w.db.spend.budgetOperations({ budget_key: budgetKey(REQUEST_ID) });
    const operation = operations.ok ? operations.operations[0] : undefined;
    if (operation === undefined) throw new Error("synthetic: the worker's operation is not recorded");
    ok(await w.db.spend.transition({ operation_id: operation.operation_id, from_state: "running", to_state: "uncertain", actor_role: "factory-worker", uncertainty: "unknown_status" }));
    const slot = await w.db.spend.slotStatus({ slot_key: "factory" });
    ok(
      await w.db.spend.reconcile({
        schema_version: 1,
        operation_id: operation.operation_id,
        previous_state: "uncertain",
        evidence: [{ key: "synthetic/reconcile/worker", sha256: "f".repeat(64) }],
        provider_resource_ids: slot.ok ? slot.children.filter((child) => child.operation_id === operation.operation_id).map((child) => child.resource_id) : [],
        recorded_at: new Date(w.clock.ms).toISOString(),
        actor_role: "operator",
        decision: "confirm_stopped_incomplete",
        retained_microusd: Number(operation.open_microusd) + 1,
        released_microusd: 0,
        reason: "synthetic over-envelope reconciliation",
      }),
    );
    expect(await w.server.ports.ledgerState()).toEqual({ configured: true, halted: true });
    const capabilities = await contractBody("Capabilities", await getCapabilities(request("/api/factory/capabilities", { session: false }), w.server));
    expect(capabilities.service.code).toBe("halted");
    const refused = await start(OTHER_REQUEST_ID);
    expect(refused.status).toBe(503);
    expect(await w.db.factoryRecords.request(OTHER_REQUEST_ID)).toBeNull();
    const interpretation = await interpret(input());
    const direct = await w.server.ports.createRecordLaunch({ start: { request_id: OTHER_REQUEST_ID, input: input(), interpretation_sha256: interpretation.interpretation_sha256 }, sha256: "e".repeat(64), interpretation, root: FACTORY_IDENTITY.requestRoot(OTHER_REQUEST_ID) });
    expect(direct).toMatchObject({ ok: false, code: "unavailable" });
    expect(await w.db.factoryRecords.request(OTHER_REQUEST_ID)).toBeNull();
  });
});

describe("status, stop and the lost worker", () => {
  it("projects the recorded events: queued, then the worker's events appended through the factory records", async () => {
    expect((await start()).status).toBe(202);
    expect((await contractBody("RequestStatus", await status())).state).toBe("queued");
    await w.db.factoryRecords.recordHeartbeat({ request_id: REQUEST_ID }, new Date(w.clock.ms));
    await append(REQUEST_ID, { ...NO_LINKS, event_key: "worker_started", type: "worker_started", message: "The worker started.", data: {} });
    const cid = candidateId(host.entry);
    await append(REQUEST_ID, { ...NO_LINKS, host_id: "task-report", candidate_id: cid, event_key: `cand:${cid}:selected`, type: "candidate_selected", message: `Selected catalog entry ${host.entry.entry_id}.`, data: { source_id: host.entry.source_id, entry_id: host.entry.entry_id } });
    const running = await contractBody("RequestStatus", await status());
    expect(running.state).toBe("running");
    expect(running.candidates).toEqual([expect.objectContaining({ candidate_id: cid, host_id: "task-report", entry_id: host.entry.entry_id, stage: "selected" })]);
    expect(running.events.map((event) => event.type)).toEqual(["request_accepted", "budget_updated", "worker_started", "candidate_selected"]);
    const after = await contractBody("RequestStatus", await getRequestStatus(request(`/api/factory/requests/${REQUEST_ID}?after=3`), w.server, { request_id: REQUEST_ID }));
    expect(after.events.map((event) => event.seq)).toEqual([4]);
    expect((await status(OTHER_REQUEST_ID)).status).toBe(404);
  });

  it("appends worker_unresponsive once after 60 s without a heartbeat, under concurrent polls", async () => {
    expect((await start()).status).toBe(202);
    w.clock.ms += 61_000;
    // The poll that appended answers the status after it; the other may answer the one it read before.
    const polls = await Promise.all([status(), status()]);
    const attention = await Promise.all(polls.map(async (response) => (await contractBody("RequestStatus", response)).attention));
    expect(attention).toContainEqual(expect.objectContaining({ code: "worker_unresponsive" }));
    expect((await contractBody("RequestStatus", await status())).attention).toMatchObject({ code: "worker_unresponsive" });
    const events = await w.db.factoryRecords.events(REQUEST_ID);
    expect(events.filter((event) => event.type === "attention")).toHaveLength(1);
  });

  it("clears worker_unresponsive once when the worker resumed and finished between polls, under concurrent polls", async () => {
    await acceptWithoutSlot();
    w.clock.ms += 61_000;
    expect((await contractBody("RequestStatus", await status())).attention).toMatchObject({ code: "worker_unresponsive" });
    // Between polls the heartbeat resumes and the worker records its case and its finish.
    w.clock.ms += 5_000;
    await w.db.factoryRecords.recordHeartbeat({ request_id: REQUEST_ID }, new Date(w.clock.ms));
    await packageCase(REQUEST_ID, true);
    await finishFulfilled(REQUEST_ID);
    const finishedAt = (await w.db.factoryRecords.events(REQUEST_ID)).find((event) => event.type === "request_finished")?.at;
    w.clock.ms += 5_000;
    const polls = await Promise.all([status(), status()]);
    for (const response of polls) {
      const shown = await contractBody("RequestStatus", response);
      expect(shown).toMatchObject({ state: "finished", outcome: "fulfilled", attention: null });
      expect(shown.events.filter((event) => event.type === "attention_cleared")).toEqual([expect.objectContaining({ at: finishedAt, data: { code: "worker_unresponsive" } })]);
    }
    const events = await w.db.factoryRecords.events(REQUEST_ID);
    expect(events.filter((event) => event.type === "attention")).toHaveLength(1);
    expect(events.filter((event) => event.type === "attention_cleared")).toHaveLength(1);
    expect((await contractBody("RequestStatus", await status())).attention).toBeNull();
  });

  it("records a stop once and answers a repeat as a replay", async () => {
    expect((await start()).status).toBe(202);
    const stopped = await postStop(request(`/api/factory/requests/${REQUEST_ID}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID });
    expect(stopped.status).toBe(200);
    expect((await contractBody("RequestStatus", stopped)).state).toBe("stopping");
    expect(await w.server.ports.recordStop(REQUEST_ID)).toBe("replay");
    expect(await w.db.factoryRecords.stopRequested(REQUEST_ID)).toBe(true);
    const stops = (await w.db.factoryRecords.events(REQUEST_ID)).filter((event) => event.type === "stop_requested");
    expect(stops.map((event) => event.message)).toEqual([STOP_MESSAGE]);
    expect(await w.server.ports.recordStop(OTHER_REQUEST_ID)).toBe("not_found");
  });

  it("finishes a request whose worker sent no heartbeat for 180 s worker_lost, keeping the slot for reconciliation", async () => {
    expect((await start()).status).toBe(202);
    w.clock.ms += 181_000;
    const lost = await contractBody("RequestStatus", await status());
    expect(lost).toMatchObject({ state: "finished", outcome: "operational_error", stop_reason: { code: "worker_lost" }, attention: { code: "needs_reconciliation" } });
    expect(await w.server.ports.slotHolder()).toEqual({ request_id: REQUEST_ID });
    const next = await start(OTHER_REQUEST_ID);
    expect(next.status).toBe(409);
    expect((await readJson(next)).error).toMatchObject({ code: "busy", retryable: false, details: { reason: "needs_reconciliation" } });
  });
});

describe("downloads", () => {
  it("answers 404 for both parts between package_ready and case_delivered", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, false);
    for (const part of ["bug-case", "validator"]) expect((await download(REQUEST_ID, evidence.case.case_id, part)).status).toBe(404);
    expect(await w.server.ports.readPackage(REQUEST_ID, "f".repeat(64), "bug-case")).toBeNull();
  });

  it("sends a delivered case's parts as the worker built them: the prepared bug case and the assembled validator, hash-checked", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, true);
    const caseId = evidence.case.case_id;
    const bugCase = await download(REQUEST_ID, caseId, "bug-case");
    expect(bugCase.status).toBe(200);
    expect(Buffer.from(await bugCase.arrayBuffer()).equals(Buffer.from(host.bugCase))).toBe(true);
    expect(bugCase.headers.get("content-disposition")).toBe(`attachment; filename="${packageFilename("bug_case", caseId, 1)}"`);
    const validator = await download(REQUEST_ID, caseId, "validator");
    expect(validator.status).toBe(200);
    const bytes = new Uint8Array(await validator.arrayBuffer());
    expect(sha256(bytes)).toBe(evidence.case.packages.validator.sha256);
    expect(bytes.length).toBe(evidence.case.packages.validator.size_bytes);
    expect(Buffer.from(bytes).equals(Buffer.from(assembleFinalValidator(host.core, evidence.record)))).toBe(true);
    expect(validator.headers.get("content-disposition")).toBe(`attachment; filename="${packageFilename("validator", caseId, 1)}"`);
    expect(sha256(bytes)).not.toBe(host.prepared.validator_core_sha256);
  });

  it("answers unavailable when the prepared bytes are not the ones the case announced", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, true);
    const work = await mkdtemp(join(tmpdir(), "rbw-web-live-tampered-"));
    await writeFile(join(work, preparedObjectName(host.prepared.bug_case_sha256)), Buffer.from("synthetic tampered bytes"));
    w.server = createLiveServer({ passcode: PASSCODE, database: () => Promise.resolve(w.db), launch: { sandbox: w.sandbox, config: { image: IMAGE, env: LAUNCH_ENV } }, adapters: [host.adapter], prepared: { dir: work, index: await readPreparedIndex(host.dir) }, rates: RATES, now: () => new Date(w.clock.ms), log: () => undefined });
    expect((await download(REQUEST_ID, evidence.case.case_id, "bug-case")).status).toBe(503);
  });

  it("rebuilds a delivered validator from the core its record verified after a newer package version is prepared into the same directory", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, true);
    w.server = restartedServer(await newerVersionDir());
    const validator = await download(REQUEST_ID, evidence.case.case_id, "validator");
    expect(validator.status).toBe(200);
    const bytes = new Uint8Array(await validator.arrayBuffer());
    expect(sha256(bytes)).toBe(evidence.case.packages.validator.sha256);
    expect(bytes.length).toBe(evidence.case.packages.validator.size_bytes);
    expect(validator.headers.get("content-disposition")).toBe(`attachment; filename="${packageFilename("validator", evidence.case.case_id, 1)}"`);
    expect((await download(REQUEST_ID, evidence.case.case_id, "bug-case")).status).toBe(200);
  });
});

describe("validation runs", () => {
  it("accepts a validation POST: the slot under the validation root, the protocol's worst case reserved, one launch; its replay answers 200", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, true);
    await finishFulfilled(REQUEST_ID);
    const caseId = evidence.case.case_id;
    expect(await w.server.ports.slotHolder()).toBeNull();
    const before = await budget();
    const accepted = await validate(REQUEST_ID, caseId);
    expect(accepted.status).toBe(202);
    const run = await contractBody("ValidationRun", accepted);
    expect(run).toMatchObject({ validation_id: VALIDATION_ID, case_id: caseId, state: "queued", package_sha256: { bug_case: evidence.case.packages.bug_case.sha256, validator: evidence.case.packages.validator.sha256 }, harness: HARNESS_IDENTITY });
    expect((await budget()).open - before.open).toBe(BigInt(validationWorstCase(RATES, "task-report", coreCopies())));
    expect(await slotHolder()).toBe(FACTORY_IDENTITY.validationRoot(VALIDATION_ID));
    expect(await w.server.ports.slotHolder()).toEqual({ validation_id: VALIDATION_ID });
    expect(w.sandbox.creates).toHaveLength(1);

    const replay = await validate(REQUEST_ID, caseId);
    expect(replay.status).toBe(200);
    expect((await contractBody("ValidationRun", replay)).validation_id).toBe(VALIDATION_ID);
    expect(w.sandbox.creates).toHaveLength(1);
    const read = await getValidationRun(request(`/api/factory/requests/${REQUEST_ID}/cases/${caseId}/validations/${VALIDATION_ID}`), w.server, { request_id: REQUEST_ID, case_id: caseId, validation_id: VALIDATION_ID });
    expect((await contractBody("ValidationRun", read)).state).toBe("queued");
    expect(await w.server.ports.getValidation(REQUEST_ID, "f".repeat(64), VALIDATION_ID)).toBeNull();
    expect(await w.server.ports.getValidation(OTHER_REQUEST_ID, caseId, VALIDATION_ID)).toBeNull();
    const shown = await contractBody("RequestStatus", await status());
    expect(shown.cases[0]?.validation).toMatchObject({ validation_id: VALIDATION_ID, state: "queued" });
  });

  it("prices a validation run on the protocol of the core the case's record verified after a newer package version is prepared into the same directory", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, true);
    await finishFulfilled(REQUEST_ID);
    w.server = restartedServer(await newerVersionDir());
    const before = await budget();
    const accepted = await validate(REQUEST_ID, evidence.case.case_id);
    expect(accepted.status).toBe(202);
    expect(await contractBody("ValidationRun", accepted)).toMatchObject({ package_sha256: { bug_case: evidence.case.packages.bug_case.sha256, validator: evidence.case.packages.validator.sha256 } });
    expect(coreCopies()).toBe(3);
    expect((await budget()).open - before.open).toBe(BigInt(validationWorstCase(RATES, "task-report", coreCopies())));
  });

  it("shows each case's latest validation run by acceptance, whatever order the runs were recorded in", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, true);
    await finishFulfilled(REQUEST_ID);
    const caseId = evidence.case.case_id;
    expect((await validate(REQUEST_ID, caseId)).status).toBe(202);
    const accepted = await w.db.factoryRecords.validation(VALIDATION_ID);
    if (accepted === null) throw new Error("synthetic: the validation run is not recorded");
    // Further runs of the same case as the ledger holds them after earlier runs finished: one accepted before, one after.
    const run = (validationId: string, offsetMs: number) => ({ ...accepted, validation_id: validationId, root: FACTORY_IDENTITY.validationRoot(validationId), accepted_at: new Date(Date.parse(accepted.accepted_at) + offsetMs).toISOString() });
    const shown = async (): Promise<string | undefined> => (await contractBody("RequestStatus", await status())).cases[0]?.validation?.validation_id;
    expect(await w.db.factoryRecords.recordValidation(run(OTHER_VALIDATION_ID, -60_000))).toBe("created");
    expect(await shown()).toBe(VALIDATION_ID);
    expect(await w.db.factoryRecords.recordValidation(run(LATER_VALIDATION_ID, 60_000))).toBe("created");
    expect(await shown()).toBe(LATER_VALIDATION_ID);
  });

  it("answers a validation ID used on another case idempotency_conflict, and another run busy while one holds the slot", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, true);
    await finishFulfilled(REQUEST_ID);
    const caseId = evidence.case.case_id;
    expect((await validate(REQUEST_ID, caseId)).status).toBe(202);
    const conflict = await validate(REQUEST_ID, "f".repeat(64));
    expect(conflict.status).toBe(409);
    expect((await readJson(conflict)).error).toMatchObject({ code: "idempotency_conflict" });
    const busy = await validate(REQUEST_ID, caseId, OTHER_VALIDATION_ID);
    expect(busy.status).toBe(409);
    expect((await readJson(busy)).error).toMatchObject({ code: "busy", details: { reason: "active" } });
    expect(await w.db.factoryRecords.validation(OTHER_VALIDATION_ID)).toBeNull();
  });

  it("keeps the qualification record's evaluator detail out of every JSON response", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, true);
    await finishFulfilled(REQUEST_ID);
    expect(JSON.stringify(evidence.record)).toContain(SENTINEL);
    const caseId = evidence.case.case_id;
    const responses = [
      await status(),
      await validate(REQUEST_ID, caseId),
      await validate(REQUEST_ID, caseId),
      await getValidationRun(request(`/api/factory/requests/${REQUEST_ID}/cases/${caseId}/validations/${VALIDATION_ID}`), w.server, { request_id: REQUEST_ID, case_id: caseId, validation_id: VALIDATION_ID }),
      await postStop(request(`/api/factory/requests/${REQUEST_ID}/stop`, { body: {} }), w.server, { request_id: REQUEST_ID }),
      await getCapabilities(request("/api/factory/capabilities", { session: false }), w.server),
    ];
    for (const response of responses) {
      expect(response.status).toBeLessThan(300);
      expect(await response.text()).not.toContain(SENTINEL);
    }
  });

  it("answers a validation POST 404 before the case is delivered", async () => {
    await acceptWithoutSlot();
    const evidence = await packageCase(REQUEST_ID, false);
    expect((await validate(REQUEST_ID, evidence.case.case_id)).status).toBe(404);
    expect(await slotHolder()).toBeNull();
  });
});
