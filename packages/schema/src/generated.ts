// Derived from packages/schema/schema/records.schema.json; regenerate with pnpm --filter @rbw/schema run generate.

export const DEF_NAMES = ["SafeInteger", "NonNegativeInteger", "PositiveInteger", "SchemaVersion", "Uuid", "Sha256", "ImageDigest", "GitCommitId", "UtcTime", "DurationMs", "ByteCount", "TokenCount", "MicroUsd", "StageName", "TrialId", "Slug", "ArtifactKind", "RelativePath", "MediaType", "HttpsRepositoryUrl", "HttpsBaseUri", "HttpsObjectUri", "PolicyPurpose", "Visibility", "RootRunKind", "RootRunStatus", "RootRunOutcome", "PublicationStatus", "FailureReason", "OmissionOutcome", "EntryOutcome", "OmissionReason", "RedactionCategory", "Exposure", "ProjectPolicy", "SourceFix", "Family", "FamilyRegistry", "HeldOutIdentityList", "RootRun", "ArtifactEntry", "ArtifactManifest", "PublishedArtifact", "Omission", "PublicationRecord", "Redaction", "ExecutionLink", "RunManifestEntry", "RunManifest", "PublicRunStatus", "PathOmissionDeclaration", "WithheldDeclaration", "RedactionDeclaration", "StagingOmissions", "JobKind", "CodeState", "ExpectedOutcome", "ObservedOutcome", "TrialStatus", "TrialReason", "AssertionFailureCode", "CheckId", "TestId", "OperationKind", "CallName", "FileMode", "TaskRevisionKind", "TimeZoneName", "LocaleTag", "EndpointPath", "JobRequest", "ExpectedCheck", "ExpectedTrial", "ExpectedTrials", "CheckObservation", "TrialObservations", "TrialResult", "QueryParameters", "SymptomRequest", "SymptomEvent", "BucketCount", "FollowUpExample", "DocExcerpt", "ObservedSymptom", "OperationIdentity", "MutationChange", "MutationIdentity", "TaskRevisionIdentity", "ImageReference", "ReleaseRevision", "ReleaseImages", "ReleaseFamily", "ReleaseRun", "ReleaseAdmission", "ReleaseFile", "ReleaseApproval", "ReleaseJudgeJob", "Release"] as const;
export type DefName = (typeof DEF_NAMES)[number];

export type SafeInteger = number;

export type NonNegativeInteger = number;

export type PositiveInteger = number;

export type SchemaVersion = 1;

export type Uuid = string;

export type Sha256 = string;

export type ImageDigest = string;

export type GitCommitId = string;

export type UtcTime = string;

export type DurationMs = NonNegativeInteger;

export type ByteCount = NonNegativeInteger;

export type TokenCount = NonNegativeInteger;

export type MicroUsd = SafeInteger;

export type StageName = string;

export type TrialId = string;

export type Slug = string;

export type ArtifactKind = string;

export type RelativePath = string;

export type MediaType = string;

export type HttpsRepositoryUrl = string;

export type HttpsBaseUri = string;

export type HttpsObjectUri = string;

export const POLICY_PURPOSE_VALUES = ["public_demo", "evaluation"] as const;
export type PolicyPurpose = (typeof POLICY_PURPOSE_VALUES)[number];

export const VISIBILITY_VALUES = ["public", "private"] as const;
export type Visibility = (typeof VISIBILITY_VALUES)[number];

export const ROOT_RUN_KIND_VALUES = ["factory", "kit_check", "judge_replay"] as const;
export type RootRunKind = (typeof ROOT_RUN_KIND_VALUES)[number];

export const ROOT_RUN_STATUS_VALUES = ["prepared", "running", "terminal", "needs_reconciliation"] as const;
export type RootRunStatus = (typeof ROOT_RUN_STATUS_VALUES)[number];

export const ROOT_RUN_OUTCOME_VALUES = ["completed", "failed", "incomplete", "cancelled"] as const;
export type RootRunOutcome = (typeof ROOT_RUN_OUTCOME_VALUES)[number];

export const PUBLICATION_STATUS_VALUES = ["prepared", "published", "blocked", "failed"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUS_VALUES)[number];

export const FAILURE_REASON_VALUES = ["scan_blocked", "scan_unavailable", "store_unavailable", "store_mismatch", "repository_unavailable", "repository_conflict", "limit_exceeded", "candidate_corrupt"] as const;
export type FailureReason = (typeof FAILURE_REASON_VALUES)[number];

