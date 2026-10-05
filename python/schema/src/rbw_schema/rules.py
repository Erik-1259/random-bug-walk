"""Rules JSON Schema cannot express.

packages/schema/src/rules.ts implements the same rules, and the shared invalid fixtures cover
each one.
"""

from __future__ import annotations

from collections.abc import Sequence
from itertools import pairwise
from typing import TypedDict, cast

from rbw_schema.canonical import JsonValue, canonical_digest
from rbw_schema.derive import (
    TRIAL_PROFILES,
    job_operation_identity,
    job_payload_digest,
    utc_instant_key,
    utc_seconds,
)
from rbw_schema.generated import (
    ArtifactManifest,
    CheckObservation,
    ExpectedTrials,
    FamilyRegistry,
    JobRequest,
    MutationIdentity,
    ObservedSymptom,
    ProjectPolicy,
    PublicationRecord,
    RootRun,
    RunManifest,
    StagingOmissions,
    TrialObservations,
    TrialResult,
)


class RecordContext(TypedDict, total=False):
    """Records a value may be checked against: its policy, its root, the policy it succeeds, or
    its job request."""

    policy: ProjectPolicy
    root: RootRun
    previous: ProjectPolicy
    request: JobRequest


def _strictly_sorted(values: Sequence[str]) -> bool:
    return all(earlier < later for earlier, later in pairwise(values))


def _has_duplicates(values: Sequence[str]) -> bool:
    return len(set(values)) != len(values)


def _registry_rules(registry: FamilyRegistry) -> list[str]:
    errors: list[str] = []
    families = registry["families"]
    if _has_duplicates([family["family_id"] for family in families]):
        errors.append("registry:duplicate_family")
    # The commit ID alone is the source-fix identity, so one commit sits in at most one family.
    fixes = [fix["commit"] for f in families for fix in f["source_fixes"]]
    if _has_duplicates(fixes):
        errors.append("registry:duplicate_source_fix")
    if _has_duplicates([mutation for f in families for mutation in f["mutation_ids"]]):
        errors.append("registry:duplicate_mutation")
    return errors


def _public_uri_ok(public_uri: str, sha256: str | None, policy: ProjectPolicy | None) -> bool:
    key = f"sha256/{sha256 or ''}"
    if policy is None:
        return public_uri.endswith(f"/{key}")
    return public_uri == f"{policy['public_artifact_base_uri'] or ''}{key}"


def _run_manifest_rules(manifest: RunManifest, policy: ProjectPolicy | None) -> list[str]:
    errors: list[str] = []
    root = manifest["root_execution_id"]
    executions = manifest["executions"]
    first = executions[0] if executions else None
    if first is None or first["execution_id"] != root or first["parent_execution_id"] is not None:
        errors.append("manifest:root_first")
    if any(child["parent_execution_id"] != root for child in executions[1:]):
        errors.append("manifest:child_parent")
    ids = [execution["execution_id"] for execution in executions]
    if _has_duplicates(ids):
        errors.append("manifest:duplicate_execution")
    if not _strictly_sorted([entry["path"] for entry in manifest["entries"]]):
        errors.append("manifest:entries_sorted")
    for entry in manifest["entries"]:
        if entry["execution_id"] not in ids:
            errors.append("manifest:unknown_execution")
        if not _strictly_sorted([redaction["category"] for redaction in entry["redactions"]]):
            errors.append("manifest:redactions_sorted")
        public_uri = entry["public_uri"]
        if public_uri is not None and not _public_uri_ok(public_uri, entry["sha256"], policy):
            errors.append("manifest:public_uri")
    # Withheld entries are numbered withheld/1 to withheld/<k> without gaps.
    withheld = [e["path"] for e in manifest["entries"] if e["outcome"] == "withheld_private"]
    if sorted(withheld) != sorted(f"withheld/{n}" for n in range(1, len(withheld) + 1)):
        errors.append("manifest:withheld_numbering")
    return errors


def _omissions_rules(omissions: StagingOmissions) -> list[str]:
    errors: list[str] = []
    paths = [entry["path"] for entry in omissions["entries"] if "path" in entry]
    if _has_duplicates(paths):
        errors.append("omissions:duplicate_path")
    redactions = [f"{item['path']}\n{item['category']}" for item in omissions["redactions"]]
    if _has_duplicates(redactions):
        errors.append("omissions:duplicate_redaction")
    return errors


def _job_request_rules(request: JobRequest) -> list[str]:
    errors: list[str] = []
    is_root = request["execution_id"] == request["root_execution_id"]
    if (request["parent_execution_id"] is None) != is_root:
        errors.append("job:root_parent")
    if request["parent_execution_id"] == request["execution_id"]:
        errors.append("job:own_parent")
    if canonical_digest(job_operation_identity(request)).sha256 != request["operation_id"]:
        errors.append("job:operation_id")
    if job_payload_digest(request).sha256 != request["payload_hash"]:
        errors.append("job:payload_hash")
    return errors


