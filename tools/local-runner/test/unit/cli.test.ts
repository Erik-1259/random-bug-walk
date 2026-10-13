// The command line's family options, run as a child process. The dry run starts no container,
// and every usage error stops before Docker.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProbeSet } from "@rbw/shapes";
import { FAMILIES } from "../../src/family.ts";
import type { FamilyId } from "../../src/family.ts";
import { tempDir, writeKitStage, writeManifest, writeTerms } from "../support/synthetic.ts";

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;

function cli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The command line has no --probes, so a dry run reads the family's committed probe set. Its
 * manifest needs only the probes' target file, named by the clean hash the probe set records.
 */
function familyManifest(dir: string, family: FamilyId): string {
  const probes = loadProbeSet(FAMILIES[family].probesDir).data;
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ files: [{ mode: "100644", path: probes.target_path, sha256: probes.clean_sha256, size_bytes: 1 }], host_commit: probes.host_commit }));
  return path;
}

function runArgs(family: FamilyId = "time-zone"): string[] {
  const dir = tempDir("rbw-local-runner-cli-");
  return ["--image", "rbw-umami-kit:synthetic", "--kit-stage", writeKitStage(dir, family), "--manifest", familyManifest(dir, family), "--terms", writeTerms(dir), "--work", join(dir, "work")];
}

function runCopyArgs(): string[] {
  const dir = tempDir("rbw-local-runner-cli-");
  return ["--job", join(dir, "job"), "--trial", "planted-01", "--image", "rbw-umami-kit:synthetic", "--manifest", writeManifest(dir), "--terms", writeTerms(dir), "--work", join(dir, "work")];
}

/** The last line of each copy's `docker create`: the copy script's quoted end, then its arguments. */
function copyArguments(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.includes("' rbw-copy "));
}

describe("the command line's --family and --race-latency-ms", () => {
  it("runs the race family's dry run with the latency: 11 admission copies, each copy script given 50", () => {
    const result = cli(["run", "--dry-run", "--family", "race", "--race-latency-ms", "50", ...runArgs("race")]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("family race: 11 admission copies, ADM-06 not applicable, latency 50 ms");
    const copies = copyArguments(result.stdout);
    expect(copies).toHaveLength(1 + 5 + 1 + 11);
    expect(copies.every((line) => / rbw-copy (freeze freeze|trial [a-z]+-\d\d) 50$/.test(line))).toBe(true);
  });

  it("runs the time-zone family's dry run without --family, with no family line and no latency argument", () => {
    const result = cli(["run", "--dry-run", ...runArgs()]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("family ");
    const copies = copyArguments(result.stdout);
    expect(copies.length).toBeGreaterThan(1 + 5 + 1 + 11);
    expect(copies.every((line) => / rbw-copy (freeze freeze|trial [a-z]+-\d\d)$/.test(line))).toBe(true);
  });

  it("exits 2 with a usage error for an unknown family, in run and in run-copy", () => {
    for (const args of [["run", "--dry-run", "--family", "bogus", ...runArgs()], ["run-copy", "--family", "bogus", ...runCopyArgs()]]) {
      const result = cli(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("unknown family bogus; expected one of time-zone, race");
    }
  });

  it("exits 2 with a usage error for a latency without the race family, in run and in run-copy", () => {
    for (const args of [["run", "--dry-run", "--race-latency-ms", "5", ...runArgs()], ["run-copy", "--race-latency-ms", "5", ...runCopyArgs()]]) {
      const result = cli(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("the time-zone family's kit image has no database proxy");
    }
  });

  it("exits 2 with a usage error for a race latency above 10000 ms", () => {
    const result = cli(["run", "--dry-run", "--family", "race", "--race-latency-ms", "10001", ...runArgs("race")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("from 0 to 10000");
  });
});
