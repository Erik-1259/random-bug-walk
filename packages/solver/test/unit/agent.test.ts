import type { PGlite } from "@electric-sql/pglite";
import type { Spend } from "@rbw/spend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { attemptKey, elideOldestToolResult, HISTORY_ELISION_NOTE, NO_TOOL_CALL_REMINDER, runAttempt, SOLVER_SYSTEM_PROMPT, transcriptLine } from "../../src/agent.ts";
import { countSolverPromptBound } from "../../src/envelope.ts";
import { CHAT_COMPLETIONS_URL, SUPER_SOLVER_PROFILE } from "../../src/profile.ts";
import { MIN_TOOL_TIMEOUT_MS } from "../../src/tools.ts";
import { attemptOptions, FakeSession, freshSpend, openDb, scriptedFetch, spySpend, steppingClock, withCaps } from "../support.ts";

let db: PGlite;

beforeAll(async () => {
  db = await openDb();
});

afterAll(async () => {
  await db.close();
});

interface Body {
  model: string;
  temperature: number;
  seed: number;
  max_tokens: number;
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
  chat_template_kwargs?: unknown;
}

function parse(body: string): Body {
  return JSON.parse(body) as Body;
}

/** Every operation in the schema, by call name, with its state as the ledger reports it. */
async function operations(schema: string, spend: Spend): Promise<{ state: string; call_name: string }[]> {
  const rows = await db.query<{ operation_id: string; call_name: string }>(`SELECT operation_id, call_name FROM ${schema}.operations ORDER BY call_name`);
  const out: { state: string; call_name: string }[] = [];
  for (const row of rows.rows) {
    const status = await spend.operationStatus({ operation_id: row.operation_id });
    out.push({ call_name: row.call_name, state: status.ok ? status.state : `error:${status.code}` });
  }
  return out;
}

const SUBMIT = { name: "submit", input: { summary: "synthetic fix" } };

describe("the request each arm sends", () => {
  it("differs between arms only in the server_logs tool", async () => {
    const bodies: Record<string, Body> = {};
    for (const arm of ["off", "on"] as const) {
      const { spend } = await freshSpend(db);
      const script = scriptedFetch([{ calls: [SUBMIT] }]);
      const run = attemptOptions(spend, script.fetch, new FakeSession(), { spec: { arm, index: 4, rerun: 0 } });
      await runAttempt(run.options);
      bodies[arm] = parse(script.bodies[0] ?? "");
    }
    const { off, on } = bodies;
    if (off === undefined || on === undefined) {
      throw new Error("expected a request from each arm");
    }
    expect(off.tools?.map((t) => t.function.name)).toEqual(["bash", "read_file", "write_file", "rebuild_restart", "submit"]);
    expect(on.tools?.map((t) => t.function.name)).toEqual(["bash", "read_file", "write_file", "rebuild_restart", "submit", "server_logs"]);
    expect({ ...on, tools: on.tools?.slice(0, 5) }).toEqual(off);
  });

  it("carries the fixed prompt, the profile's model, sampling and extras, and the index as seed", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [SUBMIT] }]);
    const run = attemptOptions(spend, script.fetch, new FakeSession(), { spec: { arm: "on", index: 17, rerun: 1 } });
    await runAttempt(run.options);
    const body = parse(script.bodies[0] ?? "");
    expect(script.urls).toEqual([CHAT_COMPLETIONS_URL]);
    expect(body.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(body.temperature).toBe(0.6);
    expect(body.seed).toBe(17);
    expect(body.max_tokens).toBe(8_192);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages[0]).toEqual({ role: "system", content: SOLVER_SYSTEM_PROMPT });
    expect(body.messages[1]?.content).toContain("Synthetic report");
  });
});

