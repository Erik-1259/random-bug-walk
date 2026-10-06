import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRIAL_PROFILES, parseRecord, sha256Hex } from "@rbw/schema";
import { loadProbeSet } from "@rbw/shapes";
import { loadFixture } from "@rbw/umami-fixture";
import { deriveCodeStates, loadAlternativeFix } from "../../src/code-states.ts";
import { BASELINE_KEY, JobRefusal, buildJob, checkBaseline, expectedVectors, newRunIds, writeJobDir } from "../../src/jobs.ts";
import type { JobContext } from "../../src/jobs.ts";
import { importJob } from "../../src/records.ts";
import { CLEAN, MUTATION_PATCH, PARTIAL_PATCH, STUB_PATCH, sha256, tempDir, writeAlternativeDir, writeProbeDir } from "../support/synthetic.ts";

let counter = 0;
function syntheticUuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

function context(): JobContext {
  const probes = loadProbeSet(writeProbeDir());
  const states = deriveCodeStates(Buffer.from(CLEAN), probes, loadAlternativeFix(writeAlternativeDir()));
  return {
    ids: newRunIds(syntheticUuid),
    imageDigest: `sha256:${"c".repeat(64)}`,
    kitSha256: "d".repeat(64),
    fixtureSha256: "e".repeat(64),
    addedSuiteSha256: "f".repeat(64),
    originalSuite: { sha256: "a".repeat(64), testIds: ["synthetic-test-a", "synthetic-test-b"] },
    states,
    vectors: expectedVectors(loadFixture(), probes),
    profileSha256: "b".repeat(64),
    deadlineAt: "2026-10-06T21:00:00Z",
  };
}

function trialsOf(kind: keyof typeof TRIAL_PROFILES) {
  return TRIAL_PROFILES[kind].trials.map((trial) => [trial.trial_id, trial.code_state, trial.added_repeat_count]);
}

