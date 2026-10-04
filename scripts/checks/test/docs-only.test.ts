import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitAll, git, initRepository, makeTempDir, runScript, writeFiles } from "./helpers.ts";

function classify(paths: readonly string[]): { status: number | null; stdout: string } {
  const input = paths.length === 0 ? "" : `${paths.join("\n")}\n`;
  const result = runScript("docs-only.ts", [], { input });
  return { status: result.status, stdout: result.stdout };
}

describe("docs-only classifier", () => {
  it.each([
    ["root README.md", ["README.md"]],
    ["README.md in a subfolder", ["packages/example/README.md"]],
    [".md under docs/", ["docs/guide.md"]],
    [".mdx under docs/", ["docs/page.mdx"]],
    ["nested files under docs/", ["docs/a/b/c.md", "docs/a/b/d.mdx"]],
    ["the root LICENSE", ["LICENSE"]],
    ["a mix of docs paths", ["README.md", "docs/guide.md", "LICENSE", "tools/example/README.md"]],
  ])("prints true for %s", (_label, paths) => {
    expect(classify(paths)).toEqual({ status: 0, stdout: "true\n" });
  });

  it.each([
    ["AGENTS.md", ["AGENTS.md"]],
    ["CLAUDE.md", ["CLAUDE.md"]],
    ["another root Markdown file", ["CONTRIBUTING.md"]],
    ["Markdown inside a code directory", ["tools/x/notes.md"]],
    ["readme.md in the wrong case", ["readme.md"]],
    ["a nested LICENSE", ["packages/example/LICENSE"]],
    ["a code file", ["packages/example/src/index.ts"]],
    ["the CI workflow", [".github/workflows/ci.yml"]],
    ["an image under docs/", ["docs/img.png"]],
    ["README.md with an image under docs/", ["README.md", "docs/img.png"]],
    ["a mixed set", ["docs/guide.md", "package.json"]],
    ["empty input", []],
    ["both sides of a rename from code to docs", ["src/notes.ts", "docs/notes.md"]],
    ["Markdown in a docs folder below the root", ["packages/example/docs/guide.md"]],
  ])("prints false for %s", (_label, paths) => {
    expect(classify(paths)).toEqual({ status: 0, stdout: "false\n" });
  });

  it("ignores blank lines and CRLF line endings on stdin", () => {
    const result = runScript("docs-only.ts", [], { input: "README.md\r\n\r\ndocs/a.md\r\n" });
    expect(result).toMatchObject({ status: 0, stdout: "true\n" });
  });

  it("prints false for whitespace-only input", () => {
    const result = runScript("docs-only.ts", [], { input: "\n\n" });
    expect(result).toMatchObject({ status: 0, stdout: "false\n" });
  });

  it("classifies a rename by both of its sides with the workflow's diff command", () => {
    const dir = makeTempDir("docs-only-rename");
    initRepository(dir);
    writeFiles(dir, { "src/notes.ts": "export const synthetic = 1;\n" });
    const base = commitAll(dir, "test: base");
    mkdirSync(join(dir, "docs"));
    git(dir, ["mv", "src/notes.ts", "docs/notes.md"]);
    const head = commitAll(dir, "test: rename code to docs");

    const paths = git(dir, ["diff", "--name-only", "--no-renames", `${base}...${head}`]);
    const result = runScript("docs-only.ts", [], { input: `${paths}\n` });

    expect(paths.split("\n").sort()).toEqual(["docs/notes.md", "src/notes.ts"]);
    expect(result.stdout).toBe("false\n");
  });
});
