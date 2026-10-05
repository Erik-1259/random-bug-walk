"""Values derived from records, shared by the code rules and the builders.

Nothing here validates; packages/schema/src/derive.ts computes the same values.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, cast

from rbw_schema.canonical import CanonicalDigest, canonical_digest
from rbw_schema.generated import CodeState, JobKind, OperationIdentity


@dataclass(frozen=True)
class ProfileTrial:
    trial_id: str
    code_state: CodeState
    added_repeat_count: int


@dataclass(frozen=True)
class TrialProfile:
    trials: tuple[ProfileTrial, ...]
    # Whether every trial runs the original suite; only observe runs without it.
    original_suite: bool


def _numbered(state: CodeState, count: int, first_repeat: int) -> tuple[ProfileTrial, ...]:
    """`<state>-01` to `<state>-<count>`; the first trial repeats the added suite `first_repeat`
    times, the rest once."""
    return tuple(
        ProfileTrial(f"{state}-{index + 1:02d}", state, first_repeat if index == 0 else 1)
        for index in range(count)
    )


# The trials each job kind runs, in order.
TRIAL_PROFILES: Final[Mapping[JobKind, TrialProfile]] = {
    "kit_check": TrialProfile(_numbered("clean", 5, 20), original_suite=True),
    "observe": TrialProfile(_numbered("planted", 1, 1), original_suite=False),
    "admission": TrialProfile(
        _numbered("clean", 1, 1)
        + _numbered("fixed", 5, 20)
        + _numbered("planted", 5, 20)
        + _numbered("partial", 1, 1)
        + _numbered("stub", 1, 1),
        original_suite=True,
    ),
    "judge_verify": TrialProfile(
        _numbered("clean", 1, 1) + _numbered("planted", 1, 1) + _numbered("fixed", 1, 1),
        original_suite=True,
    ),
}


def job_operation_identity(fields: Mapping[str, object]) -> OperationIdentity:
    """The operation identity of a job request: its own fields, its kind, and a null call
    name."""
    return cast(
        OperationIdentity,
        {
            "schema_version": 1,
            "project_id": fields["project_id"],
            "project_policy_sha256": fields["project_policy_sha256"],
            "root_execution_id": fields["root_execution_id"],
            "batch_id": fields["batch_id"],
            "task_revision": fields["task_revision"],
            "kind": fields["kind"],
            "runtime_profile_sha256": fields["runtime_profile_sha256"],
            "call_name": None,
            "attempt_ordinal": fields["attempt_ordinal"],
        },
    )


def job_payload_digest(fields: Mapping[str, object]) -> CanonicalDigest:
    """Canonical bytes and SHA-256 of a job request without its payload_hash key."""
    return canonical_digest({key: value for key, value in fields.items() if key != "payload_hash"})


def utc_instant_key(value: str) -> str:
    """A key that orders UtcTime values as instants: the seconds part, then the fraction padded
    to nine digits, so 00.3Z and 00.300Z are equal and 00.5Z is after 00Z."""
    return f"{value[:19]}{value[20:-1].ljust(9, '0')}"


def utc_seconds(value: str) -> int:
    """Whole seconds since 1970-01-01T00:00:00Z of a UtcTime without fraction."""
    year, month, day = int(value[0:4]), int(value[5:7]), int(value[8:10])
    hour, minute, second = int(value[11:13]), int(value[14:16]), int(value[17:19])
    # Days from the civil date (proleptic Gregorian), with integer arithmetic only.
    shifted = year - 1 if month <= 2 else year
    era = shifted // 400
    year_of_era = shifted - era * 400
    day_of_year = (153 * (month - 3 if month > 2 else month + 9) + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    days = era * 146097 + day_of_era - 719468
    return days * 86400 + hour * 3600 + minute * 60 + second
