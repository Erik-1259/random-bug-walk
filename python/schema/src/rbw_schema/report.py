"""Prints the fixture report: `python -m rbw_schema.report [fixtures_dir]`."""

from __future__ import annotations

import sys
from pathlib import Path

from rbw_schema.fixtures import fixture_report


def main(argv: list[str]) -> int:
    fixtures_dir = Path(argv[0]) if argv else Path.cwd() / "packages/schema/fixtures"
    sys.stdout.write("".join(f"{line}\n" for line in fixture_report(fixtures_dir)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
