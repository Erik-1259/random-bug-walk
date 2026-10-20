// Synthetic fakes for the factory worker's tests: a PGlite spend ledger with every migration, the
// factory pool and slot key; an in-memory request-budget layer and factory record store with the
// behavior the ledger's budget functions and records are specified to have (replay by operation or
// event key, budget room over committed amounts, validation reserves after close, only the
// contract's late event types after request_finished); stand-ins for the factory core's identity
// and event modules over synthetic namespaces; fake Sandbox SDKs for worker and copy sandboxes
// that record every call; and a settable clock.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { pack } from "tar-stream";
import { loadRateSheet } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import type { CopyPlan, CopyRoots, CopyState, EventType, HostId, Protocol, StopCode } from "@rbw/factory-contract";
import type { SandboxInstance, SandboxSdk } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { createSpend, migrate } from "@rbw/spend";
import type { Reservation, ReserveRequest, Spend } from "@rbw/spend";
import type {
  AppendOutcome,
  BudgetResult,
  BudgetRole,
  BudgetTotals,
  FactoryBudgets,
  FactoryEventBuilders,
  FactoryEventInput,
  FactoryIdentity,
  FactoryLedger,
  FactoryRecords,
  FactoryRequestRecord,
  FactoryValidationRecord,
  HeartbeatTarget,
  StoredFactoryEvent,
  ValidationEventInput,
  WorkerSandboxCreateParams,
  WorkerSandboxInstance,
  WorkerSandboxSdk,
  WorkerSandboxStatus,
} from "../../src/factory-ports.ts";
import { RATE_SHEET_PATH } from "../../src/rate-sheet.ts";