export const OMISSION_OUTCOME_VALUES = ["truncated", "not_produced", "withheld_private"] as const;
export type OmissionOutcome = (typeof OMISSION_OUTCOME_VALUES)[number];

export type EntryOutcome = "published" | OmissionOutcome;

export const OMISSION_REASON_VALUES = ["size_limit", "time_limit", "stage_failed", "stage_skipped", "run_cancelled", "private_material", "report_missing"] as const;
export type OmissionReason = (typeof OMISSION_REASON_VALUES)[number];

export const REDACTION_CATEGORY_VALUES = ["credential", "auth_header", "provider_identifier", "private_material"] as const;
export type RedactionCategory = (typeof REDACTION_CATEGORY_VALUES)[number];

export const EXPOSURE_VALUES = ["public"] as const;
export type Exposure = (typeof EXPOSURE_VALUES)[number];

export interface ProjectPolicy {
  schema_version: SchemaVersion;
  project_id: Uuid;
  purpose: PolicyPurpose;
  visibility: Visibility;
  output_repository: HttpsRepositoryUrl | null;
  public_artifact_base_uri: HttpsBaseUri | null;
  policy_version: PositiveInteger;
}

export interface SourceFix {
  upstream: Slug;
  commit: GitCommitId;
}

export interface Family {
  family_id: Slug;
  exposure: Exposure;
  held_out_eligible: false;
  source_fixes: SourceFix[];
  mutation_ids: Sha256[];
}

export interface FamilyRegistry {
  schema_version: SchemaVersion;
  families: Family[];
}

export interface HeldOutIdentityList {
  schema_version: SchemaVersion;
  family_ids: Slug[];
  source_fixes: SourceFix[];
  mutation_ids: Sha256[];
}

export interface RootRun {
  schema_version: SchemaVersion;
  project_id: Uuid;
  root_execution_id: Uuid;
  project_policy_sha256: Sha256;
  kind: RootRunKind;
  declared_stages: StageName[];
  child_execution_ids: Uuid[];
  status: RootRunStatus;
  outcome: RootRunOutcome | null;
}

export interface ArtifactEntry {
  kind: ArtifactKind;
  key: RelativePath;
  sha256: Sha256;
  size_bytes: ByteCount;
  media_type: MediaType;
}

export interface ArtifactManifest {
  schema_version: SchemaVersion;
  project_policy_sha256: Sha256;
  root_execution_id: Uuid;
  execution_id: Uuid;
  task_revision: Sha256;
  trial_id: TrialId;
  entries: ArtifactEntry[];
}

export interface PublishedArtifact {
  path: RelativePath;
  sha256: Sha256;
  size_bytes: ByteCount;
  public_uri: HttpsObjectUri | null;
}

export interface Omission {
  category: OmissionOutcome;
  reason: OmissionReason;
}

export interface PublicationRecord {
  schema_version: SchemaVersion;
  root_execution_id: Uuid;
  project_policy_sha256: Sha256;
  publication_id: Uuid;
  manifest_sha256: Sha256;
  execution_id: Uuid;
  status: PublicationStatus;
  repository_commit: GitCommitId | null;
  artifacts: PublishedArtifact[];
  omissions: Omission[];
  failure_reason: FailureReason | null;
}

export interface Redaction {
  category: RedactionCategory;
  count: PositiveInteger;
}

export interface ExecutionLink {
  execution_id: Uuid;
  parent_execution_id: Uuid | null;
}

export interface RunManifestEntry {
  path: RelativePath;
  execution_id: Uuid;
  trial_id: TrialId | null;
  media_type: MediaType | null;
  outcome: EntryOutcome;
  sha256: Sha256 | null;
  size_bytes: ByteCount | null;
  public_uri: HttpsObjectUri | null;
  reason: OmissionReason | null;
  redactions: Redaction[];
}

export interface RunManifest {
  schema_version: SchemaVersion;
  project_id: Uuid;
  project_policy_sha256: Sha256;
  root_execution_id: Uuid;
  kind: RootRunKind;
  declared_stages: StageName[];
  outcome: RootRunOutcome;
  executions: ExecutionLink[];
  entries: RunManifestEntry[];
}

export interface PublicRunStatus {
  schema_version: SchemaVersion;
  root_execution_id: Uuid;
  project_policy_sha256: Sha256;
  kind: RootRunKind;
  status: RootRunStatus;
  outcome: RootRunOutcome | null;
  declared_stage_count: PositiveInteger;
  child_execution_count: NonNegativeInteger;
  publication_status: PublicationStatus | null;
}