describe("jobs built with the shared schema's builders", () => {
  const ctx = context();

  it("builds the kit check: 5 clean copies, 20 rounds in the first, the frozen original suite in each", () => {
    const job = buildJob("kit-check", ctx);
    const request = parseRecord("JobRequest", job.requestBytes);
    const expected = parseRecord("ExpectedTrials", job.expectedBytes, { request });
    expect(request.kind).toBe("kit_check");
    expect(request.expected_trials_sha256).toBe(sha256Hex(job.expectedBytes));
    expect(request.baseline_evidence_key).toBeNull();
    expect(expected.trials.map((trial) => [trial.trial_id, trial.code_state, trial.added_repeat_count])).toEqual(trialsOf("kit_check"));
    expect(expected.trials.every((trial) => trial.original_suite_sha256 === "a".repeat(64))).toBe(true);
    expect(expected.trials[0]?.original_test_ids).toEqual(["synthetic-test-a", "synthetic-test-b"]);
    expect(expected.trials.every((trial) => trial.added_suite_sha256 === "f".repeat(64) && trial.patch_sha256 === null)).toBe(true);
    expect(expected.trials[0]?.expected_checks).toEqual(ctx.vectors.clean);
  });

  it("builds the observation: one planted copy, the four added checks once, no original suite, and the kit-check baseline", () => {
    const job = buildJob("observe", ctx, { key: BASELINE_KEY, sha256: "1".repeat(64) });
    const request = parseRecord("JobRequest", job.requestBytes);
    const expected = parseRecord("ExpectedTrials", job.expectedBytes, { request });
    expect(request.kind).toBe("observe");
    expect([request.baseline_evidence_key, request.baseline_evidence_sha256]).toEqual([BASELINE_KEY, "1".repeat(64)]);
    expect(expected.trials).toHaveLength(1);
    expect(expected.trials[0]).toMatchObject({ trial_id: "planted-01", code_state: "planted", added_repeat_count: 1, original_suite_sha256: null, original_test_ids: [] });
    expect(expected.trials[0]?.patch_sha256).toBe(sha256(MUTATION_PATCH));
    expect(expected.trials[0]?.expected_checks).toEqual(ctx.vectors.planted);
  });

  it("refuses to build an observation without a baseline", () => {
    expect(() => buildJob("observe", ctx)).toThrow(JobRefusal);
  });

  it("builds admission per ADM-02 to ADM-06: 13 copies, 20 rounds only in fixed-01 and planted-01", () => {
    const job = buildJob("admission", ctx);
    const request = parseRecord("JobRequest", job.requestBytes);
    const expected = parseRecord("ExpectedTrials", job.expectedBytes, { request });
    expect(request.kind).toBe("admission");
    expect(expected.trials.map((trial) => [trial.trial_id, trial.code_state, trial.added_repeat_count])).toEqual(trialsOf("admission"));
    expect(expected.trials.filter((trial) => trial.added_repeat_count === 20).map((trial) => trial.trial_id)).toEqual(["fixed-01", "planted-01"]);
    const patch = (state: string) => expected.trials.find((trial) => trial.code_state === state)?.patch_sha256;
    expect(patch("planted")).toBe(sha256(MUTATION_PATCH));
    expect(patch("partial")).toBe(sha256(PARTIAL_PATCH));
    expect(patch("stub")).toBe(sha256(STUB_PATCH));
    expect(patch("fixed")).toBe(ctx.states.get("fixed")?.patch_sha256);
    expect(expected.trials.every((trial) => trial.original_suite_sha256 === "a".repeat(64))).toBe(true);
    const vector = (id: string) => expected.trials.find((trial) => trial.trial_id === id)?.expected_checks;
    expect(vector("partial-01")).toEqual(ctx.vectors.partial);
    expect(vector("stub-01")).toEqual(ctx.vectors.stub);
    expect(vector("fixed-03")).toEqual(ctx.vectors.fixed);
  });

  it("builds the alternative fix as a separate development job whose fixed trial names the alternative patch", () => {
    const job = buildJob("alternative-fix", ctx);
    const request = parseRecord("JobRequest", job.requestBytes);
    const expected = parseRecord("ExpectedTrials", job.expectedBytes, { request });
    expect(request.kind).toBe("judge_verify");
    expect(request.release_id).not.toBeNull();
    const fixed = expected.trials.find((trial) => trial.trial_id === "fixed-01");
    expect(fixed?.patch_sha256).toBe(ctx.states.get("alternative_fix")?.patch_sha256);
    expect(fixed?.expected_checks).toEqual(ctx.vectors.fixed);
  });

  it("gives each job its own execution under one root, and the same task revision to observe and admission", () => {
    const jobs = (["kit-check", "admission", "alternative-fix"] as const).map((label) => parseRecord("JobRequest", buildJob(label, ctx).requestBytes));
    const observe = parseRecord("JobRequest", buildJob("observe", ctx, { key: BASELINE_KEY, sha256: "1".repeat(64) }).requestBytes);
    const all = [...jobs, observe];
    expect(new Set(all.map((request) => request.execution_id)).size).toBe(4);
    expect(new Set(all.map((request) => request.root_execution_id)).size).toBe(1);
    expect(all.every((request) => request.parent_execution_id === request.root_execution_id)).toBe(true);
    expect(observe.task_revision).toBe(jobs[1]?.task_revision);
    expect(jobs[0]?.task_revision).not.toBe(observe.task_revision);
  });

  it("takes the expected vectors from the fixture and refuses probes whose recorded vector disagrees", () => {
    const fixture = loadFixture();
    const vectors = expectedVectors(fixture, loadProbeSet(writeProbeDir()));
    expect(vectors.planted).toEqual(fixture.outcome_vectors.planted.map((row) => ({ check_id: row.check_id, expected: row.observed, failure_code: row.failure_code })));
    const probeDir = writeProbeDir();
    const data = JSON.parse(readFileSync(join(probeDir, "probes.json"), "utf8")) as { probes: { id: string; expected: Record<string, unknown> }[] };
    const stub = data.probes.find((probe) => probe.id === "stub");
    if (stub !== undefined) stub.expected["tzarg.la-day-counts"] = { outcome: "pass" };
    writeFileSync(join(probeDir, "probes.json"), JSON.stringify(data));
    expect(() => expectedVectors(fixture, loadProbeSet(probeDir))).toThrow(/stub/);
  });

  it("writes a job directory laid out as the driver reads it", () => {
    const dir = tempDir();
    const job = buildJob("kit-check", ctx);
    writeJobDir(join(dir, "job"), job);
    expect(readFileSync(join(dir, "job", "request.json")).equals(Buffer.from(job.requestBytes))).toBe(true);
    expect(readFileSync(join(dir, "job", ...job.request.expected_trials_key.split("/"))).equals(Buffer.from(job.expectedBytes))).toBe(true);
  });
});

