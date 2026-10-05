import hashlib
import json
from typing import Any, NotRequired, TypedDict, cast

import pytest
from conftest import FIXTURES, read_manifest
from rbw_schema.generated import (
    CodeState,
    ExpectedCheck,
    JobKind,
    JobRequest,
    MutationChange,
    MutationIdentity,
    OperationIdentity,
    TaskRevisionIdentity,
)
from rbw_schema.jobs import (
    ExpectedTrialsInput,
    build_expected_trials,
    build_job_request,
    call_name,
    job_operation_identity,
    job_payload_hash,
    mutation_id,
    operation_id,
    provider_call_identity,
    task_revision,
)
from rbw_schema.validate import RecordError, validate_record

RECORDS = FIXTURES / "records"


def record(name: str) -> dict[str, Any]:  # Any: fixture JSON, narrowed by each test with cast.
    return json.loads((RECORDS / f"{name}.json").read_text("utf-8"))


def committed_sha(name: str) -> str:
    return (RECORDS / f"{name}.sha256").read_text("ascii")


def committed_bytes(name: str) -> bytes:
    return (RECORDS / f"{name}.canonical").read_bytes()


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def refusal(errors: pytest.ExceptionInfo[RecordError]) -> list[str]:
    return errors.value.errors


# The check vectors of the first fixture; the fixture package owns them, so they are test inputs.
CHECK_IDS = [
    "tzarg.utc-day-counts",
    "tzarg.la-day-counts",
    "tzarg.auckland-day-counts",
    "tzarg.kolkata-day-counts",
]
UTC, LA, AKL, KOL = CHECK_IDS


def passes(check_id: str) -> ExpectedCheck:
    return {"check_id": check_id, "expected": "pass", "failure_code": None}


def fails(check_id: str, code: str) -> ExpectedCheck:
    return cast(
        ExpectedCheck, {"check_id": check_id, "expected": "assertion_fail", "failure_code": code}
    )


LOCAL = "local_day_counts_mismatch"
LABELS = "bucket_labels_mismatch"
VECTORS: dict[CodeState, list[ExpectedCheck]] = {
    "clean": [passes(check) for check in CHECK_IDS],
    "fixed": [passes(check) for check in CHECK_IDS],
    "planted": [passes(UTC), fails(LA, LOCAL), fails(AKL, LOCAL), fails(KOL, LOCAL)],
    "partial": [passes(UTC), fails(LA, LOCAL), passes(AKL), fails(KOL, LOCAL)],
    "stub": [passes(UTC), fails(LA, LABELS), fails(AKL, LABELS), fails(KOL, LABELS)],
}
PATCHES = {"fixed": "c" * 64, "planted": "d" * 64, "partial": "7" * 64, "stub": "3" * 64}
ORIGINAL_SUITE = "1" * 64
TEST_IDS = [
    "0000000000000000aaaa-00000000000000000001",
    "0000000000000000aaaa-00000000000000000002",
]
ADDED_SUITE = "2" * 64
KINDS: list[tuple[JobKind, str, int]] = [
    ("kit_check", "kit-check", 5),
    ("observe", "observe", 1),
    ("admission", "admission", 13),
    ("judge_verify", "judge-verify", 3),
]


def trials_input(kind: JobKind, fixture: str) -> ExpectedTrialsInput:
    committed = record(f"expected-trials-{fixture}")
    return {
        "kind": kind,
        "execution_id": committed["execution_id"],
        "task_revision": committed["task_revision"],
        "patch_sha256": dict(PATCHES),
        "original_suite_sha256": ORIGINAL_SUITE,
        "original_test_ids": list(TEST_IDS),
        "added_suite_sha256": ADDED_SUITE,
        "checks": dict(VECTORS),
    }


def without_ids(request: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in request.items() if k not in ("operation_id", "payload_hash")}


@pytest.mark.parametrize(("kind", "fixture", "count"), KINDS)
def test_builds_the_committed_manifest(kind: JobKind, fixture: str, count: int) -> None:
    built = build_expected_trials(trials_input(kind, fixture))
    assert len(built.manifest["trials"]) == count
    assert built.data == committed_bytes(f"expected-trials-{fixture}")
    assert built.sha256 == committed_sha(f"expected-trials-{fixture}")
    assert built.sha256 == record(f"job-request-{fixture}")["expected_trials_sha256"]


