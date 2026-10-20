// What the factory-worker command runs with: the factory core's identity module and request loop,
// the spend ledger's request budgets and factory records, and the harness with its host registry
// and copy runner. They live in other workspace packages that are not on this branch yet, so this
// build has no wiring and the command says what is missing. The integration pass replaces
// loadFactoryWiring with the real modules; everything the command does with them is in
// factory-cli.ts and factory-worker.ts, and the tests run it with synthetic wiring.
import type { FactoryIdentity, FactoryLedger, FactoryRecords } from "./factory-ports.ts";
import type { Orchestrate, Validate } from "./factory-worker.ts";

export interface OpenedLedger {
  ledger: FactoryLedger;
  records: FactoryRecords;
  close: () => Promise<void>;
}

export interface FactoryWiring {
  identity: FactoryIdentity;
  /** The spend ledger and factory records in the database named by DATABASE_URL. */
  openLedger(databaseUrl: string, now: () => Date): Promise<OpenedLedger>;
  /** The factory core's request loop over the harness, the host registry and the copy runner of the backend. */
  orchestrate(backend: "sandbox" | "docker"): Orchestrate;
  /** The harness on a case's two parts, with the copy runner of the backend. */
  validate(backend: "sandbox" | "docker"): Validate;
}

export type WiringResult = { ok: true; wiring: FactoryWiring } | { ok: false; missing: string[] };

export const MISSING_MODULES: readonly string[] = [
  "the factory core's identity module, event builders and request loop",
  "the spend ledger's request budgets and factory records",
  "the harness (validatePair) with its host registry, docker runner and results hash",
];

/**
 * Interfaces this code cannot wire yet because a decision between the parts is open. Each is held,
 * not final: no integration claims conformance until it is settled.
 */
export const HELD_INTERFACES: readonly string[] = [
  // Contract section 8.5 reserves each candidate's worst case from its selection; the request
  // mode's copy meter reserves one operation per copy at its launch. The request loop's ledger
  // port (status, reserveCandidate, settleCandidate) waits for that decision.
  "the request mode's reservation unit (per copy at launch, or each candidate from its selection)",
  // The ledger's validation record has no host, accepted time, package hashes or package copy count.
  "the validation record's host_id, accepted_at, package_sha256 and copies (FactoryValidationRecord)",
  // The docker runner resolves a CollectedCopy but reports no resource or lifetime of its own.
  "the copy meter's glue around the harness's docker runner for local requests",
];

export function loadFactoryWiring(): Promise<WiringResult> {
  return Promise.resolve({ ok: false, missing: [...MISSING_MODULES] });
}
