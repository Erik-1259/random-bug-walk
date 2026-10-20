// collect: one copy's CopyRecord from the plan and what the runner brought back.
import type { CollectedCopy, CopyPlan, CopyState } from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";
import { afterEach, describe, expect, it } from "vitest";
import { buildUmamiAdapter } from "../src/adapter.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { UMAMI_PROTOCOL } from "../src/protocol.ts";
import { cleanupTemp, copyDraft, evaluatorTree, observe, syntheticWorld, unpackedPair, writeCopyResults } from "./support.ts";

afterEach(cleanupTemp);

const CODE = "local_day_counts_mismatch";
const RESULTS_SHA = "7".repeat(64);

function setup() {
  const world = syntheticWorld();
  const adapter = buildUmamiAdapter(world.pins);
  const pair = unpackedPair(world, evaluatorTree(world));
  const plan = (state: CopyState): CopyPlan => {
    const [found] = adapter.copyPlans(state, pair, UMAMI_PROTOCOL);
    if (found === undefined) throw new Error("no plan");
    return found;
  };
  return { world, adapter, plan };
}

function collected(plan: CopyPlan, resultsDir: string | null, overrides: Partial<CollectedCopy> = {}): CollectedCopy {
  return {
    copy_id: plan.copy_id,
    outcome: "ran",
    exit_code: 0,
    results_dir: resultsDir,
    image_digest: plan.image.digest ?? "",
    architecture: "amd64",
    started_at: "2026-10-19T12:00:00.000Z",
    finished_at: "2026-10-19T12:03:10.000Z",
    results_sha256: resultsDir === null ? null : RESULTS_SHA,
    ...overrides,
  };
}

describe("collect", () => {
  it("makes a schema-valid record of the copy's own trial, with the collected results' hash as its evidence", async () => {
    const { world, adapter, plan } = setup();
    const buggy = plan("buggy");
    const record = await adapter.collect(buggy, collected(buggy, writeCopyResults(world.job, copyDraft(world.job, "buggy"))));
    expect(validateContract("CopyRecord", record)).toEqual([]);
    expect(record).toMatchObject({
      copy_id: "buggy-01",
      state: "buggy",
      status: "complete",
      original_suite: { observed: "pass", executed: 3, expected: 3 },
      verification: { observed: "fail", failure_codes: [CODE] },
      image_digest: world.pins.kit.digest,
      architecture: "amd64",
      started_at: "2026-10-19T12:00:00.000Z",
      finished_at: "2026-10-19T12:03:10.000Z",
      evidence_sha256: RESULTS_SHA,
    });
  });

  it("reports the criterion's code only on buggy with every declared check failing with it and the control passing", async () => {
    const { world, adapter, plan } = setup();
    const buggy = plan("buggy");
    const partial = copyDraft(world.job, "buggy");
    observe(partial, "tzarg.la-day-counts", "pass", null);
    expect((await adapter.collect(buggy, collected(buggy, writeCopyResults(world.job, partial)))).verification).toMatchObject({ observed: "fail", failure_codes: [] });
    const unrelated = copyDraft(world.job, "buggy");
    observe(unrelated, "tzarg.kolkata-day-counts", "assertion_fail", "bucket_labels_mismatch");
    expect(await adapter.collect(buggy, collected(buggy, writeCopyResults(world.job, unrelated)))).toMatchObject({ status: "invalid", verification: { observed: "error", failure_codes: [] } });
    const clean = plan("clean");
    expect((await adapter.collect(clean, collected(clean, writeCopyResults(world.job, copyDraft(world.job, "clean"))))).verification).toMatchObject({ observed: "pass", failure_codes: [] });
  });

  it("makes a setup failure an invalid record with no evidence hash, as the contract's fixture shows", async () => {
    const { adapter, plan } = setup();
    const fixed = plan("fixed");
    const record = await adapter.collect(fixed, collected(fixed, null, { outcome: "setup_failed", exit_code: null }));
    expect(validateContract("CopyRecord", record)).toEqual([]);
    expect(record).toMatchObject({
      status: "invalid",
      original_suite: { observed: "error", runs_valid: 0, runs_total: 0 },
      verification: { observed: "error", runs_valid: 0, runs_total: 0, failure_codes: [] },
      evidence_sha256: null,
    });
  });

  it("makes a timed-out copy incomplete, whatever its results say", async () => {
    const { world, adapter, plan } = setup();
    const buggy = plan("buggy");
    const record = await adapter.collect(buggy, collected(buggy, writeCopyResults(world.job, copyDraft(world.job, "buggy")), { outcome: "timed_out", exit_code: null }));
    expect(validateContract("CopyRecord", record)).toEqual([]);
    expect(record).toMatchObject({ status: "incomplete", verification: { observed: "incomplete", failure_codes: [] }, evidence_sha256: RESULTS_SHA });
  });

  it("never makes a complete record without collected results", async () => {
    const { world, adapter, plan } = setup();
    const clean = plan("clean");
    const record = await adapter.collect(clean, collected(clean, writeCopyResults(world.job, copyDraft(world.job, "clean")), { results_sha256: null }));
    expect(record).toMatchObject({ status: "invalid", evidence_sha256: null });
    expect(validateContract("CopyRecord", record)).toEqual([]);
  });

  it("makes a copy that ran another image invalid", async () => {
    const { world, adapter, plan } = setup();
    const buggy = plan("buggy");
    const record = await adapter.collect(buggy, collected(buggy, writeCopyResults(world.job, copyDraft(world.job, "buggy")), { image_digest: `sha256:${"6".repeat(64)}` }));
    expect(record).toMatchObject({ status: "invalid", verification: { observed: "error", failure_codes: [] } });
  });

  it("refuses a collected copy that is not the plan's", async () => {
    const { world, adapter, plan } = setup();
    const buggy = plan("buggy");
    const results = writeCopyResults(world.job, copyDraft(world.job, "buggy"));
    await expect(adapter.collect(buggy, collected(buggy, results, { copy_id: "clean-01" }))).rejects.toThrow(UmamiRefusal);
    await expect(adapter.collect({ ...buggy, host_id: "task-report" }, collected(buggy, results))).rejects.toThrow(/copy_mismatch/);
  });

  it("feeds interpret: three collected copies give the qualification table's cells", async () => {
    const { world, adapter, plan } = setup();
    const states: CopyState[] = ["clean", "buggy", "fixed"];
    const cells = [];
    for (const state of states) {
      const current = plan(state);
      const record = await adapter.collect(current, collected(current, writeCopyResults(world.job, copyDraft(world.job, state))));
      cells.push(adapter.interpret([record], UMAMI_PROTOCOL));
    }
    expect(cells.map((item) => [item.original_suite.observed, item.verification.observed, item.verification.failure_codes])).toEqual([
      ["pass", "pass", []],
      ["pass", "fail", [CODE]],
      ["pass", "pass", []],
    ]);
  });
});
