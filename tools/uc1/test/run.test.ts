// The counted run's rules in the dry-run world: the spend guard before every model call and
// regrade, the refusals before anything starts, the rerun rule, the scope rule, concurrency and
// the model freeze.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readSolverRateSheet, solverEnvelope, SUPER_SOLVER_PROFILE } from "@rbw/solver";
import { describe, expect, it } from "vitest";
import { DRY_CLEAN, DRY_COPY_MICROUSD, DRY_OTHER, DRY_TARGET, defaultScript, dryRunWorld } from "../src/fakes.ts";
import type { DryRunOptions, DryRunWorld } from "../src/fakes.ts";
import { RunRefusal, finalize, runGrade2, runSessions } from "../src/orchestrator.ts";
import type { SessionsOptions } from "../src/orchestrator.ts";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "rbw-uc1-run-"));
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function world(options: Partial<DryRunOptions> = {}): Promise<DryRunWorld> {
  return dryRunWorld({ root: temp(), ...options });
}

function counted(w: DryRunWorld, overrides: Partial<SessionsOptions> = {}): SessionsOptions {
  return { mode: "run", runsDir: w.runsDir, name: "race-01", caseFile: w.raceCase, policyFile: w.policy, model: "super", concurrency: 1, ...overrides };
}

function pilot(w: DryRunWorld, overrides: Partial<SessionsOptions> = {}): SessionsOptions {
  return { mode: "pilot", runsDir: w.runsDir, name: "pilot-01", caseFile: w.pilotCase, policyFile: w.policy, model: "super", concurrency: 1, ...overrides };
}