export interface PathOmissionDeclaration {
  outcome: "truncated" | "not_produced";
  path: RelativePath;
  execution_id: Uuid;
  trial_id: TrialId | null;
  reason: OmissionReason;
}

export interface WithheldDeclaration {
  outcome: "withheld_private";
  execution_id: Uuid;
  trial_id: TrialId | null;
  reason: OmissionReason;
}

export interface RedactionDeclaration {
  path: RelativePath;
  category: RedactionCategory;
  count: PositiveInteger;
}

export interface StagingOmissions {
  schema_version: SchemaVersion;
  entries: (PathOmissionDeclaration | WithheldDeclaration)[];
  redactions: RedactionDeclaration[];
}

export const JOB_KIND_VALUES = ["kit_check", "observe", "admission", "judge_verify"] as const;
export type JobKind = (typeof JOB_KIND_VALUES)[number];

export const CODE_STATE_VALUES = ["clean", "planted", "fixed", "partial", "stub"] as const;
export type CodeState = (typeof CODE_STATE_VALUES)[number];

export const EXPECTED_OUTCOME_VALUES = ["pass", "assertion_fail"] as const;
export type ExpectedOutcome = (typeof EXPECTED_OUTCOME_VALUES)[number];

export const OBSERVED_OUTCOME_VALUES = ["pass", "assertion_fail", "setup_fail", "skipped", "not_run"] as const;
export type ObservedOutcome = (typeof OBSERVED_OUTCOME_VALUES)[number];

export const TRIAL_STATUS_VALUES = ["complete", "invalid", "incomplete"] as const;
export type TrialStatus = (typeof TRIAL_STATUS_VALUES)[number];

export const TRIAL_REASON_VALUES = ["scope_violation", "build_failed", "startup_failed", "auth_failed", "seed_failed", "timeout", "artifact_missing", "artifact_hash_mismatch", "test_missing", "test_skipped", "unrelated_failure", "provider_uncertain", "limit_exceeded"] as const;
export type TrialReason = (typeof TRIAL_REASON_VALUES)[number];

export const ASSERTION_FAILURE_CODE_VALUES = ["local_day_counts_mismatch", "bucket_labels_mismatch"] as const;
export type AssertionFailureCode = (typeof ASSERTION_FAILURE_CODE_VALUES)[number];

export type CheckId = string;

export type TestId = string;

export type OperationKind = string;

export type CallName = string;

export const FILE_MODE_VALUES = ["100644", "100755"] as const;
export type FileMode = (typeof FILE_MODE_VALUES)[number];

export const TASK_REVISION_KIND_VALUES = ["kit", "provisional", "complete"] as const;
export type TaskRevisionKind = (typeof TASK_REVISION_KIND_VALUES)[number];

export type TimeZoneName = string;

export type LocaleTag = string;

export type EndpointPath = string;

export interface JobRequest {
  schema_version: SchemaVersion;
  project_id: Uuid;
  project_policy_sha256: Sha256;
  batch_id: Uuid;
  execution_id: Uuid;
  root_execution_id: Uuid;
  parent_execution_id: Uuid | null;
  operation_id: Sha256;
  attempt_ordinal: PositiveInteger;
  payload_hash: Sha256;
  kind: JobKind;
  task_revision: Sha256;
  policy_id: Slug;
  runtime_profile_sha256: Sha256;
  image_digest: ImageDigest;
  expected_trials_key: RelativePath;
  expected_trials_sha256: Sha256;
  baseline_evidence_key: RelativePath | null;
  baseline_evidence_sha256: Sha256 | null;
  deadline_at: UtcTime;
  reservation_microusd: MicroUsd;
  release_id: Uuid | null;
}

export interface ExpectedCheck {
  check_id: CheckId;
  expected: ExpectedOutcome;
  failure_code: AssertionFailureCode | null;
}

export interface ExpectedTrial {
  trial_id: TrialId;
  code_state: CodeState;
  patch_sha256: Sha256 | null;
  original_suite_sha256: Sha256 | null;
  original_test_ids: TestId[];
  added_suite_sha256: Sha256;
  added_repeat_count: PositiveInteger;
  expected_checks: ExpectedCheck[];
}

export interface ExpectedTrials {
  schema_version: SchemaVersion;
  execution_id: Uuid;
  task_revision: Sha256;
  trials: ExpectedTrial[];
}

export interface CheckObservation {
  check_id: CheckId;
  repeat_index: PositiveInteger;
  observed: ObservedOutcome;
  failure_code: AssertionFailureCode | TrialReason | null;
  duration_ms: DurationMs;
  response_artifact_key: RelativePath | null;
  response_artifact_sha256: Sha256 | null;
}

