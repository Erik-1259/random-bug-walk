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
    "JobKind",
    "CodeState",
    "ExpectedOutcome",
    "ObservedOutcome",
    "TrialStatus",
    "TrialReason",
    "AssertionFailureCode",
    "CheckId",
    "TestId",
    "OperationKind",
    "CallName",
    "FileMode",
    "TaskRevisionKind",
    "TimeZoneName",
    "LocaleTag",
    "EndpointPath",
    "JobRequest",
    "ExpectedCheck",
    "ExpectedTrial",
    "ExpectedTrials",
    "CheckObservation",
    "TrialObservations",
    "TrialResult",
    "QueryParameters",
    "SymptomRequest",
    "SymptomEvent",
    "BucketCount",
    "FollowUpExample",
    "DocExcerpt",
    "ObservedSymptom",
    "OperationIdentity",
    "MutationChange",
    "MutationIdentity",
    "TaskRevisionIdentity",
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


type JobKind = Literal[
    "kit_check",
    "observe",
    "admission",
    "judge_verify",
]
JOB_KIND_VALUES: Final = (
    "kit_check",
    "observe",
    "admission",
    "judge_verify",
)

type CodeState = Literal[
    "clean",
    "planted",
    "fixed",
    "partial",
    "stub",
]
CODE_STATE_VALUES: Final = (
    "clean",
    "planted",
    "fixed",
    "partial",
    "stub",
)

type ExpectedOutcome = Literal[
    "pass",
    "assertion_fail",
]
EXPECTED_OUTCOME_VALUES: Final = (
    "pass",
    "assertion_fail",
)

type ObservedOutcome = Literal[
    "pass",
    "assertion_fail",
    "setup_fail",
    "skipped",
    "not_run",
]
OBSERVED_OUTCOME_VALUES: Final = (
    "pass",
    "assertion_fail",
    "setup_fail",
    "skipped",
    "not_run",
)

type TrialStatus = Literal[
    "complete",
    "invalid",
    "incomplete",
]
TRIAL_STATUS_VALUES: Final = (
    "complete",
    "invalid",
    "incomplete",
)

type TrialReason = Literal[
    "scope_violation",
    "build_failed",
    "startup_failed",
    "auth_failed",
    "seed_failed",
    "timeout",
    "artifact_missing",
    "artifact_hash_mismatch",
    "test_missing",
    "test_skipped",
    "unrelated_failure",
    "provider_uncertain",
    "limit_exceeded",
]
TRIAL_REASON_VALUES: Final = (
    "scope_violation",
    "build_failed",
    "startup_failed",
    "auth_failed",
    "seed_failed",
    "timeout",
    "artifact_missing",
    "artifact_hash_mismatch",
    "test_missing",
    "test_skipped",
    "unrelated_failure",
    "provider_uncertain",
    "limit_exceeded",
)

type AssertionFailureCode = Literal[
    "local_day_counts_mismatch",
    "bucket_labels_mismatch",
]
ASSERTION_FAILURE_CODE_VALUES: Final = (
    "local_day_counts_mismatch",
    "bucket_labels_mismatch",
)

type CheckId = str

type TestId = str

type OperationKind = str

type CallName = str

type FileMode = Literal[
    "100644",
    "100755",
]
FILE_MODE_VALUES: Final = (
    "100644",
    "100755",
)

type TaskRevisionKind = Literal[
    "kit",
    "provisional",
    "complete",
]
TASK_REVISION_KIND_VALUES: Final = (
    "kit",
    "provisional",
    "complete",
)

type TimeZoneName = str

type LocaleTag = str

type EndpointPath = str


class JobRequest(TypedDict):
    schema_version: SchemaVersion
    project_id: Uuid
    project_policy_sha256: Sha256
    batch_id: Uuid
    execution_id: Uuid
    root_execution_id: Uuid
    parent_execution_id: Uuid | None
    operation_id: Sha256
    attempt_ordinal: PositiveInteger
    payload_hash: Sha256
    kind: JobKind
    task_revision: Sha256
    policy_id: Slug
    runtime_profile_sha256: Sha256
    image_digest: ImageDigest
    expected_trials_key: RelativePath
    expected_trials_sha256: Sha256
    baseline_evidence_key: RelativePath | None
    baseline_evidence_sha256: Sha256 | None
    deadline_at: UtcTime
    reservation_microusd: MicroUsd
    release_id: Uuid | None


