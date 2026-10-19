// Hand-written and type-only: the interfaces with methods, over the generated data types.
import type {
  BaselineIdentity,
  BugCaseInputs,
  CatalogEntry,
  CellObservation,
  CopyPlan,
  CopyRecord,
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

/** One host's baseline, catalog and copy mapping. */
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
  interpret(records: CopyRecord[], protocol: Protocol): InterpretedCells;
}

/** Runs one copy. */
export interface CopyRunner {
  /**
   * Resolves with a record whose status is complete, invalid or incomplete (setup and infrastructure
   * failures are invalid). Rejects only for an uncertain provider outcome, which the caller turns into
   * needs_reconciliation.
   */
  run(plan: CopyPlan): Promise<CopyRecord>;
}