export interface TrialObservations {
  schema_version: SchemaVersion;
  execution_id: Uuid;
  trial_id: TrialId;
  observations: CheckObservation[];
}

export interface TrialResult {
  schema_version: SchemaVersion;
  project_policy_sha256: Sha256;
  root_execution_id: Uuid;
  execution_id: Uuid;
  task_revision: Sha256;
  trial_id: TrialId;
  code_state: CodeState;
  status: TrialStatus;
  expected_trials_sha256: Sha256;
  observations_key: RelativePath | null;
  observations_sha256: Sha256 | null;
  artifacts_key: RelativePath | null;
  artifacts_sha256: Sha256 | null;
  invalid_reason: TrialReason | null;
  started_at: UtcTime;
  ended_at: UtcTime;
}

export type QueryParameters = Record<string, string>;

export interface SymptomRequest {
  method: "GET" | "POST";
  path: EndpointPath;
  query: QueryParameters;
}

export interface SymptomEvent {
  label: string;
  timestamp_seconds: NonNegativeInteger;
  utc_instant: UtcTime;
}

export interface BucketCount {
  bucket_label: string;
  count: NonNegativeInteger;
}

export interface FollowUpExample {
  timezone: TimeZoneName;
  expected: BucketCount[];
  observed: BucketCount[];
}

export interface DocExcerpt {
  text: string;
  source_url: HttpsObjectUri;
}

export interface ObservedSymptom {
  schema_version: SchemaVersion;
  user_action: string;
  request: SymptomRequest;
  timezone: TimeZoneName;
  locale: LocaleTag | null;
  fixture_description: string;
  events: SymptomEvent[];
  http_status: number;
  expected: BucketCount[];
  observed: BucketCount[];
  follow_up_examples: FollowUpExample[];
  doc_excerpts: DocExcerpt[];
}

export interface OperationIdentity {
  schema_version: SchemaVersion;
  project_id: Uuid;
  project_policy_sha256: Sha256;
  root_execution_id: Uuid;
  batch_id: Uuid;
  task_revision: Sha256;
  kind: OperationKind;
  runtime_profile_sha256: Sha256;
  call_name: CallName | null;
  attempt_ordinal: PositiveInteger;
}

export interface MutationChange {
  path: RelativePath;
  original_sha256: Sha256 | null;
  resulting_sha256: Sha256 | null;
  original_mode: FileMode | null;
  resulting_mode: FileMode | null;
}

export interface MutationIdentity {
  schema_version: SchemaVersion;
  host_commit: GitCommitId;
  changes: MutationChange[];
}

export interface TaskRevisionIdentity {
  schema_version: SchemaVersion;
  revision_kind: TaskRevisionKind;
  host_commit: GitCommitId;
  image_digest: ImageDigest;
  kit_sha256: Sha256;
  fixture_sha256: Sha256;
  original_suite_sha256: Sha256;
  added_suite_sha256: Sha256;
  grading_policy_id: Slug;
  environment_sha256: Sha256;
  mutation_id: Sha256 | null;
  issue_sha256: Sha256 | null;
  issue_style: Slug | null;
}

export type ImageReference = string;

export interface ReleaseRevision {
  sha256: Sha256;
  identity: TaskRevisionIdentity;
}

export interface ReleaseImages {
  kit_image: ImageReference;
  controller_image: ImageReference;
}

export interface ReleaseFamily {
  family_id: Slug;
  source_fix: SourceFix;
  mutation_id: Sha256;
  split: "public_demo";
}

export interface ReleaseRun {
  root_execution_id: Uuid;
  publication_id: Uuid;
  manifest_sha256: Sha256;
  repository_commit: GitCommitId;
}

export interface ReleaseAdmission {
  execution_id: Uuid;
  outcome_verdict: "pass";
  classification: "blind_spot_demonstrated";
}

export interface ReleaseFile {
  path: RelativePath;
  sha256: Sha256;
}

export interface ReleaseApproval {
  decision: "approved";
  issue_sha256: Sha256;
  reviewed_at: UtcTime;
}

export interface ReleaseJudgeJob {
  index_key: RelativePath;
  index_sha256: Sha256;
}