describe("a full attempt", () => {
  it("runs the tools, submits, and meters every turn in reserve, launch, send, settle order", async () => {
    const { spend, schema } = await freshSpend(db);
    const events: string[] = [];
    const script = scriptedFetch(
      [
        { calls: [{ name: "read_file", input: { path: "src/lib/date.ts" } }], usage: { prompt_tokens: 1200, completion_tokens: 40 } },
        { calls: [{ name: "write_file", input: { path: "src/lib/date.ts", content: "export const offset = 1;\n" } }], usage: { prompt_tokens: 1400, completion_tokens: 60 } },
        { calls: [{ name: "rebuild_restart", input: {} }], usage: { prompt_tokens: 1600, completion_tokens: 20 } },
        { calls: [SUBMIT], usage: { prompt_tokens: 1800, completion_tokens: 30 } },
      ],
      events,
    );
    const session = new FakeSession();
    const run = attemptOptions(spySpend(spend, events), script.fetch, session);
    const result = await runAttempt(run.options);

    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("synthetic fix");
    expect(result.turns).toBe(4);
    expect(result.input_tokens).toBe(6000);
    expect(result.output_tokens).toBe(150);
    expect(result.usage_complete).toBe(true);
    expect(result.rebuilds).toBe(1);
    expect(result.tool_calls).toMatchObject({ read_file: 1, write_file: 1, rebuild_restart: 1, submit: 1, server_logs: 0 });
    expect(session.files.get("src/lib/date.ts")).toBe("export const offset = 1;\n");
    // ceil(6000 × 0.3) + ceil(150 × 0.9) micro-USD, line by line per turn.
    expect(result.settled_microusd).toBe(360 + 36 + 420 + 54 + 480 + 18 + 540 + 27);

    const perTurn = ["reserve", "transition:launching", "fetch", "transition:terminal", "settle"];
    expect(events).toEqual([...perTurn, ...perTurn, ...perTurn, ...perTurn]);
    const ops = await operations(schema, spend);
    expect(ops.map((op) => op.call_name)).toEqual([1, 2, 3, 4].map((n) => `solver.turn:off-001-r0:${String(n)}`));
    expect(ops.every((op) => op.state === "reconciled")).toBe(true);
  });

  it("returns each tool's result to the model in the next request", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "bash", input: { command: "ls src" } }] }, { calls: [SUBMIT] }]);
    const session = new FakeSession();
    session.bashResult = { exit_code: 0, stdout: "synthetic-listing\n", stderr: "", timed_out: false };
    await runAttempt(attemptOptions(spend, script.fetch, session).options);
    const second = parse(script.bodies[1] ?? "");
    const tool = second.messages.find((m) => m.role === "tool");
    expect(tool?.content).toContain("synthetic-listing");
    expect(session.log).toEqual(["bash:ls src"]);
  });

  it("writes a transcript whose model calls carry the model, endpoint, dates and usage", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [SUBMIT], usage: { prompt_tokens: 900, completion_tokens: 12 } }], undefined, "synthetic-served-model");
    const run = attemptOptions(spend, script.fetch, new FakeSession(), { now: steppingClock(1000, Date.UTC(2026, 9, 13, 12, 0, 0)) });
    await runAttempt(run.options);
    expect(run.events.map((e) => e.type)).toEqual(["attempt_start", "model_call", "tool_call", "attempt_end"]);
    const call = run.events[1];
    if (call?.type !== "model_call") {
      throw new Error("expected a model call");
    }
    expect(call).toMatchObject({
      model_id: SUPER_SOLVER_PROFILE.hashed.model,
      endpoint: CHAT_COMPLETIONS_URL,
      response_model: "synthetic-served-model",
      usage: { prompt_tokens: 900, completion_tokens: 12 },
      status: "completed",
      http_status: 200,
      settled_microusd: 270 + 11,
    });
    expect(call.requested_at).toMatch(/^2026-10-13T12:00:\d\d\.000Z$/);
    expect(call.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    const lines = run.events.map(transcriptLine).join("");
    expect(lines.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown)).toHaveLength(4);
  });
});