export const SYNTHETIC_REQUEST_NAMESPACE = "5a0e6c1e-0000-5000-8000-0000000000a1";
export const SYNTHETIC_VALIDATION_NAMESPACE = "5a0e6c1e-0000-5000-8000-0000000000b2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A test stand-in for the factory core's UUIDv5 (RFC 4122 version 5); the code under test computes no IDs itself. */
export function syntheticUuidV5(namespace: string, name: string): string {
  const hash = createHash("sha1").update(Buffer.from(namespace.replaceAll("-", ""), "hex")).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const WORKER_IMAGE = `synthetic-team/synthetic-project/rbw-factory-worker@sha256:${"ab".repeat(32)}`;
export const CREDENTIALS = { DATABASE_URL: "postgres://synthetic.invalid/db", VERCEL_TOKEN: "synthetic-token", VERCEL_TEAM_ID: "synthetic-team", VERCEL_PROJECT_ID: "synthetic-project" };
export const INTERPRETATION_SHA256 = "1".repeat(64);
export const CASE_ID = "c".repeat(64);
export const CANDIDATE_A = "a".repeat(64);
export const CANDIDATE_B = "b".repeat(64);

/** A synthetic protocol's per-state part: `copies` copies of each state, one round each. */
export function protocolOf(copies: Record<CopyState, number> = { clean: 1, buggy: 1, fixed: 1 }): Pick<Protocol, "per_state"> {
  const state = (n: number) => ({ copies: n, rounds_per_copy: 1, min_valid_runs: n });
  return { per_state: { clean: state(copies.clean), buggy: state(copies.buggy), fixed: state(copies.fixed) } };
}

/** The protocol of the synthetic validator packages: one copy per state. */
export const PROTOCOL = protocolOf();

/**
 * A validation run of a three-copy package on either host, worked from the v1 rate sheet: its worker
 * at 2 vCPU and 4 GB for 1,860 s and its copies at 4 vCPU and 8 GB within 1,800 s plus three 60 s
 * allowances (11,640 vCPU-s, 23,280 GB-s), and four creations.
 */
export const VALIDATION_3_MICROUSD = 413_867 + 137_094 + 3;

/** A stand-in for the factory core's identity module, over synthetic namespaces. */
export function syntheticIdentity(): FactoryIdentity {
  return {
    project_id: syntheticUuidV5(SYNTHETIC_REQUEST_NAMESPACE, "synthetic-project"),
    isUuid: (value): value is string => typeof value === "string" && UUID.test(value),
    requestRoot: (id) => syntheticUuidV5(SYNTHETIC_REQUEST_NAMESPACE, id),
    validationRoot: (id) => syntheticUuidV5(SYNTHETIC_VALIDATION_NAMESPACE, id),
    copyExecutionId: (input) => syntheticUuidV5(input.kind === "request" ? SYNTHETIC_REQUEST_NAMESPACE : SYNTHETIC_VALIDATION_NAMESPACE, `${input.root}:${input.subject_id}:${input.state}-${String(input.n)}`),
  };
}

const NO_LINKS = { host_id: null, candidate_id: null, item_key: null, case_id: null };

/**
 * A stand-in for the factory core's event module, with its key scheme for the lost-worker finish
 * (`lost:candidate-end`, `lost:attention`, `lost:finished`) and the run's attention
 * (`run:attention:<code>`).
 */
export function syntheticEventBuilders(): FactoryEventBuilders {
  const attention = (key: string): FactoryEventInput => ({ event_key: key, type: "attention", ...NO_LINKS, message: "Spend needs reconciliation.", data: { code: "needs_reconciliation" } });
  return {
    lostWorker({ events }) {
      if (events.some((event) => event.type === "request_finished")) return [];
      const ended = new Set(events.filter((event) => ["candidate_rejected", "candidate_invalid", "candidate_incomplete", "candidate_skipped", "case_delivered"].includes(event.type)).map((event) => event.candidate_id));
      const inFlight = events.filter((event) => event.type === "candidate_selected" && !ended.has(event.candidate_id)).at(-1);
      const out: FactoryEventInput[] = [];
      if (inFlight !== undefined) {
        out.push({ event_key: "lost:candidate-end", type: "candidate_incomplete", host_id: inFlight.host_id, candidate_id: inFlight.candidate_id, item_key: null, case_id: null, message: "Incomplete: the worker stopped responding.", data: { reason: "incomplete_run" } });
      }
      out.push(attention("lost:attention"));
      out.push({ event_key: "lost:finished", type: "request_finished", ...NO_LINKS, message: "Request finished: operational error.", data: { outcome: "operational_error", stop_code: "worker_lost" } });
      return out;
    },
    attention: (code) => attention(`run:attention:${code}`),
  };
}

export class Clock {
  ms: number;
  constructor(iso = "2026-10-20T19:00:00.000Z") {
    this.ms = Date.parse(iso);
  }
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Every fake call yields once, as a database or provider round trip would, so concurrent callers interleave. */
function roundTrip(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The envelope's priced total, as the ledger prices it: each line rounded up. */
function priced(request: ReserveRequest): bigint {
  return request.envelope.reduce((total, line) => {
    if (line.price === null) throw new Error("synthetic: unpriced line");
    return total + (BigInt(line.limit) * BigInt(line.price.microusd) + BigInt(line.price.per_units) - 1n) / BigInt(line.price.per_units);
  }, 0n);
}

interface Budget {
  cap: bigint;
  root: string;
  closed: StopCode | null;
  operations: string[];
}

/** Request budgets over the real spend ledger: room = cap - committed over every operation the budget admitted. */
export class FakeBudgets implements FactoryBudgets {
  readonly budgets = new Map<string, Budget>();
  readonly refusals: { budget_key: string; code: string; role: BudgetRole }[] = [];
  readonly closes: { budget_key: string; cause: StopCode }[] = [];
  private readonly spend: Spend;

  constructor(spend: Spend) {
    this.spend = spend;
  }

  create(budgetKey: string, root: string, cap: number): void {
    this.budgets.set(budgetKey, { cap: BigInt(cap), root, closed: null, operations: [] });
  }

  private async committed(budget: Budget): Promise<{ settled: bigint; open: bigint }> {
    let settled = 0n;
    let open = 0n;
    for (const id of budget.operations) {
      const status = await this.spend.operationStatus({ operation_id: id });
      if (!status.ok) throw new Error("synthetic: a budget operation is unknown");
      settled += status.settled_microusd;
      open += status.open_microusd;
    }
    return { settled, open };
  }

  async reserve(budgetKey: string, role: BudgetRole, request: ReserveRequest): Promise<BudgetResult<Reservation>> {
    const budget = this.budgets.get(budgetKey);
    if (budget === undefined) return { ok: false, code: "unknown_budget" };
    const existing = await this.spend.operationStatus({ operation_id: request.operation_id });
    if (existing.ok) return this.spend.reserve(request);
    const refuse = (code: string): BudgetResult<Reservation> => {
      this.refusals.push({ budget_key: budgetKey, code, role });
      return { ok: false, code };
    };
    if (role === "request" && request.root_execution_id !== budget.root) return refuse("invalid_request");
    if (role === "request" && budget.closed !== null) return refuse("budget_closed");
    const { settled, open } = await this.committed(budget);
    if (priced(request) > budget.cap - settled - open) return refuse("budget_exhausted");
    const reserved = await this.spend.reserve(request);
    if (reserved.ok && !reserved.replay) budget.operations.push(request.operation_id);
    return reserved;
  }

  async close(budgetKey: string, cause: StopCode): Promise<BudgetResult<{ replay: boolean }>> {
    await roundTrip();
    const budget = this.budgets.get(budgetKey);
    if (budget === undefined) return { ok: false, code: "unknown_budget" };
    if (budget.closed !== null) return budget.closed === cause ? { ok: true, replay: true } : { ok: false, code: "operation_conflict" };
    budget.closed = cause;
    this.closes.push({ budget_key: budgetKey, cause });
    return { ok: true, replay: false };
  }

  async status(budgetKey: string): Promise<BudgetResult<BudgetTotals>> {
    const budget = this.budgets.get(budgetKey);
    if (budget === undefined) return { ok: false, code: "unknown_budget" };
    const { settled, open } = await this.committed(budget);
    return { ok: true, budget_microusd: budget.cap, settled_microusd: settled, open_microusd: open, committed_microusd: settled + open, available_microusd: budget.cap - settled - open, closed: budget.closed !== null };
  }
}

const LATE_TYPES: ReadonlySet<EventType> = new Set(["budget_updated", "attention", "attention_cleared", "validation_started", "validation_finished"]);

/** The same content: every field of the input, in a fixed key order, without the stored seq and time. */
function sameContent(stored: (FactoryEventInput | ValidationEventInput) & { seq: number; at: string }, input: FactoryEventInput | ValidationEventInput): boolean {
  const content: Record<string, unknown> = { ...stored };
  delete content.seq;
  delete content.at;
  const order = (value: object): string => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y))));
  return order(content) === order(input);
}