def test_lists_the_admission_trials_in_order() -> None:
    built = build_expected_trials(trials_input("admission", "admission"))
    assert [
        f"{t['trial_id']}:{t['code_state']}:{t['added_repeat_count']}"
        for t in built.manifest["trials"]
    ] == [
        "clean-01:clean:1",
        "fixed-01:fixed:20",
        "fixed-02:fixed:1",
        "fixed-03:fixed:1",
        "fixed-04:fixed:1",
        "fixed-05:fixed:1",
        "planted-01:planted:20",
        "planted-02:planted:1",
        "planted-03:planted:1",
        "planted-04:planted:1",
        "planted-05:planted:1",
        "partial-01:partial:1",
        "stub-01:stub:1",
    ]


def test_ignores_original_suite_inputs_for_observe() -> None:
    built = build_expected_trials(trials_input("observe", "observe"))
    assert built.manifest["trials"][0]["original_suite_sha256"] is None
    assert built.manifest["trials"][0]["original_test_ids"] == []
    bare = trials_input("observe", "observe")
    bare["original_suite_sha256"] = None
    bare["original_test_ids"] = []
    assert build_expected_trials(bare).sha256 == built.sha256


def test_kit_check_needs_no_patch() -> None:
    given = trials_input("kit_check", "kit-check")
    given["patch_sha256"] = {}
    assert build_expected_trials(given).sha256 == committed_sha("expected-trials-kit-check")


def test_refuses_a_missing_patch_hash() -> None:
    given = trials_input("admission", "admission")
    del given["patch_sha256"]["stub"]
    with pytest.raises(RecordError) as errors:
        build_expected_trials(given)
    assert refusal(errors) == ["build:patch_missing"]
    observe = trials_input("observe", "observe")
    observe["patch_sha256"] = {}
    with pytest.raises(RecordError) as errors:
        build_expected_trials(observe)
    assert refusal(errors) == ["build:patch_missing"]


def test_refuses_a_missing_check_vector() -> None:
    given = trials_input("admission", "admission")
    del given["checks"]["partial"]
    with pytest.raises(RecordError) as errors:
        build_expected_trials(given)
    assert refusal(errors) == ["build:checks_missing"]


def test_refuses_a_kind_that_is_not_a_job_kind() -> None:
    given = trials_input("admission", "admission")
    given["kind"] = cast(JobKind, "factory")
    with pytest.raises(RecordError) as errors:
        build_expected_trials(given)
    assert refusal(errors) == ["build:kind"]


def test_refuses_a_non_observe_manifest_without_original_suite() -> None:
    given = trials_input("admission", "admission")
    given["original_suite_sha256"] = None
    given["original_test_ids"] = []
    with pytest.raises(RecordError) as errors:
        build_expected_trials(given)
    assert refusal(errors) == ["build:original_suite_missing"]


def test_refuses_an_invalid_manifest() -> None:
    given = trials_input("admission", "admission")
    given["added_suite_sha256"] = "Z"
    with pytest.raises(RecordError) as errors:
        build_expected_trials(given)
    assert all(error.startswith("schema:") for error in refusal(errors))


@pytest.mark.parametrize(
    "fixture", ["kit-check", "observe", "observe-root", "admission", "judge-verify"]
)
def test_builds_the_committed_request(fixture: str) -> None:
    committed = record(f"job-request-{fixture}")
    built = build_job_request(without_ids(committed))
    assert built.request == committed
    assert built.data == committed_bytes(f"job-request-{fixture}")
    assert built.sha256 == committed_sha(f"job-request-{fixture}")


@pytest.mark.parametrize("key", ["batch_id", "project_id", "kind", "attempt_ordinal"])
def test_build_job_request_refuses_a_missing_field_with_a_schema_error(key: str) -> None:
    fields = without_ids(record("job-request-admission"))
    del fields[key]
    with pytest.raises(RecordError) as errors:
        build_job_request(fields)
    assert refusal(errors)
    assert all(error.startswith("schema:") for error in refusal(errors))


def test_build_job_request_refuses_broken_fields() -> None:
    fields = without_ids(record("job-request-observe"))
    with pytest.raises(RecordError):
        build_job_request(
            {**fields, "baseline_evidence_key": None, "baseline_evidence_sha256": None}
        )
    with pytest.raises(RecordError) as errors:
        build_job_request({**fields, "parent_execution_id": None})
    assert refusal(errors) == ["job:root_parent"]


