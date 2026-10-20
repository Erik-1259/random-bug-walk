// The effects the request loop needs, as injected ports. The spend ledger, the event and evidence
// stores, the hosted worker, packaging and the export-verification harness supply the real functions;
// tests and test mode pass the fakes in ./testing. The shared data types come from @rbw/factory-contract.
import type {
  CatalogEntry,
  CellObservation,
  CheckSet,
  CopyPlan,
  CopyRecord,
  CopyState,
  Event,
  HarnessIdentity,
  HostAdapter,
  HostId,
  Interpretation,
  InterpretedCells,
  StopCode,
} from "@rbw/factory-contract";

/** Removes a key from every member of a union, keeping the union discriminated. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * An event to append. The store assigns `seq`. `event_key` is deterministic and unique per request:
 * the same key with the same content replays, different content conflicts (see events.ts for the scheme).
 */
export type NewEvent = DistributiveOmit<Event, "seq"> & { event_key: string };

export interface EventSink {
  append(event: NewEvent): Promise<void>;
}

/** The request budget and the factory pool, as the spend ledger reports them. */
export interface LedgerStatus {
  budget_microusd: number;
  reserved_microusd: number;
  spent_microusd: number;
  /** The spend ledger is halted. */
  halted: boolean;
  /** The factory pool's available amount: its cap less every request's committed amount. */
  pool_available_microusd: number;
  pool_halted: boolean;
}

export type ReserveOutcome = { kind: "reserved" } | { kind: "refused"; reason: "budget" | "pool" | "halted" };

/**
 * The request's ledger operations. `reserveCandidate` is the hard bound behind the loop's pre-check (the
 * database's budget reserve); an implementation that reserves per copy inside the runner instead may
 * answer "reserved" here and reserve per copy: the loop reads `status()` after every copy and appends a
 * `budget_updated` event whenever the amounts changed. Any rejection of a reserve or settle call is an
 * uncertain outcome: the loop never retries it and stops the request with `needs_reconciliation`.
 */
export interface RequestLedger {
  status(): Promise<LedgerStatus>;
  reserveCandidate(input: { candidate_id: string; host_id: HostId; worst_case_microusd: number }): Promise<ReserveOutcome>;
  /** Settles what the candidate's copies used and releases the rest of its reservation. */
  settleCandidate(input: { candidate_id: string }): Promise<void>;
  /**
   * Settles the worker (at its full worst case when its use cannot be measured) and closes the request
   * budget with `stop_code` as the cause. Operations left uncertain stay held.
   */
  settleWorker(input: { stop_code: StopCode }): Promise<void>;
}

/** The two check sets by copy state; the harness's matrix. */
export type CellMatrix = Record<CheckSet, Record<CopyState, CellObservation>>;

/**
 * What the export-verification harness reports for one entry. It mirrors the result of the package
 * tool's `validatePair`, plus the harness identity and whether the archives passed their integrity
 * checks (hashes and pairing), which the qualification record and the `export_mismatch` reason need.
 * The `validatePair` result, as its interface is specified today, carries neither field, so the wiring
 * that adapts the real harness to this port is held until it does (see the README's "Held" section).
 */
export interface HarnessResult {
  result: "passed" | "failed" | "error";
  /** True when a `beforeCopy` hook answered "stop". */
  stopped: boolean;
  /** The archives export verification ran on: the entry's bug case and its validator core. */
  package_sha256: { bug_case: string; validator: string };
  harness: HarnessIdentity;
  /** Null when the harness could run no cell. */
  matrix: CellMatrix | null;
  records: CopyRecord[];
  /** "failed" when the archives failed their hash or pairing checks. */
  integrity: "verified" | "failed";
  message: string | null;
}

export interface QualifyInput {
  entry: CatalogEntry;
  adapter: HostAdapter;
  /** The stop and time check between copies. */
  beforeCopy(plan: CopyPlan): Promise<"continue" | "stop">;
  /** Called with each copy's record as it is collected. */
  onCopy(record: CopyRecord): Promise<void>;
  /**
   * Called after a state's last copy with that state's two cells as the harness checked them (the
   * protocol's floor applied: a pass or fail on fewer valid runs than `min_valid_runs` is incomplete).
   * These are the cells the result's matrix holds; the loop's `check_finished` events come from them.
   */
  onCells(state: CopyState, cells: InterpretedCells): Promise<void>;
}

/**
 * Runs export verification for one catalog entry: the entry's exported bug case and validator core,
 * unpacked in fresh workspaces and run copy by copy. It rejects only for an uncertain provider
 * outcome (a runner rejection passed through unchanged); the loop treats every rejection as uncertain.
 */
export type QualifyHarness = (input: QualifyInput) => Promise<HarnessResult>;

export interface PackagePartInfo {
  sha256: string;
  size_bytes: number;
  filename: string;
}

/**
 * The stored validator archive and what it holds, read back from the stored bytes (hashes and layout
 * only, no copy runs), so the loop can check that the downloadable validator is the core export
 * verification ran on plus this candidate's qualification record.
 */
export interface ValidatorPartInfo extends PackagePartInfo {
  /**
   * SHA-256 of the validator core the stored archive holds: the archive without its evidence member,
   * packed as the package tooling packs a core. Null when the archive holds no validator core.
   */
  core_sha256: string | null;
  /** SHA-256 of the stored archive's evidence member; null when it has none. */
  evidence_sha256: string | null;
}

export interface CasePackages {
  package_version: number;
  pair_sha256: string;
  bug_case: PackagePartInfo;
  validator: ValidatorPartInfo;
}

/**
 * Builds and stores the case's final parts: the entry's bug case and the validator archive made from
 * the validator core plus this qualification record (`record_json`, canonical JSON) as its evidence
 * member. Every hash it reports is of the stored bytes. The loop delivers the case only when the bug
 * case is the archive export verification ran on, `validator.core_sha256` is the core it ran on and
 * `validator.evidence_sha256` is the SHA-256 of `record_json`; otherwise the candidate is rejected
 * with `export_mismatch`.
 */
export type PackageCase = (input: { request_id: string; case_id: string; entry: CatalogEntry; record_json: Uint8Array }) => Promise<CasePackages>;

/** The frozen request a worker runs. */
export interface RequestRecordInput {
  request_id: string;
  created_at: string;
  interpretation: Interpretation;
}
