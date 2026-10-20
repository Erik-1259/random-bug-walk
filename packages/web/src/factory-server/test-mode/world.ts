// Test mode (contract section 15.1): every port of the factory service over deterministic in-memory
// fakes, for the acceptance tests, with no network service. A fake ledger holds the factory slot, the
// request budgets and the operations; a fake worker runs the selected scenario's script one step per
// `stepMs`, advanced whenever a port is read; a fake provider records every sandbox create; fake
// storage serves synthetic archive pairs whose SHA-256 the scenario's package_ready events carry.
// Every fake operation costs exactly its worst case. Starts and validation starts are held for 2 s
// inside their ID lock. The state lives on globalThis, so every route bundle of one server shares it.
//
// These fakes stand in for the shared request loop's fake runner and scenarios, the worker's
// in-process entry and the package tooling's synthetic pair builder until those are wired here.
import { createHash } from "node:crypto";
import type {
  AttentionCode,
  Candidate,
  CandidateStage,
  Capabilities,
  Case,
  Event,
  HostId,
  Interpretation,
  Limits,
  RequestFinishedData,
  RequestInput,
  RequestState,
  RequestStatus,
  StartRequest,
  StopCode,
  TestEvidence,
  TestOperationKind,
  TestOperationState,
  TestProviderAction,
  TestScenario,
  ValidationResult,
  ValidationRun,
} from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";
import { canonicalDigest } from "@rbw/schema";
import type { FactoryConfig } from "../../config.ts";
import type {
  CreateRecordLaunchResult,
  FactoryServer,
  FactoryServerPorts,
  FactoryTestControls,
  LostTarget,
  PackageRead,
  SlotResult,
  StartValidationResult,
} from "../ports.ts";
import { syntheticPair, type ArchivePair } from "./archives.ts";
import { inputKey, loadTestFixtures, SCENARIO_FIXTURE, type TestFixtures } from "./fixtures.ts";
import { profileSha256, TEST_PROFILE, type TestProfile } from "./profile.ts";
import { draft, scriptFor, type Draft, type Step } from "./scenarios.ts";

const COPY_STATES = ["clean", "buggy", "fixed"] as const;
/** cancel-midway waits this long for a stop (contract section 15.1). */
const PAUSE_MS = 60_000;
const UNRESPONSIVE_MS = 60_000;
const LOST_MS = 180_000;
/** worker-lost: when the worker stalls, the fake clock moves past the lost-worker threshold. */
export const STALL_JUMP_MS = LOST_MS + 1000;

const HOST_TEXT: Record<HostId, string> = { umami: "Umami", "task-report": "the task-and-report service" };

/** budget_exhausted names the fake ledger's amount (budgetStopText), never the fixture's illustrative one. */
const STOP_TEXT: Record<Exclude<StopCode, "budget_exhausted">, string> = {
  fulfilled: "Every requested case was delivered.",
  time_limit: "The request reached its wall-clock limit.",
  candidate_limit: "The request reached its candidate limit.",
  sources_exhausted: "Every eligible catalog entry was tried.",
  cancelled_by_user: "Stopped by the user. The candidate in progress was not delivered; cases delivered earlier stay available.",
  worker_lost: "The worker stopped responding. No replacement work was started.",
  needs_reconciliation: "A provider outcome became uncertain, so the request stopped instead of retrying. No replacement work was started.",
  operational_error: "An execution or accounting problem stopped the request.",
};

const ATTENTION_TEXT: Record<AttentionCode, string> = {
  worker_unresponsive: "No heartbeat from the worker for 60 s.",
  needs_reconciliation: "A provider outcome is uncertain, so its reservation stays held until an operator reconciles it. New factory work answers busy until then.",
};

const ENDED_STAGE = {
  candidate_rejected: "rejected",
  candidate_invalid: "invalid",
  candidate_incomplete: "incomplete",
  candidate_skipped: "skipped",
} as const satisfies Record<string, CandidateStage>;

interface Op {
  operation_id: string;
  kind: TestOperationKind;
  call_name: string;
  state: TestOperationState;
  reserved: number;
  settled: number | null;
  request_id: string;
  candidate_id: string | null;
}

interface ProviderCall {
  request_id: string;
  call_name: string;
  action: TestProviderAction;
  at: string;
}

interface WorldRequest {
  request_id: string;
  root: string;
  sha256: string;
  interpretation: Interpretation;
  scenario: TestScenario;
  /** The scenario's end-state fixture: candidate, case and message texts. */
  template: RequestStatus;
  script: Step[];
  cursor: number;
  nextDueMs: number;
  createdMs: number;
  events: Event[];
  heartbeatMs: number | null;
  stopMs: number | null;
  pausedMs: number | null;
  stalled: boolean;
  done: boolean;
  pendingReserve: string | null;
  pendingSettle: string | null;
  /** Candidates whose worst case was reserved, in order. */
  reserved: string[];
  ended: Set<string>;
}

interface WorldValidation {
  validation_id: string;
  request_id: string;
  case_id: string;
  host_id: HostId;
  root: string;
  op: Op;
  result: ValidationResult;
  acceptedMs: number;
  finishDueMs: number;
  finishedMs: number | null;
}