JOB_IDENTITY = cast(OperationIdentity, record("operation-identity-job"))
OPERATION_ALTERNATIVES: dict[str, object] = {
    "project_id": "00000000-0000-4000-8000-000000000002",
    "project_policy_sha256": "0" * 64,
    "root_execution_id": "00000000-0000-4000-8000-000000000102",
    "batch_id": "00000000-0000-4000-8000-000000000302",
    "task_revision": "0" * 64,
    "kind": "observe",
    "runtime_profile_sha256": "0" * 64,
    "call_name": "admission:cand-17:1",
    "attempt_ordinal": 2,
}


def test_operation_id_is_the_committed_hash() -> None:
    digest = operation_id(JOB_IDENTITY)
    assert digest.sha256 == committed_sha("operation-identity-job")
    assert digest.data == committed_bytes("operation-identity-job")
    assert operation_id(cast(OperationIdentity, dict(JOB_IDENTITY))).sha256 == digest.sha256
    call = cast(OperationIdentity, record("operation-identity-call"))
    assert operation_id(call).sha256 == committed_sha("operation-identity-call")


@pytest.mark.parametrize(("key", "value"), list(OPERATION_ALTERNATIVES.items()))
def test_operation_id_changes_with_each_field(key: str, value: object) -> None:
    changed = cast(OperationIdentity, {**JOB_IDENTITY, key: value})
    assert operation_id(changed).sha256 != operation_id(JOB_IDENTITY).sha256


def test_operation_id_of_a_job_request() -> None:
    request = cast(JobRequest, record("job-request-admission"))
    identity = job_operation_identity(request)
    assert operation_id(identity).sha256 == committed_sha("operation-identity-job")


def test_runtime_profile_changes_operation_id_not_task_revision() -> None:
    fields = without_ids(record("job-request-admission"))
    first = build_job_request(fields).request
    second = build_job_request({**fields, "runtime_profile_sha256": "0" * 64}).request
    assert second["operation_id"] != first["operation_id"]
    assert second["task_revision"] == first["task_revision"]
    revision = cast(TaskRevisionIdentity, record("task-revision-complete"))
    assert task_revision(revision).sha256 == first["task_revision"]
    with pytest.raises(RecordError):
        task_revision(cast(TaskRevisionIdentity, {**revision, "runtime_profile_sha256": "0" * 64}))


def test_operation_id_refuses_an_invalid_identity() -> None:
    with pytest.raises(RecordError):
        operation_id(cast(OperationIdentity, {**JOB_IDENTITY, "call_name": "Writer.Issue"}))


class CallNameCase(TypedDict):
    name: str
    kind: str
    segments: list[str | int]
    expect: NotRequired[str]
    error: NotRequired[str]


CALL_NAME_CASES: list[CallNameCase] = json.loads((FIXTURES / "call-names.json").read_text("utf-8"))[
    "cases"
]


@pytest.mark.parametrize(
    "case", [c for c in CALL_NAME_CASES if "expect" in c], ids=lambda c: c["name"]
)
def test_call_name_builds(case: CallNameCase) -> None:
    name = call_name(case["kind"], *case["segments"])
    assert name == case.get("expect")
    assert validate_record("CallName", name) == []


@pytest.mark.parametrize(
    "case", [c for c in CALL_NAME_CASES if "error" in c], ids=lambda c: c["name"]
)
def test_call_name_refuses(case: CallNameCase) -> None:
    with pytest.raises(RecordError) as errors:
        call_name(case["kind"], *case["segments"])
    assert refusal(errors) == [case.get("error")]


def test_call_name_is_the_committed_provider_call_name() -> None:
    expected = json.loads((RECORDS / "call-name-valid.json").read_text("utf-8"))
    assert call_name("writer.issue", "cand-17", 3) == expected


@pytest.mark.parametrize("ordinal", [True, 2**53])
def test_call_name_refuses_a_bool_or_unsafe_ordinal(ordinal: int) -> None:
    with pytest.raises(RecordError) as errors:
        call_name("writer.issue", "cand-17", ordinal)
    assert refusal(errors) == ["call_name:segment"]


CALL_IDENTITY = cast(OperationIdentity, record("operation-identity-call"))
CALL_FIELDS: dict[str, object] = {
    key: value for key, value in CALL_IDENTITY.items() if key != "schema_version"
}


def test_provider_call_identity_is_the_committed_identity() -> None:
    fields = {**CALL_FIELDS, "call_name": call_name("writer.issue", "cand-17", 3)}
    assert provider_call_identity(fields) == CALL_IDENTITY
    digest = operation_id(provider_call_identity(fields))
    assert digest.sha256 == committed_sha("operation-identity-call")