class ExpectedCheck(TypedDict):
    check_id: CheckId
    expected: ExpectedOutcome
    failure_code: AssertionFailureCode | None


class ExpectedTrial(TypedDict):
    trial_id: TrialId
    code_state: CodeState
    patch_sha256: Sha256 | None
    original_suite_sha256: Sha256 | None
    original_test_ids: list[TestId]
    added_suite_sha256: Sha256
    added_repeat_count: PositiveInteger
    expected_checks: list[ExpectedCheck]


class ExpectedTrials(TypedDict):
    schema_version: SchemaVersion
    execution_id: Uuid
    task_revision: Sha256
    trials: list[ExpectedTrial]


class CheckObservation(TypedDict):
    check_id: CheckId
    repeat_index: PositiveInteger
    observed: ObservedOutcome
    failure_code: AssertionFailureCode | TrialReason | None
    duration_ms: DurationMs
    response_artifact_key: RelativePath | None
    response_artifact_sha256: Sha256 | None


class TrialObservations(TypedDict):
    schema_version: SchemaVersion
    execution_id: Uuid
    trial_id: TrialId
    observations: list[CheckObservation]


class TrialResult(TypedDict):
    schema_version: SchemaVersion
    project_policy_sha256: Sha256
    root_execution_id: Uuid
    execution_id: Uuid
    task_revision: Sha256
    trial_id: TrialId
    code_state: CodeState
    status: TrialStatus
    expected_trials_sha256: Sha256
    observations_key: RelativePath | None
    observations_sha256: Sha256 | None
    artifacts_key: RelativePath | None
    artifacts_sha256: Sha256 | None
    invalid_reason: TrialReason | None
    started_at: UtcTime
    ended_at: UtcTime


type QueryParameters = dict[str, str]


class SymptomRequest(TypedDict):
    method: Literal["GET", "POST"]
    path: EndpointPath
    query: QueryParameters


class SymptomEvent(TypedDict):
    label: str
    timestamp_seconds: NonNegativeInteger
    utc_instant: UtcTime


class BucketCount(TypedDict):
    bucket_label: str
    count: NonNegativeInteger


class FollowUpExample(TypedDict):
    timezone: TimeZoneName
    expected: list[BucketCount]
    observed: list[BucketCount]


class DocExcerpt(TypedDict):
    text: str
    source_url: HttpsObjectUri


class ObservedSymptom(TypedDict):
    schema_version: SchemaVersion
    user_action: str
    request: SymptomRequest
    timezone: TimeZoneName
    locale: LocaleTag | None
    fixture_description: str
    events: list[SymptomEvent]
    http_status: int
    expected: list[BucketCount]
    observed: list[BucketCount]
    follow_up_examples: list[FollowUpExample]
    doc_excerpts: list[DocExcerpt]


class OperationIdentity(TypedDict):
    schema_version: SchemaVersion
    project_id: Uuid
    project_policy_sha256: Sha256
    root_execution_id: Uuid
    batch_id: Uuid
    task_revision: Sha256
    kind: OperationKind
    runtime_profile_sha256: Sha256
    call_name: CallName | None
    attempt_ordinal: PositiveInteger


class MutationChange(TypedDict):
    path: RelativePath
    original_sha256: Sha256 | None
    resulting_sha256: Sha256 | None
    original_mode: FileMode | None
    resulting_mode: FileMode | None


class MutationIdentity(TypedDict):
    schema_version: SchemaVersion
    host_commit: GitCommitId
    changes: list[MutationChange]


class TaskRevisionIdentity(TypedDict):
    schema_version: SchemaVersion
    revision_kind: TaskRevisionKind
    host_commit: GitCommitId
    image_digest: ImageDigest
    kit_sha256: Sha256
    fixture_sha256: Sha256
    original_suite_sha256: Sha256
    added_suite_sha256: Sha256
    grading_policy_id: Slug
    environment_sha256: Sha256
    mutation_id: Sha256 | None
    issue_sha256: Sha256 | None
    issue_style: Slug | None
