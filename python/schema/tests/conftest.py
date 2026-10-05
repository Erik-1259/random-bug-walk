import json
from pathlib import Path
from typing import NotRequired, TypedDict

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "schema" / "fixtures"
REGISTRY = (
    Path(__file__).resolve().parents[3] / "packages" / "schema" / "registry" / "families.json"
)


class CanonicalCase(TypedDict):
    name: str
    expect: str


class RecordCase(TypedDict):
    name: str
    type: str
    expect: str
    rule: str
    error: NotRequired[str]


class Manifest(TypedDict):
    canonical: list[CanonicalCase]
    records: list[RecordCase]


def read_manifest() -> Manifest:
    manifest: Manifest = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
    return manifest
