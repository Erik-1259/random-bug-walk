# Derived from packages/schema/schema/records.schema.json;
# regenerate with pnpm --filter @rbw/schema run generate.

from __future__ import annotations

from typing import Final, Literal, TypedDict

DEF_NAMES: Final = (
    "SafeInteger",
    "NonNegativeInteger",
    "PositiveInteger",
    "SchemaVersion",
    "Uuid",
    "Sha256",
    "ImageDigest",
    "GitCommitId",
    "UtcTime",
    "DurationMs",
    "ByteCount",
    "TokenCount",
    "MicroUsd",
    "StageName",
    "TrialId",
    "Slug",
    "ArtifactKind",
    "RelativePath",
    "MediaType",
    "HttpsRepositoryUrl",
    "HttpsBaseUri",
    "HttpsObjectUri",
    "PolicyPurpose",
    "Visibility",
    "RootRunKind",
    "RootRunStatus",
    "RootRunOutcome",
    "PublicationStatus",
    "FailureReason",
    "OmissionOutcome",
    "EntryOutcome",
    "OmissionReason",
    "RedactionCategory",
    "Exposure",
    "ProjectPolicy",
    "SourceFix",
    "Family",
    "FamilyRegistry",
    "HeldOutIdentityList",
    "RootRun",
    "ArtifactEntry",
    "ArtifactManifest",
    "PublishedArtifact",
    "Omission",
    "PublicationRecord",
    "Redaction",
    "ExecutionLink",
    "RunManifestEntry",
    "RunManifest",
    "PublicRunStatus",
    "PathOmissionDeclaration",
    "WithheldDeclaration",
    "RedactionDeclaration",
    "StagingOmissions",
)

type SafeInteger = int

type NonNegativeInteger = int

type PositiveInteger = int

type SchemaVersion = Literal[1]

type Uuid = str

type Sha256 = str

type ImageDigest = str

type GitCommitId = str

type UtcTime = str

type DurationMs = NonNegativeInteger

type ByteCount = NonNegativeInteger

type TokenCount = NonNegativeInteger

type MicroUsd = SafeInteger

type StageName = str

type TrialId = str

type Slug = str

type ArtifactKind = str

type RelativePath = str

type MediaType = str

type HttpsRepositoryUrl = str

type HttpsBaseUri = str

type HttpsObjectUri = str

type PolicyPurpose = Literal[
    "public_demo",
    "evaluation",
]
POLICY_PURPOSE_VALUES: Final = (
    "public_demo",
    "evaluation",
)

type Visibility = Literal[
    "public",
    "private",
]
VISIBILITY_VALUES: Final = (
    "public",
    "private",
)

type RootRunKind = Literal[
    "factory",
    "kit_check",
    "judge_replay",
]
ROOT_RUN_KIND_VALUES: Final = (
    "factory",
    "kit_check",
    "judge_replay",
)

type RootRunStatus = Literal[
    "prepared",
    "running",
    "terminal",
    "needs_reconciliation",
]
ROOT_RUN_STATUS_VALUES: Final = (
    "prepared",
    "running",
    "terminal",
    "needs_reconciliation",
)

type RootRunOutcome = Literal[
    "completed",
    "failed",
    "incomplete",
    "cancelled",
]
ROOT_RUN_OUTCOME_VALUES: Final = (
    "completed",
    "failed",
    "incomplete",
    "cancelled",
)

type PublicationStatus = Literal[
    "prepared",
    "published",
    "blocked",
    "failed",
]
PUBLICATION_STATUS_VALUES: Final = (
    "prepared",
    "published",
    "blocked",
    "failed",
)

type FailureReason = Literal[
    "scan_blocked",
    "scan_unavailable",
    "store_unavailable",
    "store_mismatch",
    "repository_unavailable",
    "repository_conflict",
    "limit_exceeded",
    "candidate_corrupt",
]
FAILURE_REASON_VALUES: Final = (
    "scan_blocked",
    "scan_unavailable",
    "store_unavailable",
    "store_mismatch",
    "repository_unavailable",
    "repository_conflict",
    "limit_exceeded",
    "candidate_corrupt",
)

type OmissionOutcome = Literal[
    "truncated",
    "not_produced",
    "withheld_private",
]
OMISSION_OUTCOME_VALUES: Final = (
    "truncated",
    "not_produced",
    "withheld_private",
)

type EntryOutcome = Literal["published"] | OmissionOutcome

type OmissionReason = Literal[
    "size_limit",
    "time_limit",
    "stage_failed",
    "stage_skipped",
    "run_cancelled",
    "private_material",
    "report_missing",
]
OMISSION_REASON_VALUES: Final = (
    "size_limit",
    "time_limit",
    "stage_failed",
    "stage_skipped",
    "run_cancelled",
    "private_material",
    "report_missing",
)

