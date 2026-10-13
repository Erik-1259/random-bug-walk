import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRunIds } from "@rbw/local-runner";
import { runJob } from "../../src/controller.ts";
import { DEVELOPMENT, JUDGE } from "../../src/limits.ts";
import { GRADING_POLICY_ID } from "../../src/attempt.ts";
import { UsageError, judgeFixed, ledgerTarget, parseRunIds, parseTrials, runJobInputs } from "../../src/run-options.ts";
import type { Values } from "../../src/run-options.ts";
import { ATTEMPT_PROJECT_ID, attemptPolicy } from "../support/attempt.ts";
import { jobInputs, uuids, world } from "../support/harness.ts";
import type { World } from "../support/harness.ts";
import { ALTERNATIVE, CLEAN, sha256, tempDir } from "../../../local-runner/test/support/synthetic.ts";

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

async function testWorld(): Promise<World> {
  const w = await world();
  worlds.push(w);
  return w;
}

/** The options a `run` command parses, from a world's synthetic inputs, on the Docker backend. */
function values(w: World, extra: Values): Values {
  const base = jobInputs(w);
  return { work: base.work, image: base.image, manifest: base.manifest, terms: base.terms, "kit-stage": base.kitStage, backend: "docker", ...extra };
}

function rootIds(projectId?: string) {
  const ids = newRunIds(uuids("8100"));
  return projectId === undefined ? ids : { ...ids, project_id: projectId };
}

describe("--ledger", () => {
  it("keeps today's default: the judge allocation and slot for judge_verify, the development pool and slot otherwise", () => {
    expect(ledgerTarget(undefined, "judge_verify")).toBe(JUDGE);
    for (const kind of ["kit_check", "observe", "admission"] as const) expect(ledgerTarget(undefined, kind)).toBe(DEVELOPMENT);
  });

  it("runs judge_verify on the development pool and slot with --ledger development", () => {
    expect(ledgerTarget("development", "judge_verify")).toBe(DEVELOPMENT);
    expect(ledgerTarget("judge", "judge_verify")).toBe(JUDGE);
  });

  it("refuses the judge ledger for any other kind, and any other value", () => {
    expect(() => ledgerTarget("judge", "admission")).toThrow(UsageError);
    expect(() => ledgerTarget("judge-demo", "judge_verify")).toThrow("--ledger must be development or judge");
  });

  it("never acquires the judge slot or charges the judge allocation for a judge_verify job on --ledger development", async () => {
    const w = await testWorld();
    // The reference fix, so the copy needs no projection audit of an alternative fix.
    const job = runJobInputs(values(w, { "job-kind": "judge_verify", ledger: "development", trials: "fixed-01", "judge-fixed": "fixed", name: "grade-1" }));
    const outcome = await runJob({ ...job, probesDir: jobInputs(w).probesDir, alternativeDir: jobInputs(w).alternativeDir }, w.deps);
    expect(outcome.status).toBe("complete");
    expect(outcome.summary.controller).toMatchObject({ pool_key: "development", allocation_key: null, slot_key: "development" });
    const slots = w.ledgerCalls.filter((call) => call.method === "acquireSlot" || call.method === "releaseSlot").map((call) => (call.request as { slot_key: string }).slot_key);
    expect(slots).toEqual(["development", "development"]);
    const reserves = w.ledgerCalls.filter((call) => call.method === "reserve").map((call) => call.request as { pool_key: string; allocation_key: string | null });
    expect(reserves).toEqual([expect.objectContaining({ pool_key: "development", allocation_key: null })]);
    const judgeSlot = await w.spend.slotStatus({ slot_key: "judge" });
    expect(judgeSlot.ok && judgeSlot.holder).toBe(null);
    const pool = await w.spend.poolStatus({ pool_key: "judge-demo" });
    expect(pool.ok && pool.allocations.find((item) => item.allocation_key === "judge")).toMatchObject({ settled_microusd: 0n, open_microusd: 0n });
  });
});