def test_provider_call_identity_keeps_only_identity_fields() -> None:
    wider = {
        **CALL_FIELDS,
        "execution_id": "00000000-0000-4000-8000-000000000102",
        "parent_execution_id": None,
    }
    assert provider_call_identity(wider) == CALL_IDENTITY


@pytest.mark.parametrize(
    ("key", "value"), [("call_name", "writer.issue::3"), ("attempt_ordinal", 0)]
)
def test_provider_call_identity_refuses_an_invalid_field(key: str, value: object) -> None:
    with pytest.raises(RecordError):
        provider_call_identity({**CALL_FIELDS, key: value})


JUDGE_REQUEST = record("job-request-judge-verify")


def test_payload_hash_ignores_its_own_field() -> None:
    expected = JUDGE_REQUEST["payload_hash"]
    digest = job_payload_hash(JUDGE_REQUEST)
    assert digest.sha256 == expected
    rest = {k: v for k, v in JUDGE_REQUEST.items() if k != "payload_hash"}
    assert job_payload_hash(rest).sha256 == expected
    assert job_payload_hash({**JUDGE_REQUEST, "payload_hash": "0" * 64}).sha256 == expected
    assert b"payload_hash" not in digest.data
    assert f'"operation_id":"{JUDGE_REQUEST["operation_id"]}"'.encode() in digest.data


@pytest.mark.parametrize("key", [key for key in JUDGE_REQUEST if key != "payload_hash"])
def test_payload_hash_changes_with_each_other_field(key: str) -> None:
    numeric = key in ("attempt_ordinal", "reservation_microusd", "schema_version")
    value: object = 7 if numeric else f"{JUDGE_REQUEST[key]}-x"
    assert job_payload_hash({**JUDGE_REQUEST, key: value}).sha256 != JUDGE_REQUEST["payload_hash"]


MUTATION = cast(MutationIdentity, record("mutation-identity-valid"))
ALLOWED = [change["path"] for change in MUTATION["changes"]]
ADDITION, DELETION, MODIFICATION = MUTATION["changes"]
HOST = MUTATION["host_commit"]


def test_mutation_id_is_the_committed_hash() -> None:
    digest = mutation_id(
        {"host_commit": HOST, "changes": MUTATION["changes"]}, allowed_paths=ALLOWED
    )
    assert digest.sha256 == committed_sha("mutation-identity-valid")
    assert digest.data == committed_bytes("mutation-identity-valid")


@pytest.mark.parametrize(
    "order",
    [
        [ADDITION, DELETION, MODIFICATION],
        [MODIFICATION, DELETION, ADDITION],
        [DELETION, MODIFICATION, ADDITION],
        [MODIFICATION, ADDITION, DELETION],
    ],
)
def test_mutation_id_ignores_change_order(order: list[MutationChange]) -> None:
    digest = mutation_id({"host_commit": HOST, "changes": order}, allowed_paths=ALLOWED)
    assert digest.sha256 == committed_sha("mutation-identity-valid")


def test_mutation_id_sees_whitespace_only_changes() -> None:
    one: MutationChange = {**MODIFICATION, "resulting_sha256": sha256("const a = 1;\n")}
    other: MutationChange = {**MODIFICATION, "resulting_sha256": sha256("const a =  1;\n")}
    first = mutation_id({"host_commit": HOST, "changes": [one]}, allowed_paths=ALLOWED)
    second = mutation_id({"host_commit": HOST, "changes": [other]}, allowed_paths=ALLOWED)
    assert first.sha256 != second.sha256