export class FakeRecords implements FactoryRecords {
  readonly requests = new Map<string, FactoryRequestRecord>();
  readonly eventLog = new Map<string, StoredFactoryEvent[]>();
  readonly heartbeats: { target: HeartbeatTarget; at: string }[] = [];
  readonly stops = new Set<string>();
  readonly validations = new Map<string, FactoryValidationRecord>();
  readonly validationLog = new Map<string, (ValidationEventInput & { seq: number; at: string })[]>();
  /** Every refused append (an event type no longer allowed after request_finished). */
  readonly refusedAppends: FactoryEventInput[] = [];

  async request(requestId: string): Promise<FactoryRequestRecord | null> {
    await roundTrip();
    return this.requests.get(requestId) ?? null;
  }

  async appendEvent(requestId: string, event: FactoryEventInput, at: Date): Promise<AppendOutcome> {
    await roundTrip();
    const log = this.eventLog.get(requestId) ?? [];
    this.eventLog.set(requestId, log);
    const prior = log.find((stored) => stored.event_key === event.event_key);
    if (prior !== undefined) return sameContent(prior, event) ? { kind: "replay", seq: prior.seq } : { kind: "conflict" };
    if (log.some((stored) => stored.type === "request_finished") && !LATE_TYPES.has(event.type)) {
      this.refusedAppends.push(event);
      return { kind: "refused", reason: "request_finished" };
    }
    const stored: StoredFactoryEvent = { ...event, seq: log.length + 1, at: at.toISOString() };
    log.push(stored);
    return { kind: "appended", seq: stored.seq };
  }

  async events(requestId: string): Promise<StoredFactoryEvent[]> {
    await roundTrip();
    return [...(this.eventLog.get(requestId) ?? [])];
  }

