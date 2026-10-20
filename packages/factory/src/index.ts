// @rbw/factory: the factory's core logic. Shared types come from @rbw/factory-contract; this package
// defines the ports it needs and the only implementation of the factory's identities.
export { assignItem, assignmentOrder, demonstratedCriteria, itemStates, nextCandidate, servesItem, unfilledUnits } from "./assignment.ts";
export type { ItemState, PlannedCandidate } from "./assignment.ts";
export { admitCandidate, ledgerStop } from "./budget.ts";
export type { Admission, LedgerStop } from "./budget.ts";
export {
  AVAILABLE_SERVICE,
  CONTRACT_VERSION,
  DIFFICULTY_OPTIONS,
  INTERPRETER,
  PACKAGE_FORMATS,
  QUALIFICATION_ROUTE,
  buildCapabilities,
  combinationOf,
} from "./capabilities.ts";
export type { CapabilitiesInput } from "./capabilities.ts";
export { CatalogError, bugTypeOf, criteriaCatalogV1, criterionOf, parseCriteriaCatalog } from "./criteria.ts";
export type { CriteriaCatalog } from "./criteria.ts";
export { ATTENTION_TEXT, OUTCOME_OF, REASON_TEXT } from "./events.ts";
export {
  FACTORY_REQUEST_NAMESPACE,
  FACTORY_VALIDATION_NAMESPACE,
  candidateId,
  caseId,
  copyExecutionId,
  defectId,
  environmentSha256,
  factoryProjectId,
  isUuid,
  mutationSha256,
  requestRoot,
  uuidV5,
  validationRoot,
} from "./identity.ts";
export { canonicalStart, canonicalStartSha256, limitProblem, normalizeInput, parseRequestInput } from "./input.ts";
export type { CanonicalStart, Parsed } from "./input.ts";
export { ESTIMATE_NOTE, interpret } from "./interpret.ts";
export type { InterpretInput } from "./interpret.ts";
export { matchDescription, phraseWords } from "./match.ts";
export type { DescriptionMatch, MatchedCriterion } from "./match.ts";
export { formatUsd } from "./money.ts";
export { DIFFICULTY_NOTE, runRequest } from "./orchestrator.ts";
export type { RunRequestDeps, RunResult } from "./orchestrator.ts";
export type {
  CasePackages,
  CellMatrix,
  DistributiveOmit,
  EventSink,
  HarnessResult,
  LedgerStatus,
  NewEvent,
  PackageCase,
  PackagePartInfo,
  QualifyHarness,
  QualifyInput,
  RequestLedger,
  RequestRecordInput,
  ReserveOutcome,
  ValidatorPartInfo,
} from "./ports.ts";
export { candidateWorstCase, copyEnvelope, entryWorstCase, hostCandidateWorstCase, validationWorstCase } from "./profile.ts";
export type { FactoryProfileInput } from "./profile.ts";
export { MAX_EVENTS_PER_RESPONSE, POLL_AFTER_MS, ProjectionError, UNRESPONSIVE_AFTER_MS, lostWorkerEvents, projectStatus, workerAttentionEvent } from "./projection.ts";
export type { CaseEvidence, ProjectionInput } from "./projection.ts";
export { serviceFunctions } from "./service.ts";
export type { ServiceConfig, ServiceFunctions } from "./service.ts";
export { HOST_PRESENTATION, adapterFor, candidateIndex, candidateInfo, entryServes, plannedWindow, sourceFor, sourcesOf } from "./sources.ts";
export type { CandidateInfo, HostPresentation, HostRegistry, SourceView, TimeWindow, UnavailableEntry } from "./sources.ts";
export { EXPECTED, cellVerdict, qualificationRecord } from "./verdict.ts";
export type { CellVerdict, CellVerdictInput, RecordInput } from "./verdict.ts";