/** A finalized, completed pilot root on this model under the runs directory, as finalize leaves it (only the fields the gate reads). */
function completedPilot(w: DryRunWorld, model: "super" | "kimi" = "super"): void {
  const dir = join(w.runsDir, `pilot-done-${model}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ schema_version: 1, kind: "uc1_run", mode: "pilot", name: `pilot-done-${model}`, model, root_execution_id: `00000000-0000-4000-8000-00000000${model === "super" ? "0f01" : "0f02"}`, plan: [] }));
  writeFileSync(join(dir, "root-run.json"), JSON.stringify({ status: "terminal", outcome: "completed" }));
}

const TURN_WORST = (() => {
  const priced = solverEnvelope(readSolverRateSheet(), SUPER_SOLVER_PROFILE);
  if (!priced.ok) throw new Error("the solver rate sheet must price Super");
  return BigInt(priced.turn_worst_case_microusd);
})();

function runs(runDir: string, dir: string): Record<string, unknown>[] {
  return json(join(runDir, "attempts", dir, "attempt.json")).runs as Record<string, unknown>[];
}

describe("refusals before anything starts", () => {
  it("refuses a counted run on the time-zone case, whose screen record fails it", async () => {
    const w = await world();
    await expect(runSessions(counted(w, { caseFile: w.pilotCase }), w.deps)).rejects.toThrow(RunRefusal);
    await expect(runSessions(counted(w, { caseFile: w.pilotCase }), w.deps)).rejects.toThrow("not eligible for a counted UC1 run");
    expect(w.sessions).toHaveLength(0);
    expect(existsSync(join(w.runsDir, "race-01"))).toBe(false);
    await w.close();
  });

  it("refuses a pilot on any case but the time-zone case", async () => {
    const w = await world();
    await expect(runSessions(pilot(w, { caseFile: w.raceCase }), w.deps)).rejects.toThrow("runs only umami-tz-arg-001");
    await w.close();
  });

  it("refuses a policy that is not public_demo, and more than 3 sessions at once", async () => {
    const w = await world();
    await expect(runSessions(pilot(w, { policyFile: w.privatePolicy }), w.deps)).rejects.toThrow("public_demo");
    await expect(runSessions(pilot(w, { concurrency: 4 }), w.deps)).rejects.toThrow("1 to 3");
    await expect(runSessions(pilot(w, { concurrency: 0 }), w.deps)).rejects.toThrow("1 to 3");
    expect(w.model.bodies).toHaveLength(0);
    await w.close();
  });

  it("refuses to switch the model after the first counted attempt, and to resume a run on another model", async () => {
    const w = await world();
    completedPilot(w);
    // The pilot may run Kimi before any counted attempt.
    expect((await runSessions(pilot(w, { name: "pilot-kimi", model: "kimi" }), w.deps)).exitCode).toBe(0);
    expect((await runSessions(counted(w, { name: "race-01" }), w.deps)).exitCode).toBe(0);
    await expect(runSessions(counted(w, { name: "race-02", model: "kimi" }), w.deps)).rejects.toThrow("the model is frozen");
    await expect(runSessions(pilot(w, { name: "pilot-late", model: "kimi" }), w.deps)).rejects.toThrow("the model is frozen");
    await expect(runSessions(counted(w, { name: "race-01", model: "kimi" }), w.deps)).rejects.toThrow("ran on super");
    await w.close();
  });

  it("refuses a counted run until a pilot on the same model is finalized and completed", async () => {
    const w = await world({ controller: (call) => (call.name === "grade-2-sandbox-seed-clean-r0" ? "failed" : "passed") });
    await expect(runSessions(counted(w), w.deps)).rejects.toThrow("needs a finalized, completed harness pilot on super");
    // A pilot that has not been finalized does not count.
    const first = await runSessions(pilot(w), w.deps);
    await expect(runSessions(counted(w), w.deps)).rejects.toThrow("needs a finalized, completed harness pilot on super");
    // Nor does one that finalized incomplete (a seeded round trip failed grade 2).
    await runGrade2({ runDir: first.runDir }, w.deps);
    expect((await finalize({ runDir: first.runDir }, w.deps)).rootRun.outcome).toBe("incomplete");
    await expect(runSessions(counted(w), w.deps)).rejects.toThrow("needs a finalized, completed harness pilot on super");
    expect(existsSync(join(w.runsDir, "race-01"))).toBe(false);
    // A completed pilot admits its own model only.
    completedPilot(w);
    await expect(runSessions(counted(w, { model: "kimi" }), w.deps)).rejects.toThrow("needs a finalized, completed harness pilot on kimi");
    await w.close();
  });

  it("puts the Kimi run under the $75 cap, with its 2 pilot attempts", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w, { model: "kimi" }), w.deps);
    expect(json(join(outcome.runDir, "run.json"))).toMatchObject({ model: "kimi", model_id: "moonshotai/Kimi-K2.7-Code", cap_microusd: "75000000" });
    expect(w.sessions.map((session) => session.request.serverLogs)).toEqual([false, true]);
    await w.close();
  });
});

describe("the spend guard", () => {
  it("starts no attempt when one model turn's worst case does not fit, and records the stop", async () => {
    const w = await world({ view: (view) => ({ ...view, settled_microusd: 40_000_000n - TURN_WORST + 1n }) });
    const outcome = await runSessions(pilot(w), w.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stop).toMatchObject({ reason: "allowance_exceeded" });
    expect(w.model.bodies).toHaveLength(0);
    expect(w.sessions).toHaveLength(0);
    const stops = readFileSync(join(outcome.runDir, "stops.jsonl"), "utf8").trim().split("\n");
    expect(stops).toHaveLength(1);
    await w.close();
  });

  it("refuses the model call that does not fit mid-attempt and stops the run: no later attempt starts", async () => {
    // Each scripted turn settles 495 micro-USD (1 200 input and 150 output tokens on Super). With
    // room for one turn's worst case plus 742, turns 1 and 2 fit and turn 3 is refused.
    const w = await world({ view: (view) => ({ ...view, settled_microusd: view.settled_microusd + 40_000_000n - TURN_WORST - 742n }) });
    completedPilot(w);
    const outcome = await runSessions(counted(w), w.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stop).toMatchObject({ reason: "allowance_exceeded" });
    expect(w.sessions).toHaveLength(1);
    const record = json(join(outcome.runDir, "attempts", "001-off", "attempt.json"));
    expect(record.status).toBe("stopped");
    const result = runs(outcome.runDir, "001-off")[0]?.result as { outcome: string; refusal: { code: string; detail: string } };
    expect(result.outcome).toBe("spend_refused");
    expect(result.refusal.detail).toMatch(/^uc1_allowance_exceeded/);
    // Turns 1 and 2 were sent; turn 3 was refused before it was reserved, so it was never sent.
    expect(w.model.bodies).toHaveLength(2);
    expect(readdirSync(join(outcome.runDir, "attempts"))).toEqual(["001-off"]);
    await w.close();
  });

  it("stops before any work when the ledger shows an uncertain operation", async () => {
    const w = await world({ view: (view) => ({ ...view, uncertain: ["a".repeat(64)] }) });
    const outcome = await runSessions(pilot(w), w.deps);
    expect(outcome.stop).toMatchObject({ reason: "ledger_uncertain" });
    expect(w.model.bodies).toHaveLength(0);
    await w.close();
  });

  it("starts no regrade whose worst case does not fit", async () => {
    let limit = false;
    const w = await world({ view: (view) => (limit ? { ...view, settled_microusd: 40_000_000n - view.open_microusd - BigInt(DRY_COPY_MICROUSD) + 1n } : view) });
    const outcome = await runSessions(pilot(w), w.deps);
    limit = true;
    const graded = await runGrade2({ runDir: outcome.runDir }, w.deps);
    expect(graded.exitCode).toBe(1);
    expect(graded.stop).toMatchObject({ reason: "allowance_exceeded" });
    expect(w.controllerCalls.filter((call) => call.grade === 2)).toHaveLength(0);
    await w.close();
  });

  it("counts settled grade 2 spend under the root against later work", async () => {
    // Room for exactly the six regrades of the pilot after its model calls, and nothing more.
    let extra = 0n;
    const w = await world({ view: (view) => ({ ...view, settled_microusd: view.settled_microusd + extra }) });
    const outcome = await runSessions(pilot(w), w.deps);
    const view = await w.deps.allowanceSource.view([outcome.rootExecutionId]);
    extra = 40_000_000n - view.settled_microusd - BigInt(DRY_COPY_MICROUSD) * 5n;
    const graded = await runGrade2({ runDir: outcome.runDir }, w.deps);
    expect(graded.graded).toBe(5);
    expect(graded.stop).toMatchObject({ reason: "allowance_exceeded" });
    await w.close();
  });

  it("holds sessions running at once to the cap: concurrent turns cannot pass it", async () => {
    // Three sessions at once, room for exactly two turns: two first turns are reserved, then everything stops.
    const w = await world({ sessionDelayMs: 5, view: (view) => ({ ...view, settled_microusd: view.settled_microusd + 40_000_000n - TURN_WORST * 2n }) });
    completedPilot(w);
    const outcome = await runSessions(counted(w, { concurrency: 3 }), w.deps);
    expect(outcome.stop).toMatchObject({ reason: "allowance_exceeded" });
    const ledger = await w.deps.allowanceSource.view([outcome.rootExecutionId]);
    // Every model call that started was reserved first; at most two turns' worth was ever reserved.
    expect(w.model.bodies).toHaveLength(2);
    expect(ledger.uncertain).toEqual([]);
    await w.close();
  });
});

describe("attempts, reruns and scope", () => {
  it("starts up to 3 sessions at once, in index order, and records by index", async () => {
    const w = await world({ sessionDelayMs: 2 });
    completedPilot(w);
    const outcome = await runSessions(counted(w, { concurrency: 3 }), w.deps);
    expect(outcome.exitCode).toBe(0);
    const keys = w.sessions.map((session) => session.request.id.split("-").slice(-3).join("-"));
    expect(keys.slice(0, 6)).toEqual(["off-001-r0", "on-002-r0", "on-003-r0", "off-004-r0", "off-005-r0", "on-006-r0"]);
    expect(w.sessions).toHaveLength(40);
    expect(readdirSync(join(outcome.runDir, "attempts"))).toHaveLength(40);
    await w.close();
  });

  it("reruns an infrastructure error from scratch at the same index up to 2 times, then reports it", async () => {
    const w = await world({
      sessionFault: (request) => {
        if (request.id.endsWith("on-002-r0") || request.id.endsWith("on-002-r1")) return "error";
        if (request.id.includes("on-003-")) return "error";
        return null;
      },
    });
    const outcome = await runSessions(pilot(w), w.deps);
    const second = json(join(outcome.runDir, "attempts", "002-on", "attempt.json"));
    expect(second.status).toBe("counted");
    expect((second.runs as { ended: string }[]).map((run) => run.ended)).toEqual(["infrastructure_error", "infrastructure_error", "submitted"]);
    const third = json(join(outcome.runDir, "attempts", "003-on", "attempt.json"));
    expect(third.status).toBe("infrastructure_error");
    expect(third.runs as unknown[]).toHaveLength(3);
    await runGrade2({ runDir: outcome.runDir }, w.deps);
    await finalize({ runDir: outcome.runDir }, w.deps);
    const rows = JSON.parse(readFileSync(join(outcome.runDir, "results", "rows.json"), "utf8")) as { index: number; status: string; reruns: number; grade2: string | null }[];
    expect(rows.find((row) => row.index === 2)).toMatchObject({ status: "counted", reruns: 2, grade2: "pass" });
    expect(rows.find((row) => row.index === 3)).toMatchObject({ status: "infrastructure_error", reruns: 2, grade2: null });
    await w.close();
  });

  it("stops the run on a session refusal (an audit or image mismatch) without rerunning it", async () => {
    const w = await world({ sessionFault: (request) => (request.id.endsWith("on-002-r0") ? "refused" : null) });
    const outcome = await runSessions(pilot(w), w.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stop).toMatchObject({ reason: "session_refused" });
    expect(w.sessions).toHaveLength(1);
    await w.close();
  });

  it("does not grade an out-of-scope fix and counts it unsolved", async () => {
    const w = await world({
      script: (turn) =>
        turn.seed === 1 && turn.turn === 2
          ? { calls: [{ name: "write_file", input: { path: DRY_OTHER, content: "export const other = 2;\n" } }, { name: "write_file", input: { path: DRY_TARGET, content: DRY_CLEAN } }] }
          : defaultScript(turn),
    });
    const outcome = await runSessions(pilot(w), w.deps);
    const run = runs(outcome.runDir, "001-off")[0] ?? {};
    expect(run).toMatchObject({ submission: { scope: "out_of_scope" }, route: null, grade1: [] });
    expect(w.controllerCalls.some((call) => call.name.includes("off-001"))).toBe(false);
    await runGrade2({ runDir: outcome.runDir }, w.deps);
    await finalize({ runDir: outcome.runDir }, w.deps);
    const rows = JSON.parse(readFileSync(join(outcome.runDir, "results", "rows.json"), "utf8")) as { index: number; out_of_scope: boolean; prohibited_edits: number; grade1: unknown; grade2: unknown }[];
    expect(rows.find((row) => row.index === 1)).toMatchObject({ out_of_scope: true, prohibited_edits: 1, grade1: null, grade2: null });
    await w.close();
  });

  it("retries a grade that stops for infrastructure reasons as a grade only", async () => {
    let failures = 0;
    const w = await world({
      controller: (call) => {
        if (call.name === "grade-1-docker-off-001-r0-r0" && failures === 0) {
          failures += 1;
          return "infrastructure";
        }
        return "passed";
      },
    });
    const outcome = await runSessions(pilot(w), w.deps);
    const run = runs(outcome.runDir, "001-off")[0] ?? {};
    expect((run.grade1 as { result: { state: string; job: string } }[]).map((item) => [item.result.job, item.result.state])).toEqual([
      ["grade-1-docker-off-001-r0-r0", "infrastructure"],
      ["grade-1-docker-off-001-r0-r1", "passed"],
    ]);
    expect(w.sessions).toHaveLength(4);
    await w.close();
  });

  it("records a controller that cannot start as an infrastructure grade, retries it, and leaves the slot free", async () => {
    const w = await world();
    const controller = w.deps.runController.bind(w.deps);
    w.deps.runController = (args) => (args.includes("grade-1-docker-on-002-r0-r0") || args.includes("grade-1-docker-on-002-r0-r1") ? Promise.reject(new Error("spawn node ENOENT")) : controller(args));
    const outcome = await runSessions(pilot(w), w.deps);
    expect(outcome.exitCode).toBe(0);
    const run = runs(outcome.runDir, "002-on")[0] ?? {};
    expect((run.grade1 as { result: { state: string; detail: string | null } }[]).map((item) => [item.result.state, item.result.detail])).toEqual([
      ["infrastructure", "controller: spawn node ENOENT"],
      ["infrastructure", "controller: spawn node ENOENT"],
      ["passed", null],
    ]);
    const slot = await w.spend.slotStatus({ slot_key: "development" });
    expect(slot.ok && slot.holder).toBeNull();
    await w.close();
  });

  it("releases the development slot when a step throws", async () => {
    const w = await world();
    w.deps.report = (line) => {
      if (line === "attempt=on-002-r0 status=starting") throw new Error("synthetic harness fault");
    };
    await expect(runSessions(pilot(w), w.deps)).rejects.toThrow("synthetic harness fault");
    const slot = await w.spend.slotStatus({ slot_key: "development" });
    expect(slot.ok && slot.holder).toBeNull();
    await w.close();
  });

  it("refuses to finalize while a counted attempt still waits for grade 2", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    await expect(finalize({ runDir: outcome.runDir }, w.deps)).rejects.toThrow("grade 2");
    await w.close();
  });

  it("resumes a stopped run at the stopped index after the ledger is reconciled", async () => {
    let tight = true;
    // Attempt 1 settles 4 turns (1 980); attempt 2's first turn fits and its second is refused.
    const w = await world({ view: (view) => (tight ? { ...view, settled_microusd: view.settled_microusd + 40_000_000n - TURN_WORST - 2_227n } : view) });
    const first = await runSessions(pilot(w), w.deps);
    expect(first.stop).toMatchObject({ reason: "allowance_exceeded" });
    tight = false;
    const second = await runSessions(pilot(w), w.deps);
    expect(second.exitCode).toBe(0);
    expect(second.rootExecutionId).toBe(first.rootExecutionId);
    const record = json(join(second.runDir, "attempts", "002-on", "attempt.json"));
    expect(record.status).toBe("counted");
    expect((record.runs as { ended: string }[]).map((run) => run.ended)).toEqual(["spend_refused", "submitted"]);
    await runGrade2({ runDir: second.runDir }, w.deps);
    await finalize({ runDir: second.runDir }, w.deps);
    const rows = JSON.parse(readFileSync(join(second.runDir, "results", "rows.json"), "utf8")) as { index: number; reruns: number }[];
    expect(rows.find((row) => row.index === 2)?.reruns).toBe(0);
    await w.close();
  });

  it("leaves grade2 failing when a grade is still infrastructure after its retries", async () => {
    const w = await world({ controller: (call) => (call.name.startsWith("grade-2-sandbox-off-001") ? "infrastructure" : "passed") });
    const outcome = await runSessions(pilot(w), w.deps);
    const graded = await runGrade2({ runDir: outcome.runDir }, w.deps);
    expect(graded.stop).toBeNull();
    expect(graded.exitCode).toBe(1);
    await w.close();
  });

  it("does not complete a pilot whose seeded round trip took the expected route but failed a grade", async () => {
    const w = await world({ controller: (call) => (call.name === "grade-2-sandbox-seed-clean-r0" ? "failed" : "passed") });
    const outcome = await runSessions(pilot(w), w.deps);
    await runGrade2({ runDir: outcome.runDir }, w.deps);
    const done = await finalize({ runDir: outcome.runDir }, w.deps);
    expect(done.rootRun).toMatchObject({ status: "terminal", outcome: "incomplete" });
    expect(done.exitCode).toBe(1);
    await w.close();
  });

  it("reports spend against the cap across every UC1 root under the runs directory, the pilot included", async () => {
    const w = await world();
    const first = await runSessions(pilot(w), w.deps);
    await runGrade2({ runDir: first.runDir }, w.deps);
    const second = await runSessions(pilot(w, { name: "pilot-02" }), w.deps);
    await runGrade2({ runDir: second.runDir }, w.deps);
    const done = await finalize({ runDir: second.runDir }, w.deps);
    const both = await w.deps.allowanceSource.view([first.rootExecutionId, second.rootExecutionId]);
    const own = await w.deps.allowanceSource.view([second.rootExecutionId]);
    expect(both.settled_microusd).toBeGreaterThan(own.settled_microusd);
    expect(done.summary.spend.uc1_roots).toEqual({ roots: 2, settled_microusd: both.settled_microusd.toString(), open_microusd: "0" });
    const report = readFileSync(join(second.runDir, "staging", "report.md"), "utf8");
    expect(report).toContain(`Every UC1 root under the runs directory (2, this one included): settled $${(Number(both.settled_microusd) / 1_000_000).toFixed(4)}, open $0.0000, against the UC1 cap of $40.0000.`);
    await w.close();
  });
});

const ATTEMPT_WORST = (() => {
  const priced = solverEnvelope(readSolverRateSheet(), SUPER_SOLVER_PROFILE);
  if (!priced.ok) throw new Error("the solver rate sheet must price Super");
  return BigInt(priced.attempt_worst_case_microusd);
})();

describe("resumes, reruns and exit codes", () => {
  it("refuses to resume or regrade a run whose root finalize has made terminal", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    await runGrade2({ runDir: outcome.runDir }, w.deps);
    const done = await finalize({ runDir: outcome.runDir }, w.deps);
    expect(done.rootRun.status).toBe("terminal");
    const sessions = w.sessions.length;
    await expect(runSessions(pilot(w), w.deps)).rejects.toThrow("finalized");
    await expect(runGrade2({ runDir: outcome.runDir }, w.deps)).rejects.toThrow("finalized");
    expect(w.sessions).toHaveLength(sessions);
    expect(json(join(outcome.runDir, "root-run.json"))).toMatchObject({ status: "terminal" });
    await w.close();
  });

  it("starts an infrastructure rerun only when a whole attempt's worst case fits", async () => {
    let tight = false;
    const w = await world({
      sessionFault: (request) => {
        if (!request.id.endsWith("on-002-r0")) return null;
        tight = true;
        return "error";
      },
      // Room for more than one turn but less than a whole attempt.
      view: (view) => (tight ? { ...view, settled_microusd: view.settled_microusd + 40_000_000n - ATTEMPT_WORST + 1n } : view),
    });
    const outcome = await runSessions(pilot(w), w.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stop).toMatchObject({ reason: "allowance_exceeded" });
    // Only the failed first run at index 2 exists: the rerun never opened a session.
    expect(runs(outcome.runDir, "002-on")).toHaveLength(1);
    expect(w.sessions).toHaveLength(1);
    await w.close();
  });

  it("refuses to resume a run after its solver profile or rate sheet changed", async () => {
    let tight = true;
    const w = await world({ view: (view) => (tight ? { ...view, settled_microusd: view.settled_microusd + 40_000_000n - TURN_WORST + 1n } : view) });
    const first = await runSessions(pilot(w), w.deps);
    expect(first.stop).toMatchObject({ reason: "allowance_exceeded" });
    tight = false;
    const path = join(first.runDir, "run.json");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, JSON.stringify({ ...json(path), rate_sheet_sha256: "0".repeat(64) }));
    await expect(runSessions(pilot(w), w.deps)).rejects.toThrow("solver profile or rate sheet");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), runtime_profile_sha256: "0".repeat(64) }));
    await expect(runSessions(pilot(w), w.deps)).rejects.toThrow("solver profile or rate sheet");
    writeFileSync(path, original);
    expect((await runSessions(pilot(w), w.deps)).exitCode).toBe(0);
    await w.close();
  });

  it("refuses to resume or regrade a run after a file or directory its case names changed", async () => {
    let tight = true;
    const w = await world({ view: (view) => (tight ? { ...view, settled_microusd: view.settled_microusd + 40_000_000n - TURN_WORST + 1n } : view) });
    const first = await runSessions(pilot(w), w.deps);
    expect(first.stop).toMatchObject({ reason: "allowance_exceeded" });
    tight = false;
    const inputs = dirname(w.pilotCase);
    const manifest = join(inputs, "manifest.json");
    writeFileSync(manifest, "changed\n");
    await expect(runSessions(pilot(w), w.deps)).rejects.toThrow("the case's manifest changed since the run started");
    await expect(runGrade2({ runDir: first.runDir }, w.deps)).rejects.toThrow("the case's manifest changed since the run started");
    writeFileSync(manifest, "synthetic\n");
    writeFileSync(join(inputs, "reference-fix", "extra.ts"), "export {};\n");
    await expect(runSessions(pilot(w), w.deps)).rejects.toThrow("the case's reference_fix changed since the run started");
    expect(w.sessions).toHaveLength(0);
    await w.close();
  });

  it("exits 1 when an attempt ends an infrastructure error after its reruns", async () => {
    const w = await world({ sessionFault: (request) => (request.id.includes("on-003-") ? "error" : null) });
    const outcome = await runSessions(pilot(w), w.deps);
    expect(outcome.stop).toBeNull();
    expect(json(join(outcome.runDir, "attempts", "003-on", "attempt.json")).status).toBe("infrastructure_error");
    expect(outcome.exitCode).toBe(1);
    await w.close();
  });
});
