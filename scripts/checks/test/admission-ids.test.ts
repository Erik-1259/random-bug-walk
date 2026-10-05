import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitAll, initRepository, lines, makeTempDir, repositoryRoot, runScript, writeFiles } from "./helpers.ts";

type Status = "planned" | "implemented" | "retired";

const allIds = Array.from({ length: 10 }, (_, index) => `ADM-${String(index + 1).padStart(2, "0")}`);

function documentWith(rows: readonly (readonly [string, string])[]): string {
  const header = "| ID | Status | Rule | Required work | Decision |\n|---|---|---|---|---|\n";
  const body = rows.map(([id, status]) => `| ${id} | ${status} | Rule | Work | Decision |`).join("\n");
  return `# Synthetic rules\n\nSome prose that mentions ADM-99 outside the table.\n\n${header}${body}\n`;
}

function statuses(overrides: Readonly<Record<string, Status>> = {}): string {
  return documentWith(allIds.map((id) => [id, overrides[id] ?? "planned"]));
}

function repositoryWith(files: Readonly<Record<string, string>>, document: string | null = statuses()): string {
  const dir = makeTempDir("admission");
  initRepository(dir);
  writeFiles(dir, document === null ? files : { "docs/admission-rules.md": document, ...files });
  commitAll(dir, "test: synthetic content");
  return dir;
}

function run(dir: string) {
  return runScript("admission-ids.ts", [], { cwd: dir });
}

const implementationFile = "packages/synthetic/src/rule.ts";
const testFile = "packages/synthetic/test/rule.test.ts";

function markers(id: string): Record<string, string> {
  return {
    [implementationFile]: `// ${id}: synthetic marker\nexport const value = 1;\n`,
    [testFile]: `import { it } from "vitest";\nit("${id} synthetic marker test", () => undefined);\n`,
  };
}

describe("admission rule document", () => {
  it("lists the ten rows in ID order and exits 0 when all are planned", () => {
    const result = run(repositoryWith({}));

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(allIds.map((id) => `${id} planned implementation=0 tests=0`));
  });

  it("exits 2 when an ID repeats", () => {
    const document = documentWith([...allIds, "ADM-03"].map((id) => [id, "planned"] as const));

    expect(run(repositoryWith({}, document)).status).toBe(2);
  });

  it("exits 2 when a status is not planned, implemented or retired", () => {
    const document = documentWith([["ADM-01", "enforced"]]);

    expect(run(repositoryWith({}, document)).status).toBe(2);
  });

  it("exits 2 when a row has the wrong number of cells", () => {
    const document = `${statuses()}| ADM-11 | planned | Rule | Work |\n`;

    expect(run(repositoryWith({}, document)).status).toBe(2);
  });

  it("exits 2 when the table has no ADM rows", () => {
    const document = "# Synthetic\n\n| ID | Status | Rule | Required work | Decision |\n|---|---|---|---|---|\n";

    expect(run(repositoryWith({}, document)).status).toBe(2);
  });

  it("exits 0 with a message when the document and every marker are absent", () => {
    const result = run(repositoryWith({ "packages/synthetic/src/plain.ts": "export const a = 1;\n" }, null));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no admission rules document; nothing to check");
  });

  it("exits 1 when markers exist but the document is absent", () => {
    const result = run(repositoryWith(markers("ADM-01"), null));

    expect(result.status).toBe(1);
  });

  it("exits 2 outside a git work tree", () => {
    const dir = makeTempDir("admission-plain");
    writeFiles(dir, { "docs/admission-rules.md": statuses() });

    expect(run(dir).status).toBe(2);
  });
});

describe("implemented rules", () => {
  it("passes with both an implementation and a test marker", () => {
    const result = run(repositoryWith(markers("ADM-01"), statuses({ "ADM-01": "implemented" })));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ADM-01 implemented implementation=1 tests=1");
  });

  it("fails without a test marker", () => {
    const files = { [implementationFile]: markers("ADM-01")[implementationFile] ?? "" };
    const result = run(repositoryWith(files, statuses({ "ADM-01": "implemented" })));

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toContain("error: ADM-01 implemented but has no test");
  });

  it("fails without an implementation marker", () => {
    const files = { [testFile]: markers("ADM-01")[testFile] ?? "" };
    const result = run(repositoryWith(files, statuses({ "ADM-01": "implemented" })));

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toContain("error: ADM-01 implemented but has no implementation");
  });

  it("fails when the ID is removed from the test name of a committed repository", () => {
    const files = markers("ADM-01");
    files[testFile] = `import { it } from "vitest";\nit("synthetic marker test", () => undefined);\n`;
    const result = run(repositoryWith(files, statuses({ "ADM-01": "implemented" })));

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toContain("error: ADM-01 implemented but has no test");
  });
});

