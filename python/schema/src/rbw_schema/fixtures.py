"""Verdicts for the shared fixtures, compared line by line with the TypeScript report."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NotRequired, TypedDict, cast

from rbw_schema.canonical import CanonicalError, JsonValue, canonical_digest, parse_canonical
from rbw_schema.generated import (
    DEF_NAMES,
    JobRequest,
    MutationIdentity,
    OperationIdentity,
    ProjectPolicy,
    RootRun,
    TaskRevisionIdentity,
)
from rbw_schema.jobs import (
    job_operation_identity,
    job_payload_hash,
    mutation_id,
    operation_id,
    task_revision,
)
from rbw_schema.validate import RecordContext, validate_record


@dataclass(frozen=True)
class Verdict:
    verdict: Literal["valid", "invalid"]
    canonical: bytes | None
    sha256: str | None


class _ManifestEntry(TypedDict):
    name: str
    type: NotRequired[str]
    context: NotRequired[dict[str, str]]
    error: NotRequired[str]


class _FixtureManifest(TypedDict):
    canonical: list[_ManifestEntry]
    records: list[_ManifestEntry]


def _read_manifest(fixtures_dir: Path) -> _FixtureManifest:
    value = parse_canonical((fixtures_dir / "manifest.json").read_bytes())
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("canonical"), list)
        or not isinstance(value.get("records"), list)
    ):
        raise ValueError("fixture manifest is malformed")
    return cast(_FixtureManifest, value)


_INVALID = Verdict(verdict="invalid", canonical=None, sha256=None)


def _valid(value: JsonValue) -> Verdict:
    digest = canonical_digest(value)
    return Verdict(verdict="valid", canonical=digest.data, sha256=digest.sha256)


def _parse_or_none(data: bytes) -> tuple[JsonValue] | None:
    try:
        return (parse_canonical(data),)
    except CanonicalError:
        return None


def canonical_verdict(fixtures_dir: Path, name: str) -> Verdict:
    parsed = _parse_or_none((fixtures_dir / "canonical" / f"{name}.input").read_bytes())
    return _INVALID if parsed is None else _valid(parsed[0])


def _context_value(fixtures_dir: Path, name: str) -> JsonValue:
    return parse_canonical((fixtures_dir / "records" / f"{name}.json").read_bytes())


def record_errors(
    fixtures_dir: Path, name: str, manifest: _FixtureManifest | None = None
) -> tuple[tuple[JsonValue] | None, list[str]]:
    """The error codes for a record fixture: ["canonical"] when strict parsing fails, else the
    validator's codes."""
    entries = (manifest or _read_manifest(fixtures_dir))["records"]
    entry = next((item for item in entries if item["name"] == name), None)
    type_name = entry.get("type") if entry is not None else None
    if entry is None or type_name is None or type_name not in DEF_NAMES:
        raise ValueError(f"unknown record fixture {name}")
    parsed = _parse_or_none((fixtures_dir / "records" / f"{name}.json").read_bytes())
    if parsed is None:
        return None, ["canonical"]
    context: RecordContext = {}
    names = entry.get("context", {})
    if "policy" in names:
        context["policy"] = cast(ProjectPolicy, _context_value(fixtures_dir, names["policy"]))
    if "root" in names:
        context["root"] = cast(RootRun, _context_value(fixtures_dir, names["root"]))
    if "previous" in names:
        context["previous"] = cast(ProjectPolicy, _context_value(fixtures_dir, names["previous"]))
    if "request" in names:
        context["request"] = cast(JobRequest, _context_value(fixtures_dir, names["request"]))
    return parsed, validate_record(type_name, parsed[0], context)


def record_verdict(
    fixtures_dir: Path, name: str, manifest: _FixtureManifest | None = None
) -> Verdict:
    parsed, errors = record_errors(fixtures_dir, name, manifest)
    return _INVALID if parsed is None or errors else _valid(parsed[0])


def _computed_ids(type_name: str | None, value: JsonValue) -> list[tuple[str, str]]:
    """The IDs computed from a valid identity-bearing fixture, as (name, value) pairs."""
    match type_name:
        case "JobRequest":
            request = cast(JobRequest, value)
            return [
                ("operation_id", operation_id(job_operation_identity(request)).sha256),
                ("payload_hash", job_payload_hash(request).sha256),
            ]
        case "OperationIdentity":
            return [("operation_id", operation_id(cast(OperationIdentity, value)).sha256)]
        case "MutationIdentity":
            identity = cast(MutationIdentity, value)
            paths = [change["path"] for change in identity["changes"]]
            return [("mutation_id", mutation_id(identity, allowed_paths=paths).sha256)]
        case "TaskRevisionIdentity":
            return [("task_revision", task_revision(cast(TaskRevisionIdentity, value)).sha256)]
        case _:
            return []


def fixture_report(fixtures_dir: Path) -> list[str]:
    """One line per fixture, `<name> <verdict> <sha256 or ->`, canonical cases first, in manifest
    order; then `<name> <id> <value>` for each ID computed from a valid job request or identity
    record."""
    manifest = _read_manifest(fixtures_dir)

    def line(name: str, verdict: Verdict) -> str:
        return f"{name} {verdict.verdict} {verdict.sha256 or '-'}"

    records: list[str] = []
    ids: list[str] = []
    for entry in manifest["records"]:
        verdict = record_verdict(fixtures_dir, entry["name"], manifest)
        if verdict.verdict == "valid":
            value = _context_value(fixtures_dir, entry["name"])
            for id_name, id_value in _computed_ids(entry.get("type"), value):
                ids.append(f"{entry['name']} {id_name} {id_value}")
        records.append(line(entry["name"], verdict))
    return [
        *(
            line(e["name"], canonical_verdict(fixtures_dir, e["name"]))
            for e in manifest["canonical"]
        ),
        *records,
        *ids,
    ]