def test_mutation_id_changes_with_each_field() -> None:
    base = mutation_id({"host_commit": HOST, "changes": [MODIFICATION]}, allowed_paths=ALLOWED)
    variants: list[MutationChange] = [
        {**MODIFICATION, "path": ADDITION["path"]},
        {**MODIFICATION, "original_sha256": "0" * 64},
        {**MODIFICATION, "resulting_sha256": "0" * 64},
        {**MODIFICATION, "original_mode": "100755"},
        {**MODIFICATION, "resulting_mode": "100755"},
    ]
    for change in variants:
        digest = mutation_id({"host_commit": HOST, "changes": [change]}, allowed_paths=ALLOWED)
        assert digest.sha256 != base.sha256
    other_host = mutation_id(
        {"host_commit": "0" * 40, "changes": [MODIFICATION]}, allowed_paths=ALLOWED
    )
    assert other_host.sha256 != base.sha256


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({**ADDITION, "resulting_mode": "120000"}, "mutation:mode"),
        ({**DELETION, "original_mode": "160000"}, "mutation:mode"),
        ({**ADDITION, "path": "src/../etc/passwd"}, "mutation:traversal"),
        ({**ADDITION, "path": "src/./lib/date-buckets.ts"}, "mutation:traversal"),
        ({**ADDITION, "path": "/src/lib/date-buckets.ts"}, "mutation:absolute_path"),
        ({**ADDITION, "path": "src/lib/other.ts"}, "mutation:outside_allowed"),
    ],
    ids=["symlink", "submodule", "dot-dot", "dot", "absolute", "outside-allowed"],
)
def test_mutation_id_refuses_before_hashing(change: dict[str, object], code: str) -> None:
    path = cast(str, change["path"])
    allowed = ALLOWED if code == "mutation:outside_allowed" else [*ALLOWED, path]
    with pytest.raises(RecordError) as errors:
        mutation_id(
            {"host_commit": HOST, "changes": [cast(MutationChange, change)]}, allowed_paths=allowed
        )
    assert refusal(errors) == [code]


def test_mutation_id_refuses_no_op_empty_and_duplicate_changes() -> None:
    unchanged: MutationChange = {
        **MODIFICATION,
        "resulting_sha256": MODIFICATION["original_sha256"],
    }
    with pytest.raises(RecordError) as errors:
        mutation_id({"host_commit": HOST, "changes": [unchanged]}, allowed_paths=ALLOWED)
    assert refusal(errors) == ["mutation:unchanged"]
    with pytest.raises(RecordError):
        mutation_id({"host_commit": HOST, "changes": []}, allowed_paths=ALLOWED)
    with pytest.raises(RecordError) as errors:
        mutation_id({"host_commit": HOST, "changes": [ADDITION, ADDITION]}, allowed_paths=ALLOWED)
    assert refusal(errors) == ["mutation:changes_sorted"]


COMPLETE = cast(TaskRevisionIdentity, record("task-revision-complete"))


@pytest.mark.parametrize("kind", ["kit", "provisional", "complete"])
def test_task_revision_is_the_committed_hash(kind: str) -> None:
    digest = task_revision(cast(TaskRevisionIdentity, record(f"task-revision-{kind}")))
    assert digest.sha256 == committed_sha(f"task-revision-{kind}")
    assert digest.data == committed_bytes(f"task-revision-{kind}")


def test_provisional_and_complete_revisions_differ() -> None:
    provisional = cast(TaskRevisionIdentity, record("task-revision-provisional"))
    assert provisional["mutation_id"] == COMPLETE["mutation_id"]
    assert task_revision(provisional).sha256 != task_revision(COMPLETE).sha256


def _changed_revision_value(key: str, value: object) -> object:
    if isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value):
        return "0" * 64
    return {"host_commit": "0" * 40, "image_digest": "sha256:" + "0" * 64}.get(
        key, "synthetic-other"
    )


@pytest.mark.parametrize(
    "key", [key for key in COMPLETE if key not in ("schema_version", "revision_kind")]
)
def test_task_revision_changes_with_each_field(key: str) -> None:
    value = _changed_revision_value(key, cast(dict[str, object], COMPLETE)[key])
    changed = cast(TaskRevisionIdentity, {**COMPLETE, key: value})
    assert task_revision(changed).sha256 != task_revision(COMPLETE).sha256


MANIFEST = read_manifest()
VALID_REQUESTS = [
    case["name"]
    for case in MANIFEST["records"]
    if case["type"] == "JobRequest" and case["expect"] == "valid"
]


@pytest.mark.parametrize("name", VALID_REQUESTS)
def test_recomputes_request_ids(name: str) -> None:
    request = cast(JobRequest, record(name))
    assert operation_id(job_operation_identity(request)).sha256 == request["operation_id"]
    assert job_payload_hash(request).sha256 == request["payload_hash"]
    assert validate_record("JobRequest", request) == []


def test_revisions_link_requests_and_mutation() -> None:
    assert len(VALID_REQUESTS) >= 5
    assert record("job-request-admission")["task_revision"] == committed_sha(
        "task-revision-complete"
    )
    assert record("job-request-observe")["task_revision"] == committed_sha(
        "task-revision-provisional"
    )
    assert record("job-request-kit-check")["task_revision"] == committed_sha("task-revision-kit")
    assert COMPLETE["mutation_id"] == committed_sha("mutation-identity-valid")
