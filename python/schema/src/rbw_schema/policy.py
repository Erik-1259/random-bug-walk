"""Project policy construction and succession."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from rbw_schema.canonical import canonical_digest
from rbw_schema.generated import ProjectPolicy
from rbw_schema.rules import policy_succession_errors
from rbw_schema.validate import assert_record

__all__ = ["BuiltPolicy", "build_policy", "policy_succession_errors"]


@dataclass(frozen=True)
class BuiltPolicy:
    policy: ProjectPolicy
    data: bytes
    sha256: str


def build_policy(
    project_id: str,
    output_repository: str | None,
    public_artifact_base_uri: str | None,
    policy_version: int,
) -> BuiltPolicy:
    """Builds a ProjectPolicy from run-time values.

    Both destinations set gives public_demo/public; both null gives evaluation/private; anything
    else is refused. Raises RecordError when invalid.
    """
    public_demo = output_repository is not None or public_artifact_base_uri is not None
    candidate = {
        "schema_version": 1,
        "project_id": project_id,
        "purpose": "public_demo" if public_demo else "evaluation",
        "visibility": "public" if public_demo else "private",
        "output_repository": output_repository,
        "public_artifact_base_uri": public_artifact_base_uri,
        "policy_version": policy_version,
    }
    policy = cast(ProjectPolicy, assert_record("ProjectPolicy", candidate))
    digest = canonical_digest(policy)
    return BuiltPolicy(policy=policy, data=digest.data, sha256=digest.sha256)
