import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectedCopy, CopyPlan, CopyRecord, CopyState, UnpackedPair } from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticAdapter, syntheticBaseline, syntheticEntry } from "../src/synthetic.ts";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "case-package-synthetic-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function record(state: CopyState, overrides: Partial<CopyRecord> = {}, runs = { valid: 2, total: 2 }): CopyRecord {
  const cell = { observed: "pass" as const, runs_valid: runs.valid, runs_total: runs.total, failure_codes: [], detail: "" };
  return {
    copy_id: `synthetic-${state}-1`,
    state,
    status: "complete",
    original_suite: { ...cell, executed: 3, expected: 3, failing_test_ids: [], suite_sha256: "a".repeat(64) },
    verification: { ...cell },
    image_digest: `sha256:${"b".repeat(64)}`,
    architecture: "amd64",
    started_at: "2026-10-19T12:00:00.000Z",
    finished_at: "2026-10-19T12:00:05.000Z",
    evidence_sha256: "c".repeat(64),
    ...overrides,
  };
}

describe("synthetic catalog", () => {
  it("produces shapes that satisfy the shared schema", () => {
    for (const host_id of ["task-report", "umami"] as const) {
      const adapter = syntheticAdapter({ host_id, seeds: ["01"], workdir });
      expect(validateContract("BaselineIdentity", adapter.baseline())).toEqual([]);
      const entry = adapter.catalog()[0];
      expect(validateContract("CatalogEntry", entry)).toEqual([]);
      if (entry === undefined) throw new Error("no entry");
      expect(validateContract("Protocol", adapter.protocol(entry))).toEqual([]);
      expect(entry.verification.protocol_sha256).toBe(adapter.protocol(entry).sha256);
      expect(entry.host_id).toBe(host_id);
    }
    expect(syntheticBaseline("umami").host_id).toBe("umami");
  });

  it("names criteria by host and lets a test choose another failure code", () => {
    expect(syntheticEntry({ host_id: "task-report" }).criteria.map((item) => item.criterion_id)).toEqual(["concurrency.lost-acknowledged-change"]);
    expect(syntheticEntry({ host_id: "umami" }).bug_type_id).toBe("date_time");
  });

  it("writes inputs whose listed files exist with their listed hashes", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const entry = adapter.catalog()[0];
    if (entry === undefined) throw new Error("no entry");
    const bugCase = await adapter.bugCaseInputs(entry);
    const validator = await adapter.validatorInputs(entry);
    expect(validateContract("BugCaseInputs", bugCase)).toEqual([]);
    expect(validateContract("ValidatorInputs", validator)).toEqual([]);
    for (const set of [bugCase.source, bugCase.incident, validator.checks]) {
      for (const file of set.files) expect(sha(await readFile(join(set.root, file.path))), file.path).toBe(file.sha256);
    }
    const target = entry.plant.targets[0];
    expect(bugCase.source.files.find((file) => file.path === target?.path)?.sha256).toBe(target?.after_sha256);
  });
});

describe("synthetic copyPlans", () => {
  it("maps the harness-built tree of each state to one plan per declared copy and applies no patch", () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const entry = adapter.catalog()[0];
    if (entry === undefined) throw new Error("no entry");
    const protocol = { ...adapter.protocol(entry), per_state: { ...adapter.protocol(entry).per_state, buggy: { copies: 2, rounds_per_copy: 2, min_valid_runs: 4 } } };
    const tree = (name: string) => ({ root: join(workdir, name), files: [{ path: "src/counter.js", sha256: sha(new TextEncoder().encode(name)) }] });
    const unpacked: UnpackedPair = {
      bug_case_sha256: "1".repeat(64), validator_sha256: "2".repeat(64), pair_sha256: "3".repeat(64),
      states: { clean: tree("clean"), buggy: tree("buggy"), fixed: tree("fixed") },
      evaluator: { root: join(workdir, "evaluator"), files: [{ path: "verify.js", sha256: "4".repeat(64) }] },
      protocol,
    };
    const plans = adapter.copyPlans("buggy", unpacked, protocol);
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(validateContract("CopyPlan", plan)).toEqual([]);
      expect(plan.state).toBe("buggy");
      expect(plan.files).toEqual(unpacked.states.buggy.files);
      expect(plan.evaluator_files).toEqual(unpacked.evaluator.files);
      expect(plan.image.digest).toBe(entry.environment.kit_image_digest);
    }
    expect(new Set(plans.map((plan) => plan.copy_id)).size).toBe(2);
  });
});

