import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMismatchedSyntheticPair, buildSyntheticPair, syntheticAdapter } from "@rbw/case-package/synthetic";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES, runValidateCli, type CliDependencies } from "../src/run-cli.ts";
import { forbiddenRunner } from "./support.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "case-validate-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
  };
}

function deps(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    adapters: { "task-report": syntheticAdapter({ seeds: ["01"], workdir: join(dir, "inputs") }) },
    runner: () => forbiddenRunner(),
    now: () => new Date("2026-10-19T12:00:00.000Z"),
    workdir: dir,
    ...overrides,
  };
}

async function write(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

describe("runValidateCli", () => {
  it("prints usage and exits with the usage code for missing or extra arguments", async () => {
    for (const argv of [[], ["one"], ["one", "two", "three"], ["one", "two", "--out"], ["--unknown", "a", "b"]]) {
      const capture = io();
      expect(await runValidateCli(argv, capture.io, deps()), argv.join(" ")).toBe(EXIT_CODES.usage);
      expect(capture.err.join("")).toMatch(/usage: rbw-validate/);
    }
  });

  it("exits with the error code and prints error for a mismatched pair", async () => {
    const pair = buildMismatchedSyntheticPair();
    const capture = io();
    const code = await runValidateCli([await write("b.tar.gz", pair.bug_case.bytes), await write("v.tar.gz", pair.validator.bytes)], capture.io, deps());
    expect(code).toBe(EXIT_CODES.error);
    expect(capture.out.join("")).toMatch(/^result: error$/m);
  });

  it("exits with the error code when a file cannot be read", async () => {
    const capture = io();
    expect(await runValidateCli([join(dir, "missing.tar.gz"), join(dir, "missing2.tar.gz")], capture.io, deps())).toBe(EXIT_CODES.error);
    expect(capture.err.join("")).toMatch(/cannot read/);
  });

  it("writes the outcome to --out and keeps the exit codes distinct", async () => {
    const pair = buildSyntheticPair({ seed: "01" });
    const capture = io();
    const out = join(dir, "report");
    const unavailable = deps({
      adapters: { "task-report": syntheticAdapter({ seeds: ["01"], workdir: join(dir, "inputs"), availability: () => ({ available: false, reason: "closed for the test" }) }) },
    });
    const code = await runValidateCli([await write("b.tar.gz", pair.bug_case.bytes), await write("v.tar.gz", pair.validator.bytes), "--out", out], capture.io, unavailable);
    expect(code).toBe(EXIT_CODES.error);
    const report = JSON.parse(await readFile(join(out, "validation.json"), "utf8")) as Record<string, unknown>;
    expect(report.result).toBe("error");
    expect(report.package_sha256).toEqual({ bug_case: pair.bug_case.sha256, validator: pair.validator.sha256 });
    expect(report.harness).toEqual({ name: "rbw-validate", version: "1.0.0" });
    expect(new Set(Object.values(EXIT_CODES)).size).toBe(4);
  });
});
