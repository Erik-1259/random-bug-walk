import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitAll, initRepository, lines, makeTempDir, runScript, writeFiles } from "./helpers.ts";

function repositoryWith(files: Readonly<Record<string, string>>): string {
  const dir = makeTempDir("prose");
  initRepository(dir);
  writeFiles(dir, files);
  commitAll(dir, "test: synthetic content");
  return dir;
}

const flaggedForms = [
  "leverage",
  "leverages",
  "leveraged",
  "leveraging",
  "utilize",
  "utilizes",
  "utilized",
  "utilizing",
  "robust",
  "seamless",
  "seamlessly",
  "effortless",
  "effortlessly",
  "revolutionary",
  "guarantee",
  "guarantees",
  "guaranteed",
  "guaranteeing",
  "it's that easy",
  "it’s that easy",
  "its that easy",
  "don't miss out",
  "don’t miss out",
  "dont miss out",
  "world's first",
  "world’s first",
  "worlds first",
  "state-of-the-art",
  "state of the art",
  "cutting-edge",
  "cutting edge",
  "game-changing",
  "game changing",
];

describe("prose check", () => {
  it("reports every listed term and form as path:line: term and exits 1", () => {
    const content = flaggedForms.map((form) => `A synthetic sentence with ${form} inside.`).join("\n");
    const dir = repositoryWith({ "README.md": `${content}\n` });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(1);
    const reported = lines(result.stdout).filter((line) => line.startsWith("README.md:"));
    expect(reported).toEqual(flaggedForms.map((form, index) => `README.md:${String(index + 1)}: ${form}`));
  });

  it("matches case-insensitively and reports the term in lower case", () => {
    const dir = repositoryWith({ "README.md": "Synthetic.\nA ROBUST tool.\nState-Of-The-Art here.\n" });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toEqual(
      expect.arrayContaining(["README.md:2: robust", "README.md:3: state-of-the-art"]),
    );
  });

  it("reports each match on a line separately", () => {
    const dir = repositoryWith({ "README.md": "robust and seamless\n" });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(lines(result.stdout)).toEqual(
      expect.arrayContaining(["README.md:1: robust", "README.md:1: seamless"]),
    );
  });

  it("matches whole words only", () => {
    const dir = repositoryWith({
      "README.md": "robustness\nutilization\nunguaranteed\nseamlessness\nleverageable\n",
    });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(0);
  });

  it("gives correct line numbers with CRLF line endings", () => {
    const dir = repositoryWith({ "docs/guide.md": "first\r\nsecond\r\nthis is robust\r\nfourth\r\n" });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toContain("docs/guide.md:3: robust");
  });

  it("covers README.md in subfolders and .md and .mdx files under docs/", () => {
    const dir = repositoryWith({
      "packages/example/README.md": "seamless\n",
      "docs/nested/deeper/page.md": "robust\n",
      "docs/page.mdx": "revolutionary\n",
    });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toEqual(
      expect.arrayContaining([
        "packages/example/README.md:1: seamless",
        "docs/nested/deeper/page.md:1: robust",
        "docs/page.mdx:1: revolutionary",
      ]),
    );
  });

  it("ignores agent instruction files, other Markdown and files outside the set", () => {
    const dir = repositoryWith({
      "README.md": "clean text\n",
      "AGENTS.md": "robust\n",
      "CLAUDE.md": "seamless\n",
      "CONTRIBUTING.md": "robust\n",
      "packages/example/notes.md": "robust\n",
      "docs/image.txt": "robust\n",
      "readme.md": "robust\n",
    });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(0);
  });

  it("ignores untracked and ignored files", () => {
    const dir = repositoryWith({ "README.md": "clean text\n", ".gitignore": "docs/ignored.md\n" });
    writeFiles(dir, { "docs/untracked.md": "robust\n", "docs/ignored.md": "seamless\n" });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(0);
  });

  it("exits 0 on a clean set after printing the number of files checked", () => {
    const dir = repositoryWith({ "README.md": "clean\n", "docs/a.md": "clean\n", "docs/b.mdx": "clean\n" });

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prose: checked 3 files");
  });

  it("exits 2 outside a git work tree", () => {
    const dir = makeTempDir("prose-no-git");
    writeFiles(dir, { "README.md": "robust\n" });

    const result = runScript("prose.ts", [], { cwd: dir, env: { GIT_CEILING_DIRECTORIES: dir } });

    expect(result.status).toBe(2);
  });

  it("exits 2 when a tracked file in the set cannot be read", () => {
    const dir = repositoryWith({ "README.md": "clean\n", "docs/gone.md": "clean\n" });
    rmSync(join(dir, "docs/gone.md"));

    const result = runScript("prose.ts", [], { cwd: dir });

    expect(result.status).toBe(2);
  });
});
