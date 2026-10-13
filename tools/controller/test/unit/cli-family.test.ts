// The controller command line's --family and --race-latency-ms, run as a child process. Each
// case is a usage error, which exits 2 before any ledger, Docker or SDK call.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, writeKitStage, writeManifest, writeTerms } from "../../../local-runner/test/support/synthetic.ts";

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;

function cli(args: readonly string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  return { status: result.status, stderr: result.stderr };
}

function jobArgs(): string[] {
  const dir = tempDir("rbw-controller-cli-");
  return ["--work", join(dir, "run"), "--image", "rbw-umami-kit:synthetic", "--manifest", writeManifest(dir), "--terms", writeTerms(dir), "--kit-stage", writeKitStage(dir)];
}

function runArgs(): string[] {
  return ["run", "--job-kind", "kit_check", "--backend", "docker", ...jobArgs()];
}

function attemptArgs(): string[] {
  const dir = tempDir("rbw-controller-cli-");
  const file = (name: string): string => join(dir, name);
  return [
    "attempt",
    ...jobArgs(),
    "--policy",
    file("policy.json"),
    "--candidate",
    file("candidate.json"),
    "--writer-rates",
    file("writer-rates.json"),
    "--search-rates",
    file("search-rates.json"),
    "--audit-policy",
    file("audit-policy.json"),
    "--sandbox-image",
    `synthetic/rbw-umami-kit@sha256:${"cd".repeat(32)}`,
  ];
}

describe("the controller command line's family options", () => {
  it("exits 2 for an unknown family, in run and in attempt", () => {
    for (const args of [[...runArgs(), "--family", "nope"], [...attemptArgs(), "--family", "nope"]]) {
      const result = cli(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("unknown family nope; expected one of time-zone, race");
    }
  });

  it("exits 2 for a latency without the race family, in run and in attempt", () => {
    for (const args of [[...runArgs(), "--race-latency-ms", "5"], [...attemptArgs(), "--race-latency-ms", "5"]]) {
      const result = cli(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("the time-zone family's kit image has no database proxy");
    }
  });

  it("exits 2 for a race latency that is not a whole number from 0 to 10000", () => {
    for (const latency of ["10001", "-1", "5.5"]) {
      const result = cli([...runArgs(), "--family", "race", `--race-latency-ms=${latency}`]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("from 0 to 10000");
    }
  });

  it("takes no family option in proof, whose grader cases are the time-zone family's", () => {
    const result = cli(["proof", "--backend", "docker", ...jobArgs(), "--family", "race"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown option '--family'");
  });
});
