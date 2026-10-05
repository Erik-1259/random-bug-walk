import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, sha256Hex } from "@rbw/schema";
import { RefusedInput } from "../../src/job.ts";
import { CANNED_TESTS, EXPECTED_TRIALS_KEY, FakeTimers, hex, jobFiles, tempDir } from "../helpers.ts";
import { exitCodeFor } from "../../src/trial.ts";
import { BASE_URL, FIXTURE_DIR, trial } from "../trial-harness.ts";

const SUITE_ARGS = ["test", "--config=rbw-api.config.ts", "--workers=1", "--retries=0", "--max-failures=0"];

describe("one trial", () => {
  it("builds, starts, runs the suite, resets, runs the round and stops, in that order", async () => {
    const run = await trial(tempDir());
    expect(run.events).toEqual(["build", "start", "identity", "suite", "reset 1", "round 1", "stop"]);
  });

  it("runs 20 rounds for a repeat count of 20 and writes 80 observations, complete", async () => {
    const run = await trial(tempDir(), { job: { trialId: "clean-01" } });
    expect(run.job.trial.added_repeat_count).toBe(20);
    expect(run.observations).toHaveLength(80);
    expect(run.observations.map((o) => o.repeat_index)).toEqual(Array.from({ length: 80 }, (_, i) => Math.floor(i / 4) + 1));
    expect(run.result).toMatchObject({ status: "complete", invalid_reason: null });
    expect(run.events.filter((event) => event.startsWith("reset"))).toHaveLength(20);
  });

  it("sorts each round's observations by check ID, as the shared record requires", async () => {
    const run = await trial(tempDir());
    expect(run.observations.map((o) => o.check_id)).toEqual([
      "tzarg.auckland-day-counts",
      "tzarg.kolkata-day-counts",
      "tzarg.la-day-counts",
      "tzarg.utc-day-counts",
    ]);
  });

  it("runs the suite with the frozen arguments, after the identity check, with API_ALLOW_DESTRUCTIVE=1", async () => {
    const run = await trial(tempDir());
    const suite = run.runner.calls.find((call) => call.args.includes("--config=rbw-api.config.ts"));
    expect(suite?.command).toBe("/synthetic/verifier/node/bin/node");
    expect(suite?.args.slice(1)).toEqual(SUITE_ARGS);
    expect(suite?.args[0]).toBe(join(run.outDir, "work/clean-02/suite/node_modules/@playwright/test/cli.js"));
    expect(suite?.env).toMatchObject({ API_COVERAGE: "report", API_ALLOW_DESTRUCTIVE: "1", PLAYWRIGHT_BASE_URL: BASE_URL });
    expect(suite?.env).not.toHaveProperty("API_SKIP_SEED");
    expect(run.events.indexOf("identity")).toBeLessThan(run.events.indexOf("suite"));
  });

  it("runs each round with the fixture's command and its five inputs", async () => {
    const run = await trial(tempDir());
    const round = run.runner.calls.find((call) => call.env.RBW_FIXTURE_REPEAT_INDEX === "1");
    expect(round?.args).toEqual([
      join(dirname2(run.outDir), "verifier/node_modules/@playwright/test/cli.js"),
      "test",
      "--config",
      join(FIXTURE_DIR, "playwright.config.ts"),
      "--workers=1",
      "--retries=0",
    ]);
    expect(round?.cwd).toBe(FIXTURE_DIR);
    expect(round?.env).toMatchObject({
      RBW_FIXTURE_BASE_URL: BASE_URL,
      RBW_FIXTURE_REPEAT_INDEX: "1",
      RBW_FIXTURE_OUTPUT_DIR: join(run.outDir, "work/clean-02/added/round-01/output"),
      RBW_FIXTURE_ADMIN_USERNAME: "synthetic-admin",
      RBW_FIXTURE_ADMIN_PASSWORD: "synthetic-password",
    });
  });

  it("writes the importer's record-set layout: the request, the expected trials and the trial's records", async () => {
    const run = await trial(tempDir());
    const files = jobFiles({ originalSuiteSha256: run.job.trial.original_suite_sha256, originalTestIds: run.job.trial.original_test_ids });
    expect(run.read("request.json").equals(Buffer.from(files.requestBytes))).toBe(true);
    expect(run.read(EXPECTED_TRIALS_KEY).equals(Buffer.from(run.job.expectedTrialsBytes))).toBe(true);
    expect(run.result.observations_key).toBe("results/clean-02/observations.json");
    expect(run.result.artifacts_key).toBe("results/clean-02/artifacts.json");
    expect(existsSync(join(run.outDir, "work"))).toBe(false);
  });

  it("writes records that the shared schema parses against the request, in canonical bytes", async () => {
    const run = await trial(tempDir());
    const request = run.job.request;
    expect(parseRecord("TrialResult", run.read("results/clean-02/trial-result.json"), { request })).toEqual(run.result);
    expect(parseRecord("TrialObservations", run.read("results/clean-02/observations.json"), { request })).toEqual(run.observationsRecord);
    expect(parseRecord("ArtifactManifest", run.read("results/clean-02/artifacts.json"), { request })).toEqual(run.artifacts);
    for (const key of ["results/clean-02/trial-result.json", "results/clean-02/observations.json", "results/clean-02/artifacts.json"]) {
      expect(run.canonical(key)).toBe(true);
    }
    expect(run.result).toMatchObject({
      project_policy_sha256: request.project_policy_sha256,
      root_execution_id: request.root_execution_id,
      execution_id: request.execution_id,
      task_revision: request.task_revision,
      expected_trials_sha256: request.expected_trials_sha256,
      trial_id: "clean-02",
      code_state: "clean",
    });
    expect(run.observationsRecord).toMatchObject({ schema_version: 1, execution_id: request.execution_id, trial_id: "clean-02" });
  });

  it("writes records whose hashes match their bytes, and lists every artifact with a matching hash", async () => {
    const run = await trial(tempDir());
    expect(run.result.observations_sha256).toBe(sha256Hex(run.read("results/clean-02/observations.json")));
    expect(run.result.artifacts_sha256).toBe(sha256Hex(run.read("results/clean-02/artifacts.json")));
    for (const entry of run.artifacts.entries) {
      expect(entry.key.startsWith("results/clean-02/artifacts/")).toBe(true);
      const bytes = run.read(entry.key);
      expect(sha256Hex(bytes)).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.size_bytes);
    }
    expect(new Set(run.artifacts.entries.map((entry) => entry.key)).size).toBe(run.artifacts.entries.length);
    expect(run.artifacts.entries.filter((entry) => entry.kind === "phase_timings")).toHaveLength(1);
    for (const observation of run.observations) {
      const entry = run.artifacts.entries.find((item) => item.key === observation.response_artifact_key);
      expect(entry?.sha256).toBe(observation.response_artifact_sha256);
    }
  });

  it("writes byte-identical records for identical inputs", async () => {
    const first = await trial(tempDir());
    const second = await trial(tempDir());
    for (const name of ["trial-result.json", "observations.json", "artifacts.json"]) {
      expect(second.read(`results/clean-02/${name}`).equals(first.read(`results/clean-02/${name}`))).toBe(true);
    }
  });

  it("writes one original_suite_outcomes artifact in the importer's format, with a failing test recorded as failed", async () => {
    const run = await trial(tempDir(), { original: (test) => (test.id === "synthetic0002-bbbb0003" ? "failed" : "passed") });
    expect(run.result.status).toBe("complete");
    const entries = run.artifacts.entries.filter((entry) => entry.kind === "original_suite_outcomes");
    expect(entries).toEqual([expect.objectContaining({ key: "results/clean-02/artifacts/original/outcomes.json", media_type: "application/json" })]);
    expect(run.artifact("original/outcomes.json")).toEqual({
      schema_version: 1,
      trial_id: "clean-02",
      original_suite_sha256: run.job.trial.original_suite_sha256,
      tests: CANNED_TESTS.map((test) => test.id)
        .sort()
        .map((id) => ({ test_id: id, outcome: id === "synthetic0002-bbbb0003" ? "failed" : "passed" })),
    });
    expect(run.canonical("results/clean-02/artifacts/original/outcomes.json")).toBe(true);
  });

  it("gives test_missing for a deleted spec, leaves its tests out of the outcomes and records the deleted file", async () => {
    const run = await trial(tempDir(), { deleteSpec: "tests/api/beta.spec.ts" });
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "test_missing" });
    const diagnostics = run.artifact("diagnostics.json") as { closure_integrity: { missing: string[] }; missing_tests: string[] };
    expect(diagnostics.closure_integrity.missing).toEqual(["tests/api/beta.spec.ts"]);
    expect(diagnostics.missing_tests).toHaveLength(3);
    const outcomes = run.artifact("original/outcomes.json") as { tests: { test_id: string }[] };
    expect(outcomes.tests.map((test) => test.test_id)).toEqual(["synthetic0001-aaaa0001", "synthetic0001-aaaa0002"]);
  });

  it("gives test_skipped for an unexpected skip and records the skip in the outcomes", async () => {
    const run = await trial(tempDir(), { original: (test) => (test.id === "synthetic0001-aaaa0002" ? "skipped" : "passed") });
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "test_skipped" });
    const outcomes = run.artifact("original/outcomes.json") as { tests: { test_id: string; outcome: string }[] };
    expect(outcomes.tests.find((test) => test.test_id === "synthetic0001-aaaa0002")?.outcome).toBe("skipped");
  });

  it("is never complete when a closure file changed, even if every test ran", async () => {
    const run = await trial(tempDir(), { changeFile: "tests/api/report-migration.spec.ts" });
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "artifact_hash_mismatch" });
    const diagnostics = run.artifact("diagnostics.json") as { closure_integrity: { changed: string[] } };
    expect(diagnostics.closure_integrity.changed).toEqual(["tests/api/report-migration.spec.ts"]);
  });

  it("gives build_failed, runs no tests, still stops, and records every check as not run", async () => {
    const run = await trial(tempDir(), { stack: { buildReason: "build_failed" } });
    expect(run.result).toMatchObject({ status: "invalid", invalid_reason: "build_failed" });
    expect(run.events).toEqual(["build", "stop"]);
    expect(run.observations).toHaveLength(4);
    expect(run.observations.every((o) => o.observed === "not_run" && o.failure_code === "artifact_missing")).toBe(true);
    expect(run.artifacts.entries.some((entry) => entry.kind === "original_suite_outcomes")).toBe(false);
  });

  it("gives startup_failed and never runs the destructive suite when the identity check fails", async () => {
    const run = await trial(tempDir(), { stack: { identity: false } });
    expect(run.result).toMatchObject({ status: "invalid", invalid_reason: "startup_failed" });
    expect(run.events).not.toContain("suite");
    expect(run.runner.calls.some((call) => call.env.API_ALLOW_DESTRUCTIVE === "1")).toBe(false);
  });

  it("gives timeout with the phase name when the tests phase reaches its limit", async () => {
    const run = await trial(tempDir(), { suiteMs: 250000 });
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "timeout" });
    const timings = run.artifact("phase-timings.json") as { phases: { name: string; outcome: string }[] };
    expect(timings.phases.find((phase) => phase.name === "tests")?.outcome).toBe("timeout");
    const diagnostics = run.artifact("diagnostics.json") as { problems: { phase: string; reason: string }[] };
    expect(diagnostics.problems[0]).toMatchObject({ phase: "tests", reason: "timeout" });
    expect(run.events).not.toContain("reset 1");
    expect(run.events.at(-1)).toBe("stop");
  });

  it("in record-only mode runs past the limit, records the overrun and marks a development measurement", async () => {
    const run = await trial(tempDir(), { suiteMs: 250000, mode: "record-only" });
    expect(run.events).toContain("round 1");
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "timeout" });
    const timings = run.artifact("phase-timings.json") as {
      limits_mode: string;
      development_measurement: boolean;
      phases: { name: string; outcome: string; overrun_ms: number; duration_ms: number }[];
    };
    expect(timings.limits_mode).toBe("record-only");
    expect(timings.development_measurement).toBe(true);
    expect(timings.phases.find((phase) => phase.name === "tests")).toMatchObject({ outcome: "overrun", duration_ms: 256000, overrun_ms: 16000 });
  });

  it("in record-only mode, a build overrun does not skip the later phases", async () => {
    const run = await trial(tempDir(), { stack: { buildMs: 300000 }, mode: "record-only" });
    expect(run.events).toEqual(["build", "start", "identity", "suite", "reset 1", "round 1", "stop"]);
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "timeout" });
    const timings = run.artifact("phase-timings.json") as { phases: { name: string; outcome: string }[] };
    expect(timings.phases.find((phase) => phase.name === "build")?.outcome).toBe("overrun");
  });

  it("after an unexpected error, still stops the app copy and writes an incomplete trial result with artifact_missing", async () => {
    const events: string[] = [];
    const timers = new FakeTimers();
    const run = await trial(tempDir(), { stack: { startThrows: true }, events, timers });
    expect(events).toEqual(["build", "start", "stop"]);
    expect(timers.pending()).toBe(0);
    expect(run.outcome.internal_error).toEqual({ phase: "readiness", error_class: "Error", code: "ECONNRESET" });
    expect(exitCodeFor(run.outcome)).toBe(3);
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "artifact_missing" });
    expect(run.observations).toHaveLength(4);
    expect(run.observations.every((item) => item.observed === "not_run" && item.failure_code === "artifact_missing")).toBe(true);
    const keys = run.artifacts.entries.map((entry) => entry.key.replace(`results/${run.trialId}/artifacts/`, ""));
    expect(keys).toEqual(expect.arrayContaining(["original/suite-manifest.json", "build/build.stdout.txt", "diagnostics.json", "phase-timings.json"]));
    const diagnostics = run.artifact("diagnostics.json") as { internal_error: unknown };
    expect(diagnostics.internal_error).toEqual({ phase: "readiness", error_class: "Error", code: "ECONNRESET" });
    const timings = run.artifact("phase-timings.json") as { phases: { name: string; outcome: string }[] };
    expect(timings.phases.map((phase) => [phase.name, phase.outcome])).toEqual([
      ["build", "ok"],
      ["readiness", "failed"],
      ["stop", "ok"],
    ]);
  });

  it("after an unexpected error in a late phase, writes the result with the artifacts collected so far", async () => {
    const run = await trial(tempDir(), { job: { trialId: "clean-01" }, stack: { resetThrowsAt: 3 } });
    expect(run.events.slice(-4)).toEqual(["reset 2", "round 2", "reset 3", "stop"]);
    expect(run.events).toContain("suite");
    expect(run.outcome.internal_error).toEqual({ phase: "tests", error_class: "Error", code: "ECONNRESET" });
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "artifact_missing" });
    expect(run.observations).toHaveLength(80);
    const keys = run.artifacts.entries.map((entry) => entry.key.replace(`results/${run.trialId}/artifacts/`, ""));
    expect(keys).toEqual(expect.arrayContaining(["original/report.json", "original/outcomes.json", "added/round-02/report.json"]));
  });

  it("keeps the problems, observations and round timings gathered before an unexpected error in a later round", async () => {
    const run = await trial(tempDir(), { job: { trialId: "clean-01" }, stack: { resetFailsAt: 1, resetThrowsAt: 3 } });
    expect(run.outcome.internal_error).toMatchObject({ phase: "tests" });
    expect(run.result).toMatchObject({ status: "invalid", invalid_reason: "seed_failed" });
    expect(run.observations).toHaveLength(80);
    const observed = (repeatIndex: number) => run.observations.filter((item) => item.repeat_index === repeatIndex).map((item) => item.observed);
    expect(observed(1)).toEqual(["not_run", "not_run", "not_run", "not_run"]);
    expect(observed(2)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(observed(3)).toEqual(["not_run", "not_run", "not_run", "not_run"]);
    const timings = run.artifact("phase-timings.json") as { phases: { name: string; repeat_index: number | null; outcome: string }[] };
    expect(timings.phases.filter((phase) => phase.name === "round").map((phase) => [phase.repeat_index, phase.outcome])).toEqual([
      [1, "failed"],
      [2, "ok"],
    ]);
    const diagnostics = run.artifact("diagnostics.json") as { problems: { reason: string }[] };
    expect(diagnostics.problems.map((problem) => problem.reason)).toEqual(["seed_failed", "artifact_missing"]);
  });

  it("keeps a timeout of the phase an unexpected error ends, ahead of the error", async () => {
    const run = await trial(tempDir(), { job: { trialId: "clean-01" }, stack: { resetThrowsAt: 3, resetMs: 60000 } });
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "timeout" });
    const diagnostics = run.artifact("diagnostics.json") as { problems: { phase: string; reason: string }[] };
    expect(diagnostics.problems.map((problem) => [problem.phase, problem.reason])).toEqual([
      ["tests", "timeout"],
      ["tests", "artifact_missing"],
    ]);
  });

  it("writes the result when stopping the app copy throws, with the stop phase named", async () => {
    const run = await trial(tempDir(), { stack: { stopThrows: true } });
    expect(run.outcome.internal_error).toEqual({ phase: "stop", error_class: "TypeError", code: null });
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "artifact_missing" });
  });

  it("records an internal error's class and phase but never its message", async () => {
    const run = await trial(tempDir(), { job: { trialId: "clean-01" }, stack: { resetThrowsAt: 3 } });
    for (const entry of run.artifacts.entries) {
      const text = run.read(entry.key).toString("utf8");
      expect(text).not.toContain("synthetic-secret");
      expect(text).not.toContain("synthetic unexpected error");
    }
    expect(JSON.stringify(run.result)).not.toContain("synthetic");
  });

  it("exits 0 when the records were written without an internal error", async () => {
    const run = await trial(tempDir());
    expect(run.outcome.internal_error).toBeNull();
    expect(exitCodeFor(run.outcome)).toBe(0);
  });

  it("records phase timings for every phase and round, with samples every 30 seconds", async () => {
    const run = await trial(tempDir());
    const timings = run.artifact("phase-timings.json") as {
      phases: { name: string; repeat_index: number | null; limit_ms: number | null }[];
      samples: { elapsed_ms: number; memory_current_bytes: number; cpu_usage_usec: number; disks: unknown[] }[];
    };
    expect(timings.phases.map((phase) => phase.name)).toEqual(["build", "readiness", "original_suite", "round", "tests", "stop"]);
    expect(timings.phases.find((phase) => phase.name === "tests")?.limit_ms).toBe(240000);
    expect(timings.samples.map((sample) => sample.elapsed_ms)).toEqual([0, 30000, 60000, 90000, 120000, 150000, 178000]);
    expect(timings.samples[0]).toMatchObject({ memory_current_bytes: 1048576, cpu_usage_usec: 5000000 });
    expect(timings.samples[0]?.disks).toEqual([
      { path: "/var/lib/rbw/results", total_bytes: 4096000, free_bytes: 2457600, available_bytes: 2048000 },
    ]);
  });

  it("keeps the kit's process logs that exist, and skips the ones that do not", async () => {
    const run = await trial(tempDir());
    const logs = run.artifacts.entries.filter((entry) => entry.kind === "log").map((entry) => entry.key);
    expect(logs).toEqual(["results/clean-02/artifacts/processes/umami.stdout.log"]);
    expect(run.read(logs[0] ?? "").toString("utf8")).toBe("synthetic app log\n");
  });

  it("skips the original suite for an observation trial and writes no outcomes entry", async () => {
    const run = await trial(tempDir(), { job: { kind: "observe", originalSuiteSha256: null, originalTestIds: [] } });
    expect(run.trialId).toBe("planted-01");
    expect(run.events).toEqual(["build", "start", "reset 1", "round 1", "stop"]);
    expect(run.result.status).toBe("complete");
    expect(run.artifacts.entries.some((entry) => entry.kind === "original_suite_outcomes" || entry.kind === "test_report")).toBe(false);
  });

  it("gives limit_exceeded when the trial's artifacts exceed the size limit", async () => {
    const run = await trial(tempDir(), { artifactLimitBytes: 4000 });
    expect(run.result).toMatchObject({ status: "incomplete", invalid_reason: "limit_exceeded" });
  });

  it("refuses a trial whose original suite hash differs from the frozen manifest's, writing nothing", async () => {
    const root = tempDir();
    await expect(trial(root, { job: { originalSuiteSha256: "f".repeat(64) } })).rejects.toBeInstanceOf(RefusedInput);
    expect(existsSync(join(root, "results", "job"))).toBe(false);
  });

  it("refuses a trial whose original test list differs from the manifest's", async () => {
    await expect(trial(tempDir(), { job: { originalTestIds: ["synthetic0001-aaaa0001"] } })).rejects.toThrow(/original_test_ids/);
  });

  it("refuses a trial whose added suite hash differs from the fixture package's", async () => {
    await expect(trial(tempDir(), { job: { addedSuiteSha256: hex(99) } })).rejects.toThrow(/added_suite_sha256/);
  });
});

function dirname2(path: string): string {
  return join(path, "..", "..");
}
