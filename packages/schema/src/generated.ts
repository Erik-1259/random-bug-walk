// Derived from packages/schema/schema/records.schema.json; regenerate with pnpm --filter @rbw/schema run generate.

export const DEF_NAMES = ["SafeInteger", "NonNegativeInteger", "PositiveInteger", "SchemaVersion", "Uuid", "Sha256", "ImageDigest", "GitCommitId", "UtcTime", "DurationMs", "ByteCount", "TokenCount", "MicroUsd", "StageName", "TrialId", "Slug", "ArtifactKind", "RelativePath", "MediaType", "HttpsRepositoryUrl", "HttpsBaseUri", "HttpsObjectUri", "PolicyPurpose", "Visibility", "RootRunKind", "RootRunStatus", "RootRunOutcome", "PublicationStatus", "FailureReason", "OmissionOutcome", "EntryOutcome", "OmissionReason", "RedactionCategory", "Exposure", "ProjectPolicy", "SourceFix", "Family", "FamilyRegistry", "HeldOutIdentityList", "RootRun", "ArtifactEntry", "ArtifactManifest", "PublishedArtifact", "Omission", "PublicationRecord", "Redaction", "ExecutionLink", "RunManifestEntry", "RunManifest", "PublicRunStatus", "PathOmissionDeclaration", "WithheldDeclaration", "RedactionDeclaration", "StagingOmissions"] as const;
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
}
