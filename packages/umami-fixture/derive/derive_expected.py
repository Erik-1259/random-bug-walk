# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["tzdata==2026.5"]
# ///
"""Derive the expected daily pageview counts of fixture umami-tz-arg-001 with Python zoneinfo.

For each event and each check's time zone, the script computes the event's local date and time
with zoneinfo, reading zone data only from the pinned tzdata package, and counts events per local
calendar day. It never uses Umami's code, date-fns or Postgres.

Run from the repository root:

    PYTHONTZPATH= uv run --locked --script packages/umami-fixture/derive/derive_expected.py --check
    PYTHONTZPATH= uv run --locked --script packages/umami-fixture/derive/derive_expected.py --write

--write fills checks[].expected and derivation in the data file. --check exits 1 if the file
differs from the derivation and 0 if it matches. --file points either mode at another copy.
Exit code 2 means the file could not be read or is malformed.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import sys
import zoneinfo
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "umami-tz-arg-001.v1.json"
METHOD = "python-zoneinfo"


class FixtureFormatError(Exception):
    """The data file cannot be derived from."""


def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise FixtureFormatError(f"duplicate key {key!r}")
        result[key] = value
    return result


def as_dict(value: object, name: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise FixtureFormatError(f"{name} must be an object")
    # json.loads returns untyped containers; the keys of a JSON object are always strings.
    return {str(key): item for key, item in cast(dict[object, object], value).items()}


def as_list(value: object, name: str) -> list[object]:
    if not isinstance(value, list):
        raise FixtureFormatError(f"{name} must be an array")
    return list(cast(list[object], value))


def as_str(value: object, name: str) -> str:
    if not isinstance(value, str):
        raise FixtureFormatError(f"{name} must be a string")
    return value


def as_int(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise FixtureFormatError(f"{name} must be an integer")
    return value


def render(data: dict[str, object]) -> str:
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def derive(data: dict[str, object]) -> dict[str, object]:
    """Return a copy of the data with checks[].expected and derivation recomputed."""
    labels = [
        as_str(label, "bucket_labels[]")
        for label in as_list(data["bucket_labels"], "bucket_labels")
    ]
    events: list[tuple[str, int]] = []
    for item in as_list(data["events"], "events"):
        event = as_dict(item, "events[]")
        event_id = as_str(event["id"], "events[].id")
        seconds = as_int(event["timestamp_seconds"], "events[].timestamp_seconds")
        instant = datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        if instant != as_str(event["utc_instant"], "events[].utc_instant"):
            raise FixtureFormatError(f"{event_id}: timestamp_seconds does not match utc_instant")
        events.append((event_id, seconds))

    local_times: dict[str, dict[str, str]] = {event_id: {} for event_id, _ in events}
    checks: list[object] = []
    for item in as_list(data["checks"], "checks"):
        check = dict(as_dict(item, "checks[]"))
        zone_name = as_str(check["timezone"], "checks[].timezone")
        zone = zoneinfo.ZoneInfo(zone_name)
        counts = [0] * len(labels)
        for event_id, seconds in events:
            local = datetime.fromtimestamp(seconds, zone)
            local_times[event_id][zone_name] = local.isoformat()
            label = f"{local.date().isoformat()}T00:00:00Z"
            if label not in labels:
                raise FixtureFormatError(
                    f"{event_id} falls outside the bucket labels in {zone_name}"
                )
            counts[labels.index(label)] += 1
        check["expected"] = counts
        checks.append(check)

    derived = dict(data)
    derived["checks"] = checks
    derived["derivation"] = {
        "local_times": [{"id": event_id, "local": local_times[event_id]} for event_id, _ in events],
        "method": METHOD,
        # Major and minor only: the result depends on the tzdata release, not the patch level.
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}",
        "tzdata_version": importlib.metadata.version("tzdata"),
    }
    return derived


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0] if __doc__ else None)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="write the derived values to the file")
    mode.add_argument("--check", action="store_true", help="exit 1 if the file differs")
    parser.add_argument(
        "--file", type=Path, default=DATA_FILE, help="data file (default: %(default)s)"
    )
    args = parser.parse_args(argv)
    path: Path = args.file

    # Zone data comes from the tzdata package only, never from the system's zone files.
    zoneinfo.reset_tzpath(to=())
    try:
        current = path.read_text(encoding="utf-8")
        data = as_dict(json.loads(current, object_pairs_hook=reject_duplicates), "the data file")
        expected = render(derive(data))
    except (OSError, ValueError, KeyError, FixtureFormatError) as error:
        print(f"derive_expected: cannot derive from {path}: {error}", file=sys.stderr)
        return 2

    if args.write:
        path.write_text(expected, encoding="utf-8")
        print(f"derive_expected: wrote {path}")
        return 0
    if current != expected:
        print(f"derive_expected: {path} differs from the derivation", file=sys.stderr)
        return 1
    print(f"derive_expected: {path} matches the derivation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