describe("planned and retired rules", () => {
  it("lists a planned rule with both markers and a note to flip its status, exit 0", () => {
    const result = run(repositoryWith(markers("ADM-04")));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ADM-04 planned implementation=1 tests=1");
    expect(lines(result.stdout).some((line) => line.startsWith("note: ADM-04 ") && line.includes("implemented"))).toBe(
      true,
    );
  });

  it("does not add a note to a planned rule with only one marker", () => {
    const result = run(repositoryWith({ [implementationFile]: markers("ADM-04")[implementationFile] ?? "" }));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("note:");
  });

  it("fails when a retired rule still has a test marker", () => {
    const files = { [testFile]: markers("ADM-02")[testFile] ?? "" };
    const result = run(repositoryWith(files, statuses({ "ADM-02": "retired" })));

    expect(result.status).toBe(1);
    expect(lines(result.stdout).some((line) => line.startsWith("error: ADM-02 retired"))).toBe(true);
  });

  it("passes a retired rule with no test marker", () => {
    expect(run(repositoryWith({}, statuses({ "ADM-02": "retired" }))).status).toBe(0);
  });
});

describe("marker detection", () => {
  function counts(files: Record<string, string>, id = "ADM-04"): string {
    const result = run(repositoryWith(files));
    return lines(result.stdout).find((line) => line.startsWith(`${id} `)) ?? "";
  }

  it.each([
    ["a line comment", "// ADM-04: note\n"],
    ["a block comment", "/* ADM-04: note */\n"],
    ["a leading star", "/**\n * ADM-04: note\n */\n"],
    ["a hash comment", "# ADM-04: note\n"],
  ])("counts %s as an implementation", (_name, content) => {
    expect(counts({ "packages/a/src/x.ts": content })).toBe("ADM-04 planned implementation=1 tests=0");
  });

  it("does not count an ID in a string of non-test code", () => {
    expect(counts({ "packages/a/src/x.ts": 'export const label = "ADM-04";\n' })).toBe(
      "ADM-04 planned implementation=0 tests=0",
    );
  });

  it("counts a Python comment in a non-test file under python/", () => {
    expect(counts({ "python/a/src/x.py": "# ADM-04: note\n" })).toBe("ADM-04 planned implementation=1 tests=0");
  });

  it("does not count an implementation marker outside packages, tools and python", () => {
    expect(counts({ "src/x.ts": "// ADM-04: note\n" })).toBe("ADM-04 planned implementation=0 tests=0");
  });

  it("does not count a marker in a test file as an implementation", () => {
    expect(counts({ "packages/a/test/x.test.ts": "// ADM-04 comment only\n" })).toBe(
      "ADM-04 planned implementation=0 tests=0",
    );
  });

  it("does not count an ID in a test-file comment or expect message", () => {
    const content = [
      "// ADM-04 in a comment",
      'it("plain name", () => {',
      '  expect(1, "ADM-04 message").toBe(1);',
      "});",
      "",
    ].join("\n");

    expect(counts({ "packages/a/test/x.test.ts": content })).toBe("ADM-04 planned implementation=0 tests=0");
  });

  it.each(["describe", "it", "test"])("counts %s with the ID in its first string", (name) => {
    expect(counts({ "packages/a/test/x.test.ts": `${name}("ADM-04 rule", () => undefined);\n` })).toBe(
      "ADM-04 planned implementation=0 tests=1",
    );
  });

  it("does not count it.skip or it.todo", () => {
    const content = 'it.skip("ADM-04 a", () => undefined);\nit.todo("ADM-04 b");\n';

    expect(counts({ "packages/a/test/x.test.ts": content })).toBe("ADM-04 planned implementation=0 tests=0");
  });

  it("counts .each forms", () => {
    const content = 'it.each([1, 2])("ADM-04 case %s", () => undefined);\ndescribe.each([[1]])(\'ADM-04 group\', () => undefined);\n';

    expect(counts({ "packages/a/test/x.test.tsx": content })).toBe("ADM-04 planned implementation=0 tests=2");
  });

  it("counts a Python test function and class name", () => {
    const content = "def test_adm_04_rejects():\n    pass\n\nclass TestADM_04:\n    pass\n";

    expect(counts({ "python/a/tests/test_rule.py": content })).toBe("ADM-04 planned implementation=0 tests=2");
  });

  it("does not count a Python ID in a comment or a non-test-named file", () => {
    expect(counts({ "python/a/tests/test_rule.py": "# adm_04\ndef test_other():\n    pass\n" })).toBe(
      "ADM-04 planned implementation=0 tests=0",
    );
    expect(counts({ "python/a/src/rule.py": "def test_adm_04_x():\n    pass\n" })).toBe(
      "ADM-04 planned implementation=0 tests=0",
    );
  });

  it("does not match ADM-041 or XADM-04", () => {
    const content = "// ADM-041 and XADM-04 only\n";
    const result = run(repositoryWith({ "packages/a/src/x.ts": content }));

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toContain("ADM-04 planned implementation=0 tests=0");
  });

  it("ignores untracked files and everything under scripts/checks", () => {
    const dir = repositoryWith({ "scripts/checks/x.ts": "// ADM-04: note\n", "scripts/checks/test/x.test.ts": 'it("ADM-04 a", () => undefined);\n' });
    writeFiles(dir, { "packages/a/src/untracked.ts": "// ADM-04: note\n" });

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toContain("ADM-04 planned implementation=0 tests=0");
  });
});

