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
  "the factory core's identity module and request loop",
  "the spend ledger's request budgets and factory records",
  "the harness (validatePair) with its host registry and docker runner",
  "the sandbox copy runner (held for the shared runner types)",
];

export function loadFactoryWiring(): Promise<WiringResult> {
  return Promise.resolve({ ok: false, missing: [...MISSING_MODULES] });
}