export interface TestWorldOptions {
  fixtures: TestFixtures;
  passcode: string | null;
  /** The base clock in milliseconds; test mode adds its own jumps. */
  clock?: () => number;
  stepMs?: number;
  holdMs?: number;
  profile?: TestProfile;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const money = (microusd: number): string => `$${(microusd / 1_000_000).toFixed(2)}`;
const pad = (n: number): string => String(n).padStart(2, "0");

/** The budget_exhausted stop text, with the request budget's remaining amount when the request finished. */
function budgetStopText(remaining: number, delivered: number, requested: number): string {
  return `The remaining budget of ${money(remaining)} cannot cover another candidate's worst case. ${String(delivered)} of ${String(requested)} requested cases ${delivered === 1 ? "was" : "were"} delivered.`;
}

/** A ledger-shaped operation ID: 64 lowercase hex characters, fixed by the request and the call. */
const operationId = (requestId: string, callName: string): string => createHash("sha256").update(`rbw-factory-test-operation:${requestId}:${callName}`).digest("hex");

export function testRequestRoot(requestId: string): string {
  return `test-request:${requestId}`;
}

function normalize(input: RequestInput): RequestInput {
  return {
    hosts: [...input.hosts],
    items: input.items.map((item) => {
      const trimmed = item.description?.trim() ?? "";
      return { ...item, description: trimmed === "" ? null : trimmed };
    }),
    budget_microusd: input.budget_microusd,
  };
}

function limitError(input: RequestInput, limits: Limits): string | null {
  if (input.items.length > limits.max_items) return `At most ${String(limits.max_items)} items.`;
  if (input.items.some((item) => item.quantity > limits.max_quantity_per_item)) return `Each quantity is at most ${String(limits.max_quantity_per_item)}.`;
  if (input.items.reduce((sum, item) => sum + item.quantity, 0) > limits.max_total_quantity) return `The quantities add up to at most ${String(limits.max_total_quantity)}.`;
  if (input.items.some((item) => (item.description?.trim() ?? "").length > limits.max_description_chars)) return `Each description has at most ${String(limits.max_description_chars)} characters.`;
  if (input.budget_microusd < limits.min_budget_microusd || input.budget_microusd > limits.max_budget_microusd) return "The budget is outside the limits.";
  return null;
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield bytes;
}

export class TestWorld implements FactoryServerPorts, FactoryTestControls {
  readonly passcode: string | null;
  readonly profile: { limits: Limits; profile_sha256: string };
  private readonly fixtures: TestFixtures;
  private readonly clock: () => number;
  private readonly stepMs: number;
  private readonly holdMs: number;
  private readonly costs: TestProfile;
  private scenario: TestScenario = "two-host-fulfilled";
  private skewMs = 0;
  private slot: string | null = null;
  private readonly requests = new Map<string, WorldRequest>();
  private readonly validations = new Map<string, WorldValidation>();
  private ops: Op[] = [];
  private providerCalls: ProviderCall[] = [];
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly archives = new Map<string, ArchivePair>();

  constructor(options: TestWorldOptions) {
    this.fixtures = options.fixtures;
    this.passcode = options.passcode;
    this.clock = options.clock ?? Date.now;
    this.stepMs = options.stepMs ?? 200;
    this.holdMs = options.holdMs ?? 2000;
    this.costs = options.profile ?? TEST_PROFILE;
    this.profile = { limits: this.costs.limits, profile_sha256: profileSha256(this.costs) };
  }

  /** The selected scenario. */
  get selected(): TestScenario {
    return this.scenario;
  }

  private ms(): number {
    return this.clock() + this.skewMs;
  }

  now(): Date {
    return new Date(this.ms());
  }

  capabilities(): Capabilities {
    return { ...structuredClone(this.fixtures.capabilities), limits: this.profile.limits };
  }

  interpret(input: unknown): { ok: true; interpretation: Interpretation } | { ok: false; message: string } {
    const errors = validateContract("RequestInput", input);
    if (errors.length > 0) return { ok: false, message: `The body does not match RequestInput: ${errors.slice(0, 5).join(", ")}.` };
    const value = input as RequestInput;
    const outside = limitError(value, this.profile.limits);
    if (outside !== null) return { ok: false, message: outside };
    const found = this.fixtures.interpretations.get(inputKey(normalize(value)));
    if (found === undefined) return { ok: false, message: "Test mode interprets only the inputs of the contract fixtures." };
    return { ok: true, interpretation: structuredClone(found) };
  }

  canonicalStart(body: unknown): { ok: true; start: StartRequest; sha256: string } | { ok: false; message: string } {
    const errors = validateContract("StartRequest", body);
    if (errors.length > 0) return { ok: false, message: `The body does not match StartRequest: ${errors.slice(0, 5).join(", ")}.` };
    const start = body as StartRequest;
    const sha256 = canonicalDigest({ request_id: start.request_id, input: normalize(start.input), interpretation_sha256: start.interpretation_sha256 }).sha256;
    return { ok: true, start, sha256 };
  }

