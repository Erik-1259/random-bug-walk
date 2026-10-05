export { canonicalJson, sha256Hex } from "./canonical.ts";
export { createTavilyClient } from "./client.ts";
export type { ClientOptions, SearchClient } from "./client.ts";
export { SearchError } from "./errors.ts";
export {
  BASE_SOURCE_DOMAINS,
  CALL_NAMES,
  CREDIT_LIMIT_PER_CALL,
  DEFAULT_SETTINGS,
  settingsSchema,
} from "./plan.ts";
export type { CallName, SearchSettings } from "./plan.ts";
export { loadRateSheet, parseRateSheet, priceOf } from "./rates.ts";
export type { RateEntry, RateSheet } from "./rates.ts";
export { runRecord } from "./record.ts";
export type { CallSummary, RecordOptions, RecordResult } from "./record.ts";
export {
  createDirectoryRecordStore,
  createMemoryRecordStore,
  freezeRecord,
  recordKey,
  searchRecordSchema,
  summarizeNovelty,
  verifyRecord,
} from "./records.ts";
export type {
  DocsResult,
  NoveltySummary,
  RecordKind,
  RecordStore,
  SearchRecord,
  SourceResult,
  UnhashedRecord,
} from "./records.ts";
export { parseSearchInput, searchInputSchema } from "./search-input.ts";
export type { SearchInput } from "./search-input.ts";
export { createSearcher } from "./searcher.ts";
export type { CallResult, LocalRefusalCode, Searcher, SearcherDeps, SpendOutcome, StopReason } from "./searcher.ts";
export { buildIdentity, buildProfile, buildReserveRequest, creditEnvelope, parseRunContext } from "./spend-identity.ts";
export type { Identity, RunContext, SearchProfile } from "./spend-identity.ts";
export { installWireTap } from "./wire-tap.ts";
export type { WireExchange, WireTap } from "./wire-tap.ts";
