import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts.ts";
import { sha256Hex } from "@rbw/schema";
import type { TrialReason } from "@rbw/schema";
import { runAddedRounds } from "../../src/rounds.ts";
import type { RoundsOptions } from "../../src/rounds.ts";
import { CHECKS, FakeTimers, commandResult, tempDir } from "../helpers.ts";
import { cannedResponse, writeRound } from "../fixture-round/index.ts";
import type { RoundCheck } from "../fixture-round/index.ts";

const IDS = CHECKS.map((check) => check.check_id);

type Scenario = (repeatIndex: number) => Partial<Record<string, RoundCheck>> | "crash";

function setup(repeatCount: number, scenario: Scenario = () => ({}), resetResult: (index: number) => TrialReason | null = () => null) {
  const out = tempDir();
  const timers = new FakeTimers();
  const events: string[] = [];
  const controller = new AbortController();
  const tmpDirs: string[] = [];
  const options: RoundsOptions = {
    checks: CHECKS,
    repeatCount,
    workDir: join(out, "work", "added"),
    store: new ArtifactStore(out, "results/t/artifacts"),
    signal: controller.signal,
    timers,
    reset: (repeatIndex) => {
      events.push(`reset ${String(repeatIndex)}`);
      timers.advance(1000);
      return Promise.resolve(resetResult(repeatIndex));
    },
    runRound: (repeatIndex, dirs) => {
      const outputDir = dirs.output;
      tmpDirs.push(dirs.tmp);
      events.push(`run ${String(repeatIndex)}`);
      timers.advance(5000);
      const behaviour = scenario(repeatIndex);
      if (behaviour === "crash") return Promise.resolve(commandResult({ code: 1 }));
      const checks = Object.fromEntries(IDS.map((id) => [id, behaviour[id] ?? "pass"])) as Record<string, RoundCheck>;
      writeRound(outputDir, repeatIndex, checks);
      return Promise.resolve(commandResult({ code: Object.values(checks).every((value) => value === "pass") ? 0 : 1 }));
    },
  };
  return { out, options, events, controller, timers, tmpDirs };
}

