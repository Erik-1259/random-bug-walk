// The fake copy runner and the fake adapter's collect, driven through the copy runner convention:
// copyPlans, then run and collect for each copy, then interpret after the last copy of a state. The
// driver below stands in for the package tool's harness (synthetic).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateContract } from "@rbw/factory-contract/validate";
import type { CatalogEntry, CollectedCopy, CopyRecord, CopyState, FileSet, UnpackedPair } from "@rbw/factory-contract";
import { afterEach, describe, expect, it } from "vitest";
import { criteriaCatalogV1 } from "../src/criteria.ts";
import type { CellMatrix } from "../src/ports.ts";
import { FakeHostAdapter, fixtureRegistry, parseSyntheticCopyId, syntheticSha } from "../src/testing/catalog.ts";
import { UncertainOutcomeError, matrixOf, qualifyingPlan } from "../src/testing/harness.ts";
import { FakeCopyRunner, scenarioCopyRunner } from "../src/testing/runner.ts";
import { declaredCodes, scenarioSetup } from "../src/testing/scenarios.ts";
import { cellVerdict } from "../src/verdict.ts";

const dirs: string[] = [];
const fresh = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileSet(files: Record<string, string>): FileSet {
  const root = fresh("rbw-factory-tree-");
  const listed = Object.entries(files).map(([path, text]) => {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    return { path, sha256: createHash("sha256").update(text).digest("hex") };
  });
  return { root, files: listed };
}

function unpacked(adapter: FakeHostAdapter, entry: CatalogEntry): UnpackedPair {
  return {
    bug_case_sha256: syntheticSha(`bug-case:${entry.entry_id}`),
    validator_sha256: syntheticSha(`validator:${entry.entry_id}`),
    pair_sha256: syntheticSha(`pair:${entry.entry_id}`),
    states: {
      clean: fileSet({ "src/synthetic/target.ts": "export const clean = true;\n" }),
      buggy: fileSet({ "src/synthetic/target.ts": "export const clean = false;\n" }),
      fixed: fileSet({ "src/synthetic/target.ts": "export const clean = true; // fixed\n" }),
    },
    evaluator: fileSet({ "checks/synthetic-check.ts": "export {};\n" }),
    protocol: adapter.protocol(),
  };
}

/** Runs every copy of every state as the convention says and returns the records and the matrix. */
async function drive(adapter: FakeHostAdapter, runner: FakeCopyRunner, pair: UnpackedPair): Promise<{ collected: CollectedCopy[]; records: CopyRecord[]; matrix: CellMatrix }> {
  const protocol = adapter.protocol();
  const collected: CollectedCopy[] = [];
  const records: CopyRecord[] = [];
  for (const state of ["clean", "buggy", "fixed"] as CopyState[]) {
    for (const plan of adapter.copyPlans(state, pair, protocol)) {
      expect(validateContract("CopyPlan", plan)).toEqual([]);
      const copy = await runner.run(plan, { app_root: pair.states[state].root, evaluator_root: pair.evaluator.root });
      collected.push(copy);
      records.push(await adapter.collect(plan, copy));
    }
  }
  return { collected, records, matrix: matrixOf(records, (stateRecords) => adapter.interpret(stateRecords)) };
}

const catalog = criteriaCatalogV1();
const now = () => new Date("2026-10-20T14:00:00.000Z");

