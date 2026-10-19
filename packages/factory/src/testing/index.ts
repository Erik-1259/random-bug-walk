// Fakes for tests and test mode: synthetic adapters and entries, a test profile, a deterministic
// harness and copy runner, the named scenarios of contract section 15.1, and an in-memory ledger and
// event store.
export {
  COPY_STATES,
  FAKE_RESULT_FILE,
  FakeHostAdapter,
  SYNTHETIC_BASELINES,
  SYNTHETIC_DESTINATIONS,
  TEST_PROFILE,
  fixtureRegistry,
  parseSyntheticCopyId,
  syntheticCopyPlan,
  syntheticEntry,
  syntheticProtocol,
  syntheticSha,
} from "./catalog.ts";
export type { FakeAdapterOptions, SyntheticEntryOptions } from "./catalog.ts";
export { FAKE_HARNESS, UncertainOutcomeError, fakeHarness, harnessResultOf, matrixOf, qualifyingPlan } from "./harness.ts";
export type { EntryPlan, FakeHarnessOptions, FakeHooks, StatePlan } from "./harness.ts";
export { EventConflictError, MemoryEventStore, MemoryLedger } from "./memory.ts";
export type { LedgerCall, MemoryLedgerOptions } from "./memory.ts";
export { syntheticCopyRecord, syntheticObservation, unrunCopyRecord } from "./records.ts";
export type { CellPlan, SyntheticRecordInput } from "./records.ts";
export { FakeCopyRunner, scenarioCopyRunner } from "./runner.ts";
export type { FakeCopyOutcome, FakeRun, FakeRunnerOptions } from "./runner.ts";
export { SCENARIOS, declaredCodes, scenarioSetup, validationPlan } from "./scenarios.ts";
export type { ScenarioSetup } from "./scenarios.ts";