describe("unknown IDs and output", () => {
  it("reports a marker for an ID absent from the document as path:line: unknown and exits 1", () => {
    const result = run(repositoryWith({ [implementationFile]: "export const a = 1;\n\n// ADM-11: note\n" }));

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toContain(`${implementationFile}:3: unknown ADM-11`);
  });

  it("reports an unknown ID in a test name", () => {
    const result = run(repositoryWith({ [testFile]: 'it("ADM-12 name", () => undefined);\n' }));

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toContain(`${testFile}:1: unknown ADM-12`);
  });

  it("lists marker locations as indented path:line lines under their ID", () => {
    const result = run(repositoryWith(markers("ADM-03")));
    const output = lines(result.stdout);
    const index = output.indexOf("ADM-03 planned implementation=1 tests=1");

    expect(index).toBeGreaterThanOrEqual(0);
    expect(output.slice(index + 1, index + 3)).toEqual([`  ${implementationFile}:1`, `  ${testFile}:2`]);
  });
});

describe("ci workflow step", () => {
  interface Step {
    name?: string;
    run?: string;
  }
  interface Workflow {
    jobs: Record<string, { steps?: Step[] }>;
  }
  const workflow = parse(readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8")) as Workflow;

  it("has the step once, in prose, directly after Check prose", () => {
    const named = Object.entries(workflow.jobs).flatMap(([job, { steps }]) =>
      (steps ?? []).filter((step) => step.name === "Check admission rule IDs").map(() => job),
    );
    const steps = workflow.jobs.prose?.steps ?? [];
    const after = steps.findIndex((step) => step.name === "Check prose") + 1;

    expect(named).toEqual(["prose"]);
    expect(steps[after]?.name).toBe("Check admission rule IDs");
    expect(steps[after]?.run).toBe("node ../check-tools/scripts/checks/admission-ids.ts");
  });

  it("keeps the job ID set unchanged", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(
      ["build", "changes", "lint", "names-attribution", "prose", "public-safety", "typecheck", "unit-tests"].sort(),
    );
  });

  it("has no expression in the step's run", () => {
    const step = workflow.jobs.prose?.steps?.find((candidate) => candidate.name === "Check admission rule IDs");

    expect(step?.run).toBeDefined();
    expect(step?.run).not.toContain("${{");
  });
});

describe("marker detection edge cases", () => {
  function counts(files: Record<string, string>): string {
    return lines(run(repositoryWith(files)).stdout).find((line) => line.startsWith("ADM-01 ")) ?? "";
  }

  it("does not count a test call that sits in a comment or a string in a test file", () => {
    const content = ['// it("ADM-01 commented out", () => undefined);', "expect(run(\"it('ADM-01 quoted')\")).toBe(1);", ""].join(
      "\n",
    );

    expect(counts({ "packages/a/test/x.test.ts": content })).toBe("ADM-01 planned implementation=0 tests=0");
  });

  it("counts a test call that opens an arrow body on the same line", () => {
    const content = 'describe("group", () => { it("ADM-01 inner", () => undefined); });\n';

    expect(counts({ "packages/a/test/x.test.ts": content })).toBe("ADM-01 planned implementation=0 tests=1");
  });

  it("does not count an ID in code after a comment-like sequence inside a string", () => {
    const content = 'const url = "http://x"; call("ADM-01");\n';

    expect(counts({ "packages/a/src/x.ts": content })).toBe("ADM-01 planned implementation=0 tests=0");
  });

  it("counts a trailing comment after code that contains a string", () => {
    expect(counts({ "packages/a/src/x.ts": 'const a = "x"; // ADM-01: note\n' })).toBe(
      "ADM-01 planned implementation=1 tests=0",
    );
  });

  it("skips a tracked file that was deleted from the work tree", () => {
    const dir = repositoryWith({ "packages/a/src/x.ts": "// ADM-01: note\n" });
    rmSync(join(dir, "packages/a/src/x.ts"));

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toContain("ADM-01 planned implementation=0 tests=0");
  });
});

describe("marker detection by language and directory", () => {
  it("does not treat a JavaScript private field or a Python floor division as a comment", () => {
    const dir = repositoryWith({
      "packages/a/src/x.ts": 'this.#rule = "ADM-09";\n',
      "python/a/src/x.py": 'half = 4 // 2; label = "ADM-09"\n',
    });

    expect(lines(run(dir).stdout)).toContain("ADM-09 planned implementation=0 tests=0");
  });

  it("gives the same result when run from a subdirectory", () => {
    const dir = repositoryWith(markers("ADM-03"));

    const result = runScript("admission-ids.ts", [], { cwd: join(dir, "packages") });

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toContain("ADM-03 planned implementation=1 tests=1");
  });
});
