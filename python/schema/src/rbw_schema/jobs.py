"""Job request and expected-trial builders, and the operation, payload, mutation and task
revision identities."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import TypedDict, cast

from rbw_schema.canonical import CanonicalDigest, canonical_digest
from rbw_schema.derive import (
    TRIAL_PROFILES,
    ProfileTrial,
    TrialProfile,
    job_operation_identity,
    job_payload_digest,
)
from rbw_schema.generated import (
    FILE_MODE_VALUES,
    JOB_KIND_VALUES,
    CodeState,
    ExpectedCheck,
    ExpectedTrial,
    ExpectedTrials,
    JobKind,
    JobRequest,
    MutationChange,
    MutationIdentity,
    OperationIdentity,
    TaskRevisionIdentity,
)
from rbw_schema.validate import RecordError, assert_record, validate_record

__all__ = [
    "TRIAL_PROFILES",
    "BuiltExpectedTrials",
    "BuiltJobRequest",
    "ExpectedTrialsInput",
    "MutationInput",
    "ProfileTrial",
    "TrialProfile",
    "build_expected_trials",
    "build_job_request",
    "call_name",
    "job_operation_identity",
    "job_payload_hash",
    "mutation_id",
    "operation_id",
    "provider_call_identity",
    "task_revision",
]


@dataclass(frozen=True)
class BuiltJobRequest:
    request: JobRequest
    data: bytes
    sha256: str


class ExpectedTrialsInput(TypedDict):
    kind: JobKind
    execution_id: str
    task_revision: str
    # A patch hash for each non-clean code state the kind uses; others are ignored.
    patch_sha256: dict[str, str]
    # Ignored for observe, whose trials run no original suite.
    original_suite_sha256: str | None
    original_test_ids: list[str]
    added_suite_sha256: str
    # An expected-check vector for each code state the kind uses; others are ignored.
    checks: dict[CodeState, list[ExpectedCheck]]


@dataclass(frozen=True)
class BuiltExpectedTrials:
    manifest: ExpectedTrials
    data: bytes
    sha256: str


class MutationInput(TypedDict):
    host_commit: str
    changes: list[MutationChange]


_PLACEHOLDER_SHA256 = "0" * 64
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_PROVIDER_CALL_FIELDS = (
    "project_id",
    "project_policy_sha256",
    "root_execution_id",
    "batch_id",
    "task_revision",
    "kind",
    "runtime_profile_sha256",
    "call_name",
    "attempt_ordinal",
)


def operation_id(identity: OperationIdentity) -> CanonicalDigest:
    """operation_id: the SHA-256 of the identity record's canonical bytes. Raises RecordError
    when invalid."""
    return canonical_digest(assert_record("OperationIdentity", identity))


def _is_call_name_segment(segment: str | int) -> bool:
    if isinstance(segment, bool):
        return False
    if isinstance(segment, int):
        return 0 <= segment <= _MAX_SAFE_INTEGER
    return ":" not in segment and not validate_record("CallName", segment)


def call_name(kind: str, *segments: str | int) -> str:
    """A provider call's call name: the operation kind and the segments joined with ":", such
    as writer.issue:cand-17:3. Raises RecordError with call_name:kind when the kind is not an
    OperationKind, and call_name:segment for a segment that is not one CallName segment or an
    integer that is not a safe non-negative integer (a bool is never one)."""
    if validate_record("OperationKind", kind):
        raise RecordError("CallName", ["call_name:kind"])
    if not all(_is_call_name_segment(segment) for segment in segments):
        raise RecordError("CallName", ["call_name:segment"])
    return cast(str, assert_record("CallName", ":".join([kind, *map(str, segments)])))


def provider_call_identity(fields: Mapping[str, object]) -> OperationIdentity:
    """The OperationIdentity of a provider call, validated; other fields of a wider run context
    are ignored. Raises RecordError when invalid."""
    identity = {"schema_version": 1, **{key: fields[key] for key in _PROVIDER_CALL_FIELDS}}
    return cast(OperationIdentity, assert_record("OperationIdentity", identity))


def job_payload_hash(fields: Mapping[str, object]) -> CanonicalDigest:
    """payload_hash of a job request: the request without its payload_hash key, operation_id
    included."""
    return job_payload_digest(fields)


def build_job_request(fields: Mapping[str, object]) -> BuiltJobRequest:
    """Takes every JobRequest field except operation_id and payload_hash, computes both,
    validates the request, and returns it with its canonical bytes and SHA-256."""
    # Check the shape first, with placeholder IDs, so a missing or malformed field is refused with
    # its schema error before anything is hashed; only the two ID rules may fail at this point.
    placeholders = {"operation_id": _PLACEHOLDER_SHA256, "payload_hash": _PLACEHOLDER_SHA256}
    shape = validate_record("JobRequest", {**fields, **placeholders})
    shape_errors = [e for e in shape if e not in ("job:operation_id", "job:payload_hash")]
    if shape_errors:
        raise RecordError("JobRequest", shape_errors)
    operation = canonical_digest(job_operation_identity(fields)).sha256
    with_operation = {**fields, "operation_id": operation}
    candidate = {**with_operation, "payload_hash": job_payload_digest(with_operation).sha256}
    request = cast(JobRequest, assert_record("JobRequest", candidate))
    digest = canonical_digest(request)
    return BuiltJobRequest(request=request, data=digest.data, sha256=digest.sha256)


def _trial(given: ExpectedTrialsInput, profile: TrialProfile, trial: ProfileTrial) -> ExpectedTrial:
    patch = None if trial.code_state == "clean" else given["patch_sha256"].get(trial.code_state)
    if trial.code_state != "clean" and patch is None:
        raise RecordError("ExpectedTrials", ["build:patch_missing"])
    checks = given["checks"].get(trial.code_state)
    if checks is None:
        raise RecordError("ExpectedTrials", ["build:checks_missing"])
    return {
        "trial_id": trial.trial_id,
        "code_state": trial.code_state,
        "patch_sha256": patch,
        "original_suite_sha256": given["original_suite_sha256"] if profile.original_suite else None,
        "original_test_ids": list(given["original_test_ids"]) if profile.original_suite else [],
        "added_suite_sha256": given["added_suite_sha256"],
        "added_repeat_count": trial.added_repeat_count,
        "expected_checks": [cast(ExpectedCheck, dict(check)) for check in checks],
    }


def build_expected_trials(given: ExpectedTrialsInput) -> BuiltExpectedTrials:
    """Builds the expected-trial manifest of a job kind from the kind's trial profile and the
    given hashes and check vectors.

    Raises RecordError with a build: code for a kind that is not a job kind, a missing patch hash
    or check vector, or a missing original suite outside observe.
    """
    if given["kind"] not in JOB_KIND_VALUES:
        raise RecordError("ExpectedTrials", ["build:kind"])
    profile = TRIAL_PROFILES[given["kind"]]
    if profile.original_suite and given["original_suite_sha256"] is None:
        raise RecordError("ExpectedTrials", ["build:original_suite_missing"])
    candidate = {
        "schema_version": 1,
        "execution_id": given["execution_id"],
        "task_revision": given["task_revision"],
        "trials": [_trial(given, profile, trial) for trial in profile.trials],
    }
    manifest = cast(ExpectedTrials, assert_record("ExpectedTrials", candidate))
    digest = canonical_digest(manifest)
    return BuiltExpectedTrials(manifest=manifest, data=digest.data, sha256=digest.sha256)


def _change_refusal(change: MutationChange, allowed: frozenset[str]) -> str | None:
    for mode in (change["original_mode"], change["resulting_mode"]):
        if mode is not None and mode not in FILE_MODE_VALUES:
            return "mutation:mode"
    path = change["path"]
    if path.startswith("/"):
        return "mutation:absolute_path"
    if any(segment in ("..", ".") for segment in path.split("/")):
        return "mutation:traversal"
    if path not in allowed:
        return "mutation:outside_allowed"
    return None


def mutation_id(given: MutationInput, *, allowed_paths: Iterable[str]) -> CanonicalDigest:
    """mutation_id: sorts the changes by path and hashes the identity record.

    A mode outside FileMode (such as a symlink), an absolute path, a . or .. segment, or a path
    outside allowed_paths is refused before anything is hashed. Raises RecordError.
    """
    allowed = frozenset(allowed_paths)
    for change in given["changes"]:
        code = _change_refusal(change, allowed)
        if code is not None:
            raise RecordError("MutationIdentity", [code])
    identity: MutationIdentity = {
        "schema_version": 1,
        "host_commit": given["host_commit"],
        "changes": sorted(given["changes"], key=lambda change: change["path"]),
    }
    return canonical_digest(assert_record("MutationIdentity", identity))


def task_revision(identity: TaskRevisionIdentity) -> CanonicalDigest:
    """task_revision: the SHA-256 of the identity record's canonical bytes. Raises RecordError
    when invalid."""
    return canonical_digest(assert_record("TaskRevisionIdentity", identity))
