import json

import pytest
from conftest import FIXTURES, RecordCase, read_manifest
from rbw_schema.canonical import CanonicalError, encode_canonical, parse_canonical, sha256_hex
from rbw_schema.fixtures import fixture_report, record_errors, record_verdict

MANIFEST = read_manifest()
VALID_CANONICAL = [case["name"] for case in MANIFEST["canonical"] if case["expect"] == "valid"]
INVALID_CANONICAL = [case["name"] for case in MANIFEST["canonical"] if case["expect"] == "invalid"]


def test_fixture_files_are_binary() -> None:
    assert (FIXTURES / ".gitattributes").read_bytes() == b"* -text\n"


@pytest.mark.parametrize("name", VALID_CANONICAL)
def test_reproduces_canonical_case(name: str) -> None:
    output = encode_canonical(
        parse_canonical((FIXTURES / "canonical" / f"{name}.input").read_bytes())
    )
    assert output == (FIXTURES / "canonical" / f"{name}.canonical").read_bytes()
    assert sha256_hex(output) == (FIXTURES / "canonical" / f"{name}.sha256").read_text("ascii")


@pytest.mark.parametrize("name", INVALID_CANONICAL)
def test_rejects_invalid_canonical_input(name: str) -> None:
    with pytest.raises(CanonicalError):
        parse_canonical((FIXTURES / "canonical" / f"{name}.input").read_bytes())


@pytest.mark.parametrize("case", MANIFEST["records"], ids=lambda case: case["name"])
def test_record_fixture_verdict(case: dict[str, str]) -> None:
    verdict = record_verdict(FIXTURES, case["name"])
    assert verdict.verdict == case["expect"], case["rule"]
    if case["expect"] == "valid":
        assert (
            verdict.canonical == (FIXTURES / "records" / f"{case['name']}.canonical").read_bytes()
        )
        assert verdict.sha256 == (FIXTURES / "records" / f"{case['name']}.sha256").read_text(
            "ascii"
        )
    else:
        assert verdict.sha256 is None


INVALID_RECORDS = [case for case in MANIFEST["records"] if case["expect"] == "invalid"]


@pytest.mark.parametrize("case", INVALID_RECORDS, ids=lambda case: case["name"])
def test_invalid_record_fixture_fails_only_its_own_rule(case: RecordCase) -> None:
    # An invalid fixture proves its rule only when nothing else is wrong with it.
    _, errors = record_errors(FIXTURES, case["name"])
    if "error" in case:
        assert errors == [case["error"]]
    else:
        assert errors
        assert [error for error in errors if not error.startswith("schema:")] == []


def test_report_lists_every_fixture_in_manifest_order() -> None:
    expected: list[str] = []
    for case in MANIFEST["canonical"]:
        folder = "canonical"
        digest = (
            (FIXTURES / folder / f"{case['name']}.sha256").read_text("ascii")
            if case["expect"] == "valid"
            else "-"
        )
        expected.append(f"{case['name']} {case['expect']} {digest}")
    for record in MANIFEST["records"]:
        digest = (
            (FIXTURES / "records" / f"{record['name']}.sha256").read_text("ascii")
            if record["expect"] == "valid"
            else "-"
        )
        expected.append(f"{record['name']} {record['expect']} {digest}")
    ids = {
        "OperationIdentity": "operation_id",
        "MutationIdentity": "mutation_id",
        "TaskRevisionIdentity": "task_revision",
    }
    for record in MANIFEST["records"]:
        if record["expect"] != "valid":
            continue
        if record["type"] == "JobRequest":
            request = json.loads((FIXTURES / "records" / f"{record['name']}.json").read_text())
            expected.append(f"{record['name']} operation_id {request['operation_id']}")
            expected.append(f"{record['name']} payload_hash {request['payload_hash']}")
        elif record["type"] in ids:
            digest = (FIXTURES / "records" / f"{record['name']}.sha256").read_text("ascii")
            expected.append(f"{record['name']} {ids[record['type']]} {digest}")
    assert fixture_report(FIXTURES) == expected