describe("added-check rounds", () => {
  it("runs 20 complete rounds and gives 80 observations with repeat_index 1 to 20", async () => {
    const { options } = setup(20);
    const result = await runAddedRounds(options);
    expect(result.observations).toHaveLength(80);
    for (let index = 1; index <= 20; index += 1) {
      const round = result.observations.filter((observation) => observation.repeat_index === index);
      expect(round.map((observation) => observation.check_id)).toEqual(IDS);
      expect(round.every((observation) => observation.observed === "pass")).toBe(true);
    }
    expect(result.problems).toEqual([]);
    expect(result.rounds.map((round) => round.repeat_index)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("gives each round an empty output directory and its own scratch directory under the work directory", async () => {
    const { options, tmpDirs, out } = setup(2);
    await runAddedRounds(options);
    expect(tmpDirs).toEqual([join(out, "work", "added", "round-01", "tmp"), join(out, "work", "added", "round-02", "tmp")]);
  });

  it("resets before every round", async () => {
    const { options, events } = setup(3);
    await runAddedRounds(options);
    expect(events).toEqual(["reset 1", "run 1", "reset 2", "run 2", "reset 3", "run 3"]);
  });

  it("runs one round when the repeat count is 1", async () => {
    const { options, events } = setup(1);
    const result = await runAddedRounds(options);
    expect(events).toEqual(["reset 1", "run 1"]);
    expect(result.observations).toHaveLength(4);
  });

  it("does not stop later rounds after a failing check, and records the failure as observed", async () => {
    const { options } = setup(5, (index) => (index === 2 ? { "tzarg.la-day-counts": "assertion_fail" } : {}));
    const result = await runAddedRounds(options);
    expect(result.observations).toHaveLength(20);
    expect(result.observations.find((o) => o.repeat_index === 2 && o.check_id === "tzarg.la-day-counts")).toMatchObject({
      observed: "assertion_fail",
      failure_code: "local_day_counts_mismatch",
    });
    expect(result.observations.filter((o) => o.repeat_index > 2).every((o) => o.observed === "pass")).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("starts the round after a crashed runner from a reset, and records the crashed round as not run", async () => {
    const { options, events } = setup(4, (index) => (index === 3 ? "crash" : {}));
    const result = await runAddedRounds(options);
    expect(events.slice(4)).toEqual(["reset 3", "run 3", "reset 4", "run 4"]);
    const crashed = result.observations.filter((o) => o.repeat_index === 3);
    expect(crashed.every((o) => o.observed === "not_run" && o.failure_code === "artifact_missing")).toBe(true);
    expect(result.observations.filter((o) => o.repeat_index === 4).every((o) => o.observed === "pass")).toBe(true);
    expect(result.problems.map((problem) => problem.reason)).toContain("artifact_missing");
  });

  it("records a check with no outcome file as not_run with artifact_missing", async () => {
    const { options } = setup(1, () => ({ "tzarg.auckland-day-counts": "no_outcome" }));
    const result = await runAddedRounds(options);
    expect(result.observations.find((o) => o.check_id === "tzarg.auckland-day-counts")).toEqual({
      check_id: "tzarg.auckland-day-counts",
      repeat_index: 1,
      observed: "not_run",
      failure_code: "artifact_missing",
      duration_ms: 0,
      response_artifact_key: null,
      response_artifact_sha256: null,
    });
    expect(result.problems).toEqual([expect.objectContaining({ reason: "artifact_missing" })]);
  });

  it("records a check the report shows as skipped as skipped", async () => {
    const { options } = setup(1, () => ({ "tzarg.kolkata-day-counts": "skipped" }));
    const result = await runAddedRounds(options);
    expect(result.observations.find((o) => o.check_id === "tzarg.kolkata-day-counts")).toMatchObject({
      observed: "skipped",
      failure_code: "test_skipped",
      response_artifact_key: null,
      response_artifact_sha256: null,
    });
    expect(result.problems).toEqual([expect.objectContaining({ reason: "test_skipped" })]);
  });

  it("treats an outcome that contradicts the report's status as invalid evidence", async () => {
    const { options } = setup(1, () => ({ "tzarg.utc-day-counts": "contradict" }));
    const result = await runAddedRounds(options);
    expect(result.observations.find((o) => o.check_id === "tzarg.utc-day-counts")).toMatchObject({
      observed: "setup_fail",
      failure_code: "unrelated_failure",
      response_artifact_key: null,
    });
    expect(result.problems).toEqual([expect.objectContaining({ reason: "unrelated_failure" })]);
  });

  it("records a setup failure with its failure code as the reason", async () => {
    const { options } = setup(1, () => ({ "tzarg.utc-day-counts": "setup_fail" }));
    const result = await runAddedRounds(options);
    expect(result.observations[0]).toMatchObject({ observed: "setup_fail", failure_code: "auth_failed" });
    expect(result.problems.map((problem) => problem.reason)).toEqual(["auth_failed"]);
  });

  it("copies each response's bytes into the trial artifacts and points the observation at the copy", async () => {
    const { options, out } = setup(2);
    const result = await runAddedRounds(options);
    const observation = result.observations.find((o) => o.repeat_index === 2 && o.check_id === "tzarg.la-day-counts");
    const key = "results/t/artifacts/added/round-02/responses/tzarg.la-day-counts.json";
    expect(observation?.response_artifact_key).toBe(key);
    expect(observation?.response_artifact_sha256).toBe(sha256Hex(cannedResponse("tzarg.la-day-counts")));
    expect(readFileSync(join(out, key))).toEqual(cannedResponse("tzarg.la-day-counts"));
    const entry = options.store.entries().find((item) => item.key === key);
    expect(entry).toMatchObject({ kind: "check_response", sha256: observation?.response_artifact_sha256 });
    expect(options.store.entries().map((item) => item.key)).toContain("results/t/artifacts/added/round-02/report.json");
  });

  it("gives artifact_hash_mismatch when a response's bytes do not match the outcome's hash", async () => {
    const { options } = setup(1, () => ({ "tzarg.la-day-counts": "bad_response_hash" }));
    const result = await runAddedRounds(options);
    expect(result.observations.find((o) => o.check_id === "tzarg.la-day-counts")).toMatchObject({
      observed: "pass",
      response_artifact_key: null,
      response_artifact_sha256: null,
    });
    expect(result.problems.map((problem) => problem.reason)).toEqual(["artifact_hash_mismatch"]);
  });

  it("gives artifact_missing when an outcome names a response file that is absent", async () => {
    const { options } = setup(1, () => ({ "tzarg.la-day-counts": "no_response" }));
    const result = await runAddedRounds(options);
    expect(result.problems.map((problem) => problem.reason)).toEqual(["artifact_missing"]);
  });

  it("records a failed reset and still resets and runs the next round", async () => {
    const { options, events } = setup(3, () => ({}), (index) => (index === 2 ? "seed_failed" : null));
    const result = await runAddedRounds(options);
    expect(events).toEqual(["reset 1", "run 1", "reset 2", "reset 3", "run 3"]);
    expect(result.observations.filter((o) => o.repeat_index === 2).every((o) => o.observed === "not_run")).toBe(true);
    expect(result.problems.map((problem) => problem.reason)).toEqual(["seed_failed"]);
  });

  it("stops starting rounds once the tests phase is aborted, and records the rest as not run", async () => {
    const { options, events, controller } = setup(5, (index) => {
      if (index === 2) controller.abort();
      return {};
    });
    const result = await runAddedRounds(options);
    expect(events).toEqual(["reset 1", "run 1", "reset 2", "run 2"]);
    expect(result.observations).toHaveLength(20);
    expect(result.observations.filter((o) => o.repeat_index >= 3).every((o) => o.observed === "not_run")).toBe(true);
  });
});