  async recordHeartbeat(target: HeartbeatTarget, at: Date): Promise<void> {
    await roundTrip();
    this.heartbeats.push({ target, at: at.toISOString() });
  }

  async lastHeartbeat(target: HeartbeatTarget): Promise<Date | null> {
    await roundTrip();
    const key = JSON.stringify(target);
    const last = this.heartbeats.filter((beat) => JSON.stringify(beat.target) === key).at(-1);
    return last === undefined ? null : new Date(last.at);
  }

  async stopRequested(requestId: string): Promise<boolean> {
    await roundTrip();
    return this.stops.has(requestId);
  }

  async recordValidation(record: FactoryValidationRecord): Promise<"created" | "replay" | "conflict"> {
    await roundTrip();
    const prior = this.validations.get(record.validation_id);
    if (prior !== undefined) return JSON.stringify(prior) === JSON.stringify(record) ? "replay" : "conflict";
    this.validations.set(record.validation_id, record);
    return "created";
  }

  async validation(validationId: string): Promise<FactoryValidationRecord | null> {
    await roundTrip();
    return this.validations.get(validationId) ?? null;
  }

  async appendValidationEvent(validationId: string, event: ValidationEventInput, at: Date): Promise<AppendOutcome> {
    await roundTrip();
    const log = this.validationLog.get(validationId) ?? [];
    this.validationLog.set(validationId, log);
    const prior = log.find((stored) => stored.event_key === event.event_key);
    if (prior !== undefined) return sameContent(prior, event) ? { kind: "replay", seq: prior.seq } : { kind: "conflict" };
    const stored = { ...event, seq: log.length + 1, at: at.toISOString() };
    log.push(stored);
    return { kind: "appended", seq: stored.seq };
  }

  async validationEvents(validationId: string): Promise<(ValidationEventInput & { seq: number; at: string })[]> {
    await roundTrip();
    return [...(this.validationLog.get(validationId) ?? [])];
  }

  async rootOwner(root: string): Promise<{ request_id: string; validation_id: string | null } | null> {
    await roundTrip();
    for (const request of this.requests.values()) if (request.root === root) return { request_id: request.request_id, validation_id: null };
    for (const validation of this.validations.values()) if (validation.root === root) return { request_id: validation.request_id, validation_id: validation.validation_id };
    return null;
  }

  types(requestId: string): string[] {
    return (this.eventLog.get(requestId) ?? []).map((event) => event.type);
  }
}

export class FakeInstance implements WorkerSandboxInstance {
  readonly name: string;
  status: WorkerSandboxStatus = "running";
  /** Status reads left that answer stopping before this sandbox answers stopped. */
  stoppingLeft = 0;
  readonly sdk: FakeWorkerSandbox;
  constructor(name: string, sdk: FakeWorkerSandbox) {
    this.name = name;
    this.sdk = sdk;
  }
  async runCommand(params: { cmd: string; args: string[]; cwd: string; detached: true }): Promise<unknown> {
    await roundTrip();
    this.sdk.calls.push({ action: "run", name: this.name, detail: params });
    if (this.sdk.failRun) throw new Error("synthetic: the command could not be started");
    if (this.sdk.onRun !== null) await this.sdk.onRun(params);
    return { cmdId: "synthetic" };
  }
  async stop(): Promise<unknown> {
    await roundTrip();
    this.sdk.calls.push({ action: "stop", name: this.name, detail: null });
    if (this.sdk.failStop) throw new Error("synthetic: the stop failed");
    if (this.sdk.stopTakesEffect) {
      this.stoppingLeft = this.sdk.stoppingReads;
      this.status = this.stoppingLeft > 0 ? "stopping" : "stopped";
    }
    if (this.sdk.stopAnswerLost) throw new Error("synthetic: the stop's answer was lost");
    return undefined;
  }
}

export class SyntheticApiError extends Error {
  readonly response: { status: number };
  constructor(status: number) {
    super(`synthetic API error ${String(status)}`);
    this.name = "APIError";
    this.response = { status };
  }
}