export interface Release {
  schema_version: SchemaVersion;
  release_id: Uuid;
  project_id: Uuid;
  project_policy_sha256: Sha256;
  policy_id: Slug;
  created_at: UtcTime;
  calibration: "not_requested";
  revisions: ReleaseRevision[];
  images: ReleaseImages;
  family: ReleaseFamily;
  run: ReleaseRun;
  admission: ReleaseAdmission;
  files: ReleaseFile[];
  approval: ReleaseApproval;
  judge_job: ReleaseJudgeJob;
}

/** Maps each definition name to its type. */
export interface DefTypes {
  SafeInteger: SafeInteger;
  NonNegativeInteger: NonNegativeInteger;
  PositiveInteger: PositiveInteger;
  SchemaVersion: SchemaVersion;
  Uuid: Uuid;
  Sha256: Sha256;
  ImageDigest: ImageDigest;
  GitCommitId: GitCommitId;
  UtcTime: UtcTime;
  DurationMs: DurationMs;
  ByteCount: ByteCount;
  TokenCount: TokenCount;
  MicroUsd: MicroUsd;
  StageName: StageName;
  TrialId: TrialId;
  Slug: Slug;
  ArtifactKind: ArtifactKind;
  RelativePath: RelativePath;
  MediaType: MediaType;
  HttpsRepositoryUrl: HttpsRepositoryUrl;
  HttpsBaseUri: HttpsBaseUri;
  HttpsObjectUri: HttpsObjectUri;
  PolicyPurpose: PolicyPurpose;
  Visibility: Visibility;
  RootRunKind: RootRunKind;
  RootRunStatus: RootRunStatus;
  RootRunOutcome: RootRunOutcome;
  PublicationStatus: PublicationStatus;
  FailureReason: FailureReason;
  OmissionOutcome: OmissionOutcome;
  EntryOutcome: EntryOutcome;
  OmissionReason: OmissionReason;
  RedactionCategory: RedactionCategory;
  Exposure: Exposure;
  ProjectPolicy: ProjectPolicy;
  SourceFix: SourceFix;
  Family: Family;
  FamilyRegistry: FamilyRegistry;
  HeldOutIdentityList: HeldOutIdentityList;
  RootRun: RootRun;
  ArtifactEntry: ArtifactEntry;
  ArtifactManifest: ArtifactManifest;
  PublishedArtifact: PublishedArtifact;
  Omission: Omission;
  PublicationRecord: PublicationRecord;
  Redaction: Redaction;
  ExecutionLink: ExecutionLink;
  RunManifestEntry: RunManifestEntry;
  RunManifest: RunManifest;
  PublicRunStatus: PublicRunStatus;
  PathOmissionDeclaration: PathOmissionDeclaration;
  WithheldDeclaration: WithheldDeclaration;
  RedactionDeclaration: RedactionDeclaration;
  StagingOmissions: StagingOmissions;
  JobKind: JobKind;
  CodeState: CodeState;
  ExpectedOutcome: ExpectedOutcome;
  ObservedOutcome: ObservedOutcome;
  TrialStatus: TrialStatus;
  TrialReason: TrialReason;
  AssertionFailureCode: AssertionFailureCode;
  CheckId: CheckId;
  TestId: TestId;
  OperationKind: OperationKind;
  CallName: CallName;
  FileMode: FileMode;
  TaskRevisionKind: TaskRevisionKind;
  TimeZoneName: TimeZoneName;
  LocaleTag: LocaleTag;
  EndpointPath: EndpointPath;
  JobRequest: JobRequest;
  ExpectedCheck: ExpectedCheck;
  ExpectedTrial: ExpectedTrial;
  ExpectedTrials: ExpectedTrials;
  CheckObservation: CheckObservation;
  TrialObservations: TrialObservations;
  TrialResult: TrialResult;
  QueryParameters: QueryParameters;
  SymptomRequest: SymptomRequest;
  SymptomEvent: SymptomEvent;
  BucketCount: BucketCount;
  FollowUpExample: FollowUpExample;
  DocExcerpt: DocExcerpt;
  ObservedSymptom: ObservedSymptom;
  OperationIdentity: OperationIdentity;
  MutationChange: MutationChange;
  MutationIdentity: MutationIdentity;
  TaskRevisionIdentity: TaskRevisionIdentity;
  ImageReference: ImageReference;
  ReleaseRevision: ReleaseRevision;
  ReleaseImages: ReleaseImages;
  ReleaseFamily: ReleaseFamily;
  ReleaseRun: ReleaseRun;
  ReleaseAdmission: ReleaseAdmission;
  ReleaseFile: ReleaseFile;
  ReleaseApproval: ReleaseApproval;
  ReleaseJudgeJob: ReleaseJudgeJob;
  Release: Release;
}
