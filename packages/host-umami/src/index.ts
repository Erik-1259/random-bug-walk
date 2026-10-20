// The main entry. It loads no Docker, local runner, sandbox or database code, so a web route can
// import it; the Docker export that prepares the store is the separate `./prepare` entry.
export { buildUmamiAdapter, createUmamiAdapter } from "./adapter.ts";
export type { UmamiAdapter, UmamiAdapterOptions } from "./adapter.ts";
export { CALENDAR_REASON, calendarAvailability } from "./availability.ts";
export {
  CATALOG_VERSION,
  CHECK_SET_ID,
  CHECK_SET_VERSION,
  CRITERION,
  ENTRY_ID,
  HOST_ID,
  PRESENTATION,
  SOURCE_ID,
  TIME_ZONE_FAILURE_CODE,
  baselineIdentity,
  buildCatalogEntry,
  checkEntryTargets,
  environmentSha256,
  expectedVectorsSha256,
} from "./catalog.ts";
export { CLOSURE_APP_MODULE, isClosurePath } from "./closure.ts";
export { COPY_LIMITS, COPY_SCRIPT, UMAMI_COPY_DESTINATIONS, copyCommand, copyPlans } from "./copy-plans.ts";
export { UMAMI_REFUSAL_CODES, UmamiRefusal } from "./errors.ts";
export type { UmamiRefusalCode } from "./errors.ts";
export { CHECKS_LAYOUT, EXPECTED_MATRIX, RUNTIME_SETUP } from "./inputs.ts";
export { combineCells, interpret } from "./interpret.ts";
export { EXPECTED_TRIALS_FILE, FROZEN_JOB_IDS, REQUEST_FILE, buildFrozenJob, frozenTaskIdentity, mutationIdOf } from "./job.ts";
export type { FrozenJob } from "./job.ts";
export { RELEASED_CASE, releasedCaseMapping } from "./mapping.ts";
export type { FactoryIdentity, ReleasedCaseMapping } from "./mapping.ts";
export { TARGET_PATH, UMAMI_PINS } from "./pins.ts";
export type { ExpectedVectors, UmamiPins } from "./pins.ts";
export { PROTOCOL_ID, PROTOCOL_VERSION, TRIAL_OF_STATE, UMAMI_PROTOCOL, VALID_TRIAL_RULES } from "./protocol.ts";
export { RECORDS_DIR, collectCopy, demonstratedCodes, readCopyResults } from "./records.ts";
export type { CopyObservation, CopyResultsInput } from "./records.ts";
export { INDEX_FILE, OBJECTS_DIR, STORE_FORMAT, openStore, parseIndex, writeStore } from "./store.ts";
export type { PreparedStore, StoreIndex } from "./store.ts";
export { treeSha256 } from "./tree.ts";