describe("rebuild_restart in the loop", () => {
  it("never passes rbw-start's runtime log tail to the model", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "rebuild_restart", input: {} }] }, { calls: [SUBMIT] }]);
    const session = new FakeSession();
    session.rebuildResult = {
      build: {
        exit_code: 0,
        stdout: ["--- build stdout (/var/lib/rbw/logs/build.stdout.log)", "synthetic compiler warning", "--- build stderr (/var/lib/rbw/logs/build.stderr.log)", "build_exit=0"].join("\n"),
        stderr: "",
      },
      start: {
        exit_code: 1,
        stdout: "postgres_ready_ms=800",
        stderr: [
          "rbw-start: Umami exited before answering the heartbeat",
          "--- /var/lib/rbw/logs/umami.stdout.log",
          "synthetic stdout line",
          "--- /var/lib/rbw/logs/umami.stderr.log",
          'PrismaClientKnownRequestError: duplicate key value violates unique constraint "session_pkey"',
        ].join("\n"),
      },
    };
    await runAttempt(attemptOptions(spend, script.fetch, session).options);
    const second = script.bodies[1] ?? "";
    expect(second).toContain("rbw-start: Umami exited before answering the heartbeat");
    expect(second).toContain("synthetic compiler warning");
    expect(second).not.toContain("duplicate key value");
    expect(second).not.toContain("synthetic stdout line");
  });

  it("refuses rebuilds past the cap without calling the session", async () => {
    const { spend } = await freshSpend(db);
    const rebuild = { calls: [{ name: "rebuild_restart", input: {} }] };
    const script = scriptedFetch([rebuild, rebuild, rebuild, { calls: [SUBMIT] }]);
    const session = new FakeSession();
    const profile = withCaps(SUPER_SOLVER_PROFILE, { max_rebuilds: 2 });
    const result = await runAttempt(attemptOptions(spend, script.fetch, session, { profile }).options);
    expect(session.log).toEqual(["rebuild_restart", "rebuild_restart"]);
    expect(result.rebuilds).toBe(2);
    expect(script.bodies[3]).toContain("the rebuild limit of 2 is reached");
  });
});

describe("tool calls the arm does not have", () => {
  it("answers server_logs in the off arm with an error and never reads the logs", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "server_logs", input: {} }] }, { calls: [SUBMIT] }]);
    const session = new FakeSession();
    const result = await runAttempt(attemptOptions(spend, script.fetch, session).options);
    expect(session.log).toEqual([]);
    expect(result.invalid_tool_calls).toBe(1);
    expect(result.tool_calls.server_logs).toBe(0);
    const second = parse(script.bodies[1] ?? "");
    expect(JSON.stringify(second.messages.filter((m) => m.role === "tool"))).toContain("server_logs");
  });

  it("reads the logs in the on arm", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "server_logs", input: {} }] }, { calls: [SUBMIT] }]);
    const session = new FakeSession();
    const result = await runAttempt(attemptOptions(spend, script.fetch, session, { spec: { arm: "on", index: 1, rerun: 0 } }).options);
    expect(session.log).toEqual(["server_logs:tail"]);
    expect(result.tool_calls.server_logs).toBe(1);
    expect(script.bodies[1]).toContain("synthetic log line");
  });

  it("answers input that fails the tool's schema with an error and does not run it", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "bash", input: { cmd: "ls" } }] }, { calls: [SUBMIT] }]);
    const session = new FakeSession();
    const result = await runAttempt(attemptOptions(spend, script.fetch, session).options);
    expect(session.log).toEqual([]);
    expect(result.invalid_tool_calls).toBe(1);
  });
});

describe("a reply without a tool call", () => {
  it("is answered with the fixed reminder and counts as a turn", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ text: "I think the bug is in the date code." }, { calls: [SUBMIT] }]);
    const run = attemptOptions(spend, script.fetch, new FakeSession());
    const result = await runAttempt(run.options);
    expect(result.turns).toBe(2);
    const second = parse(script.bodies[1] ?? "");
    expect(second.messages.at(-1)).toEqual({ role: "user", content: NO_TOOL_CALL_REMINDER });
    expect(run.events.some((e) => e.type === "reminder")).toBe(true);
  });
});