export class FakeWorkerSandbox implements WorkerSandboxSdk {
  readonly calls: { action: "create" | "get" | "run" | "stop"; name: string; detail: unknown }[] = [];
  readonly sandboxes = new Map<string, FakeInstance>();
  /** When set, create throws this; with `createdAnyway` the sandbox exists afterwards. */
  createError: Error | null = null;
  createdAnyway = false;
  failRun = false;
  failStop = false;
  stopTakesEffect = true;
  /** Status reads after a stop that still answer stopping, as the provider's asynchronous shutdown does. */
  stoppingReads = 0;
  /** When set, a stop takes effect but its call throws, as a lost response does. */
  stopAnswerLost = false;
  /** Held creates wait for this before answering. */
  gate: Promise<void> | null = null;
  /** What a started command does first, such as the worker's first heartbeat (simulateWorkerStart). */
  onRun: ((params: { cmd: string; args: string[] }) => Promise<void>) | null = null;

  async create(params: WorkerSandboxCreateParams): Promise<WorkerSandboxInstance> {
    this.calls.push({ action: "create", name: params.name, detail: params });
    if (this.gate !== null) await this.gate;
    // The provider keeps a named sandbox, a stopped one included, and refuses a second create on its name.
    if (this.sandboxes.has(params.name)) throw new SyntheticApiError(409);
    if (this.createError !== null) {
      if (this.createdAnyway) this.sandboxes.set(params.name, new FakeInstance(params.name, this));
      throw this.createError;
    }
    const instance = new FakeInstance(params.name, this);
    this.sandboxes.set(params.name, instance);
    return instance;
  }

  async get(name: string): Promise<WorkerSandboxInstance | null> {
    await roundTrip();
    this.calls.push({ action: "get", name, detail: null });
    const found = this.sandboxes.get(name) ?? null;
    if (found?.status === "stopping") {
      if (found.stoppingLeft > 0) found.stoppingLeft -= 1;
      else found.status = "stopped";
    }
    return found;
  }

  count(action: "create" | "get" | "run" | "stop"): number {
    return this.calls.filter((call) => call.action === action).length;
  }
}

export interface FactoryWorld {
  db: PGlite;
  spend: Spend;
  budgets: FakeBudgets;
  ledger: FactoryLedger;
  records: FakeRecords;
  identity: FactoryIdentity;
  events: FactoryEventBuilders;
  sandbox: FakeWorkerSandbox;
  clock: Clock;
  rates: Rates;
  logs: string[];
  close: () => Promise<void>;
}

/** A fresh world: the ledger with the factory pool ($40) and slot key, no request yet. */
export async function factoryWorld(): Promise<FactoryWorld> {
  const clock = new Clock();
  const db = await PGlite.create();
  await migrate(db, { schema: "public" });
  const spend = createSpend({ client: db, schema: "public", clock: clock.now });
  const pool = await spend.createPool({ pool_key: "factory", cap_microusd: 40_000_000, allocations: [], actor_role: "owner", reason: "synthetic factory pool" });
  if (!pool.ok) throw new Error(`synthetic: the factory pool was refused (${pool.code})`);
  const slot = await spend.createSlotKey({ slot_key: "factory", actor_role: "owner", reason: "synthetic factory slot" });
  if (!slot.ok) throw new Error(`synthetic: the factory slot key was refused (${slot.code})`);
  const budgets = new FakeBudgets(spend);
  return {
    db,
    spend,
    budgets,
    ledger: { spend, budgets },
    records: new FakeRecords(),
    identity: syntheticIdentity(),
    events: syntheticEventBuilders(),
    sandbox: new FakeWorkerSandbox(),
    clock,
    rates: await loadRateSheet(RATE_SHEET_PATH),
    logs: [],
    close: () => db.close(),
  };
}

let counter = 0;
/** A fresh synthetic UUID per call. */
export function syntheticUuid(prefix = "9000"): string {
  counter += 1;
  return `00000000-0000-4000-${prefix}-${counter.toString(16).padStart(12, "0")}`;
}

/**
 * What the web service does before it calls startFactoryWorker (contract section 7, steps 6 and 7):
 * takes the slot under the request root, creates the budget, records the request and appends
 * request_accepted.
 */