describe("the observation's kit-check baseline", () => {
  const ctx = context();

  /** A run root holding the kit check's records and its imported evidence at the baseline key. */
  function baselineRoot() {
    const root = tempDir();
    const kit = buildJob("kit-check", ctx);
    const records = join(root, "jobs", "kit-check", "records");
    writeJobDir(records, kit);
    const imported = importJob(records, join(root, "jobs", "kit-check"));
    if (imported.evidence_sha256 === null) throw new Error("the synthetic kit-check records did not import");
    return { root, records, evidenceSha256: imported.evidence_sha256 };
  }

  it("accepts a baseline whose evidence file and records on disk both match the request", () => {
    const { root, evidenceSha256 } = baselineRoot();
    const observe = buildJob("observe", ctx, { key: BASELINE_KEY, sha256: evidenceSha256 });
    expect(checkBaseline(root, observe.request)).toEqual({ ok: true, key: BASELINE_KEY, sha256: evidenceSha256 });
  });

  it("refuses a missing baseline file, naming the key", () => {
    const { root, evidenceSha256 } = baselineRoot();
    rmSync(join(root, ...BASELINE_KEY.split("/")));
    const observe = buildJob("observe", ctx, { key: BASELINE_KEY, sha256: evidenceSha256 });
    expect(checkBaseline(root, observe.request)).toEqual({ ok: false, reason: "baseline_missing", detail: `no kit-check evidence at ${BASELINE_KEY}` });
  });

  it("refuses a request with no baseline at all", () => {
    const { root } = baselineRoot();
    const kit = buildJob("kit-check", ctx);
    expect(checkBaseline(root, kit.request)).toMatchObject({ ok: false, reason: "baseline_missing" });
  });

  it("refuses a baseline file whose hash differs from the request, naming both hashes", () => {
    const { root, evidenceSha256 } = baselineRoot();
    const observe = buildJob("observe", ctx, { key: BASELINE_KEY, sha256: evidenceSha256 });
    const path = join(root, ...BASELINE_KEY.split("/"));
    writeFileSync(path, `${readFileSync(path, "utf8")} `);
    const check = checkBaseline(root, observe.request);
    expect(check).toMatchObject({ ok: false, reason: "baseline_mismatch" });
    expect(check.ok ? "" : check.detail).toBe(`the request names ${evidenceSha256} but ${BASELINE_KEY} hashes to ${sha256Hex(readFileSync(path))}`);
  });

  it("refuses a baseline that no longer matches the kit-check records it was imported from", () => {
    const { root, records, evidenceSha256 } = baselineRoot();
    const observe = buildJob("observe", ctx, { key: BASELINE_KEY, sha256: evidenceSha256 });
    mkdirSync(join(records, "results", "clean-09"), { recursive: true });
    writeFileSync(join(records, "results", "clean-09", "trial-result.json"), "{}");
    const check = checkBaseline(root, observe.request);
    expect(check).toMatchObject({ ok: false, reason: "baseline_mismatch" });
    expect(check.ok ? "" : check.detail).toMatch(/^the kit-check records at jobs\/kit-check\/records import to [0-9a-f]{64}, not [0-9a-f]{64}$/);
  });
});
