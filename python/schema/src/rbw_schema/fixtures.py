"""Verdicts for the shared fixtures, compared line by line with the TypeScript report."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NotRequired, TypedDict, cast

from rbw_schema.canonical import CanonicalError, JsonValue, canonical_digest, parse_canonical
from rbw_schema.generated import DEF_NAMES, ProjectPolicy, RootRun
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
    return parsed, validate_record(type_name, parsed[0], context)


def record_verdict(
    fixtures_dir: Path, name: str, manifest: _FixtureManifest | None = None
) -> Verdict:
    parsed, errors = record_errors(fixtures_dir, name, manifest)
    return _INVALID if parsed is None or errors else _valid(parsed[0])


def fixture_report(fixtures_dir: Path) -> list[str]:
    """One line per fixture, `<name> <verdict> <sha256 or ->`, canonical cases first, in manifest
    order."""
    manifest = _read_manifest(fixtures_dir)

    def line(name: str, verdict: Verdict) -> str:
        return f"{name} {verdict.verdict} {verdict.sha256 or '-'}"

    return [
        *(
            line(e["name"], canonical_verdict(fixtures_dir, e["name"]))
            for e in manifest["canonical"]
        ),
        *(
            line(e["name"], record_verdict(fixtures_dir, e["name"], manifest))
            for e in manifest["records"]
        ),
    ]
