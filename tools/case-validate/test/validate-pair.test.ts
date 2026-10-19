import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMismatchedSyntheticPair, buildSyntheticPair, syntheticAdapter } from "@rbw/case-package/synthetic";
import type { HostAdapter } from "@rbw/factory-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePair } from "../src/validate.ts";
import { editManifest, forbiddenRunner, sha } from "./support.ts";

let parent: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "case-validate-pair-"));
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

const NOW = new Date("2026-10-19T12:00:00.000Z");

function hooks() {
  const seen = { beforeCopy: 0, onCopy: 0, onCells: 0 };
  return {
    seen,
    beforeCopy: () => {
      seen.beforeCopy += 1;
      return Promise.resolve("continue" as const);
    },
    onCopy: () => {
      seen.onCopy += 1;
      return Promise.resolve();
    },
    onCells: () => {
      seen.onCells += 1;
      return Promise.resolve();
    },
  };
}

describe("validatePair before any copy runs", () => {
  it("refuses a mismatched pair with error and runs no copy", async () => {
    const mismatched = buildMismatchedSyntheticPair();
    const runner = forbiddenRunner();
    const { seen, ...callbacks } = hooks();
    const outcome = await validatePair({
      bug_case: mismatched.bug_case.bytes, validator: mismatched.validator.bytes,
      adapters: { "task-report": syntheticAdapter({ workdir: parent }) }, runner, now: () => NOW, workdir: parent, ...callbacks,
    });
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("export_mismatch");
    expect(outcome.matrix).toBeNull();
    expect(outcome.records).toEqual([]);
    expect(outcome.stopped).toBe(false);
    expect(outcome.package_sha256).toEqual({ bug_case: mismatched.bug_case.sha256, validator: mismatched.validator.sha256 });
    expect(runner.calls).toBe(0);
    expect(seen).toEqual({ beforeCopy: 0, onCopy: 0, onCells: 0 });
  });

  it("refuses a swapped pair", async () => {
    const pair = buildSyntheticPair();
    const outcome = await validatePair({
      bug_case: pair.validator.bytes, validator: pair.bug_case.bytes,
      adapters: { "task-report": syntheticAdapter({ workdir: parent }) }, runner: forbiddenRunner(), now: () => NOW, workdir: parent,
    });
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("export_mismatch");
    expect(outcome.package_sha256).toEqual({ bug_case: sha(pair.validator.bytes), validator: sha(pair.bug_case.bytes) });
  });

  it("answers error for a host without an adapter", async () => {
    const pair = buildSyntheticPair({ host_id: "umami" });
    const outcome = await validatePair({
      bug_case: pair.bug_case.bytes, validator: pair.validator.bytes,
      adapters: { "task-report": syntheticAdapter({ workdir: parent }) }, runner: forbiddenRunner(), now: () => NOW, workdir: parent,
    });
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("unsupported_host");
  });

  it("runs no copy when the adapter reports the combination unavailable for the planned span, and says why", async () => {
    const pair = buildSyntheticPair({ seed: "01" });
    const windows: { from: string; until: string }[] = [];
    const adapter = syntheticAdapter({
      seeds: ["01"], workdir: parent,
      availability: (_entry, from, until) => {
        windows.push({ from, until });
        return { available: false, reason: "synthetic maintenance window" };
      },
    });
    const runner = forbiddenRunner();
    const { seen, ...callbacks } = hooks();
    const outcome = await validatePair({
      bug_case: pair.bug_case.bytes, validator: pair.validator.bytes,
      adapters: { "task-report": adapter }, runner, now: () => NOW, workdir: parent, ...callbacks,
    });
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("host_unavailable");
    expect(outcome.message).toContain("synthetic maintenance window");
    expect(runner.calls).toBe(0);
    expect(seen.beforeCopy).toBe(0);
    // Without an explicit end, the planned span is now plus every planned copy's time limit.
    const entry = adapter.catalog()[0];
    if (entry === undefined) throw new Error("no synthetic entry");
    const protocol = adapter.protocol(entry);
    const copies = protocol.per_state.clean.copies + protocol.per_state.buggy.copies + protocol.per_state.fixed.copies;
    const limit = adapter.copyPlans("clean", { ...emptyUnpacked(), protocol }, protocol)[0]?.limits.timeout_s ?? 0;
    expect(windows).toEqual([{ from: NOW.toISOString(), until: new Date(NOW.getTime() + copies * limit * 1000).toISOString() }]);
    expect(await readdir(parent)).toEqual([]);
  });

  it("passes an explicit planned end to the availability check", async () => {
    const pair = buildSyntheticPair({ seed: "01" });
    const windows: string[] = [];
    const until = new Date(NOW.getTime() + 1_800_000);
    const adapter = syntheticAdapter({
      seeds: ["01"], workdir: parent,
      availability: (_entry, _from, end) => {
        windows.push(end);
        return { available: false, reason: "closed" };
      },
    });
    await validatePair({ bug_case: pair.bug_case.bytes, validator: pair.validator.bytes, adapters: { "task-report": adapter }, runner: forbiddenRunner(), now: () => NOW, until, workdir: parent });
    expect(windows).toEqual([until.toISOString()]);
  });

  it("answers error when the adapter checks availability but no longer lists the package's entry", async () => {
    const pair = buildSyntheticPair({ seed: "01" });
    const adapter: HostAdapter = { ...syntheticAdapter({ seeds: ["02"], workdir: parent, availability: () => ({ available: true, reason: null }) }) };
    const outcome = await validatePair({ bug_case: pair.bug_case.bytes, validator: pair.validator.bytes, adapters: { "task-report": adapter }, runner: forbiddenRunner(), now: () => NOW, workdir: parent });
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("host_unavailable");
  });

  it("answers error, before any copy, when the reference repair's result does not match its recorded hash", async () => {
    const pair = buildSyntheticPair({ evidence: null });
    const edited = editManifest(pair.validator.bytes, "validator.json", (manifest) => {
      const repair = manifest.reference_repair as { result_sha256: { path: string; sha256: string }[] };
      repair.result_sha256 = repair.result_sha256.map((item) => ({ ...item, sha256: "0".repeat(64) }));
    });
    const runner = forbiddenRunner();
    const outcome = await validatePair({ bug_case: pair.bug_case.bytes, validator: edited, adapters: { "task-report": syntheticAdapter({ workdir: parent }) }, runner, now: () => NOW, workdir: parent });
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("export_mismatch");
    expect(runner.calls).toBe(0);
    expect(outcome.message).not.toMatch(/counter|src\//);
    expect(await readdir(parent)).toEqual([]);
  });
});

function emptyUnpacked() {
  const tree = { root: "/synthetic/none", files: [] };
  return { bug_case_sha256: "1".repeat(64), validator_sha256: "2".repeat(64), pair_sha256: "3".repeat(64), states: { clean: tree, buggy: tree, fixed: tree }, evaluator: tree };
}