describe("caps", () => {
  it("stops at the turn cap without another request", async () => {
    const { spend } = await freshSpend(db);
    const bash = { calls: [{ name: "bash", input: { command: "true" } }] };
    const script = scriptedFetch([bash, bash, bash, bash]);
    const profile = withCaps(SUPER_SOLVER_PROFILE, { max_turns: 3 });
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession(), { profile }).options);
    expect(result).toMatchObject({ outcome: "cap_reached", cap: "turns", turns: 3 });
    expect(script.bodies).toHaveLength(3);
  });

  it("stops before a turn whose counted bound would pass the attempt's input-token cap, reserving nothing", async () => {
    const { spend, schema } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "bash", input: { command: "true" } }], usage: { prompt_tokens: 5000, completion_tokens: 10 } }]);
    const profile = withCaps(SUPER_SOLVER_PROFILE, { max_input_tokens: 6000 });
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession(), { profile }).options);
    expect(result).toMatchObject({ outcome: "cap_reached", cap: "input_tokens", turns: 1, input_tokens: 5000 });
    expect(script.bodies).toHaveLength(1);
    expect(await operations(schema, spend)).toHaveLength(1);
  });

  it("stops at the wall-clock cap", async () => {
    const { spend } = await freshSpend(db);
    const bash = { calls: [{ name: "bash", input: { command: "true" } }] };
    const script = scriptedFetch([bash, bash, bash]);
    const profile = withCaps(SUPER_SOLVER_PROFILE, { max_wall_ms: 5 * 60_000 });
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession(), { profile, now: steppingClock(60_000) }).options);
    expect(result).toMatchObject({ outcome: "cap_reached", cap: "wall" });
    expect(script.bodies.length).toBeLessThan(3);
  });

  it("bounds a tool call by the remaining wall time and ends the attempt when the cap cuts it off", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "bash", input: { command: "sleep 120" } }, SUBMIT, { name: "read_file", input: { path: "src/lib/date.ts" } }] }]);
    const profile = withCaps(SUPER_SOLVER_PROFILE, { max_wall_ms: 5 * 60_000 });
    const start = Date.UTC(2026, 9, 13, 12, 0, 0);
    // The clock stands still except while the bash command runs; the turn starts 30 seconds before the cap.
    let t = start;
    const session = new FakeSession();
    const fakeBash = session.bash.bind(session);
    session.bash = async (command: string, options: { timeoutMs: number }) => {
      const ran = Math.min(2 * 60_000, options.timeoutMs);
      t += ran;
      const result = await fakeBash(command, options);
      return ran < 2 * 60_000 ? { exit_code: null, stdout: "", stderr: "", timed_out: true } : result;
    };
    const run = attemptOptions(spend, script.fetch, session, { profile, now: () => new Date(t), startedAt: new Date(start - 5 * 60_000 + 30_000) });
    const result = await runAttempt(run.options);
    expect(session.bashTimeouts).toEqual([30_000]);
    expect(result).toMatchObject({ outcome: "cap_reached", cap: "wall", turns: 1, summary: null });
    expect(result.wall_ms).toBe(5 * 60_000);
    expect(result.tool_calls).toMatchObject({ bash: 1, submit: 0, read_file: 0 });
    expect(session.log).toEqual(["bash:sleep 120"]);
    expect(run.events.filter((e) => e.type === "tool_call")).toHaveLength(1);
  });

  it("does not start a bash call when less than the minimum useful call time remains, and ends the attempt at the cap", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "bash", input: { command: "true" } }, SUBMIT] }]);
    const profile = withCaps(SUPER_SOLVER_PROFILE, { max_wall_ms: 5 * 60_000 });
    const start = Date.UTC(2026, 9, 13, 12, 0, 0);
    const session = new FakeSession();
    const run = attemptOptions(spend, script.fetch, session, { profile, now: () => new Date(start), startedAt: new Date(start - 5 * 60_000 + 100) });
    const result = await runAttempt(run.options);
    expect(MIN_TOOL_TIMEOUT_MS).toBeGreaterThan(100);
    expect(session.bashTimeouts).toEqual([]);
    expect(session.log).toEqual([]);
    expect(result).toMatchObject({ outcome: "cap_reached", cap: "wall", summary: null });
    expect(result.tool_calls).toMatchObject({ bash: 0, submit: 0 });
  });

  it("counts time before the loop (the session's open and initial build) against the wall-clock cap", async () => {
    const { spend, schema } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "bash", input: { command: "true" } }] }]);
    const profile = withCaps(SUPER_SOLVER_PROFILE, { max_wall_ms: 5 * 60_000 });
    const start = Date.UTC(2026, 9, 13, 12, 0, 0);
    const startedAt = new Date(start - 6 * 60_000);
    const run = attemptOptions(spend, script.fetch, new FakeSession(), { profile, now: steppingClock(1_000, start), startedAt });
    const result = await runAttempt(run.options);
    expect(result).toMatchObject({ outcome: "cap_reached", cap: "wall", turns: 0 });
    expect(result.wall_ms).toBeGreaterThanOrEqual(6 * 60_000);
    expect(run.events[0]).toMatchObject({ type: "attempt_start", started_at: startedAt.toISOString() });
    expect(script.bodies).toHaveLength(0);
    expect(await operations(schema, spend)).toHaveLength(0);
  });

  it.each(["off", "on"] as const)(
    "keeps a 20-turn %s-arm session with many capped outputs under the per-call limit by eliding the oldest tool results",
    async (arm) => {
      const { spend } = await freshSpend(db);
      // Realistic capped outputs: 16 KB of log-like lines on stdout and on stderr, and 16 KB pages of logs.
      const lines = (label: string) => Array.from({ length: 400 }, (_, i) => `${label} line ${String(i)}: synthetic output text`).join("\n");
      const session = new FakeSession();
      session.bashResult = { exit_code: 1, stdout: lines("stdout"), stderr: lines("stderr"), timed_out: false };
      session.logsPage = { text: lines("server log"), next_cursor: "c1", truncated: true };
      const replies = Array.from({ length: 19 }, (_, i) =>
        arm === "on" && i % 2 === 1 ? { calls: [{ name: "server_logs", input: {} }] } : { calls: [{ name: "bash", input: { command: `grep -rn synthetic src/${String(i)}` } }] },
      );
      const script = scriptedFetch([...replies, { calls: [SUBMIT] }]);
      const run = attemptOptions(spend, script.fetch, session, { spec: { arm, index: 2, rerun: 0 } });
      const result = await runAttempt(run.options);

      expect(result).toMatchObject({ outcome: "submitted", cap: null, turns: 20 });
      expect(script.bodies).toHaveLength(20);
      for (const body of script.bodies) {
        expect(countSolverPromptBound(body, SUPER_SOLVER_PROFILE)).toBeLessThanOrEqual(SUPER_SOLVER_PROFILE.hashed.max_input_tokens);
      }
      expect(result.elided_tool_results).toBeGreaterThan(0);
      const elided = run.events.filter((e) => e.type === "history_elided");
      expect(elided).toHaveLength(result.elided_tool_results);
      // The newest result stays whole and the oldest is a stub.
      const last = parse(script.bodies.at(-1) ?? "");
      const tools = last.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content));
      expect(tools[0]).toContain(HISTORY_ELISION_NOTE);
      expect(tools.at(-1)).not.toContain(HISTORY_ELISION_NOTE);
      expect(tools.at(-1)).toContain("line 399: synthetic output text");
    },
  );

  it("elides the oldest long result first, never a short one, a stub or the newest tool message", () => {
    const result = (id: string, value: string) => ({ type: "tool-result" as const, toolCallId: id, toolName: "bash", output: { type: "text" as const, value } });
    const long = "x".repeat(1000);
    const messages: ModelMessage[] = [
      { role: "user", content: "Bug report" },
      { role: "tool", content: [result("short", "ok"), result("a", long)] },
      { role: "tool", content: [result("b", long)] },
      { role: "tool", content: [result("newest", long)] },
    ];
    expect(elideOldestToolResult(messages)).toEqual({ tool_call_id: "a", tool_name: "bash", bytes: 1000 });
    expect(elideOldestToolResult(messages)).toEqual({ tool_call_id: "b", tool_name: "bash", bytes: 1000 });
    expect(elideOldestToolResult(messages)).toBeNull();
    const text = JSON.stringify(messages);
    expect(text).toContain('"value":"ok"');
    expect(text.split(HISTORY_ELISION_NOTE)).toHaveLength(3);
    expect(JSON.stringify(messages[3])).toContain(long);
  });

  it("refuses a request over the per-call input limit without reserving", async () => {
    const { spend, schema } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [SUBMIT] }]);
    const profile = { ...SUPER_SOLVER_PROFILE, hashed: { ...SUPER_SOLVER_PROFILE.hashed, max_input_tokens: 100 } };
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession(), { profile }).options);
    expect(result).toMatchObject({ outcome: "cap_reached", cap: "context_window", turns: 0 });
    expect(script.bodies).toHaveLength(0);
    expect(await operations(schema, spend)).toHaveLength(0);
  });
});