type RedactionCategory = Literal[
    "credential",
    "auth_header",
    "provider_identifier",
    "private_material",
]
REDACTION_CATEGORY_VALUES: Final = (
    "credential",
    "auth_header",
    "provider_identifier",
    "private_material",
)

type Exposure = Literal["public"]
EXPOSURE_VALUES: Final = ("public",)


class ProjectPolicy(TypedDict):
    schema_version: SchemaVersion
    project_id: Uuid
    purpose: PolicyPurpose
    visibility: Visibility
    output_repository: HttpsRepositoryUrl | None
    public_artifact_base_uri: HttpsBaseUri | None
    policy_version: PositiveInteger


class SourceFix(TypedDict):
    upstream: Slug
    commit: GitCommitId


class Family(TypedDict):
    family_id: Slug
    exposure: Exposure
    held_out_eligible: Literal[False]
    source_fixes: list[SourceFix]
    mutation_ids: list[Sha256]


class FamilyRegistry(TypedDict):
    schema_version: SchemaVersion
    families: list[Family]


class HeldOutIdentityList(TypedDict):
    schema_version: SchemaVersion
    family_ids: list[Slug]
    source_fixes: list[SourceFix]
    mutation_ids: list[Sha256]


class RootRun(TypedDict):
    schema_version: SchemaVersion
    project_id: Uuid
    root_execution_id: Uuid
    project_policy_sha256: Sha256
    kind: RootRunKind
    declared_stages: list[StageName]
    child_execution_ids: list[Uuid]
    status: RootRunStatus
    outcome: RootRunOutcome | None


class ArtifactEntry(TypedDict):
    kind: ArtifactKind
    key: RelativePath
    sha256: Sha256
    size_bytes: ByteCount
    media_type: MediaType


class ArtifactManifest(TypedDict):
    schema_version: SchemaVersion
    project_policy_sha256: Sha256
    root_execution_id: Uuid
    execution_id: Uuid
    task_revision: Sha256
    trial_id: TrialId
    entries: list[ArtifactEntry]


class PublishedArtifact(TypedDict):
    path: RelativePath
    sha256: Sha256
    size_bytes: ByteCount
    public_uri: HttpsObjectUri | None


class Omission(TypedDict):
    category: OmissionOutcome
    reason: OmissionReason


class PublicationRecord(TypedDict):
    schema_version: SchemaVersion
    root_execution_id: Uuid
    project_policy_sha256: Sha256
    publication_id: Uuid
    manifest_sha256: Sha256
    execution_id: Uuid
    status: PublicationStatus
    repository_commit: GitCommitId | None
    artifacts: list[PublishedArtifact]
    omissions: list[Omission]
    failure_reason: FailureReason | None


class Redaction(TypedDict):
    category: RedactionCategory
    count: PositiveInteger


class ExecutionLink(TypedDict):
    execution_id: Uuid
    parent_execution_id: Uuid | None


class RunManifestEntry(TypedDict):
    path: RelativePath
    execution_id: Uuid
    trial_id: TrialId | None
    media_type: MediaType | None
    outcome: EntryOutcome
    sha256: Sha256 | None
    size_bytes: ByteCount | None
    public_uri: HttpsObjectUri | None
    reason: OmissionReason | None
    redactions: list[Redaction]


class RunManifest(TypedDict):
    schema_version: SchemaVersion
    project_id: Uuid
    project_policy_sha256: Sha256
    root_execution_id: Uuid
    kind: RootRunKind
    declared_stages: list[StageName]
    outcome: RootRunOutcome
    executions: list[ExecutionLink]
    entries: list[RunManifestEntry]


class PublicRunStatus(TypedDict):
    schema_version: SchemaVersion
    root_execution_id: Uuid
    project_policy_sha256: Sha256
    kind: RootRunKind
    status: RootRunStatus
    outcome: RootRunOutcome | None
    declared_stage_count: PositiveInteger
    child_execution_count: NonNegativeInteger
    publication_status: PublicationStatus | None


class PathOmissionDeclaration(TypedDict):
    outcome: Literal["truncated", "not_produced"]
    path: RelativePath
    execution_id: Uuid
    trial_id: TrialId | None
    reason: OmissionReason


class WithheldDeclaration(TypedDict):
    outcome: Literal["withheld_private"]
    execution_id: Uuid
    trial_id: TrialId | None
    reason: OmissionReason


class RedactionDeclaration(TypedDict):
    path: RelativePath
    category: RedactionCategory
    count: PositiveInteger


class StagingOmissions(TypedDict):
    schema_version: SchemaVersion
    entries: list[PathOmissionDeclaration | WithheldDeclaration]
    redactions: list[RedactionDeclaration]