describe("the fake copy runner and collect (synthetic)", () => {
  it("follows the runner convention and gives a qualifying matrix for a qualifying plan", async () => {
    const setup = scenarioSetup("two-host-fulfilled", catalog);
    const adapter = setup.registry[0];
    const entry = adapter?.entries[0];
    if (adapter === undefined || entry === undefined) throw new Error("no task-report fake");
    const runner = scenarioCopyRunner(setup, { now, resultsBase: fresh("rbw-factory-results-") });
    const { collected, records, matrix } = await drive(adapter, runner, unpacked(adapter, entry));
    for (const copy of collected) expect(validateContract("CollectedCopy", copy)).toEqual([]);
    for (const record of records) expect(validateContract("CopyRecord", record)).toEqual([]);
    expect(records.every((record, index) => record.evidence_sha256 === collected[index]?.results_sha256)).toBe(true);
    expect(matrix.verification.buggy).toMatchObject({ observed: "fail", failure_codes: declaredCodes(catalog, entry) });
    expect(cellVerdict({ matrix, records, stopped: false, integrity: "verified" })).toEqual({ kind: "matched" });
    expect(runner.runs.map((run) => run.outcome)).toEqual(["ran", "ran", "ran"]);
  });

  it("treats a file whose sha256 does not match as a setup failure, collected as invalid with no evidence", async () => {
    const adapter = fixtureRegistry()[0];
    const entry = adapter?.entries[0];
    if (adapter === undefined || entry === undefined) throw new Error("no task-report fake");
    const pair = unpacked(adapter, entry);
    writeFileSync(join(pair.states.buggy.root, "src", "synthetic", "target.ts"), "tampered\n");
    const runner = new FakeCopyRunner({ now, resultsBase: fresh("rbw-factory-results-"), outcome: () => ({ kind: "ran", cell: { original_suite: "pass", verification: "pass" } }) });
    const { collected, records, matrix } = await drive(adapter, runner, pair);
    expect(collected[1]).toMatchObject({ outcome: "setup_failed", results_dir: null, results_sha256: null, exit_code: null });
    expect(records[1]).toMatchObject({ status: "invalid", evidence_sha256: null });
    expect(validateContract("CopyRecord", records[1])).toEqual([]);
    expect(cellVerdict({ matrix, records, stopped: false, integrity: "verified" })).toEqual({ kind: "ended", verdict: "invalid", reason: "setup_failed" });
  });

  it("collects a timed-out copy as incomplete and a copy with no readable result as invalid", async () => {
    const adapter = fixtureRegistry()[0];
    const entry = adapter?.entries[0];
    if (adapter === undefined || entry === undefined) throw new Error("no task-report fake");
    const timedOut = new FakeCopyRunner({ now, resultsBase: fresh("rbw-factory-results-"), outcome: () => ({ kind: "timed_out" }) });
    const { records } = await drive(adapter, timedOut, unpacked(adapter, entry));
    expect(records.map((record) => record.status)).toEqual(["incomplete", "incomplete", "incomplete"]);
    const plan = adapter.copyPlans("clean", unpacked(adapter, entry), adapter.protocol())[0];
    if (plan === undefined) throw new Error("no plan");
    const empty = fresh("rbw-factory-empty-");
    const record = await adapter.collect(plan, { copy_id: plan.copy_id, outcome: "ran", exit_code: 0, results_dir: empty, image_digest: entry.environment.kit_image_digest, architecture: "amd64", started_at: now().toISOString(), finished_at: now().toISOString(), results_sha256: "ab".repeat(32) });
    expect(record.status).toBe("invalid");
  });

  it("rejects for an uncertain provider outcome and records it", async () => {
    const setup = scenarioSetup("uncertain-provider", catalog);
    const adapter = setup.registry[0];
    const entry = adapter?.entries[0];
    if (adapter === undefined || entry === undefined) throw new Error("no task-report fake");
    const runner = scenarioCopyRunner(setup, { now, resultsBase: fresh("rbw-factory-results-") });
    await expect(drive(adapter, runner, unpacked(adapter, entry))).rejects.toBeInstanceOf(UncertainOutcomeError);
    expect(runner.runs.map((run) => [parseSyntheticCopyId(run.copy_id), run.outcome])).toEqual([[{ entry_id: entry.entry_id, state: "clean", n: 1 }, "uncertain"]]);
  });

  it("needs entryOf to plan an adapter with several entries, and names the entry and the pair in each copy ID", () => {
    const registry = fixtureRegistry({ duplicate_defect: true });
    const several = registry[0];
    const second = several?.entries[1];
    if (several === undefined || second === undefined) throw new Error("no duplicate-defect fake");
    const pair = unpacked(several, second);
    expect(() => several.copyPlans("clean", pair, several.protocol())).toThrow(/entryOf/);
    const mapped = new FakeHostAdapter({ host_id: "task-report", entries: several.entries, entryOf: () => second });
    const [plan] = mapped.copyPlans("buggy", pair, mapped.protocol());
    expect(plan?.copy_id).toBe(`${second.entry_id}-${pair.pair_sha256.slice(0, 12)}-buggy-1`);
    expect(parseSyntheticCopyId(plan?.copy_id ?? "")).toEqual({ entry_id: second.entry_id, state: "buggy", n: 1 });
    expect(parseSyntheticCopyId(`${second.entry_id}-fixed-2`)).toEqual({ entry_id: second.entry_id, state: "fixed", n: 2 });
  });

  it("counts a scenario's copies per run of an entry, so a second run sees the same outcome", async () => {
    const setup = scenarioSetup("uncertain-provider", catalog);
    const adapter = setup.registry[0];
    const entry = adapter?.entries[0];
    if (adapter === undefined || entry === undefined) throw new Error("no task-report fake");
    const runner = scenarioCopyRunner(setup, { now, resultsBase: fresh("rbw-factory-results-") });
    await expect(drive(adapter, runner, unpacked(adapter, entry))).rejects.toBeInstanceOf(UncertainOutcomeError);
    await expect(drive(adapter, runner, unpacked(adapter, entry))).rejects.toBeInstanceOf(UncertainOutcomeError);
    expect(runner.runs.map((run) => run.outcome)).toEqual(["uncertain", "uncertain"]);
  });

  it("gives the zero-result scenario's rejection through the runner path", async () => {
    const setup = scenarioSetup("zero-result", catalog);
    const adapter = setup.registry[1];
    const entry = adapter?.entries[0];
    if (adapter === undefined || entry === undefined) throw new Error("no Umami fake");
    const runner = scenarioCopyRunner(setup, { now, resultsBase: fresh("rbw-factory-results-") });
    const { records, matrix } = await drive(adapter, runner, unpacked(adapter, entry));
    expect(cellVerdict({ matrix, records, stopped: false, integrity: "verified" })).toEqual({ kind: "ended", verdict: "rejected", reason: "original_suite_caught_bug" });
  });

  it("gives the same cells as the fake harness for the same plan", async () => {
    const adapter = new FakeHostAdapter({ host_id: "task-report", entries: fixtureRegistry()[0]?.entries ?? [] });
    const entry = adapter.entries[0];
    if (entry === undefined) throw new Error("no entry");
    const plan = qualifyingPlan(declaredCodes(catalog, entry));
    const runner = new FakeCopyRunner({ now, resultsBase: fresh("rbw-factory-results-"), outcome: (copy) => ({ kind: "ran", cell: plan[copy.state] }) });
    const { matrix } = await drive(adapter, runner, unpacked(adapter, entry));
    const strip = (m: CellMatrix) => JSON.parse(JSON.stringify(m, (key, value: unknown) => (key === "detail" ? undefined : value))) as unknown;
    const expected = matrixOf(
      (["clean", "buggy", "fixed"] as CopyState[]).map((state) => ({
        copy_id: state,
        state,
        status: "complete" as const,
        original_suite: { observed: "pass" as const, runs_valid: 3, runs_total: 3, failure_codes: [], detail: "", executed: 48, expected: 48, failing_test_ids: [], suite_sha256: "5a".repeat(32) },
        verification: { observed: plan[state].verification, runs_valid: 5, runs_total: 5, failure_codes: plan[state].failure_codes ?? [], detail: "" },
        image_digest: entry.environment.kit_image_digest,
        architecture: "amd64" as const,
        started_at: now().toISOString(),
        finished_at: now().toISOString(),
        evidence_sha256: null,
      })),
      (records) => adapter.interpret(records),
    );
    expect(strip(matrix)).toEqual(strip(expected));
  });
});
