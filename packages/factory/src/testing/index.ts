// Fakes for tests and test mode: synthetic adapters and entries, a test profile, a deterministic
// harness, the named scenarios of contract section 15.1, and an in-memory ledger and event store.
export {
  COPY_STATES,
  FakeHostAdapter,
  SYNTHETIC_BASELINES,
  TEST_PROFILE,
  fixtureRegistry,
  syntheticCopyPlan,
  syntheticEntry,
  syntheticProtocol,
  syntheticSha,
} from "./catalog.ts";
export type { FakeAdapterOptions, SyntheticEntryOptions } from "./catalog.ts";
export { FAKE_HARNESS, UncertainOutcomeError, fakeHarness, qualifyingPlan } from "./harness.ts";
export type { CellPlan, EntryPlan, FakeHarnessOptions, StatePlan } from "./harness.ts";
export { EventConflictError, MemoryEventStore, MemoryLedger } from "./memory.ts";
export type { LedgerCall, MemoryLedgerOptions } from "./memory.ts";
export { SCENARIOS, declaredCodes, scenarioSetup, validationPlan } from "./scenarios.ts";
export type { ScenarioSetup } from "./scenarios.ts";
