// The harness pilot end to end in the dry-run world: the paired_comparison root before the first
// attempt, the pre-registered order, arms and seeds, the seeded grade round trips with no model,
// grade 1 with each session, grade 2 as its own step, and the run directory for the analyzer and
// the publisher.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecord } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { DRY_ALTERNATIVE, DRY_CLEAN, DRY_COPY_MICROUSD, DRY_DIGEST, DRY_SANDBOX_IMAGE, dryRunWorld } from "../src/fakes.ts";
import type { DryRunOptions, DryRunWorld } from "../src/fakes.ts";
import { finalize, runGrade2, runSessions } from "../src/orchestrator.ts";
import type { SessionsOptions } from "../src/orchestrator.ts";
import { PILOT_LABEL } from "../src/plan.ts";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "rbw-uc1-pilot-"));
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function world(options: Partial<DryRunOptions> = {}): Promise<DryRunWorld> {
  return dryRunWorld({ root: temp(), ...options });
}

function pilot(w: DryRunWorld, overrides: Partial<SessionsOptions> = {}): SessionsOptions {
  return { mode: "pilot", runsDir: w.runsDir, name: "pilot-01", caseFile: w.pilotCase, policyFile: w.policy, model: "super", concurrency: 1, ...overrides };
}

interface Body {
  seed: number;
  tools: { function: { name: string } }[];
  messages: { role: string; content: unknown }[];
  temperature: number;
}

