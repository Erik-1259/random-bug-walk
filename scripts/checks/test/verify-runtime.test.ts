import { describe, expect, it } from "vitest";
import { lines, makeTempDir, runScript, writeFiles } from "./helpers.ts";

describe("check script runtime verification", () => {
  it("passes for the committed check scripts", () => {
    const result = runScript("verify-runtime.ts", []);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^verify-runtime: \d+ check scripts load under Node with standard-library imports only$/m);
  });

  it("fails when a script imports a third-party package and names the file", () => {
    const dir = makeTempDir("runtime-third-party");
    writeFiles(dir, {
      "ok.ts": 'import { join } from "node:path";\nexport const value: string = join("a", "b");\n',
      "bad.ts": 'import { parse } from "yaml";\nexport const value: unknown = parse("a: 1");\n',
    });

    const result = runScript("verify-runtime.ts", ["--dir", dir]);

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toContain("bad.ts: imports yaml, which is not a node: built-in or a relative .ts module");
  });

  it("fails when a script uses syntax that Node cannot strip", () => {
    const dir = makeTempDir("runtime-syntax");
    writeFiles(dir, { "enum.ts": "export enum Synthetic { A }\n" });

    const result = runScript("verify-runtime.ts", ["--dir", dir]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("enum.ts: does not load under Node");
  });

  it("ignores test files and fixtures", () => {
    const dir = makeTempDir("runtime-tests");
    writeFiles(dir, {
      "ok.ts": "export const value = 1;\n",
      "test/a.test.ts": 'import { parse } from "yaml";\nexport const value: unknown = parse("a: 1");\n',
    });

    expect(runScript("verify-runtime.ts", ["--dir", dir]).status).toBe(0);
  });
});
