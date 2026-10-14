// The adapter from a Session to packages/solver's SolverSession, driven through the solver's own
// runTool, so each tool call goes from the solver's tool layer to the session's Docker calls.
import { join } from "node:path";
import { ATTEMPT_CAPS, newToolState, runTool } from "@rbw/solver";
import type { Arm } from "@rbw/solver";
import { describe, expect, it } from "vitest";
import { failed, ok } from "../../../local-runner/test/support/fakes.ts";
import { PLANTED, TARGET } from "../../../local-runner/test/support/synthetic.ts";
import { Session } from "../../src/session.ts";
import type { SessionOptions } from "../../src/session.ts";
import { solverSession } from "../../src/solver.ts";
import { SessionKit } from "../support/session-kit.ts";
import type { SessionKitOptions } from "../support/session-kit.ts";

async function open(kitOptions: SessionKitOptions = {}, extra: Partial<SessionOptions> = {}) {
  const kit = new SessionKit(kitOptions);
  const options: SessionOptions = { id: "uc1-adapter-01", image: "rbw-umami-kit:test", expectedDigest: null, work: join(kit.root, "work"), serverLogs: true, ...kit.inputs(), ...extra };
  const { session } = await Session.open(options, { docker: kit.docker, clock: kit.clock });
  return { kit, session, adapted: solverSession(session) };
}

async function call(arm: Arm, name: string, input: unknown, adapted: ReturnType<typeof solverSession>): Promise<string> {
  return (await runTool(arm, name, input, adapted, newToolState(), ATTEMPT_CAPS)).output;
}

describe("the solver's tools over a session", () => {
  it("runs bash, read_file and write_file through the session", async () => {
    const { kit, session, adapted } = await open();
    expect(await call("off", "bash", { command: "echo hi" }, adapted)).toBe("exit_code: 0\n--- stdout\nran: echo hi\n\n--- stderr\n");
    expect(await call("off", "read_file", { path: TARGET }, adapted)).toBe(PLANTED);
    expect(await call("off", "read_file", { path: "missing.ts" }, adapted)).toBe("error: no such file: missing.ts");
    expect(await call("off", "write_file", { path: TARGET, content: "fixed\n" }, adapted)).toBe(`wrote ${TARGET} (6 bytes)`);
    expect(kit.files.get(TARGET)?.bytes.toString()).toBe("fixed\n");
    expect(await call("off", "write_file", { path: "not-tracked.ts", content: "x" }, adapted)).toBe("error: not_tracked");
    await session.close();
  });

  it("passes the build's own stdout and stderr to rebuild_restart and only rbw-start's status lines", async () => {
    const build = { code: 0, stdout: Buffer.from("--- build stdout (/var/tmp/b.out)\ncompiled ok\n--- build stderr (/var/tmp/b.err)\nwarn: slow\nbuild_exit=0\n"), stderr: "rbw-build-app: font server up\n", timedOut: false };
    const start = { code: 1, stdout: Buffer.from("postgres_ready_ms=640\n"), stderr: "rbw-start: Umami exited\n--- /var/lib/rbw/logs/umami.stderr.log\nruntime secret line\n", timedOut: false };
    const { session, adapted } = await open({ build: (n) => (n === 1 ? ok("build_exit=0\n") : build), start: (n) => (n === 1 ? ok("ready_ms=1\n") : start) });
    const report = await call("off", "rebuild_restart", {}, adapted);
    expect(report).toContain("build_exit_code: 0\n--- build stdout\ncompiled ok\n--- build stderr\nwarn: slow\n--- rbw-build-app messages\nrbw-build-app: font server up");
    expect(report).toContain("start_exit_code: 1\n--- start status\npostgres_ready_ms=640\nrbw-start: Umami exited");
    expect(report).not.toContain("runtime secret line");
    await session.close();
  });

  it("reports a warm tree after the reset as a failed build with the findings", async () => {
    const { session, adapted } = await open({ checkCold: (n) => (n === 2 ? { ...failed(1), stdout: Buffer.from("pnpm store present: /tmp/.pnpm-store\n") } : ok()) });
    const report = await call("off", "rebuild_restart", {}, adapted);
    expect(report).toMatch(/^build_exit_code: 1\n/);
    expect(report).toContain("pnpm store present: /tmp/.pnpm-store");
    expect(report).toContain("start: not run (the build failed)");
    await session.close();
  });

  it("pages both server logs with an opaque cursor that reads what was written since", async () => {
    const { kit, session, adapted } = await open();
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "u1\n");
    kit.logs.set("/var/lib/rbw/logs/postgres.stderr.log", "p1\n");
    const first = await call("on", "server_logs", {}, adapted);
    const cursor = /^next_cursor: (\S+)\n/.exec(first)?.[1];
    expect(cursor).toBeDefined();
    expect(first).toContain("--- umami.stderr.log\nu1\n");
    expect(first).toContain("--- postgres.stderr.log\np1\n");
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "u1\nu2\n");
    const next = await call("on", "server_logs", { cursor }, adapted);
    expect(next).toContain("--- umami.stderr.log\nu2\n");
    expect(next).not.toContain("u1");
    expect(next).not.toContain("[earlier lines skipped]");
    await session.close();
  });

  it("keeps each log's page within half the solver's byte cap, so both logs fit", async () => {
    const { kit, session, adapted } = await open({}, { limits: { logBytes: 1_000_000 } });
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "u".repeat(40_000));
    kit.logs.set("/var/lib/rbw/logs/postgres.stderr.log", "p".repeat(40_000));
    const page = await call("on", "server_logs", {}, adapted);
    expect(page).not.toContain("[cut:");
    expect(page).toContain("--- umami.stderr.log");
    expect(page).toContain("--- postgres.stderr.log");
    await session.close();
  });

  it("marks a page whose cursor is from before a restart", async () => {
    const { kit, session, adapted } = await open();
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "old\n");
    const cursor = /^next_cursor: (\S+)\n/.exec(await call("on", "server_logs", {}, adapted))?.[1];
    await call("on", "rebuild_restart", {}, adapted);
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "new\n");
    const page = await call("on", "server_logs", { cursor }, adapted);
    expect(page).toContain("[earlier lines skipped]");
    expect(page).toContain("--- umami.stderr.log\nnew\n");
    await session.close();
  });
});