def _expected_trials_rules(manifest: ExpectedTrials, request: JobRequest | None) -> list[str]:
    errors: list[str] = []
    trials = manifest["trials"]
    if _has_duplicates([trial["trial_id"] for trial in trials]):
        errors.append("trials:duplicate_trial")
    if any(
        _has_duplicates([check["check_id"] for check in trial["expected_checks"]])
        for trial in trials
    ):
        errors.append("trials:duplicate_check")
    if request is None:
        return errors
    if canonical_digest(manifest).sha256 != request["expected_trials_sha256"]:
        errors.append("request:expected_trials_sha256")
    profile = TRIAL_PROFILES[request["kind"]]
    if profile.original_suite:
        if any(trial["original_suite_sha256"] is None for trial in trials):
            errors.append("trials:original_suite_missing")
    elif any(trial["original_suite_sha256"] is not None for trial in trials):
        errors.append("trials:original_suite_present")
    expected = [(t.trial_id, t.code_state) for t in profile.trials]
    if [(trial["trial_id"], trial["code_state"]) for trial in trials] != expected:
        errors.append("trials:trial_list")
    elif [trial["added_repeat_count"] for trial in trials] != [
        t.added_repeat_count for t in profile.trials
    ]:
        errors.append("trials:repeat_count")
    return errors


def _observations_in_order(observations: list[CheckObservation]) -> bool:
    keys = [(item["repeat_index"], item["check_id"]) for item in observations]
    return all(earlier < later for earlier, later in pairwise(keys))


def _mutation_rules(identity: MutationIdentity) -> list[str]:
    errors: list[str] = []
    changes = identity["changes"]
    if not _strictly_sorted([change["path"] for change in changes]):
        errors.append("mutation:changes_sorted")
    if any(
        change["original_sha256"] == change["resulting_sha256"]
        and change["original_mode"] == change["resulting_mode"]
        for change in changes
    ):
        errors.append("mutation:unchanged")
    return errors


def policy_succession_errors(previous: ProjectPolicy, following: ProjectPolicy) -> list[str]:
    """Succession of frozen policies: same project, a higher version, and public exposure never
    reversed."""
    errors: list[str] = []
    if following["project_id"] != previous["project_id"]:
        errors.append("policy:other_project")
    if canonical_digest(following).sha256 == canonical_digest(previous).sha256:
        return errors
    if following["policy_version"] <= previous["policy_version"]:
        errors.append("policy:version_not_increased")
    if previous["visibility"] == "public" and following["visibility"] != "public":
        errors.append("policy:exposure_reversed")
    return errors


def _context_rules(value: dict[str, JsonValue], context: RecordContext) -> list[str]:
    errors: list[str] = []
    policy = context.get("policy")
    if policy is not None:
        if "project_id" in value and value["project_id"] != policy["project_id"]:
            errors.append("inherit:project_id")
        if value.get("project_policy_sha256") != canonical_digest(policy).sha256:
            errors.append("inherit:project_policy_sha256")
    root = context.get("root")
    if root is not None:
        for key in ("project_id", "project_policy_sha256", "root_execution_id"):
            if key in value and value[key] != root[key]:
                errors.append(f"inherit:{key}")
    previous = context.get("previous")
    if previous is not None:
        errors.extend(policy_succession_errors(previous, cast(ProjectPolicy, value)))
    request = context.get("request")
    if request is not None:
        for key in (
            "project_policy_sha256",
            "root_execution_id",
            "execution_id",
            "task_revision",
            "expected_trials_sha256",
        ):
            if key in value and value[key] != request[key]:
                errors.append(f"request:{key}")
    return errors


def check_rules(type_name: str, value: JsonValue, context: RecordContext) -> list[str]:
    """Applies the code rules to a value that already passed the schema."""
    errors: list[str] = []
    match type_name:
        case "FamilyRegistry":
            errors.extend(_registry_rules(cast(FamilyRegistry, value)))
        case "RootRun":
            root = cast(RootRun, value)
            if root["root_execution_id"] in root["child_execution_ids"]:
                errors.append("root:child_is_root")
        case "ArtifactManifest":
            keys = [entry["key"] for entry in cast(ArtifactManifest, value)["entries"]]
            if _has_duplicates(keys):
                errors.append("artifacts:duplicate_key")
        case "PublicationRecord":
            record = cast(PublicationRecord, value)
            if record["execution_id"] != record["root_execution_id"]:
                errors.append("publication:execution_not_root")
            paths = [artifact["path"] for artifact in record["artifacts"]]
            if not _strictly_sorted(paths):
                errors.append("publication:artifacts_sorted")
        case "RunManifest":
            errors.extend(_run_manifest_rules(cast(RunManifest, value), context.get("policy")))
        case "StagingOmissions":
            errors.extend(_omissions_rules(cast(StagingOmissions, value)))
        case "JobRequest":
            errors.extend(_job_request_rules(cast(JobRequest, value)))
        case "ExpectedTrials":
            manifest = cast(ExpectedTrials, value)
            errors.extend(_expected_trials_rules(manifest, context.get("request")))
        case "TrialObservations":
            if not _observations_in_order(cast(TrialObservations, value)["observations"]):
                errors.append("observations:order")
        case "TrialResult":
            result = cast(TrialResult, value)
            if utc_instant_key(result["ended_at"]) < utc_instant_key(result["started_at"]):
                errors.append("result:ended_before_started")
        case "ObservedSymptom":
            events = cast(ObservedSymptom, value)["events"]
            if any(utc_seconds(e["utc_instant"]) != e["timestamp_seconds"] for e in events):
                errors.append("symptom:event_instant")
        case "MutationIdentity":
            errors.extend(_mutation_rules(cast(MutationIdentity, value)))
        case _:
            pass
    if isinstance(value, dict):
        errors.extend(_context_rules(value, context))
    return errors
