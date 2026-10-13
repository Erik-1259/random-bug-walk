import { describe, expect, it } from "vitest";
import { ATTEMPT_CAPS, TOOL_OUTPUT_CAPS } from "../../src/profile.ts";
import { armToolNames, armToolSet, headBytes, isAppPath, newToolState, rebuildReport, runTool, scrubRuntimeLogs, tailBytes } from "../../src/tools.ts";
import { FakeSession } from "../support.ts";

describe("the tools of each arm", () => {
  it("differ only by server_logs, which only the on arm has", () => {
    expect(armToolNames("off")).toEqual(["bash", "read_file", "write_file", "rebuild_restart", "submit"]);
    expect(armToolNames("on")).toEqual([...armToolNames("off"), "server_logs"]);
    expect(Object.keys(armToolSet("off"))).not.toContain("server_logs");
    expect(Object.keys(armToolSet("on"))).toContain("server_logs");
  });

  it("carry no execute function, so the loop runs every call", () => {
    for (const definition of Object.values(armToolSet("on"))) {
      expect(definition.execute).toBeUndefined();
    }
  });
});

describe("the runtime log scrub", () => {
  const failed = [
    "rbw-start: no heartbeat within 60000 ms",
    "--- /var/lib/rbw/logs/umami.stdout.log",
    "synthetic stdout",
    "--- /var/lib/rbw/logs/umami.stderr.log",
    "synthetic Prisma error P2002",
    "--- /var/lib/rbw/logs/postgres.stderr.log",
    "ERROR:  synthetic duplicate key value",
  ].join("\n");

  it("removes every Umami and Postgres log section rbw-start's fail() prints", () => {
    const scrubbed = scrubRuntimeLogs(failed);
    expect(scrubbed).toContain("rbw-start: no heartbeat within 60000 ms");
    expect(scrubbed).not.toContain("synthetic stdout");
    expect(scrubbed).not.toContain("P2002");
    expect(scrubbed).not.toContain("duplicate key");
  });

  it("keeps other sections, such as the build's own output", () => {
    const text = ["--- /var/lib/rbw/logs/umami.stderr.log", "runtime", "--- build stderr", "Type error: synthetic"].join("\n");
    expect(scrubRuntimeLogs(text)).toBe(["[runtime log lines withheld]", "--- build stderr", "Type error: synthetic"].join("\n"));
  });

  it("shows only exit statuses, build stderr and rbw-start's status lines from a rebuild", () => {
    const report = rebuildReport({
      build: { exit_code: 0, stderr: "synthetic warning" },
      start: { exit_code: 1, stdout: "postgres_ready_ms=700\nsynthetic check-db output", stderr: failed },
    });
    expect(report).toContain("build_exit_code: 0");
    expect(report).toContain("synthetic warning");
    expect(report).toContain("start_exit_code: 1");
    expect(report).toContain("postgres_ready_ms=700");
    expect(report).toContain("rbw-start: no heartbeat within 60000 ms");
    expect(report).not.toContain("check-db output");
    expect(report).not.toContain("synthetic Prisma error");
    expect(report).not.toContain("duplicate key");
  });

  it("says the app was not started after a failed build", () => {
    const report = rebuildReport({ build: { exit_code: 1, stderr: "Type error: synthetic" }, start: null });
    expect(report).toContain("start: not run (the build failed)");
  });
});

describe("byte caps", () => {
  it("cut long text with a marker and leave short text alone", () => {
    expect(headBytes("abcdef", 10)).toBe("abcdef");
    expect(headBytes("abcdef", 3)).toBe("abc\n[cut: showing the first 3 of 6 bytes]");
    expect(tailBytes("abcdef", 3)).toBe("[cut: showing the last 3 of 6 bytes]\ndef");
  });

  it("apply to bash output", async () => {
    const session = new FakeSession();
    session.bashResult = { exit_code: 0, stdout: "x".repeat(TOOL_OUTPUT_CAPS.bash_output_bytes + 10), stderr: "", timed_out: false };
    const outcome = await runTool("off", "bash", { command: "yes" }, session, newToolState(), ATTEMPT_CAPS);
    expect(outcome.output).toContain(`showing the last ${String(TOOL_OUTPUT_CAPS.bash_output_bytes)} of`);
  });
});

describe("paths", () => {
  it("must stay inside the app tree", () => {
    expect(isAppPath("src/lib/date.ts")).toBe(true);
    for (const bad of ["/etc/passwd", "../x", "src/../../x", "src//x", "./src", "a\\b", ""]) {
      expect(isAppPath(bad)).toBe(false);
    }
  });

  it("outside the app tree never reach the session", async () => {
    const session = new FakeSession();
    const outcome = await runTool("off", "write_file", { path: "../escape", content: "x" }, session, newToolState(), ATTEMPT_CAPS);
    expect(outcome.output).toMatch(/^error:/);
    expect(session.log).toEqual([]);
  });
});

describe("runTool", () => {
  it("refuses server_logs in the off arm without calling the session", async () => {
    const session = new FakeSession();
    const state = newToolState();
    const outcome = await runTool("off", "server_logs", {}, session, state, ATTEMPT_CAPS);
    expect(outcome.output).toBe("error: there is no tool named server_logs");
    expect(session.log).toEqual([]);
    expect(state.calls.server_logs).toBe(0);
  });

  it("passes the server_logs cursor through and shows the next one", async () => {
    const session = new FakeSession();
    const outcome = await runTool("on", "server_logs", { cursor: "c0" }, session, newToolState(), ATTEMPT_CAPS);
    expect(session.log).toEqual(["server_logs:c0"]);
    expect(outcome.output.startsWith("next_cursor: c1\n")).toBe(true);
  });

  it("ends the attempt on submit", async () => {
    const outcome = await runTool("on", "submit", { summary: "done" }, new FakeSession(), newToolState(), ATTEMPT_CAPS);
    expect(outcome).toEqual({ output: "submitted", submitted: true, summary: "done" });
  });

  it("records bash commands for the contamination check", async () => {
    const state = newToolState();
    await runTool("off", "bash", { command: "ls" }, new FakeSession(), state, ATTEMPT_CAPS);
    expect(state.bash_commands).toEqual(["ls"]);
  });
});