describe("--trials", () => {
  it("parses a comma-separated subset, and null when absent", () => {
    expect(parseTrials(undefined)).toBeNull();
    expect(parseTrials("fixed-01")).toEqual(["fixed-01"]);
    expect(parseTrials("clean-01,fixed-01")).toEqual(["clean-01", "fixed-01"]);
  });

  it("refuses an empty entry, a malformed ID or a repeated trial", () => {
    for (const bad of ["", "fixed-01,", "Fixed-01", "fixed-01 ", "fixed-01,fixed-01"]) expect(() => parseTrials(bad)).toThrow(UsageError);
  });

  it("runs only the named trials instead of the whole profile", async () => {
    const w = await testWorld();
    const job = runJobInputs(values(w, { "job-kind": "judge_verify", ledger: "development", trials: "fixed-01" }));
    expect(job.trials).toEqual(["fixed-01"]);
    const outcome = await runJob({ ...job, probesDir: jobInputs(w).probesDir, alternativeDir: jobInputs(w).alternativeDir }, w.deps);
    expect(outcome.summary.copies.map((copy) => copy.trial_id)).toEqual(["fixed-01"]);
  });
});

describe("--probes-dir", () => {
  it("passes the case's probe directory to the job, which grades with it", async () => {
    const w = await testWorld();
    const probes = jobInputs(w).probesDir;
    if (probes === undefined) throw new Error("the synthetic world names a probe directory");
    const job = runJobInputs(values(w, { "job-kind": "judge_verify", ledger: "development", trials: "fixed-01", "judge-fixed": "fixed", "probes-dir": probes }));
    expect(job.probesDir).toBe(probes);
    const outcome = await runJob({ ...job, alternativeDir: jobInputs(w).alternativeDir }, w.deps);
    expect(outcome.status).toBe("complete");
  });

  it("leaves the local runner's default probe set when absent", async () => {
    const w = await testWorld();
    expect(runJobInputs(values(w, { "job-kind": "kit_check" }))).not.toHaveProperty("probesDir");
  });
});

describe("--ids and --project-policy", () => {
  it("shares the root's IDs with the job", async () => {
    const w = await testWorld();
    const ids = rootIds();
    const file = join(w.dir, "ids.json");
    writeFileSync(file, JSON.stringify(ids));
    const job = runJobInputs(values(w, { "job-kind": "kit_check", trials: "clean-01", ids: file }));
    expect(job.ids).toEqual(ids);
    const outcome = await runJob({ ...job, probesDir: jobInputs(w).probesDir, alternativeDir: jobInputs(w).alternativeDir }, w.deps);
    expect(outcome.summary.job.root_execution_id).toBe(ids.root_execution_id);
    expect(outcome.summary.job.execution_id).toBe(ids.executions["kit-check"]);
  });

  it("refuses IDs that are not a root's RunIds", () => {
    const ids = rootIds();
    const bad: unknown[] = [{ ...ids, run_tag: "00000000" }, { ...ids, extra: 1 }, { ...ids, executions: { ...ids.executions, observe: "not-a-uuid" } }, { ...ids, batch_id: ids.batch_id.replaceAll("0", "A") }];
    for (const value of bad) expect(() => parseRunIds(Buffer.from(JSON.stringify(value)))).toThrow(UsageError);
    expect(() => parseRunIds(Buffer.from("{"))).toThrow("--ids is not JSON");
    expect(parseRunIds(Buffer.from(JSON.stringify(ids)))).toEqual(ids);
  });

  it("records the policy's hash under the grading policy ID, with IDs naming its project", async () => {
    const w = await testWorld();
    const policy = attemptPolicy(w.dir);
    const file = join(w.dir, "ids.json");
    writeFileSync(file, JSON.stringify(rootIds(ATTEMPT_PROJECT_ID)));
    const job = runJobInputs(values(w, { "job-kind": "judge_verify", ledger: "development", ids: file, "project-policy": policy.file }));
    expect(job.projectPolicy).toEqual({ sha256: policy.sha256, policy_id: GRADING_POLICY_ID });
  });

  it("refuses a policy without IDs, with IDs for another project, or naming the placeholder project", () => {
    const dir = tempDir("rbw-cli-test-");
    const policy = attemptPolicy(dir);
    const other = join(dir, "other-ids.json");
    writeFileSync(other, JSON.stringify(rootIds()));
    const base: Values = { "job-kind": "judge_verify", work: join(dir, "run"), image: "x", manifest: "m", terms: "t", "kit-stage": "k", backend: "docker" };
    expect(() => runJobInputs({ ...base, "project-policy": policy.file })).toThrow("--project-policy needs --ids naming the policy's project");
    expect(() => runJobInputs({ ...base, ids: other, "project-policy": policy.file })).toThrow("--project-policy needs --ids naming the policy's project");
    const placeholder = attemptPolicy(tempDir("rbw-cli-test-"), rootIds().project_id);
    expect(() => runJobInputs({ ...base, ids: other, "project-policy": placeholder.file })).toThrow("placeholder");
  });
});

