import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lines, makeTempDir, runScript, writeFiles } from "./helpers.ts";

type Status = "passed" | "failed" | "skipped" | "pending" | "todo" | "disabled";

interface VitestFile {
  file: string;
  statuses: readonly Status[];
}

function vitestReport(root: string, files: readonly VitestFile[]): string {
  return JSON.stringify({
    numTotalTests: files.reduce((total, entry) => total + entry.statuses.length, 0),
    success: true,
    testResults: files.map((entry) => ({
      name: join(root, entry.file),
      status: "passed",
      assertionResults: entry.statuses.map((status, index) => ({
        fullName: `synthetic test ${String(index)}`,
        title: `synthetic test ${String(index)}`,
        status,
      })),
    })),
  });
}

interface PytestReport {
  nodeid: string;
  when: "setup" | "call" | "teardown";
  outcome: "passed" | "failed" | "skipped" | "rerun";
  wasxfail?: string;
}

function pytestReport(reports: readonly PytestReport[]): string {
  const records = [
    { pytest_version: "9.1.1", $report_type: "SessionStart" },
    ...reports.map((report) => ({
      $report_type: "TestReport",
      location: [report.nodeid.split("::")[0], 1, "synthetic"],
      keywords: {},
      longrepr: null,
      duration: 0.01,
      sections: [],
      user_properties: [],
      ...report,
    })),
    { exitstatus: 0, $report_type: "SessionFinish" },
  ];
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function passingPytest(nodeid: string): PytestReport[] {
  return [
    { nodeid, when: "setup", outcome: "passed" },
    { nodeid, when: "call", outcome: "passed" },
    { nodeid, when: "teardown", outcome: "passed" },
  ];
}

interface Setup {
  floors?: unknown;
  rawFloors?: string;
  vitest?: string;
  pytest?: string;
}

function runFloors(root: string, setup: Setup): { status: number | null; out: string[] } {
  const files: Record<string, string> = {};
  if (setup.rawFloors !== undefined) {
    files["floors.json"] = setup.rawFloors;
  } else if (setup.floors !== undefined) {
    files["floors.json"] = JSON.stringify(setup.floors);
  }
  if (setup.vitest !== undefined) {
    files["vitest.json"] = setup.vitest;
  }
  if (setup.pytest !== undefined) {
    files["pytest.jsonl"] = setup.pytest;
  }
  const reports = makeTempDir("floor-reports");
  writeFiles(reports, files);
  const result = runScript("test-floor.ts", [
    "--root",
    root,
    "--floors",
    join(reports, "floors.json"),
    "--vitest",
    join(reports, "vitest.json"),
    "--pytest",
    join(reports, "pytest.jsonl"),
  ]);
  return { status: result.status, out: lines(result.stdout + result.stderr) };
}

const checksFile = "scripts/checks/test/a.test.ts";

describe("test floor check", () => {
  it("passes at the floor and prints a line per suite", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { "scripts/checks": 3 }, pytest: {} },
      vitest: vitestReport(root, [{ file: checksFile, statuses: ["passed", "passed", "failed"] }]),
      pytest: pytestReport([]),
    });

    expect(result.status).toBe(0);
    expect(result.out).toContain("vitest scripts/checks: executed 3, floor 3, ok");
  });

  it("passes above the floor", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { "scripts/checks": 1 }, pytest: {} },
      vitest: vitestReport(root, [{ file: checksFile, statuses: ["passed", "passed"] }]),
      pytest: pytestReport([]),
    });

    expect(result.status).toBe(0);
    expect(result.out).toContain("vitest scripts/checks: executed 2, floor 1, ok");
  });

  it("fails below the floor and names the suite, executed count and floor", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { "scripts/checks": 3 }, pytest: {} },
      vitest: vitestReport(root, [{ file: checksFile, statuses: ["passed", "passed", "skipped"] }]),
      pytest: pytestReport([]),
    });

    expect(result.status).toBe(1);
    expect(result.out).toContain("vitest scripts/checks: executed 2, floor 3, below floor");
  });

  it("does not count skipped, pending, todo or disabled results and counts failed ones", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { "scripts/checks": 2 }, pytest: {} },
      vitest: vitestReport(root, [
        { file: checksFile, statuses: ["failed", "skipped", "pending", "todo", "disabled", "passed"] },
      ]),
      pytest: pytestReport([]),
    });

    expect(result.status).toBe(0);
    expect(result.out).toContain("vitest scripts/checks: executed 2, floor 2, ok");
  });

  it("fails when a listed suite executed nothing", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { "scripts/checks": 1, "tools/publication": 4 }, pytest: {} },
      vitest: vitestReport(root, [
        { file: checksFile, statuses: ["passed"] },
        { file: "tools/publication/src/a.test.ts", statuses: ["skipped"] },
      ]),
      pytest: pytestReport([]),
    });

    expect(result.status).toBe(1);
    expect(result.out).toContain("vitest tools/publication: executed 0, floor 4, missing");
  });

  it("fails as missing when the runner's report file is absent", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { "scripts/checks": 1 }, pytest: { "python/schema": 2 } },
      vitest: vitestReport(root, [{ file: checksFile, statuses: ["passed"] }]),
    });

    expect(result.status).toBe(1);
    expect(result.out).toContain("pytest python/schema: executed 0, floor 2, missing");
  });

  it("accepts an absent report for a runner without listed suites", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { "scripts/checks": 1 }, pytest: {} },
      vitest: vitestReport(root, [{ file: checksFile, statuses: ["passed"] }]),
    });

    expect(result.status).toBe(0);
  });

  it("fails on a suite without a floor and names the key to add", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { "scripts/checks": 1 }, pytest: {} },
      vitest: vitestReport(root, [
        { file: checksFile, statuses: ["passed"] },
        { file: "packages/synthetic/src/deep/x.test.ts", statuses: ["passed", "passed", "skipped"] },
      ]),
      pytest: pytestReport([]),
    });

    expect(result.status).toBe(1);
    expect(result.out).toContain(
      'vitest packages/synthetic: executed 2, floor none, unfloored; add "packages/synthetic": 2 under "vitest"',
    );
  });

  it("maps deep, root-level and one-level paths to suites by exact key", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: {
        vitest: { "tools/publication": 2, ".": 1, scripts: 1 },
        pytest: { "python/schema": 1 },
      },
      vitest: vitestReport(root, [
        { file: "tools/publication/src/a/b/c.test.ts", statuses: ["passed"] },
        { file: "tools/publication/src/d.test.ts", statuses: ["passed"] },
        { file: "agent-config.test.ts", statuses: ["passed"] },
        { file: "scripts/one.test.ts", statuses: ["passed"] },
      ]),
      pytest: pytestReport(passingPytest("python/schema/tests/deep/test_a.py::test_one")),
    });

    expect(result.status).toBe(0);
    expect(result.out).toEqual(
      expect.arrayContaining([
        "vitest tools/publication: executed 2, floor 2, ok",
        "vitest .: executed 1, floor 1, ok",
        "vitest scripts: executed 1, floor 1, ok",
        "pytest python/schema: executed 1, floor 1, ok",
      ]),
    );
  });

  it("does not prefix-match floor keys", () => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors: { vitest: { tools: 1 }, pytest: {} },
      vitest: vitestReport(root, [{ file: "tools/publication/src/a.test.ts", statuses: ["passed"] }]),
      pytest: pytestReport([]),
    });

    expect(result.status).toBe(1);
    expect(result.out).toContain("vitest tools: executed 0, floor 1, missing");
    expect(result.out).toContain(
      'vitest tools/publication: executed 1, floor none, unfloored; add "tools/publication": 1 under "vitest"',
    );
  });

  it("counts pytest call phases only, ignoring setup skips and xfail, and counts reruns once", () => {
    const root = makeTempDir("floor-root");
    const file = "python/schema/tests/test_a.py";
    const result = runFloors(root, {
      floors: { vitest: {}, pytest: { "python/schema": 3 } },
      pytest: pytestReport([
        ...passingPytest(`${file}::test_pass`),
        { nodeid: `${file}::test_fail`, when: "setup", outcome: "passed" },
        { nodeid: `${file}::test_fail`, when: "call", outcome: "failed" },
        { nodeid: `${file}::test_setup_skip`, when: "setup", outcome: "skipped" },
        { nodeid: `${file}::test_setup_skip`, when: "teardown", outcome: "passed" },
        { nodeid: `${file}::test_xfail`, when: "setup", outcome: "passed" },
        { nodeid: `${file}::test_xfail`, when: "call", outcome: "skipped", wasxfail: "synthetic" },
        { nodeid: `${file}::test_xpass`, when: "setup", outcome: "passed" },
        { nodeid: `${file}::test_xpass`, when: "call", outcome: "passed", wasxfail: "synthetic" },
        { nodeid: `${file}::test_call_skip`, when: "setup", outcome: "passed" },
        { nodeid: `${file}::test_call_skip`, when: "call", outcome: "skipped" },
        { nodeid: `${file}::test_flaky`, when: "setup", outcome: "passed" },
        { nodeid: `${file}::test_flaky`, when: "call", outcome: "rerun" },
        { nodeid: `${file}::test_flaky`, when: "setup", outcome: "passed" },
        { nodeid: `${file}::test_flaky`, when: "call", outcome: "failed" },
        { nodeid: `${file}::test_flaky`, when: "setup", outcome: "passed" },
        { nodeid: `${file}::test_flaky`, when: "call", outcome: "passed" },
      ]),
    });

    expect(result.status).toBe(0);
    expect(result.out).toContain("pytest python/schema: executed 3, floor 3, ok");
  });

  it("fails when one pytest test is skipped with the floor unchanged", () => {
    const root = makeTempDir("floor-root");
    const file = "python/schema/tests/test_a.py";
    const result = runFloors(root, {
      floors: { vitest: {}, pytest: { "python/schema": 2 } },
      pytest: pytestReport([
        ...passingPytest(`${file}::test_one`),
        { nodeid: `${file}::test_two`, when: "setup", outcome: "skipped" },
      ]),
    });

    expect(result.status).toBe(1);
    expect(result.out).toContain("pytest python/schema: executed 1, floor 2, below floor");
  });

  it.each([
    ["a non-integer floor", { vitest: { "scripts/checks": 1.5 }, pytest: {} }],
    ["a string floor", { vitest: { "scripts/checks": "3" }, pytest: {} }],
    ["a zero floor", { vitest: { "scripts/checks": 0 }, pytest: {} }],
    ["an extra top-level key", { vitest: { "scripts/checks": 1 }, pytest: {}, jest: {} }],
    ["a missing runner", { vitest: { "scripts/checks": 1 } }],
    ["a runner that is not an object", { vitest: [], pytest: {} }],
    ["a key with a leading ./", { vitest: { "./scripts": 1 }, pytest: {} }],
    ["a key with a trailing slash", { vitest: { "scripts/": 1 }, pytest: {} }],
    ["a key with ..", { vitest: { "../scripts": 1 }, pytest: {} }],
    ["a key with three levels", { vitest: { "scripts/checks/test": 1 }, pytest: {} }],
    ["an empty key", { vitest: { "": 1 }, pytest: {} }],
  ])("exits 2 on a malformed floor file: %s", (_label, floors) => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, {
      floors,
      vitest: vitestReport(root, [{ file: checksFile, statuses: ["passed"] }]),
      pytest: pytestReport([]),
    });

    expect(result.status).toBe(2);
  });

  it("exits 2 when the floor file is missing or not JSON", () => {
    const root = makeTempDir("floor-root");
    expect(runFloors(root, { vitest: vitestReport(root, []) }).status).toBe(2);
    expect(runFloors(root, { rawFloors: "{", vitest: vitestReport(root, []) }).status).toBe(2);
  });

  it.each([
    ["a non-JSON Vitest report", { vitest: "not json" }],
    ["a Vitest report without testResults", { vitest: JSON.stringify({ numTotalTests: 0 }) }],
    [
      "a Vitest result without a status",
      { vitest: JSON.stringify({ testResults: [{ name: "/x.test.ts", assertionResults: [{}] }] }) },
    ],
    ["a non-JSON pytest line", { vitest: JSON.stringify({ testResults: [] }), pytest: "{\n" }],
    [
      "a pytest test report without a node id",
      {
        vitest: JSON.stringify({ testResults: [] }),
        pytest: `${JSON.stringify({ $report_type: "TestReport", when: "call", outcome: "passed" })}\n`,
      },
    ],
  ])("exits 2 on %s", (_label, reports) => {
    const root = makeTempDir("floor-root");
    const result = runFloors(root, { floors: { vitest: {}, pytest: {} }, ...reports });

    expect(result.status).toBe(2);
  });

  it("exits 2 when a reported test file resolves outside the repository", () => {
    const root = makeTempDir("floor-root");
    const outside = runFloors(root, {
      floors: { vitest: { "scripts/checks": 1 }, pytest: {} },
      vitest: vitestReport(root, [{ file: "../elsewhere/a.test.ts", statuses: ["passed"] }]),
      pytest: pytestReport([]),
    });
    const pytestOutside = runFloors(root, {
      floors: { vitest: {}, pytest: {} },
      pytest: pytestReport(passingPytest("../elsewhere/test_a.py::test_one")),
    });

    expect(outside.status).toBe(2);
    expect(pytestOutside.status).toBe(2);
  });
});