describe("spend refusals and infrastructure errors", () => {
  it("sends nothing when the run's root does not hold the slot", async () => {
    const { spend } = await freshSpend(db, { acquire: false });
    const script = scriptedFetch([{ calls: [SUBMIT] }]);
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession()).options);
    expect(result.outcome).toBe("spend_refused");
    expect(result.refusal?.code).toBe("slot_not_held");
    expect(script.bodies).toHaveLength(0);
  });

  it("sends nothing when the pool cannot cover a turn's worst case", async () => {
    const { spend } = await freshSpend(db, { cap: 1000 });
    const script = scriptedFetch([{ calls: [SUBMIT] }]);
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession()).options);
    expect(result.outcome).toBe("spend_refused");
    expect(script.bodies).toHaveLength(0);
  });

  it("records a lost response as uncertain and stops as an infrastructure error", async () => {
    const { spend, schema } = await freshSpend(db);
    const script = scriptedFetch([{ throws: true }]);
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession()).options);
    expect(result.outcome).toBe("infrastructure_error");
    expect(result.infrastructure?.reason).toBe("lost_response");
    expect((await operations(schema, spend))[0]?.state).toBe("uncertain");
    expect(result.usage_complete).toBe(false);
  });

  it("settles an HTTP error at its worst case and stops as an infrastructure error", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ status: 500, body: '{"error":"synthetic"}' }]);
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession()).options);
    expect(result).toMatchObject({ outcome: "infrastructure_error", turns: 1 });
    expect(result.infrastructure?.reason).toBe("http_status");
    // No usage reported: each line retains its worst case, ceil(131072 × 0.3) + ceil(8192 × 0.9).
    expect(result.settled_microusd).toBe(39_322 + 7_373);
  });

  it.each([
    ["the launch transition", "launching"],
    ["the terminal transition", "terminal"],
    ["the settlement", "settle"],
  ])("ends with the operation's id when %s throws after the reservation", async (_label, step) => {
    const { spend, schema } = await freshSpend(db);
    const throwing: Spend = {
      ...spend,
      transition: (request) => (request.to_state === step ? Promise.reject(new Error("synthetic connection dropped")) : spend.transition(request)),
      settle: (settlement) => (step === "settle" ? Promise.reject(new Error("synthetic connection dropped")) : spend.settle(settlement)),
    };
    const script = scriptedFetch([{ calls: [SUBMIT] }]);
    const run = attemptOptions(throwing, script.fetch, new FakeSession());
    const result = await runAttempt(run.options);
    const ops = await db.query<{ operation_id: string }>(`SELECT operation_id FROM ${schema}.operations`);
    expect(ops.rows).toHaveLength(1);
    expect(result.outcome).toBe("infrastructure_error");
    expect(result.infrastructure).toEqual({ reason: "ledger_exception: synthetic connection dropped", operation_id: ops.rows[0]?.operation_id });
    expect(run.events.at(-1)?.type).toBe("attempt_end");
  });

  it("stops as an infrastructure error when the session throws", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "rebuild_restart", input: {} }] }]);
    const session = new FakeSession();
    session.failOn = "rebuild_restart";
    const result = await runAttempt(attemptOptions(spend, script.fetch, session).options);
    expect(result.outcome).toBe("infrastructure_error");
    expect(result.infrastructure?.reason).toContain("synthetic rebuild_restart failure");
  });
});

