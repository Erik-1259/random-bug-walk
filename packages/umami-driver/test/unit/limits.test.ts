import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, TRIAL_ARTIFACT_LIMIT_BYTES } from "../../src/artifacts.ts";
import { sha256Hex } from "@rbw/schema";
import { createBudget } from "../../src/limits.ts";
import { FakeTimers, tempDir } from "../helpers.ts";

describe("phase limits", () => {
  it("aborts a phase that reaches its limit and records a timeout with the phase name and elapsed time", () => {
    const timers = new FakeTimers();
    const budget = createBudget({ timers, mode: "enforce", totalMs: 600000 });
    const build = budget.begin("build", 240000);
    timers.advance(239999);
    expect(build.signal.aborted).toBe(false);
    timers.advance(1);
    expect(build.signal.aborted).toBe(true);
    timers.advance(500);
    expect(build.end("ok")).toMatchObject({
      name: "build",
      outcome: "timeout",
      duration_ms: 240500,
      limit_ms: 240000,
      overrun_ms: 500,
      started_at: "2026-10-05T00:00:00.000Z",
    });
  });

  it("in record-only mode records an overrun without stopping the phase", () => {
    const timers = new FakeTimers();
    const budget = createBudget({ timers, mode: "record-only", totalMs: 600000 });
    const tests = budget.begin("tests", 240000);
    timers.advance(300000);
    expect(tests.signal.aborted).toBe(false);
    expect(tests.end("ok")).toMatchObject({ name: "tests", outcome: "overrun", duration_ms: 300000, overrun_ms: 60000 });
  });

  it("records a phase within its limit as ok, with integer milliseconds", () => {
    const timers = new FakeTimers();
    const budget = createBudget({ timers, mode: "enforce", totalMs: 600000 });
    const readiness = budget.begin("readiness", 60000);
    timers.advance(12345);
    const timing = readiness.end("ok");
    expect(timing).toMatchObject({ outcome: "ok", duration_ms: 12345, overrun_ms: 0, ended_at: "2026-10-05T00:00:12.345Z" });
    expect(Number.isInteger(timing.duration_ms)).toBe(true);
  });

  it("never resets the whole-copy deadline when a new phase starts", () => {
    const timers = new FakeTimers();
    const budget = createBudget({ timers, mode: "enforce", totalMs: 300000 });
    const build = budget.begin("build", 240000);
    timers.advance(200000);
    build.end("ok");
    const readiness = budget.begin("readiness", 60000);
    timers.advance(50000);
    readiness.end("ok");
    const tests = budget.begin("tests", 240000);
    timers.advance(49999);
    expect(tests.signal.aborted).toBe(false);
    timers.advance(1);
    expect(tests.signal.aborted).toBe(true);
    expect(tests.end("ok")).toMatchObject({ name: "tests", outcome: "timeout", duration_ms: 50000, deadline_ms: 50000 });
    const finish = budget.begin("stop", 60000);
    expect(finish.signal.aborted).toBe(true);
    expect(budget.copy()).toMatchObject({ limit_ms: 300000, elapsed_ms: 300000, overrun_ms: 0 });
  });

  it("gives a phase that starts after the whole-copy deadline no allowance, never a negative one", () => {
    const timers = new FakeTimers();
    const budget = createBudget({ timers, mode: "record-only", totalMs: 100000 });
    budget.begin("build", 200000);
    timers.advance(150000);
    const readiness = budget.begin("readiness", 60000);
    timers.advance(10000);
    expect(readiness.end("ok")).toMatchObject({ deadline_ms: 0, duration_ms: 10000, overrun_ms: 10000, outcome: "overrun" });
  });

  it("records the whole-copy overrun in record-only mode", () => {
    const timers = new FakeTimers();
    const budget = createBudget({ timers, mode: "record-only", totalMs: 1000 });
    budget.begin("build", 5000);
    timers.advance(1500);
    expect(budget.copy()).toMatchObject({ overrun_ms: 500 });
  });

  it("records a nested round's timing without a limit of its own", () => {
    const timers = new FakeTimers();
    const budget = createBudget({ timers, mode: "enforce", totalMs: 600000 });
    const round = budget.begin("round", null, 7);
    timers.advance(4000);
    expect(round.end("ok")).toMatchObject({ name: "round", repeat_index: 7, limit_ms: null, outcome: "ok", overrun_ms: 0 });
  });
});