describe("the harness pilot", () => {
  it("persists the paired_comparison root under the public_demo policy before the first attempt", async () => {
    const w = await world();
    const seen: Record<string, unknown>[] = [];
    const open = w.deps.openSession.bind(w.deps);
    w.deps.openSession = (request) => {
      if (seen.length === 0) seen.push(json(join(w.runsDir, "pilot-01", "root-run.json")));
      return open(request);
    };
    const outcome = await runSessions(pilot(w), w.deps);
    expect(outcome.exitCode).toBe(0);
    const policy = parseRecord("ProjectPolicy", readFileSync(join(outcome.runDir, "policy.json")));
    expect(policy.purpose).toBe("public_demo");
    const seenAtFirstSession = seen[0];
    expect(seenAtFirstSession).toMatchObject({ kind: "paired_comparison", project_id: policy.project_id, declared_stages: ["solver_sessions", "grade_1", "grade_2"] });
    expect(seenAtFirstSession?.root_execution_id).toBe(outcome.rootExecutionId);
    const run = json(join(outcome.runDir, "run.json"));
    expect(run).toMatchObject({ mode: "pilot", label: PILOT_LABEL, case_id: "umami-tz-arg-001", model: "super", cap_microusd: "40000000" });
    await w.close();
  });

  it("runs the attempts in index order with the pre-registered arms and seeds, server_logs only in the on arm", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    expect(outcome.exitCode).toBe(0);
    expect(w.sessions.map((session) => [session.request.id.split("-").slice(-3).join("-"), session.request.serverLogs])).toEqual([
      ["off-001-r0", false],
      ["on-002-r0", true],
      ["on-003-r0", true],
      ["off-004-r0", false],
    ]);
    const bodies = w.model.bodies.map((body) => JSON.parse(body) as Body);
    // The same system prompt, issue and temperature in every request of both arms; the seed is the attempt index.
    expect(new Set(bodies.map((body) => JSON.stringify(body.messages.slice(0, 2)))).size).toBe(1);
    expect(new Set(bodies.map((body) => body.temperature))).toEqual(new Set([0.6]));
    const firsts = bodies.filter((body) => body.messages.filter((message) => message.role === "assistant").length === 0);
    expect(firsts.map((body) => body.seed)).toEqual([1, 2, 3, 4]);
    for (const body of bodies) {
      const names = body.tools.map((tool) => tool.function.name);
      expect(names.includes("server_logs")).toBe(body.seed === 2 || body.seed === 3);
    }
    for (const session of w.sessions) expect(session.closed).toBe(true);
    await w.close();
  });

  it("records every attempt with its grade 1, tool calls, tokens, turns, wall time and spend", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    const dirs = readdirSync(join(outcome.runDir, "attempts")).sort();
    expect(dirs).toEqual(["001-off", "002-on", "003-on", "004-off"]);
    const record = json(join(outcome.runDir, "attempts", "002-on", "attempt.json"));
    expect(record).toMatchObject({ index: 2, arm: "on", seed: 2, status: "counted" });
    const run = (record.runs as Record<string, unknown>[])[0] ?? {};
    expect(run).toMatchObject({ rerun: 0, attempt_key: "on-002-r0", ended: "submitted", submission: { scope: "in_scope" } });
    const result = run.result as Record<string, unknown>;
    expect(result).toMatchObject({ outcome: "submitted", turns: 5, input_tokens: 6000, output_tokens: 750 });
    expect(result.tool_calls).toMatchObject({ read_file: 1, write_file: 1, rebuild_restart: 1, server_logs: 1, submit: 1, bash: 0 });
    expect(Number(result.settled_microusd)).toBeGreaterThan(0);
    expect(typeof run.session_wall_ms).toBe("number");
    expect(run.route).toMatchObject({ route: "alternative_fix" });
    expect((run.grade1 as { result: { state: string } }[]).map((item) => item.result.state)).toEqual(["passed"]);
    expect(run.grade2).toEqual([]);
    expect(existsSync(join(outcome.runDir, "attempts", "002-on", "r0", "transcript.jsonl"))).toBe(true);
    // Grade 1 ran on local Docker for each attempt; no grade 2 ran in the session step.
    expect(w.controllerCalls.filter((call) => call.grade === 2)).toEqual([]);
    expect(w.controllerCalls.filter((call) => call.grade === 1 && call.name.startsWith("grade-1-docker-o"))).toHaveLength(4);
    await w.close();
  });

  it("round-trips the seeded grades with no model: the alternative fix through the fix route and the clean bytes through the clean-equal route", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    const turns = w.model.bodies.length;
    const alternative = json(join(outcome.runDir, "seeded", "seed-alternative-fix", "seeded.json"));
    const clean = json(join(outcome.runDir, "seeded", "seed-clean", "seeded.json"));
    expect(alternative).toMatchObject({ label: "seed-alternative-fix", expected_route: "alternative_fix", route: { route: "alternative_fix" }, route_matches: true });
    expect(clean).toMatchObject({ label: "seed-clean", expected_route: "clean_equal", route: { route: "clean_equal", clean_equal: true }, route_matches: true });
    const cleanCall = w.controllerCalls.find((call) => call.name === "grade-1-docker-seed-clean-r0");
    expect(cleanCall?.args[cleanCall.args.indexOf("--judge-fixed") + 1]).toBe("fixed");
    const altCall = w.controllerCalls.find((call) => call.name === "grade-1-docker-seed-alternative-fix-r0");
    expect(altCall?.args[altCall.args.indexOf("--judge-fixed") + 1]).toBe("alternative_fix");
    // Both seeds passed, so the attempts ran after them: the 4 attempts made every model call (5 turns
    // in the on arm, 4 in the off arm), none for the seeded grades.
    expect(outcome.stop).toBeNull();
    expect(w.sessions).toHaveLength(4);
    expect(turns).toBe(18);
    await w.close();
  });

  it("runs the sessions and grade 1 on the case's native kit digest, and grade 2 on its pinned registry build", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    expect((await runGrade2({ runDir: outcome.runDir }, w.deps)).exitCode).toBe(0);
    const image = (args: readonly string[]) => args[args.indexOf("--image") + 1];
    const first = w.controllerCalls.filter((call) => call.grade === 1);
    const second = w.controllerCalls.filter((call) => call.grade === 2);
    // 2 seeded round trips and 4 attempts, each graded once by each grade.
    expect(first).toHaveLength(6);
    expect(second).toHaveLength(6);
    for (const call of first) expect(image(call.args)).toBe(DRY_DIGEST);
    // Grade 2's job image is the registry build its Sandbox copies run, so it carries that build's repository digest.
    for (const call of second) {
      expect(image(call.args)).toBe(DRY_SANDBOX_IMAGE);
      expect(call.args[call.args.indexOf("--sandbox-image") + 1]).toBe(DRY_SANDBOX_IMAGE);
    }
    expect(w.sessions).toHaveLength(4);
    // Each session opens the case's native kit image and expects its digest, never the registry build.
    for (const session of w.sessions) expect([session.request.config.image, session.request.config.image_digest]).toEqual(["rbw-umami-kit:synthetic", DRY_DIGEST]);
    await w.close();
  });

  it("runs grade 2 as its own step on Sandbox, serially, charged to the development pool under the root", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    const graded = await runGrade2({ runDir: outcome.runDir }, w.deps);
    expect(graded.exitCode).toBe(0);
    const sandbox = w.controllerCalls.filter((call) => call.grade === 2);
    expect(sandbox.map((call) => call.name)).toEqual([
      "grade-2-sandbox-seed-alternative-fix-r0",
      "grade-2-sandbox-seed-clean-r0",
      "grade-2-sandbox-off-001-r0-r0",
      "grade-2-sandbox-on-002-r0-r0",
      "grade-2-sandbox-on-003-r0-r0",
      "grade-2-sandbox-off-004-r0-r0",
    ]);
    for (const call of sandbox) {
      expect(call.args).toContain("--sandbox-image");
      expect(call.args[call.args.indexOf("--ledger") + 1]).toBe("development");
      expect(call.args).toContain("--project-policy");
    }
    const record = json(join(outcome.runDir, "attempts", "001-off", "attempt.json"));
    const run = (record.runs as Record<string, unknown>[])[0] ?? {};
    expect(run.grade2).toMatchObject([{ result: { state: "passed" }, settled_microusd: DRY_COPY_MICROUSD }]);
    // A second grade2 call finds nothing left to grade.
    expect((await runGrade2({ runDir: outcome.runDir }, w.deps)).graded).toBe(0);
    await w.close();
  });

  it("finalizes a run directory the analyzer and the publisher read, with the root terminal", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    await runGrade2({ runDir: outcome.runDir }, w.deps);
    const done = await finalize({ runDir: outcome.runDir }, w.deps);
    expect(done.exitCode).toBe(0);
    const root = parseRecord("RootRun", readFileSync(join(outcome.runDir, "root-run.json")));
    expect(root).toMatchObject({ kind: "paired_comparison", status: "terminal", outcome: "completed" });
    // The attempts' executions, and each grade's (4 attempts and 2 seeded round trips, two grades each).
    expect(root.child_execution_ids.length).toBe(4 + 6 * 2);
    const rows = JSON.parse(readFileSync(join(outcome.runDir, "results", "rows.json"), "utf8")) as Record<string, unknown>[];
    expect(rows.map((row) => [row.index, row.arm, row.status, row.grade1, row.grade2, row.tokens, row.turns])).toEqual([
      [1, "off", "counted", "pass", "pass", 5400, 4],
      [2, "on", "counted", "pass", "pass", 6750, 5],
      [3, "on", "counted", "pass", "pass", 6750, 5],
      [4, "off", "counted", "pass", "pass", 5400, 4],
    ]);
    expect(rows[0]).toMatchObject({ bug_id: "umami-tz-arg-001", out_of_scope: false, prohibited_edits: 0, reruns: 0, contaminated: false, cap: null, history_elisions: 0 });
    const analysis = json(join(outcome.runDir, "results", "analysis.json"));
    expect(analysis.kind).toBe("paired_comparison_analysis");
    const summary = json(join(outcome.runDir, "results", "summary.json"));
    expect(summary).toMatchObject({ label: PILOT_LABEL, mode: "pilot" });
    const spend = summary.spend as Record<string, unknown>;
    expect(spend.grade2_settled_microusd).toBe(6 * DRY_COPY_MICROUSD);
    expect(Number(spend.model_settled_microusd)).toBeGreaterThan(0);
    expect(spend.ledger).toMatchObject({ open_microusd: "0" });
    expect((summary.seeded as { label: string; grade2: string }[]).map((item) => [item.label, item.grade2])).toEqual([
      ["seed-alternative-fix", "passed"],
      ["seed-clean", "passed"],
    ]);
    // The staging layout the publisher reads.
    const staging = join(outcome.runDir, "staging");
    expect(readdirSync(staging).sort()).toEqual(["inputs", "logs", "report.md", "results"]);
    const report = readFileSync(join(staging, "report.md"), "utf8");
    expect(report).toContain(PILOT_LABEL);
    // All three co-primary outcomes are in the report: solve, tokens and turns.
    const turns = (analysis.bugs as { turns: { hodges_lehmann_on_minus_off: string; mann_whitney_p: string; holm_p: string } }[])[0]?.turns;
    expect(turns).toBeDefined();
    expect(report).toContain(`Turns: shift on minus off ${turns?.hodges_lehmann_on_minus_off ?? ""}`);
    expect(report).toContain(`Mann-Whitney p ${turns?.mann_whitney_p ?? ""}, Holm-adjusted p ${turns?.holm_p ?? ""}`);
    expect(readdirSync(join(staging, "results"))).toContain("analysis.json");
    expect(readdirSync(join(staging, "logs"))).toContain("transcript-on-002-r0.jsonl");
    const staged = readFileSync(join(staging, "results", "attempt-002-on.json"), "utf8");
    expect(staged).not.toContain(outcome.runDir);
    await w.close();
  });

  it("writes the fixes it grades: the clean file on odd seeds, the alternative fix on even ones", async () => {
    const w = await world();
    const outcome = await runSessions(pilot(w), w.deps);
    const routes = ["001-off", "002-on"].map((dir) => ((json(join(outcome.runDir, "attempts", dir, "attempt.json")).runs as { route: { route: string } }[])[0] ?? { route: { route: "" } }).route.route);
    expect(routes).toEqual(["clean_equal", "alternative_fix"]);
    expect(DRY_CLEAN).not.toBe(DRY_ALTERNATIVE);
    await w.close();
  });
});