export async function acceptRequest(w: FactoryWorld, options: { budget?: number; requestId?: string } = {}): Promise<FactoryRequestRecord> {
  const requestId = options.requestId ?? syntheticUuid();
  const root = w.identity.requestRoot(requestId);
  const slot = await w.spend.acquireSlot({ slot_key: "factory", root_execution_id: root, actor_role: "factory-route" });
  if (!slot.ok) throw new Error(`synthetic: the slot was refused (${slot.code})`);
  const record: FactoryRequestRecord = { request_id: requestId, root, budget_key: `request-${requestId}`, interpretation_sha256: INTERPRETATION_SHA256, profile_sha256: "0".repeat(64), created_at: w.clock.now().toISOString() };
  w.budgets.create(record.budget_key, root, options.budget ?? 1_500_000);
  w.records.requests.set(requestId, record);
  await w.records.appendEvent(requestId, { event_key: "request_accepted", type: "request_accepted", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request accepted.", data: {} }, w.clock.now());
  return record;
}

/**
 * Makes every started worker command write its first heartbeat, as the worker does as soon as it
 * runs, for the request or validation run its arguments name.
 */
export function simulateWorkerStart(w: FactoryWorld): void {
  w.sandbox.onRun = async (params) => {
    const at = (flag: string): string | undefined => {
      const index = params.args.indexOf(flag);
      return index < 0 ? undefined : params.args[index + 1];
    };
    const requestId = at("--request-id");
    const validationId = at("--validation-id");
    if (requestId !== undefined) await w.records.recordHeartbeat({ request_id: requestId }, w.clock.now());
    else if (validationId !== undefined) await w.records.recordHeartbeat({ validation_id: validationId }, w.clock.now());
  };
}

export async function slotHolder(w: FactoryWorld): Promise<string | null> {
  const slot = await w.spend.slotStatus({ slot_key: "factory" });
  if (!slot.ok) throw new Error("synthetic: slot status refused");
  return slot.holder;
}

export async function operationState(w: FactoryWorld, operationId: string): Promise<string | null> {
  const status = await w.spend.operationStatus({ operation_id: operationId });
  return status.ok ? status.state : null;
}

export function host(value: HostId): HostId {
  return value;
}

// Copy sandboxes ----------------------------------------------------------------------------------

export const COPY_DIGEST = `sha256:${"e9".repeat(32)}`;
export const COPY_APP = "export const synthetic = 1;\n";
export const COPY_CHECK = "synthetic check\n";

type SandboxCreate = Parameters<SandboxSdk["create"]>[0];
type CommandParams = Parameters<SandboxInstance["runCommand"]>[0];

/** A fake Sandbox for copies: an in-memory file system per sandbox; the copy's command (whatever runs other than mkdir and tar) is the test's. */
export class FakeCopySandbox implements SandboxSdk {
  readonly creates: SandboxCreate[] = [];
  readonly files = new Map<string, Map<string, Buffer>>();
  readonly commands: CommandParams[] = [];
  readonly stops: string[] = [];
  readonly instances = new Map<string, SandboxInstance & { status: string }>();
  createError: Error | null = null;
  reportedImage: string | null = null;
  stopTakesEffect = true;
  /** Status reads after a stop that still answer stopping, as the provider's asynchronous shutdown does. */
  stoppingReads = 0;
  readonly stoppingLeft = new Map<string, number>();
  /** The copy's command: writes results into the sandbox's file system and returns its exit code. */
  copy: (fs: Map<string, Buffer>) => number = (fs) => {
    fs.set("/workspace/results/record.json", Buffer.from('{"synthetic":true}\n'));
    return 0;
  };
  /** Extra archive entries the results tar holds. */
  extraEntries: { name: string; type: "file" | "symlink" }[] = [];

  create(params: SandboxCreate): Promise<SandboxInstance> {
    this.creates.push(params);
    if (this.createError !== null) return Promise.reject(this.createError);
    const fs = new Map<string, Buffer>();
    this.files.set(params.name, fs);
    const instance = {
      name: params.name,
      status: "running",
      image: this.reportedImage ?? params.image,
      tags: params.tags,
      writeFiles: (files: { path: string; content: Uint8Array }[]) => {
        for (const file of files) fs.set(file.path, Buffer.from(file.content));
        return Promise.resolve();
      },
      runCommand: (command: CommandParams) => {
        this.commands.push(command);
        if (command.signal?.aborted === true) return Promise.reject(new Error("synthetic: aborted"));
        let exitCode = 0;
        if (command.cmd === "tar") {
          this.archive.set(params.name, this.tarOf(fs, command.args[1] ?? ""));
        } else if (command.cmd !== "mkdir") {
          exitCode = this.copy(fs);
        }
        return Promise.resolve({ wait: (options?: { signal?: AbortSignal }) => (options?.signal?.aborted === true ? Promise.reject(new Error("synthetic: aborted")) : Promise.resolve({ exitCode })) });
      },
      readFile: async () => {
        const bytes = await this.archive.get(params.name);
        return bytes === undefined ? null : Readable.from([bytes]);
      },
      stop: () => {
        this.stops.push(params.name);
        if (this.stopTakesEffect) {
          this.stoppingLeft.set(params.name, this.stoppingReads);
          instance.status = this.stoppingReads > 0 ? "stopping" : "stopped";
        }
        return Promise.resolve(undefined);
      },
    };
    this.instances.set(params.name, instance as unknown as SandboxInstance & { status: string });
    return Promise.resolve(instance as unknown as SandboxInstance);
  }

  get(name: string): Promise<SandboxInstance | null> {
    const found = this.instances.get(name) ?? null;
    if (found?.status === "stopping") {
      const left = this.stoppingLeft.get(name) ?? 0;
      if (left > 0) this.stoppingLeft.set(name, left - 1);
      else found.status = "stopped";
    }
    return Promise.resolve(found);
  }

  readonly archive = new Map<string, Promise<Buffer>>();

  tarOf(fs: Map<string, Buffer>, dir: string): Promise<Buffer> {
    const archive = pack();
    for (const [path, content] of fs) if (path.startsWith(`${dir}/`)) archive.entry({ name: `./${path.slice(dir.length + 1)}` }, content);
    for (const entry of this.extraEntries) {
      if (entry.type === "symlink") archive.entry({ name: entry.name, type: "symlink", linkname: "/etc/passwd" });
      else archive.entry({ name: entry.name }, "x");
    }
    archive.finalize();
    return new Promise((done, fail) => {
      const chunks: Buffer[] = [];
      archive.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      });
      archive.on("end", () => {
        done(Buffer.concat(chunks));
      });
      archive.on("error", fail);
    });
  }
}

