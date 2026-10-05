import subprocess
import sys

from conftest import FIXTURES
from rbw_schema.fixtures import fixture_report


def test_report_command_prints_the_fixture_report() -> None:
    completed = subprocess.run(  # noqa: S603 - fixed arguments, no shell.
        [sys.executable, "-m", "rbw_schema.report", str(FIXTURES)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert completed.stdout == "".join(f"{line}\n" for line in fixture_report(FIXTURES))