describe("artifact store", () => {
  it("writes bytes under the trial directory and records kind, key, hash, size and media type", async () => {
    const out = tempDir();
    const store = new ArtifactStore(out, "results/t/artifacts");
    const entry = await store.addBytes("test_report", "original/report.json", Buffer.from("{}"), "application/json");
    expect(entry).toEqual({
      kind: "test_report",
      key: "results/t/artifacts/original/report.json",
      sha256: sha256Hex(Buffer.from("{}")),
      size_bytes: 2,
      media_type: "application/json",
    });
    expect(readFileSync(join(out, "results/t/artifacts/original/report.json"), "utf8")).toBe("{}");
  });

  it("refuses an artifact that would take the trial over its size limit, and marks it", async () => {
    const out = tempDir();
    const source = join(out, "big.json");
    writeFileSync(source, "x".repeat(60));
    const store = new ArtifactStore(out, "a", 100);
    expect((await store.addFile("test_report", "one.json", source, "application/json")).entry).not.toBeNull();
    const second = await store.addFile("test_report", "two.json", source, "application/json");
    expect(second).toEqual({ entry: null, bytes: null, status: "refused" });
    expect(existsSync(join(out, "a/two.json"))).toBe(false);
    expect(store.limitExceeded()).toBe(true);
    expect(store.refused()).toEqual([{ key: "a/two.json", size_bytes: 60 }]);
    expect(store.truncated()).toEqual(["a/two.json"]);
  });

  it("uses a 64 MiB total per trial by default", () => {
    expect(TRIAL_ARTIFACT_LIMIT_BYTES).toBe(64 * 1024 * 1024);
  });

  it("reports a missing source file as missing, not as an empty artifact", async () => {
    const out = tempDir();
    const store = new ArtifactStore(out, "a");
    expect(await store.addFile("test_report", "none.json", join(out, "none.json"), "application/json")).toEqual({
      entry: null,
      bytes: null,
      status: "missing",
    });
    expect(store.entries()).toEqual([]);
  });

  it("stores a truncated stream, marks it truncated and never returns it for parsing", async () => {
    const out = tempDir();
    const store = new ArtifactStore(out, "a");
    const entry = await store.addStream("stdout", "logs/suite.stdout.txt", {
      bytes: Buffer.from("partial"),
      total_bytes: 2 * 1024 * 1024,
      truncated: true,
    });
    expect(entry?.size_bytes).toBe(7);
    expect(store.truncated()).toEqual(["a/logs/suite.stdout.txt"]);
    expect(store.limitExceeded()).toBe(false);
  });

  it("keeps the first bytes of a log file over its cap, marks it truncated and does not count it as over the limit", async () => {
    const out = tempDir();
    const source = join(out, "umami.stdout.log");
    writeFileSync(source, "y".repeat(50));
    const store = new ArtifactStore(out, "a");
    const added = await store.addFile("log", "processes/umami.stdout.log", source, "text/plain", 20);
    expect(added).toMatchObject({ status: "stored", bytes: null, entry: { key: "a/processes/umami.stdout.log", size_bytes: 20 } });
    expect(readFileSync(join(out, "a/processes/umami.stdout.log"), "utf8")).toBe("y".repeat(20));
    expect(store.truncated()).toEqual(["a/processes/umami.stdout.log"]);
    expect(store.limitExceeded()).toBe(false);
  });

  it("refuses duplicate, absolute and escaping keys", async () => {
    const out = tempDir();
    const store = new ArtifactStore(out, "a");
    await store.addBytes("diagnostics", "x/a.json", Buffer.from("1"), "application/json");
    await expect(store.addBytes("diagnostics", "x/a.json", Buffer.from("2"), "application/json")).rejects.toThrow(/duplicate/);
    await expect(store.addBytes("diagnostics", "/tmp/a.json", Buffer.from("2"), "application/json")).rejects.toThrow(/relative/);
    await expect(store.addBytes("diagnostics", "x/../../a.json", Buffer.from("2"), "application/json")).rejects.toThrow(/relative/);
    await expect(store.addBytes("diagnostics", "x/.hidden.json", Buffer.from("2"), "application/json")).rejects.toThrow(/relative/);
  });
});
