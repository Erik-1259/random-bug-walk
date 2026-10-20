// The factory service's injected dependencies. The handlers (handlers.ts) call only these, so tests
// and test mode supply fakes, and server.ts maps them to the ledger, the request loop, the worker
// launcher and the package store. Every shape comes from @rbw/factory-contract; nothing here
// redefines a contract or shared internal type.
import type {
  BusyReason,
  Capabilities,
  Case,
  Interpretation,
  Limits,
  RequestStatus,
  StartRequest,
  TestEvidence,
  TestScenario,
  ValidationRun,
} from "@rbw/factory-contract";

/** A package part's archive, read for one delivered case of one request. */
export interface PackageRead {
  filename: string;
  /** The SHA-256 recorded when the part became ready. */
  sha256: string;
  size: number;
  body: AsyncIterable<Uint8Array>;
}

export type SlotResult = { kind: "acquired" | "replay" } | { kind: "held"; reason: BusyReason };

export type CreateRecordLaunchResult = { ok: true } | { ok: false; code: "budget_unavailable" | "unavailable"; message: string };

export type StartValidationResult =
  | { kind: "accepted"; run: ValidationRun }
  | { kind: "busy"; reason: BusyReason }
  | { kind: "budget_unavailable" }
  | { kind: "unavailable"; message: string };

export type LostTarget = { request_id: string } | { validation_id: string };

/**
 * The service's ports. The request loop and projection supply interpretation and status, the ledger
 * the lock, slot, pool and records, the worker the launches and the lost-worker finish, and the
 * package tooling the archives.
 */
export interface FactoryServerPorts {
  now(): Date;
  /** The judges' passcode; while it is null, a sign-in answers unavailable and no session is valid. */
  passcode: string | null;
  /** From the factory profile; the capabilities' limits must equal these. */
  profile: { limits: Limits; profile_sha256: string };
  capabilities(now: Date): Capabilities;
  /** Validates the input against the limits; ok:false is an invalid request. */
  interpret(input: unknown, now: Date): { ok: true; interpretation: Interpretation } | { ok: false; message: string };
  /** Validates a start body and hashes its canonical form (request_id, normalized input, interpretation_sha256). */
  canonicalStart(body: unknown): { ok: true; start: StartRequest; sha256: string } | { ok: false; message: string };
  /** Runs fn while no other caller holds the lock on this ID, across every server instance. */
  withRequestLock<T>(request_id: string, fn: () => Promise<T>): Promise<T>;
  findRequest(request_id: string): Promise<{ canonical_sha256: string } | null>;
  ledgerState(): Promise<{ configured: boolean; halted: boolean }>;
  /** The factory pool's available amount in micro-USD; it counts committed amounts, not whole budgets. */
  poolAvailable(): Promise<number>;
  acquireSlot(root: string): Promise<SlotResult>;
  /**
   * The request or validation run whose root holds the factory slot, or null while it is free: the slot
   * status's holder, looked up by root. A start or validation start that finds the slot held for an active
   * holder asks for that holder's lost-worker finish and tries once more, so a lost holder that nobody
   * polls does not keep every later start busy.
   */
  slotHolder(): Promise<LostTarget | null>;
  /** Only for a start refused before its request is recorded. */
  releaseSlot(root: string): Promise<void>;
  /**
   * Creates the request budget (the pool must cover the worker's worst case), records the request,
   * its frozen interpretation and request_accepted, reserves the worker and launches it. A refusal
   * records nothing.
   */
  createRecordLaunch(args: { start: StartRequest; sha256: string; interpretation: Interpretation; root: string }): Promise<CreateRecordLaunchResult>;
  /** The projection of the recorded events; at most 200 events with seq greater than `after`. */
  status(request_id: string, after: number, now: Date): Promise<RequestStatus | null>;
  /**
   * Appends the attention change that the request worker's heartbeat age calls for (contract section 8.1):
   * `attention` worker_unresponsive once no heartbeat came for 60 s (before the first one, since the
   * acceptance), and `attention_cleared` once a heartbeat arrives after that. Each change is keyed, so
   * repeated or concurrent calls append it once; nothing for a finished request. True when it appended.
   * The status side appends these, since the worker that stopped responding cannot.
   */
  noteUnresponsive(request_id: string, now: Date): Promise<boolean>;
  /** Records the stop and appends stop_requested once; never after the request finished. */
  recordStop(request_id: string): Promise<"recorded" | "replay" | "not_found">;
  /**
   * The lost-worker finish (contract sections 8.1 and 11); idempotent. It decides itself whether the
   * request worker or the validation run is lost (no heartbeat for 180 s, before the first one since the
   * acceptance; a validation run also past 1800 s) and does nothing otherwise.
   */
  finalizeLost(target: LostTarget): Promise<void>;
  findValidation(validation_id: string): Promise<{ request_id: string; case_id: string } | null>;
  /** Takes the slot, reserves and records, or refuses with nothing recorded (contract section 11). */
  startValidation(args: { request_id: string; case_id: string; validation_id: string }): Promise<StartValidationResult>;
  getValidation(request_id: string, case_id: string, validation_id: string): Promise<ValidationRun | null>;
  readPackage(request_id: string, case_id: string, part: "bug-case" | "validator"): Promise<PackageRead | null>;
  example(): Promise<Case | null>;
}

/** The test controls of contract section 15.1; present only in test mode. */
export interface FactoryTestControls {
  evidence(request_id: string): Promise<TestEvidence | null>;
  /** Reconciles every held operation of the request at its worst case; false for an unknown request. */
  reconcile(request_id: string): Promise<boolean>;
  /** Discards every test-mode record and fake, releases the slot and selects the scenario. */
  reset(scenario: TestScenario): Promise<void>;
}

/** Everything a factory handler needs. */
export interface FactoryServer {
  ports: FactoryServerPorts;
  /**
   * The request's ledger root (UUIDv5 of the request ID under the factory request namespace). The
   * shared identity module implements it; the ports above take the root but none computes it.
   */
  requestRoot(request_id: string): string;
  /** Null outside test mode, so the test endpoints answer not_found. */
  test: FactoryTestControls | null;
  log: (line: string) => void;
}
