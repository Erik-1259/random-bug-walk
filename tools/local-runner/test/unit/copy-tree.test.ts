import { lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type * as fs from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadProbeSet } from "@rbw/shapes";
import { loadFixture } from "@rbw/umami-fixture";
import { deriveCodeStates, loadAlternativeFix } from "../../src/code-states.ts";
import type { CopyResult } from "../../src/copy.ts";
import { copyTree } from "../../src/copy-tree.ts";
import { buildJob, expectedVectors, newRunIds, writeJobDir } from "../../src/jobs.ts";
import { auditCopy } from "../../src/projection.ts";
import { mergeRecordSet } from "../../src/records.ts";
import { CLEAN, SOURCE_FILES, TARGET, tempDir, writeAlternativeDir, writeManifest, writeProbeDir, writeTerms } from "../support/synthetic.ts";

const mounts = vi.hoisted((): string[] => []);

vi.mock("node:fs", async (importOriginal) => {
  const { bindMountFs } = await import("../support/bind-mount.ts");
  return bindMountFs(await importOriginal<typeof fs>(), mounts);
});

/** A fresh directory that stands for a Docker Desktop bind mount, such as a run's work directory. */
function bindMounted(): string {
  const dir = tempDir("rbw-local-runner-mount-");
  mounts.push(dir);
  return dir;
}

function write(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function uuids(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  };
}

function states() {
  return deriveCodeStates(Buffer.from(CLEAN), loadProbeSet(writeProbeDir()), loadAlternativeFix(writeAlternativeDir()));
}

describe("copying a tree into a run or job directory", () => {
  it("keeps each file's bytes and mode, the nested directories, and each symbolic link as written", () => {
    const src = tempDir();
    write(join(src, "a.js"), "export {};\n", 0o644);
    write(join(src, "bin", "run.sh"), "#!/bin/sh\n", 0o755);
    write(join(src, "results", "fixed-01", "trial-result.json"), "{}\n", 0o600);
    symlinkSync("../a.js", join(src, "bin", "a-link"));
    symlinkSync("missing.txt", join(src, "dangling"));
    const dest = join(tempDir(), "copy");
    write(join(dest, "a.js"), "stale\n", 0o644);

    copyTree(src, dest);

    expect(readFileSync(join(dest, "a.js"), "utf8")).toBe("export {};\n");
    expect([mode(join(dest, "a.js")), mode(join(dest, "bin", "run.sh")), mode(join(dest, "results", "fixed-01", "trial-result.json"))]).toEqual([0o644, 0o755, 0o600]);
    expect(readFileSync(join(dest, "results", "fixed-01", "trial-result.json"), "utf8")).toBe("{}\n");
    expect(readlinkSync(join(dest, "bin", "a-link"))).toBe("../a.js");
    expect(readlinkSync(join(dest, "dangling"))).toBe("missing.txt");
    expect(lstatSync(join(dest, "dangling")).isSymbolicLink()).toBe(true);
  });

  it("audits a copy's projection in a work directory on a Docker Desktop bind mount", () => {
    const dir = tempDir();
    for (const [path, content] of Object.entries(SOURCE_FILES)) write(join(dir, "source", path), content, 0o644);
    const state = states().get("planted");
    if (state === undefined) throw new Error("missing state");
    const workDir = join(bindMounted(), "copy");

    const result = auditCopy({ sourceDir: join(dir, "source"), workDir, state, manifestPath: writeManifest(dir), termsPath: writeTerms(dir), policyPath: null });

    expect(result).toMatchObject({ verdict: "pass", reason: null, findings: 0 });
    expect(readFileSync(join(workDir, "projection", TARGET)).equals(state.bytes)).toBe(true);
    expect(mode(join(workDir, "projection", "README.md"))).toBe(0o644);
  });

  it("merges a copy's trial records into the job's record set on a Docker Desktop bind mount", () => {
    const probes = loadProbeSet(writeProbeDir());
    const job = buildJob("kit-check", {
      ids: newRunIds(uuids()),
      imageDigest: `sha256:${"c".repeat(64)}`,
      kitSha256: "d".repeat(64),
      fixtureSha256: "e".repeat(64),
      addedSuiteSha256: "f".repeat(64),
      originalSuite: { sha256: "a".repeat(64), testIds: ["synthetic-test-a"] },
      states: states(),
      vectors: expectedVectors(loadFixture(), probes),
      profileSha256: "b".repeat(64),
      deadlineAt: "2026-10-06T21:00:00Z",
    });
    const records = tempDir();
    writeJobDir(records, job);
    write(join(records, "results", "clean-01", "trial-result.json"), '{"synthetic":"result"}\n', 0o600);
    write(join(records, "results", "clean-01", "artifacts", "driver.log"), "synthetic driver log\n", 0o600);
    const copy: CopyResult = {
      job: "kit-check",
      trial_id: "clean-01",
      state: "clean",
      container: "rbw-synthetic-kit-check-clean-01",
      work_dir: tempDir(),
      status: "complete",
      reason: null,
      audit: { verdict: "not_applicable", reason: "no_declared_change", report_sha256: null, findings: 0 },
      placed_sha256: null,
      freeze_exit: 0,
      driver_exit: 0,
      container_exit: 0,
      timed_out: false,
      collected_dir: null,
      records_dir: records,
      phases: [],
    };
    const recordSet = join(bindMounted(), "records");

    expect(mergeRecordSet(job, [copy], recordSet)).toEqual([{ trial_id: "clean-01", merged: true, reason: null }]);
    const merged = join(recordSet, "results", "clean-01");
    expect(readFileSync(join(merged, "trial-result.json"), "utf8")).toBe('{"synthetic":"result"}\n');
    expect(readFileSync(join(merged, "artifacts", "driver.log"), "utf8")).toBe("synthetic driver log\n");
    expect(mode(join(merged, "trial-result.json"))).toBe(0o600);
  });
});