describe("--judge-fixed", () => {
  it("parses fixed or alternative_fix for judge_verify only, and nothing when absent", () => {
    expect(judgeFixed(undefined, "judge_verify")).toBeNull();
    expect(judgeFixed("fixed", "judge_verify")).toBe("fixed");
    expect(judgeFixed("alternative_fix", "judge_verify")).toBe("alternative_fix");
    expect(() => judgeFixed("fixed", "admission")).toThrow("--judge-fixed is only for --job-kind judge_verify");
    expect(() => judgeFixed("clean", "judge_verify")).toThrow("--judge-fixed must be fixed or alternative_fix");
  });

  it("grades the clean file's exact bytes as fixed-01 with --judge-fixed fixed, and the alternative fix without it", async () => {
    const w = await testWorld();
    const trials = { "job-kind": "judge_verify", ledger: "development", trials: "clean-01,fixed-01" };
    const synthetic = { probesDir: jobInputs(w).probesDir, alternativeDir: jobInputs(w).alternativeDir };
    const reference = await runJob({ ...runJobInputs(values(w, { ...trials, "judge-fixed": "fixed", name: "grade-clean" })), ...synthetic }, w.deps);
    const alternative = await runJob({ ...runJobInputs(values(w, { ...trials, name: "grade-alternative" })), ...synthetic }, w.deps);
    const placed = (outcome: typeof reference, id: string) => outcome.summary.copies.find((copy) => copy.trial_id === id)?.copy?.placed_sha256;
    expect(reference.status).toBe("complete");
    expect(placed(reference, "fixed-01")).toBe(sha256(CLEAN));
    expect(reference.summary.import.trials.find((trial) => trial.trial_id === "fixed-01")).toMatchObject({ status: "complete", added_verdict: "match", original_failed: 0 });
    expect(placed(alternative, "fixed-01")).toBe(sha256(ALTERNATIVE));
  });

  it("refuses, rather than replays, a stored grade when the same job is asked to grade the other code state", async () => {
    const w = await testWorld();
    const trials = { "job-kind": "judge_verify", ledger: "development", trials: "fixed-01", name: "grade-1" };
    const synthetic = { probesDir: jobInputs(w).probesDir, alternativeDir: jobInputs(w).alternativeDir };
    const reference = await runJob({ ...runJobInputs(values(w, { ...trials, "judge-fixed": "fixed" })), ...synthetic }, w.deps);
    expect(reference.status).toBe("complete");
    await expect(runJob({ ...runJobInputs(values(w, trials)), ...synthetic }, w.deps)).rejects.toThrow(/holds another job/);
  });
});

describe("the command line", () => {
  it("refuses the new options for the judge controller, exiting 2 before anything runs", () => {
    for (const extra of [["--ledger", "development"], ["--trials", "fixed-01"], ["--ids", "ids.json"], ["--project-policy", "policy.json"], ["--judge-fixed", "fixed"], ["--probes-dir", "probes"]]) {
      const result = spawnSync(process.execPath, [CLI, "run", "--job-kind", "judge_verify", "--prebuilt", "store", ...extra], { encoding: "utf8", env: {} });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${extra[0] ?? ""} is not for the judge controller`);
    }
  });

  it("names a bad --ledger value and exits 2", () => {
    const result = spawnSync(process.execPath, [CLI, "run", "--job-kind", "judge_verify", "--ledger", "judge-demo", "--work", "w", "--image", "i", "--manifest", "m", "--terms", "t", "--kit-stage", "k", "--backend", "docker"], { encoding: "utf8", env: {} });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--ledger must be development or judge");
  });
});