/** Fresh harness roots holding a copy plan's two files, and a fresh local work directory. */
export function copyRoots(): { roots: CopyRoots; work: string } {
  const base = mkdtempSync(join(tmpdir(), "rbw-factory-runner-test-"));
  const roots = { app_root: join(base, "app"), evaluator_root: join(base, "evaluator") };
  mkdirSync(join(roots.app_root, "src"), { recursive: true });
  mkdirSync(join(roots.evaluator_root, "checks"), { recursive: true });
  writeFileSync(join(roots.app_root, "src", "store.ts"), COPY_APP);
  writeFileSync(join(roots.evaluator_root, "checks", "check.txt"), COPY_CHECK);
  return { roots, work: join(base, "work") };
}

/** A synthetic task-report copy plan over the files of copyRoots(). */
export function copyPlan(overrides: Partial<CopyPlan> = {}): CopyPlan {
  return {
    copy_id: "synthetic-copy-buggy-01",
    host_id: "task-report",
    state: "buggy",
    image: { reference: "registry.invalid/synthetic/task-report-kit:1", digest: COPY_DIGEST },
    files: [{ path: "src/store.ts", sha256: sha256Hex(Buffer.from(COPY_APP)) }],
    evaluator_files: [{ path: "checks/check.txt", sha256: sha256Hex(Buffer.from(COPY_CHECK)) }],
    destinations: { app: "/workspace/app", evaluator: "/workspace/evaluator", results: "/workspace/results" },
    command: ["node", "/workspace/evaluator/run.ts", "--copy", "buggy"],
    limits: { timeout_s: 600, vcpus: 4, memory_mb: 8192, network: "none" },
    ...overrides,
  };
}
