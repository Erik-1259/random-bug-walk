// Stub ports for the factory handler tests: in-memory fakes of exactly the FactoryServerPorts,
// answering with the contract fixtures, recording every port call in order.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BusyReason,
  Capabilities,
  Case,
  DefName,
  DefTypes,
  Interpretation,
  Limits,
  RequestStatus,
  StartRequest,
  ValidationRun,
} from "@rbw/factory-contract";
import { assertContract, validateContract } from "@rbw/factory-contract/validate";
import { canonicalDigest } from "@rbw/schema";
import type {
  CreateRecordLaunchResult,
  FactoryServer,
  FactoryServerPorts,
  FactoryTestControls,
  LostTarget,
  PackageRead,
  SlotResult,
  StartValidationResult,
} from "../../src/factory-server/ports.ts";
import { factorySessionToken, FACTORY_SESSION_COOKIE } from "../../src/factory-server/session.ts";

export const FIXTURES = fileURLToPath(new URL("../../../../docs/product/fixtures/bug-request-v1/", import.meta.url));

export function fixture<K extends DefName>(name: K, file: string): DefTypes[K] {
  return assertContract(name, JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as unknown);
}

export const PASSCODE = "synthetic-factory-passcode-41";
export const REQUEST_ID = "00000000-0000-4000-8000-0000000001a1";
export const OTHER_REQUEST_ID = "00000000-0000-4000-8000-0000000001a2";
export const VALIDATION_ID = "00000000-0000-4000-8000-0000000002a1";
export const START = Date.parse("2026-10-20T14:00:00.000Z");

/** A profile whose limits differ from the fixtures' illustrative ones. */
export const PROFILE_LIMITS: Limits = {
  max_items: 4,
  max_quantity_per_item: 2,
  max_total_quantity: 5,
  max_description_chars: 400,
  budget_presets_microusd: [1_200_000, 2_400_000],
  default_budget_microusd: 1_200_000,
  min_budget_microusd: 600_000,
  max_budget_microusd: 3_000_000,
  max_wall_clock_s: 2700,
  max_candidates: 8,
};

export function cookie(passcode: string = PASSCODE): string {
  return `${FACTORY_SESSION_COOKIE}=${factorySessionToken(passcode)}`;
}

