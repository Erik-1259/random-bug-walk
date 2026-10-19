// Hand-written and type-only: the interfaces with methods, over the generated data types.
import type {
  BaselineIdentity,
  BugCaseInputs,
  CatalogEntry,
  CellObservation,
  CollectedCopy,
  CopyPlan,
  CopyRecord,
  CopyRoots,
  CopyState,
  HostId,
  Protocol,
  UnpackedPair,
  UtcTime,
  ValidatorInputs,
} from "./generated.ts";

/** Whether a catalog entry can run in a time window. */
export interface HostAvailability {
  available: boolean;
  reason: string | null;
}

/** The two cells a host adapter reads from the copy records of one copy state. */
export interface InterpretedCells {
  original_suite: CellObservation;
  verification: CellObservation;
}

/** One host's baseline, catalog, copy mapping and parsing of copy results. */
export interface HostAdapter {
  host_id: HostId;
  baseline(): BaselineIdentity;
  catalog(): CatalogEntry[];
  /** Needs no archive, so the candidate's worst case can be priced before it starts. */
  protocol(entry: CatalogEntry): Protocol;
  /** Absent means always available; `until` is the run's planned end. */
  availability?(entry: CatalogEntry, from: UtcTime, until: UtcTime): HostAvailability;
  bugCaseInputs(entry: CatalogEntry): Promise<BugCaseInputs>;
  validatorInputs(entry: CatalogEntry): Promise<ValidatorInputs>;
  /** Maps the harness-built trees of the exported parts to copy plans; applies no patch. */
  copyPlans(state: CopyState, unpacked: UnpackedPair, protocol: Protocol): CopyPlan[];
  /**
   * Host-specific parsing of one copy's results: reads only what the copy wrote under
   * `plan.destinations.results`, as the runner brought it back. A setup_failed copy becomes a record with
   * status invalid and a timed_out copy one with status incomplete (contract section 8.3), never a pass, fail
   * or detection. `evidence_sha256` is the collected `results_sha256`.
   */
  collect(plan: CopyPlan, collected: CollectedCopy): Promise<CopyRecord>;
  interpret(records: CopyRecord[], protocol: Protocol): InterpretedCells;
}

/** Runs one copy. Runners are host-neutral: every runner implements exactly this. */
export interface CopyRunner {
  /**
   * Places every `plan.files` entry from `roots.app_root` at `plan.destinations.app` and every
   * `plan.evaluator_files` entry from `roots.evaluator_root` at `plan.destinations.evaluator`, checking each
   * file's sha256 before placing it (a mismatch is setup_failed); runs `plan.command` within `plan.limits`;
   * then copies `plan.destinations.results` back into a fresh local directory. Resolves with `plan.copy_id`
   * for every definite outcome; rejects only for an uncertain provider outcome, which the caller turns into
   * needs_reconciliation.
   */
  run(plan: CopyPlan, roots: CopyRoots): Promise<CollectedCopy>;
}
