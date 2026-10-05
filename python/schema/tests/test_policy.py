import pytest
from conftest import FIXTURES
from rbw_schema.policy import build_policy, policy_succession_errors
from rbw_schema.validate import RecordError

PROJECT = "00000000-0000-4000-8000-000000000001"
REPOSITORY = "https://example.invalid/synthetic-owner/synthetic-results"
BASE = "https://example.invalid/synthetic-store/test-prefix/"


def test_reproduces_the_placeholder_policy() -> None:
    built = build_policy(PROJECT, REPOSITORY, BASE, 1)
    assert built.data == (FIXTURES / "records" / "policy-placeholder.canonical").read_bytes()
    assert built.sha256 == (FIXTURES / "records" / "policy-placeholder.sha256").read_text("ascii")
    assert built.policy["purpose"] == "public_demo"


def test_builds_an_evaluation_policy() -> None:
    built = build_policy(PROJECT, None, None, 1)
    assert built.data == (FIXTURES / "records" / "policy-evaluation.canonical").read_bytes()


@pytest.mark.parametrize(
    ("repository", "base", "version"),
    [
        (REPOSITORY, None, 1),
        (REPOSITORY + ".git", BASE, 1),
        (REPOSITORY, "https://synthetic-user:synthetic-pass@example.invalid/x/", 1),
        (REPOSITORY + "\n", BASE, 1),
        (REPOSITORY, "https://example.invalid/synthetic-store", 1),
        (REPOSITORY, BASE, 0),
    ],
)
def test_refuses_invalid_values(repository: str, base: str | None, version: int) -> None:
    with pytest.raises(RecordError):
        build_policy(PROJECT, repository, base, version)


def test_succession_rules() -> None:
    first = build_policy(PROJECT, REPOSITORY, BASE, 1).policy
    assert (
        policy_succession_errors(first, build_policy(PROJECT, REPOSITORY, BASE + "x/", 2).policy)
        == []
    )
    assert policy_succession_errors(first, build_policy(PROJECT, REPOSITORY, BASE + "x/", 1).policy)
    assert policy_succession_errors(first, build_policy(PROJECT, None, None, 2).policy)
    other = build_policy("00000000-0000-4000-8000-000000000002", REPOSITORY, BASE, 2).policy
    assert policy_succession_errors(first, other)