describe("attempt keys", () => {
  it("name the arm, the zero-padded index and the rerun", () => {
    expect(attemptKey({ arm: "on", index: 7, rerun: 2 })).toBe("on-007-r2");
    expect(() => attemptKey({ arm: "off", index: 0, rerun: 0 })).toThrow();
    expect(() => attemptKey({ arm: "off", index: 1, rerun: 10 })).toThrow();
  });

  it("give each rerun at an index its own operations", async () => {
    const { spend, schema } = await freshSpend(db);
    for (const rerun of [0, 1]) {
      const script = scriptedFetch([{ calls: [SUBMIT] }]);
      await runAttempt(attemptOptions(spend, script.fetch, new FakeSession(), { spec: { arm: "on", index: 3, rerun } }).options);
    }
    expect((await operations(schema, spend)).map((op) => op.call_name)).toEqual(["solver.turn:on-003-r0:1", "solver.turn:on-003-r1:1"]);
  });
});

describe("contamination", () => {
  it("is flagged from the attempt's bash commands", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "bash", input: { command: "cd .next/standalone && node server.js &" } }] }, { calls: [SUBMIT] }]);
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession()).options);
    expect(result.contamination.map((hit) => hit.kind)).toEqual(["starts_server"]);
  });

  it("is flagged when a file tool is pointed at the rbw log directory in the off arm", async () => {
    const { spend } = await freshSpend(db);
    const script = scriptedFetch([{ calls: [{ name: "read_file", input: { path: "/var/lib/rbw/logs/umami.stderr.log" } }] }, { calls: [SUBMIT] }]);
    const result = await runAttempt(attemptOptions(spend, script.fetch, new FakeSession(), { spec: { arm: "off", index: 1, rerun: 0 } }).options);
    expect(result.contamination).toEqual([{ kind: "reads_process_output", tool: "file", command_index: 0, pattern: "rbw log directory" }]);
  });
});