  async withRequestLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(id) ?? Promise.resolve();
    const run = before.then(async () => {
      if (this.holdMs > 0) await new Promise((resolve) => setTimeout(resolve, this.holdMs));
      return fn();
    });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    }
  }

  findRequest(id: string): Promise<{ canonical_sha256: string } | null> {
    const found = this.requests.get(id);
    return Promise.resolve(found === undefined ? null : { canonical_sha256: found.sha256 });
  }

  ledgerState(): Promise<{ configured: boolean; halted: boolean }> {
    return Promise.resolve({ configured: true, halted: false });
  }

  poolAvailable(): Promise<number> {
    this.advance();
    return Promise.resolve(this.poolLeft());
  }

  acquireSlot(root: string): Promise<SlotResult> {
    this.advance();
    if (this.slot === null) {
      this.slot = root;
      return Promise.resolve({ kind: "acquired" });
    }
    if (this.slot === root) return Promise.resolve({ kind: "replay" });
    return Promise.resolve({ kind: "held", reason: this.slotReason() });
  }

  slotHolder(): Promise<LostTarget | null> {
    this.advance();
    const validation = this.slotValidation();
    if (validation !== null) return Promise.resolve({ validation_id: validation });
    const request = this.slotRequest();
    return Promise.resolve(request === null ? null : { request_id: request });
  }

  releaseSlot(root: string): Promise<void> {
    if (this.slot === root) this.slot = null;
    return Promise.resolve();
  }

  createRecordLaunch(args: { start: StartRequest; sha256: string; interpretation: Interpretation; root: string }): Promise<CreateRecordLaunchResult> {
    this.advance();
    const template = this.endState(this.scenario);
    if (args.interpretation.interpretation_sha256 !== template.interpretation.interpretation_sha256) {
      return Promise.resolve({ ok: false, code: "unavailable", message: `Test mode runs the ${this.scenario} scenario on the input of ${SCENARIO_FIXTURE[this.scenario]}.` });
    }
    if (this.poolLeft() < this.costs.worker_microusd) return Promise.resolve({ ok: false, code: "budget_unavailable", message: "The test pool cannot cover the worker's worst case." });
    const now = this.ms();
    const accepted = template.events[0];
    if (accepted === undefined) throw new Error("test mode: the scenario fixture has no events");
    const req: WorldRequest = {
      request_id: args.start.request_id,
      root: args.root,
      sha256: args.sha256,
      interpretation: args.interpretation,
      scenario: this.scenario,
      template,
      script: scriptFor(this.scenario, template),
      cursor: 0,
      nextDueMs: now + this.stepMs,
      createdMs: now,
      events: [],
      heartbeatMs: null,
      stopMs: null,
      pausedMs: null,
      stalled: false,
      done: false,
      pendingReserve: null,
      pendingSettle: null,
      reserved: [],
      ended: new Set(),
    };
    this.requests.set(req.request_id, req);
    this.append(req, accepted, now);
    const worker = this.newOp({ kind: "worker", call_name: "worker", reserved: this.costs.worker_microusd, request_id: req.request_id });
    this.budgetEvent(req, `Reserved ${money(worker.reserved)} for the worker's worst case.`, now);
    this.create(req.request_id, worker, now, false);
    return Promise.resolve({ ok: true });
  }

  status(id: string, after: number): Promise<RequestStatus | null> {
    this.advance();
    const req = this.requests.get(id);
    return Promise.resolve(req === undefined ? null : this.project(req, after));
  }

  noteUnresponsive(id: string, now: Date): Promise<boolean> {
    this.advance();
    const req = this.requests.get(id);
    if (req === undefined || req.done) return Promise.resolve(false);
    const stale = now.getTime() - (req.heartbeatMs ?? req.createdMs) >= UNRESPONSIVE_MS;
    const attention = this.attentionOf(req);
    if (stale && attention === null) {
      this.appendUnresponsive(req);
      return Promise.resolve(true);
    }
    if (!stale && attention === "worker_unresponsive") {
      this.append(req, draft({ type: "attention_cleared", message: "A heartbeat from the worker arrived again.", data: { code: "worker_unresponsive" } }), now.getTime());
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  recordStop(id: string): Promise<"recorded" | "replay" | "not_found"> {
    this.advance();
    const req = this.requests.get(id);
    if (req === undefined) return Promise.resolve("not_found");
    if (req.done || req.stopMs !== null) return Promise.resolve("replay");
    const now = this.ms();
    this.appendStop(req, now);
    if (req.stalled) return Promise.resolve("recorded");
    if (req.pausedMs !== null || req.script[req.cursor]?.kind === "pause") {
      // cancel-midway, paused or about to pause: the run continues as its fixture shows.
      if (req.pausedMs === null) req.cursor += 1;
      req.pausedMs = null;
      req.nextDueMs = now + this.stepMs;
      return Promise.resolve("recorded");
    }
    req.script = [...req.script.slice(0, req.cursor), ...this.stopTail(req)];
    req.nextDueMs = now + this.stepMs;
    return Promise.resolve("recorded");
  }

  finalizeLost(target: LostTarget): Promise<void> {
    this.advance();
    // Validation runs in test mode never lose their worker, so only a request can be finished here.
    if (!("request_id" in target)) return Promise.resolve();
    const req = this.requests.get(target.request_id);
    const now = this.ms();
    if (req === undefined || req.done || now - (req.heartbeatMs ?? req.createdMs) < LOST_MS) return Promise.resolve();
    this.finishLost(req, now);
    return Promise.resolve();
  }

  findValidation(id: string): Promise<{ request_id: string; case_id: string } | null> {
    const found = this.validations.get(id);
    return Promise.resolve(found === undefined ? null : { request_id: found.request_id, case_id: found.case_id });
  }

  startValidation(args: { request_id: string; case_id: string; validation_id: string }): Promise<StartValidationResult> {
    this.advance();
    const req = this.requests.get(args.request_id);
    const delivered = req === undefined ? undefined : this.deliveredCase(req, args.case_id);
    if (req === undefined || delivered === undefined) return Promise.resolve({ kind: "unavailable", message: "Test mode has no such delivered case." });
    if (this.slot !== null) return Promise.resolve({ kind: "busy", reason: this.slotReason() });
    const worst = this.costs.validation_microusd[delivered.host_id];
    const budget = this.budget(req);
    if (budget.overrun || budget.remaining < worst || this.poolLeft() < worst) return Promise.resolve({ kind: "budget_unavailable" });
    const now = this.ms();
    const root = `test-validation:${args.validation_id}`;
    this.slot = root;
    const ordinal = [...this.validations.values()].filter((run) => run.request_id === req.request_id).length + 1;
    const op = this.newOp({ kind: "validation", call_name: `validation-${pad(ordinal)}`, reserved: worst, request_id: req.request_id });
    const run: WorldValidation = {
      validation_id: args.validation_id,
      request_id: req.request_id,
      case_id: args.case_id,
      host_id: delivered.host_id,
      root,
      op,
      result: this.scenario === "validation-failed" ? "failed" : this.scenario === "validation-error" ? "error" : "passed",
      acceptedMs: now,
      finishDueMs: now + 3 * this.stepMs,
      finishedMs: null,
    };
    this.validations.set(run.validation_id, run);
    this.budgetEvent(req, `Reserved ${money(worst)} for a validation run's worst case on ${HOST_TEXT[run.host_id]}.`, now);
    this.append(req, draft({ type: "validation_started", host_id: run.host_id, item_key: delivered.item_key, case_id: run.case_id, message: `Validation run ${run.validation_id} started on case ${run.case_id.slice(0, 12)}.`, data: { validation_id: run.validation_id } }), now);
    this.create(req.request_id, op, now, false);
    return Promise.resolve({ kind: "accepted", run: this.run(run) });
  }

  getValidation(requestId: string, caseId: string, validationId: string): Promise<ValidationRun | null> {
    this.advance();
    const run = this.validations.get(validationId);
    return Promise.resolve(run?.request_id !== requestId || run.case_id !== caseId ? null : this.run(run));
  }

  readPackage(requestId: string, caseId: string, part: "bug-case" | "validator"): Promise<PackageRead | null> {
    this.advance();
    const req = this.requests.get(requestId);
    const delivered = req === undefined ? undefined : this.deliveredCase(req, caseId);
    if (delivered === undefined) return Promise.resolve(null);
    const pair = this.pair(caseId);
    const archive = part === "bug-case" ? pair.bug_case : pair.validator;
    const filename = part === "bug-case" ? delivered.packages.bug_case.filename : delivered.packages.validator.filename;
    return Promise.resolve({ filename, sha256: archive.sha256, size: archive.bytes.length, body: once(archive.bytes) });
  }

  example(): Promise<Case | null> {
    return Promise.resolve(structuredClone(this.fixtures.example));
  }

  // Test controls (contract section 15.1).

  evidence(id: string): Promise<TestEvidence | null> {
    this.advance();
    if (!this.requests.has(id)) return Promise.resolve(null);
    return Promise.resolve({
      contract_version: "bug-request/1",
      request_id: id,
      operations: this.ops
        .filter((op) => op.request_id === id)
        .map((op) => ({
          operation_id: op.operation_id,
          kind: op.kind,
          call_name: op.call_name,
          state: op.state,
          reserved_microusd: op.settled === null ? op.reserved : 0,
          settled_microusd: op.settled,
          attempt_ordinal: 1,
        })),
      slot: { slot_key: "factory", holder_request_id: this.slotRequest(), holder_validation_id: this.slotValidation() },
      provider_calls: this.providerCalls.filter((call) => call.request_id === id).map((call) => ({ call_name: call.call_name, provider: "sandbox", action: call.action, at: call.at })),
    });
  }

  reconcile(id: string): Promise<boolean> {
    this.advance();
    const req = this.requests.get(id);
    if (req === undefined) return Promise.resolve(false);
    const now = this.ms();
    const held = this.ops.filter((op) => op.request_id === id && op.state === "uncertain");
    for (const op of held) {
      op.state = "reconciled";
      op.settled = op.reserved;
    }
    if (held.length > 0) this.budgetEvent(req, `Reconciled ${money(held.reduce((sum, op) => sum + op.reserved, 0))} of uncertain spend at its worst case.`, now);
    const attention = this.attentionOf(req);
    if (attention !== null && !this.budget(req).overrun) this.append(req, draft({ type: "attention_cleared", message: "The uncertain spend was reconciled.", data: { code: attention } }), now);
    // Only the request's own hold ends here; a validation run of the request keeps the slot until it finishes.
    if (req.done && this.slot === req.root && !this.uncertain(id)) this.slot = null;
    return Promise.resolve(true);
  }

  reset(scenario: TestScenario): Promise<void> {
    this.scenario = scenario;
    this.skewMs = 0;
    this.slot = null;
    this.requests.clear();
    this.validations.clear();
    this.ops = [];
    this.providerCalls = [];
    return Promise.resolve();
  }

  // The fake ledger.

  private newOp(fields: Pick<Op, "kind" | "call_name" | "reserved" | "request_id"> & Partial<Pick<Op, "candidate_id">>): Op {
    const op: Op = { operation_id: operationId(fields.request_id, fields.call_name), state: "prepared", settled: null, candidate_id: null, ...fields };
    this.ops.push(op);
    return op;
  }

  private create(requestId: string, op: Op, atMs: number, uncertain: boolean): void {
    this.providerCalls.push({ request_id: requestId, call_name: op.call_name, action: "create", at: iso(atMs) });
    op.state = uncertain ? "uncertain" : "running";
  }

  /** A launched operation settles at its worst case; one never launched is released at 0. Settled is terminal with an amount. */
  private settle(op: Op): void {
    if (op.state === "uncertain" || op.settled !== null) return;
    op.settled = op.state === "prepared" ? 0 : op.reserved;
    op.state = "terminal";
  }

  private budget(req: WorldRequest): { reserved: number; spent: number; remaining: number; overrun: boolean } {
    let reserved = 0;
    let spent = 0;
    for (const op of this.ops) {
      if (op.request_id !== req.request_id) continue;
      if (op.settled === null) reserved += op.reserved;
      else spent += op.settled;
    }
    const budget = req.interpretation.input.budget_microusd;
    return { reserved, spent, remaining: budget - reserved - spent, overrun: reserved + spent > budget };
  }

  /** The pool counts committed amounts: open reservations and settled spend. */
  private poolLeft(): number {
    return this.costs.pool_microusd - this.ops.reduce((sum, op) => sum + (op.settled ?? op.reserved), 0);
  }

  private uncertain(requestId: string): boolean {
    return this.ops.some((op) => op.request_id === requestId && op.state === "uncertain");
  }

  private slotRequest(): string | null {
    if (this.slot === null) return null;
    for (const req of this.requests.values()) if (req.root === this.slot) return req.request_id;
    for (const run of this.validations.values()) if (run.root === this.slot) return run.request_id;
    return null;
  }

  private slotValidation(): string | null {
    for (const run of this.validations.values()) if (run.root === this.slot) return run.validation_id;
    return null;
  }

  private slotReason(): "active" | "needs_reconciliation" {
    const holder = this.slotRequest();
    return holder !== null && this.uncertain(holder) ? "needs_reconciliation" : "active";
  }

  // The fake worker.

  private advance(): void {
    const now = this.ms();
    for (const req of this.requests.values()) this.advanceRequest(req, now);
    for (const run of this.validations.values()) this.advanceValidation(run, now);
  }

  private advanceRequest(req: WorldRequest, now: number): void {
    while (!req.done && !req.stalled && req.cursor < req.script.length) {
      if (req.pausedMs !== null) {
        if (now < req.pausedMs + PAUSE_MS) break;
        // No stop came within 60 s: the run continues as the fixture shows, stop event included.
        const at = req.pausedMs + PAUSE_MS;
        req.pausedMs = null;
        this.appendStop(req, at);
        req.nextDueMs = at + this.stepMs;
        continue;
      }
      if (req.nextDueMs > now) break;
      const step = req.script[req.cursor];
      if (step === undefined) break;
      req.cursor += 1;
      const at = req.nextDueMs;
      req.nextDueMs += this.stepMs;
      if (step.kind === "pause") {
        if (req.stopMs === null) req.pausedMs = at;
      } else if (step.kind === "stall") {
        req.stalled = true;
        this.skewMs += STALL_JUMP_MS;
      } else {
        this.apply(req, step.event, at);
      }
    }
    // A running worker heartbeats on every read. The worker_unresponsive attention comes only from the
    // status route's ports (noteUnresponsive and the lost-worker finish), as in live mode.
    if (!req.done && !req.stalled && req.heartbeatMs !== null) req.heartbeatMs = Math.max(req.heartbeatMs, now);
  }

  private apply(req: WorldRequest, event: Event, atMs: number): void {
    switch (event.type) {
      case "worker_started":
        req.heartbeatMs = atMs;
        break;
      case "candidate_selected":
        req.pendingReserve = event.candidate_id;
        break;
      case "case_delivered":
      case "candidate_rejected":
      case "candidate_invalid":
      case "candidate_incomplete":
        this.endCandidate(req, event.candidate_id);
        break;
      case "candidate_skipped":
        this.endCandidate(req, event.candidate_id);
        if (event.data.reason === "no_budget_for_candidate") {
          // The fixture's amounts are illustrative; the skip names the fake ledger's.
          this.append(req, { ...event, message: this.noBudgetText(req, event.host_id) }, atMs);
          return;
        }
        break;
      case "budget_updated":
        this.budgetEvent(req, this.budgetStep(req, atMs), atMs);
        return;
      case "package_ready": {
        const pair = this.pair(event.case_id ?? "");
        this.append(req, { ...event, data: { bug_case_sha256: pair.bug_case.sha256, validator_sha256: pair.validator.sha256 } }, atMs);
        return;
      }
      case "request_finished":
        this.append(req, event, atMs);
        this.finish(req);
        return;
      default:
        break;
    }
    this.append(req, event, atMs);
  }

  private endCandidate(req: WorldRequest, candidateId: string | null): void {
    if (candidateId === null) return;
    req.ended.add(candidateId);
    if (req.pendingReserve === candidateId) req.pendingReserve = null;
    if (req.reserved.includes(candidateId)) req.pendingSettle = candidateId;
  }

  /** What a budget_updated step does: settle the candidate that ended, reserve the selected one, or settle the worker. */
  private budgetStep(req: WorldRequest, atMs: number): string {
    if (req.pendingSettle !== null) {
      const id = req.pendingSettle;
      req.pendingSettle = null;
      const ops = this.ops.filter((op) => op.request_id === req.request_id && op.candidate_id === id);
      for (const op of ops) this.settle(op);
      const held = ops.filter((op) => op.state === "uncertain").reduce((sum, op) => sum + op.reserved, 0);
      const settled = ops.reduce((sum, op) => sum + (op.settled ?? 0), 0);
      return held === 0 ? `Settled ${money(settled)} for this candidate and closed its reservation.` : `Settled ${money(settled)} for this candidate; ${money(held)} stays held until reconciliation.`;
    }
    if (req.pendingReserve !== null) {
      const id = req.pendingReserve;
      req.pendingReserve = null;
      return this.reserveCandidate(req, id, atMs);
    }
    const worker = this.ops.find((op) => op.request_id === req.request_id && op.kind === "worker");
    if (worker !== undefined) this.settle(worker);
    return `Settled ${money(worker?.settled ?? 0)} for the worker and closed its reservation.`;
  }

  /** Reserves the candidate's worst case as its three copies and creates their sandboxes. */
  private reserveCandidate(req: WorldRequest, candidateId: string, atMs: number): string {
    const host = req.template.candidates.find((candidate) => candidate.candidate_id === candidateId)?.host_id;
    if (host === undefined) throw new Error("test mode: a scenario candidate is missing from its fixture");
    const worst = this.costs.candidate_microusd[host];
    req.reserved.push(candidateId);
    const ordinal = req.reserved.length;
    const share = Math.floor(worst / COPY_STATES.length);
    const ops = COPY_STATES.map((state, index) =>
      this.newOp({
        kind: "candidate_copy",
        call_name: `candidate-${pad(ordinal)}-${state}`,
        reserved: index === COPY_STATES.length - 1 ? worst - share * (COPY_STATES.length - 1) : share,
        request_id: req.request_id,
        candidate_id: candidateId,
      }),
    );
    const uncertainFirst = req.scenario === "uncertain-provider" && ordinal === 1;
    for (const [index, op] of ops.entries()) {
      if (uncertainFirst && index > 0) break;
      this.create(req.request_id, op, atMs + index, uncertainFirst);
    }
    return `Reserved ${money(worst)} for this candidate's worst case on ${HOST_TEXT[host]}.`;
  }

  /** A no_budget_for_candidate skip: the request budget's remaining amount against the candidate's worst case. */
  private noBudgetText(req: WorldRequest, host: HostId | null): string {
    if (host === null) throw new Error("test mode: a skipped scenario candidate has no host");
    return `Skipped: the remaining budget of ${money(this.budget(req).remaining)} cannot cover this candidate's worst case of ${money(this.costs.candidate_microusd[host])} on ${HOST_TEXT[host]}.`;
  }

  private finish(req: WorldRequest): void {
    req.done = true;
    if (this.slot === req.root && !this.uncertain(req.request_id)) this.slot = null;
  }

  /** The candidate that is selected or reserved and has not ended. */
  private inflight(req: WorldRequest): string | null {
    if (req.pendingReserve !== null) return req.pendingReserve;
    return req.reserved.find((id) => !req.ended.has(id)) ?? null;
  }

  /** What a stop leaves to run: settle the candidate that ended, end the one in flight, settle the worker if it is open, finish. */
  private stopTail(req: WorldRequest): Step[] {
    const settle: Draft = { type: "budget_updated", message: "", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 0 } };
    const steps: Draft[] = [];
    if (req.pendingSettle !== null) steps.push(settle);
    const inflight = this.inflight(req);
    if (inflight !== null) {
      const host = req.template.candidates.find((candidate) => candidate.candidate_id === inflight)?.host_id ?? null;
      steps.push({ type: "candidate_incomplete", host_id: host, candidate_id: inflight, message: "Incomplete: the request stopped while this candidate was in progress. It was not delivered.", data: { reason: "stopped" } });
      if (req.reserved.includes(inflight)) steps.push(settle);
    }
    const worker = this.ops.find((op) => op.request_id === req.request_id && op.kind === "worker");
    if (worker?.settled === null) steps.push(settle);
    steps.push({ type: "request_finished", message: "Request finished: cancelled.", data: { outcome: "cancelled", stop_code: "cancelled_by_user" } });
    return steps.map((event) => ({ kind: "event", event: draft(event) }));
  }

  /** The lost-worker finish (contract section 8.1): the worker and the copies in flight become uncertain and keep the slot. */
  private finishLost(req: WorldRequest, now: number): void {
    if (this.attentionOf(req) === null) this.appendUnresponsive(req);
    const inflight = this.inflight(req);
    if (inflight !== null) {
      const template = req.template.events.find((event) => event.type === "candidate_incomplete" && event.data.reason === "incomplete_run" && event.candidate_id === inflight);
      const host = req.template.candidates.find((candidate) => candidate.candidate_id === inflight)?.host_id ?? null;
      this.append(req, template ?? draft({ type: "candidate_incomplete", host_id: host, candidate_id: inflight, message: "Incomplete: the worker stopped responding before this candidate's checks finished. It is not reproduction and was not retried.", data: { reason: "incomplete_run" } }), now);
      req.ended.add(inflight);
    }
    for (const op of this.ops) {
      const lost = op.kind === "worker" || (inflight !== null && op.candidate_id === inflight);
      if (op.request_id !== req.request_id || !lost) continue;
      if (op.state === "running") op.state = "uncertain";
      else this.settle(op);
    }
    this.append(req, this.templateAttention(req, "needs_reconciliation") ?? draft({ type: "attention", message: ATTENTION_TEXT.needs_reconciliation, data: { code: "needs_reconciliation" } }), now);
    const finished = req.template.events.find((event) => event.type === "request_finished" && event.data.stop_code === "worker_lost");
    this.append(req, finished ?? draft({ type: "request_finished", message: "Request finished: operational error.", data: { outcome: "operational_error", stop_code: "worker_lost" } }), now);
    req.pendingReserve = null;
    req.pendingSettle = null;
    req.cursor = req.script.length;
    req.stalled = true;
    req.done = true;
  }

  private appendUnresponsive(req: WorldRequest): void {
    const at = (req.heartbeatMs ?? req.createdMs) + UNRESPONSIVE_MS;
    this.append(req, this.templateAttention(req, "worker_unresponsive") ?? draft({ type: "attention", message: ATTENTION_TEXT.worker_unresponsive, data: { code: "worker_unresponsive" } }), at);
  }

  private appendStop(req: WorldRequest, atMs: number): void {
    req.stopMs = atMs;
    const template = req.template.events.find((event) => event.type === "stop_requested");
    this.append(req, template ?? draft({ type: "stop_requested", message: "The user asked to stop. No new candidate or check will start.", data: {} }), atMs);
  }

  private templateAttention(req: WorldRequest, code: AttentionCode): Event | undefined {
    return req.template.events.find((event) => event.type === "attention" && event.data.code === code);
  }

  private attentionOf(req: WorldRequest): AttentionCode | null {
    let code: AttentionCode | null = null;
    for (const event of req.events) {
      if (event.type === "attention") code = event.data.code;
      else if (event.type === "attention_cleared") code = null;
    }
    return code;
  }

  private append(req: WorldRequest, event: Event, atMs: number): void {
    const last = req.events.at(-1);
    const at = Math.max(atMs, last === undefined ? 0 : Date.parse(last.at));
    req.events.push({ ...event, seq: req.events.length + 1, at: iso(at) });
  }

  private budgetEvent(req: WorldRequest, message: string, atMs: number): void {
    const budget = this.budget(req);
    this.append(req, draft({ type: "budget_updated", message, data: { reserved_microusd: budget.reserved, spent_microusd: budget.spent, remaining_microusd: budget.remaining } }), atMs);
  }

  private advanceValidation(run: WorldValidation, now: number): void {
    if (run.finishedMs !== null || now < run.finishDueMs) return;
    const req = this.requests.get(run.request_id);
    if (req === undefined) return;
    run.finishedMs = run.finishDueMs;
    this.settle(run.op);
    const delivered = this.deliveredCase(req, run.case_id);
    this.append(req, draft({ type: "validation_finished", host_id: run.host_id, item_key: delivered?.item_key ?? null, case_id: run.case_id, message: `Validation run ${run.validation_id} finished: ${run.result}.`, data: { validation_id: run.validation_id, result: run.result } }), run.finishedMs);
    this.budgetEvent(req, `Settled ${money(run.op.settled ?? 0)} for the validation run and closed its reservation.`, run.finishedMs);
    if (this.slot === run.root) this.slot = null;
  }

  // Projection.

  private endState(scenario: TestScenario): RequestStatus {
    const found = this.fixtures.statuses.get(SCENARIO_FIXTURE[scenario]);
    if (found === undefined) throw new Error(`test mode: no fixture for ${scenario}`);
    return found;
  }

  private pair(caseId: string): ArchivePair {
    let pair = this.archives.get(caseId);
    if (pair === undefined) {
      pair = syntheticPair(caseId);
      this.archives.set(caseId, pair);
    }
    return pair;
  }

  private deliveredCase(req: WorldRequest, caseId: string): Case | undefined {
    const event = req.events.find((item) => item.type === "case_delivered" && item.case_id === caseId);
    return event === undefined ? undefined : this.caseOf(req, caseId, event.item_key, event.at);
  }

  private caseOf(req: WorldRequest, caseId: string, itemKey: string | null, at: string): Case {
    const base = req.template.cases.find((item) => item.case_id === caseId);
    if (base === undefined) throw new Error("test mode: a delivered case is missing from its fixture");
    const pair = this.pair(caseId);
    const path = (part: string) => `/api/factory/requests/${req.request_id}/cases/${caseId}/packages/${part}`;
    const runs = [...this.validations.values()].filter((run) => run.request_id === req.request_id && run.case_id === caseId);
    const latest = runs.at(-1);
    return {
      ...structuredClone(base),
      item_key: itemKey ?? base.item_key,
      qualification: { ...base.qualification, qualified_at: at },
      packages: {
        ...base.packages,
        pair_sha256: pair.pair_sha256,
        bug_case: { ...base.packages.bug_case, sha256: pair.bug_case.sha256, size_bytes: pair.bug_case.bytes.length, ready: true, download_path: path("bug-case") },
        validator: { ...base.packages.validator, sha256: pair.validator.sha256, size_bytes: pair.validator.bytes.length, ready: true, download_path: path("validator") },
      },
      validation: latest === undefined ? null : this.run(latest),
      provenance: { ...base.provenance, origin: "live_request", request_id: req.request_id },
    };
  }

  private run(run: WorldValidation): ValidationRun {
    const finished = run.finishedMs !== null;
    const template = finished ? this.fixtures.runs[run.result] : this.fixtures.runs.running;
    const pair = this.pair(run.case_id);
    return {
      ...structuredClone(template),
      validation_id: run.validation_id,
      case_id: run.case_id,
      state: finished ? "finished" : "running",
      result: finished ? run.result : null,
      matrix: finished ? structuredClone(template.matrix) : null,
      package_sha256: { bug_case: pair.bug_case.sha256, validator: pair.validator.sha256 },
      started_at: iso(run.acceptedMs),
      finished_at: run.finishedMs === null ? null : iso(run.finishedMs),
      cost_microusd: run.op.settled,
      poll_after_ms: finished ? 1000 : 250,
    };
  }

  private project(req: WorldRequest, after: number): RequestStatus {
    const { template } = req;
    let state: RequestState = "queued";
    let finished: RequestFinishedData | null = null;
    const candidates = new Map<string, Candidate>();
    const delivered: { case_id: string; item_key: string | null; at: string }[] = [];
    let behavior = 0;
    let criteria = 0;
    // The request budget's remaining amount after the last budget event, and when the request finished.
    let remaining = req.interpretation.input.budget_microusd;
    let remainingAtFinish = remaining;
    const update = (id: string | null, change: Partial<Candidate>): void => {
      const found = id === null ? undefined : candidates.get(id);
      if (found !== undefined && id !== null) candidates.set(id, { ...found, ...change });
    };
    for (const event of req.events) {
      switch (event.type) {
        case "worker_started":
          if (state === "queued") state = "running";
          break;
        case "stop_requested":
          if (state !== "finished") state = "stopping";
          break;
        case "request_finished":
          state = "finished";
          finished = event.data;
          remainingAtFinish = remaining;
          break;
        case "budget_updated":
          remaining = event.data.remaining_microusd;
          break;
        case "candidate_selected": {
          const base = template.candidates.find((candidate) => candidate.candidate_id === event.candidate_id);
          if (base !== undefined) candidates.set(base.candidate_id, { ...base, stage: "selected", reason: null, item_key: null, case_id: null, started_at: event.at, finished_at: null });
          break;
        }
        case "check_finished":
          update(event.candidate_id, { stage: "checking" });
          break;
        case "behavior_checks_passed":
          behavior += 1;
          update(event.candidate_id, { stage: "behavior_checks_passed" });
          break;
        case "requested_criteria_passed":
          criteria += 1;
          update(event.candidate_id, { stage: "requested_criteria_passed", item_key: event.item_key });
          break;
        case "package_ready":
          update(event.candidate_id, { stage: "packaging" });
          break;
        case "case_delivered":
          if (event.case_id !== null) delivered.push({ case_id: event.case_id, item_key: event.item_key, at: event.at });
          update(event.candidate_id, { stage: "qualified", case_id: event.case_id, finished_at: event.at });
          break;
        case "candidate_rejected":
        case "candidate_invalid":
        case "candidate_incomplete":
        case "candidate_skipped":
          update(event.candidate_id, { stage: ENDED_STAGE[event.type], reason: { code: event.data.reason, message: event.message }, finished_at: event.at, ...(event.type === "candidate_skipped" ? { started_at: null } : {}) });
          break;
        default:
          break;
      }
    }
    const attention = this.attentionOf(req);
    const items = req.interpretation.items.map((item) => {
      const caseIds = delivered.filter((entry) => entry.item_key === item.item_key).map((entry) => entry.case_id);
      return { item_key: item.item_key, bug_type_id: item.bug_type_id, description: item.description, requested: item.quantity, delivered: caseIds.length, missing: Math.max(0, item.quantity - caseIds.length), case_ids: caseIds };
    });
    const typeTotals = req.interpretation.type_totals.map((total) => {
      const count = items.filter((item) => item.bug_type_id === total.bug_type_id).reduce((sum, item) => sum + item.delivered, 0);
      return { bug_type_id: total.bug_type_id, requested: total.quantity, delivered: count, missing: Math.max(0, total.quantity - count) };
    });
    const started = [...candidates.values()].filter((candidate) => candidate.stage !== "skipped").length;
    // Explored counts candidates whose checks started (contract section 8.2): their reservation creates their
    // copies' sandboxes. A candidate skipped after its selection, or stopped before its reservation, never counts.
    const explored = req.reserved.length;
    const budget = this.budget(req);
    const events = req.events.filter((event) => event.seq > after).slice(0, 200);
    const created = iso(req.createdMs);
    const stopCode = finished?.stop_code ?? null;
    // The fixture's texts apply only to the end the fixture shows; budget_exhausted names the fake ledger's amount.
    const sameEnd = template.stop_reason !== null && template.stop_reason.code === stopCode;
    const stopMessage = (code: StopCode): string => {
      if (code === "budget_exhausted") return budgetStopText(remainingAtFinish, delivered.length, items.reduce((sum, item) => sum + item.requested, 0));
      return sameEnd && template.stop_reason !== null ? template.stop_reason.message : STOP_TEXT[code];
    };
    return {
      contract_version: "bug-request/1",
      request_id: req.request_id,
      created_at: created,
      updated_at: req.events.at(-1)?.at ?? created,
      state,
      outcome: finished?.outcome ?? null,
      stop_reason: stopCode === null ? null : { code: stopCode, message: stopMessage(stopCode) },
      delivery: delivered.length === 0 ? "none" : items.some((item) => item.missing > 0) ? "partial" : "complete",
      attention: attention === null ? null : { code: attention, message: sameEnd && template.attention?.code === attention ? template.attention.message : ATTENTION_TEXT[attention] },
      interpretation: req.interpretation,
      budget: {
        budget_microusd: req.interpretation.input.budget_microusd,
        reserved_microusd: budget.reserved,
        spent_microusd: budget.spent,
        committed_microusd: budget.reserved + budget.spent,
        remaining_microusd: budget.remaining,
        overrun: budget.overrun,
      },
      limits: {
        max_wall_clock_s: req.interpretation.limits.max_wall_clock_s,
        deadline_at: iso(req.createdMs + req.interpretation.limits.max_wall_clock_s * 1000),
        max_candidates: req.interpretation.limits.max_candidates,
        candidates_started: started,
      },
      funnel: { candidates_explored: explored, behavior_checks_passed: behavior, requested_criteria_passed: criteria, packages_ready: delivered.length },
      items,
      type_totals: typeTotals,
      candidates: [...candidates.values()],
      cases: delivered.map((entry) => this.caseOf(req, entry.case_id, entry.item_key, entry.at)),
      events,
      next_after: events.at(-1)?.seq ?? after,
      last_heartbeat_at: req.heartbeatMs === null ? null : iso(req.heartbeatMs),
      poll_after_ms: state === "finished" ? 1000 : 250,
    };
  }
}

const WORLD_KEY = "__rbwFactoryTestWorld";

/** The test-mode server: one world per server process, shared by every route bundle. */
export function testModeServer(config: FactoryConfig, log: (line: string) => void): FactoryServer {
  const holder = globalThis as typeof globalThis & { [WORLD_KEY]?: TestWorld };
  holder[WORLD_KEY] ??= new TestWorld({ fixtures: loadTestFixtures(config.testFixturesDir), passcode: config.passcode });
  const world = holder[WORLD_KEY];
  return { ports: world, requestRoot: testRequestRoot, test: world, log };
}