export function request(path: string, init: { method?: string; body?: unknown; session?: boolean; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.session !== false) headers.cookie = cookie();
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? null : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** The response body, checked against its contract definition. */
export async function contractBody<K extends DefName>(name: K, response: Response): Promise<DefTypes[K]> {
  const body = (await response.json()) as unknown;
  expectValid(name, body);
  return body as DefTypes[K];
}

export function expectValid(name: DefName, body: unknown): void {
  const errors = validateContract(name, body);
  if (errors.length > 0) throw new Error(`${name} does not match the contract: ${errors.join(", ")}`);
}

export function startBody(requestId: string = REQUEST_ID, interpretation: Interpretation = SUPPORTED): StartRequest {
  return { request_id: requestId, input: structuredClone(interpretation.input), interpretation_sha256: interpretation.interpretation_sha256 };
}

export const SUPPORTED = fixture("Interpretation", "interpretation-supported.json");
export const UNSUPPORTED = fixture("Interpretation", "interpretation-unsupported.json");
export const QUEUED = fixture("RequestStatus", "status-queued.json");
export const RUNNING = fixture("RequestStatus", "status-running.json");
export const FULFILLED = fixture("RequestStatus", "status-fulfilled.json");
export const CAPABILITIES = fixture("Capabilities", "capabilities.json");
export const VALIDATION_RUNNING = fixture("ValidationRun", "validation-running.json");
export const VALIDATION_PASSED = fixture("ValidationRun", "validation-passed.json");
export const EXAMPLE = fixture("ExampleResponse", "example.json");

/** A fixture status re-addressed to a request ID, with its download paths and provenance. */
export function statusFor(requestId: string, status: RequestStatus): RequestStatus {
  const text = JSON.stringify(status).replaceAll(status.request_id, requestId);
  return JSON.parse(text) as RequestStatus;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const half = Math.floor(bytes.length / 2);
  yield bytes.subarray(0, half);
  await Promise.resolve();
  yield bytes.subarray(half);
}

interface StoredRequest {
  sha256: string;
  status: RequestStatus;
}

/** In-memory ports with every behavior adjustable per test; `calls` lists the port calls in order. */
export class StubPorts implements FactoryServerPorts {
  readonly calls: string[] = [];
  clock = START;
  passcode: string | null = PASSCODE;
  profile = { limits: PROFILE_LIMITS, profile_sha256: "c0".repeat(32) };
  caps: Capabilities = { ...structuredClone(CAPABILITIES), limits: PROFILE_LIMITS };
  interpretation: Interpretation = SUPPORTED;
  ledger = { configured: true, halted: false };
  pool = 40_000_000;
  /** The root that holds the slot. */
  slotRoot: string | null = null;
  /** What slotHolder answers; by default the request whose stub root holds the slot. */
  holderTarget: LostTarget | null = null;
  slotReason: BusyReason = "active";
  holdMs = 0;
  readonly requests = new Map<string, StoredRequest>();
  createResult: CreateRecordLaunchResult | Error = { ok: true };
  /** Whether a thrown createRecordLaunch had recorded the request first. */
  recordBeforeThrow = false;
  acquireError: Error | null = null;
  statusOverride: ((status: RequestStatus) => RequestStatus) | null = null;
  readonly stops = new Set<string>();
  finalizeEffect: ((target: LostTarget) => void) | null = null;
  /** What noteUnresponsive does to the stored request; it answers whether an event was appended. */
  unresponsiveEffect: ((requestId: string, now: Date) => boolean) | null = null;
  readonly validations = new Map<string, { request_id: string; case_id: string; run: ValidationRun }>();
  validationResult: StartValidationResult | null = null;
  /** Stored parts; `body`, when set, replaces the stream of `bytes`. */
  readonly packages = new Map<string, { bytes: Uint8Array; sha256: string; size: number; filename: string; body?: () => AsyncIterable<Uint8Array> }>();
  exampleCase: Case | null = EXAMPLE.case;
  private readonly locks = new Map<string, Promise<void>>();

  private call(name: string): void {
    this.calls.push(name);
  }

  now(): Date {
    return new Date(this.clock);
  }

  capabilities(): Capabilities {
    this.call("capabilities");
    return structuredClone(this.caps);
  }

  interpret(input: unknown): { ok: true; interpretation: Interpretation } | { ok: false; message: string } {
    this.call("interpret");
    const errors = validateContract("RequestInput", input);
    if (errors.length > 0) return { ok: false, message: `synthetic: ${errors.join(", ")}` };
    return { ok: true, interpretation: structuredClone(this.interpretation) };
  }

  canonicalStart(body: unknown): { ok: true; start: StartRequest; sha256: string } | { ok: false; message: string } {
    this.call("canonicalStart");
    const errors = validateContract("StartRequest", body);
    if (errors.length > 0) return { ok: false, message: `synthetic: ${errors.join(", ")}` };
    const start = body as StartRequest;
    return { ok: true, start, sha256: canonicalDigest(start).sha256 };
  }

  async withRequestLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    this.call(`lock:${id}`);
    const before = this.locks.get(id) ?? Promise.resolve();
    const { promise: mine, resolve: release } = Promise.withResolvers<undefined>();
    this.locks.set(id, before.then(() => mine));
    await before;
    try {
      if (this.holdMs > 0) await new Promise((resolve) => setTimeout(resolve, this.holdMs));
      return await fn();
    } finally {
      release(undefined);
    }
  }

  findRequest(id: string): Promise<{ canonical_sha256: string } | null> {
    this.call("findRequest");
    const found = this.requests.get(id);
    return Promise.resolve(found === undefined ? null : { canonical_sha256: found.sha256 });
  }

  ledgerState(): Promise<{ configured: boolean; halted: boolean }> {
    this.call("ledgerState");
    return Promise.resolve(this.ledger);
  }

  poolAvailable(): Promise<number> {
    this.call("poolAvailable");
    return Promise.resolve(this.pool);
  }

  acquireSlot(root: string): Promise<SlotResult> {
    this.call(`acquireSlot:${root}`);
    if (this.acquireError !== null) return Promise.reject(this.acquireError);
    if (this.slotRoot === null) {
      this.slotRoot = root;
      return Promise.resolve({ kind: "acquired" });
    }
    if (this.slotRoot === root) return Promise.resolve({ kind: "replay" });
    return Promise.resolve({ kind: "held", reason: this.slotReason });
  }

  slotHolder(): Promise<LostTarget | null> {
    this.call("slotHolder");
    if (this.holderTarget !== null || this.slotRoot === null) return Promise.resolve(this.holderTarget);
    return Promise.resolve({ request_id: this.slotRoot.replace(/^root-of-/, "") });
  }

  releaseSlot(root: string): Promise<void> {
    this.call(`releaseSlot:${root}`);
    if (this.slotRoot === root) this.slotRoot = null;
    return Promise.resolve();
  }

  createRecordLaunch(args: { start: StartRequest; sha256: string; interpretation: Interpretation; root: string }): Promise<CreateRecordLaunchResult> {
    this.call("createRecordLaunch");
    const record = () => {
      this.requests.set(args.start.request_id, { sha256: args.sha256, status: statusFor(args.start.request_id, QUEUED) });
    };
    if (this.createResult instanceof Error) {
      if (this.recordBeforeThrow) record();
      return Promise.reject(this.createResult);
    }
    if (this.createResult.ok) record();
    return Promise.resolve(this.createResult);
  }

  status(id: string, after: number): Promise<RequestStatus | null> {
    this.call(`status:${String(after)}`);
    const found = this.requests.get(id);
    if (found === undefined) return Promise.resolve(null);
    const status = structuredClone(found.status);
    const events = status.events.filter((event) => event.seq > after).slice(0, 200);
    const shown = { ...status, events, next_after: events.at(-1)?.seq ?? after };
    return Promise.resolve(this.statusOverride === null ? shown : this.statusOverride(shown));
  }

  noteUnresponsive(id: string, now: Date): Promise<boolean> {
    this.call(`noteUnresponsive:${id}`);
    return Promise.resolve(this.unresponsiveEffect?.(id, now) ?? false);
  }

  recordStop(id: string): Promise<"recorded" | "replay" | "not_found"> {
    this.call("recordStop");
    if (!this.requests.has(id)) return Promise.resolve("not_found");
    if (this.stops.has(id)) return Promise.resolve("replay");
    this.stops.add(id);
    return Promise.resolve("recorded");
  }

  async finalizeLost(target: LostTarget): Promise<void> {
    this.call(`finalizeLost:${"request_id" in target ? target.request_id : target.validation_id}`);
    await Promise.resolve();
    this.finalizeEffect?.(target);
  }

  findValidation(id: string): Promise<{ request_id: string; case_id: string } | null> {
    this.call("findValidation");
    const found = this.validations.get(id);
    return Promise.resolve(found === undefined ? null : { request_id: found.request_id, case_id: found.case_id });
  }

  startValidation(args: { request_id: string; case_id: string; validation_id: string }): Promise<StartValidationResult> {
    this.call("startValidation");
    const result = this.validationResult ?? { kind: "accepted", run: { ...structuredClone(VALIDATION_RUNNING), validation_id: args.validation_id, case_id: args.case_id } };
    if (result.kind === "accepted") this.validations.set(args.validation_id, { request_id: args.request_id, case_id: args.case_id, run: result.run });
    return Promise.resolve(result);
  }

  getValidation(requestId: string, caseId: string, validationId: string): Promise<ValidationRun | null> {
    this.call("getValidation");
    const found = this.validations.get(validationId);
    return Promise.resolve(found?.request_id !== requestId || found.case_id !== caseId ? null : structuredClone(found.run));
  }

  readPackage(requestId: string, caseId: string, part: "bug-case" | "validator"): Promise<PackageRead | null> {
    this.call(`readPackage:${part}`);
    const found = this.packages.get(`${requestId}/${caseId}/${part}`);
    if (found === undefined) return Promise.resolve(null);
    return Promise.resolve({ filename: found.filename, sha256: found.sha256, size: found.size, body: found.body?.() ?? chunks(found.bytes) });
  }

  example(): Promise<Case | null> {
    this.call("example");
    return Promise.resolve(this.exampleCase);
  }
}

export const requestRoot = (requestId: string): string => `root-of-${requestId}`;

export interface Harness {
  ports: StubPorts;
  server: FactoryServer;
  logs: string[];
}

export function harness(test: FactoryTestControls | null = null): Harness {
  const ports = new StubPorts();
  const logs: string[] = [];
  return {
    ports,
    logs,
    server: {
      ports,
      requestRoot,
      test,
      log: (line) => {
        logs.push(line);
      },
    },
  };
}

/** Stores a request in the stubs as if it had been started. */
export function seedRequest(h: Harness, status: RequestStatus, requestId: string = REQUEST_ID, sha: string = "ab".repeat(32)): void {
  h.ports.requests.set(requestId, { sha256: sha, status: statusFor(requestId, status) });
}