describe("synthetic collect", () => {
  const plan = (state: CopyState): CopyPlan => ({
    copy_id: `synthetic-${state}-1`, host_id: "task-report", state,
    image: { reference: "registry.invalid/synthetic/task-report-kit:1", digest: null },
    files: [], evaluator_files: [],
    destinations: { app: "/rbw/app", evaluator: "/rbw/evaluator", results: "/rbw/results" },
    command: ["node"], limits: { timeout_s: 10, vcpus: 1, memory_mb: 256, network: "none" },
  });
  const collected = (fields: Partial<CollectedCopy>): CollectedCopy => ({
    copy_id: "synthetic-buggy-1", outcome: "ran", exit_code: 0, results_dir: null,
    image_digest: `sha256:${"b".repeat(64)}`, architecture: "amd64",
    started_at: "2026-10-19T12:00:00.000Z", finished_at: "2026-10-19T12:00:05.000Z", results_sha256: null, ...fields,
  });
  async function results(record: unknown): Promise<string> {
    const dir = await mkdtemp(join(workdir, "results-"));
    await writeFile(join(dir, "copy.json"), JSON.stringify(record));
    return dir;
  }
  const suite = syntheticBaseline("task-report").original_suite.sha256;
  const round = (failing: string[], ok: boolean) => ({ original_suite: { executed: 3, failing_test_ids: failing }, verification: { ok, failure_code: ok ? null : "acknowledged_completion_not_counted" } });

  it("turns a setup failure into an invalid record and a timeout into an incomplete one, never an observation", async () => {
    const adapter = syntheticAdapter({ workdir });
    const failed = await adapter.collect(plan("buggy"), collected({ outcome: "setup_failed", exit_code: null }));
    expect(failed.status).toBe("invalid");
    expect([failed.original_suite.observed, failed.verification.observed]).toEqual(["error", "error"]);
    const late = await adapter.collect(plan("buggy"), collected({ outcome: "timed_out", exit_code: null }));
    expect(late.status).toBe("incomplete");
    expect(late.verification.observed).toBe("incomplete");
    expect(validateContract("CopyRecord", failed)).toEqual([]);
  });

  it("reads the copy driver's rounds and keeps the collected results hash as evidence", async () => {
    const adapter = syntheticAdapter({ workdir });
    const dir = await results({ format: "synthetic-copy/1", suite_sha256: suite, rounds: [round([], false), round([], false)] });
    const record = await adapter.collect(plan("buggy"), collected({ results_dir: dir, results_sha256: "c".repeat(64) }));
    expect(record.status).toBe("complete");
    expect(record.original_suite.observed).toBe("pass");
    expect(record.verification).toMatchObject({ observed: "fail", runs_valid: 2, runs_total: 2, failure_codes: ["acknowledged_completion_not_counted"] });
    expect(record.evidence_sha256).toBe("c".repeat(64));
    expect(validateContract("CopyRecord", record)).toEqual([]);
  });

  it("refuses a record from another original suite, a missing record and a failed driver", async () => {
    const adapter = syntheticAdapter({ workdir });
    const other = await results({ format: "synthetic-copy/1", suite_sha256: "0".repeat(64), rounds: [round([], true)] });
    expect((await adapter.collect(plan("clean"), collected({ results_dir: other, results_sha256: "c".repeat(64) }))).status).toBe("invalid");
    const empty = await mkdtemp(join(workdir, "empty-"));
    expect((await adapter.collect(plan("clean"), collected({ results_dir: empty, results_sha256: "c".repeat(64) }))).status).toBe("invalid");
    expect((await adapter.collect(plan("clean"), collected({ exit_code: 1 }))).status).toBe("invalid");
  });
});

describe("synthetic interpret", () => {
  const adapter = syntheticAdapter({ seeds: ["01"], workdir: tmpdir() });
  const entry = adapter.catalog()[0];
  if (entry === undefined) throw new Error("no entry");
  const protocol = adapter.protocol(entry);

  it("passes both cells when every valid run passes", () => {
    const cells = adapter.interpret([record("clean")], protocol);
    expect(cells.original_suite.observed).toBe("pass");
    expect(cells.verification.observed).toBe("pass");
    expect(cells.verification.runs_valid).toBe(2);
  });

  it("reports a detected failure with its failure codes", () => {
    const failing = record("buggy", {
      verification: { observed: "fail", runs_valid: 2, runs_total: 2, failure_codes: ["acknowledged_completion_not_counted"], detail: "" },
    });
    const cells = adapter.interpret([failing], protocol);
    expect(cells.verification.observed).toBe("fail");
    expect(cells.verification.failure_codes).toEqual(["acknowledged_completion_not_counted"]);
    expect(cells.original_suite.observed).toBe("pass");
  });

  it("turns an invalid copy into error, never into a pass or fail", () => {
    const cells = adapter.interpret([record("clean", { status: "invalid" })], protocol);
    expect(cells.original_suite.observed).toBe("error");
    expect(cells.verification.observed).toBe("error");
  });

  it("marks a state incomplete when fewer runs were valid than the protocol requires, or no copy ran", () => {
    const cells = adapter.interpret([record("clean", {}, { valid: 1, total: 2 })], protocol);
    expect(cells.original_suite.observed).toBe("incomplete");
    expect(cells.verification.observed).toBe("incomplete");
    expect(adapter.interpret([], protocol).verification.observed).toBe("incomplete");
    expect(adapter.interpret([record("clean", { status: "incomplete" })], protocol).verification.observed).toBe("incomplete");
  });
});
