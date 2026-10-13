import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failed, ok } from "../../../local-runner/test/support/fakes.ts";
import { CLEAN, PLANTED, SOURCE_FILES, STRICT_TERM, TARGET, sha256 } from "../../../local-runner/test/support/synthetic.ts";
import { DEFAULT_LIMITS, Session, SessionError, SessionRefusal } from "../../src/session.ts";
import type { SessionOptions } from "../../src/session.ts";
import { IMAGE_ID, START_OK, SessionKit } from "../support/session-kit.ts";
import type { SessionKitOptions } from "../support/session-kit.ts";

function options(kit: SessionKit, extra: Partial<SessionOptions> = {}): SessionOptions {
  return { id: "uc1-test-on-01", image: "rbw-umami-kit:test", expectedDigest: null, work: join(kit.root, "work"), serverLogs: true, ...kit.inputs(), ...extra };
}

async function open(kitOptions: SessionKitOptions = {}, extra: Partial<SessionOptions> = {}) {
  const kit = new SessionKit(kitOptions);
  const { session, opened } = await Session.open(options(kit, extra), { docker: kit.docker, clock: kit.clock });
  return { kit, session, opened };
}

const LOG_TAIL_FAILURE = {
  code: 1,
  stdout: Buffer.from("postgres_ready_ms=640\nPrisma schema loaded from prisma/schema.prisma\n"),
  stderr: [
    "rbw-start: Umami exited before answering the heartbeat",
    "--- /var/lib/rbw/logs/umami.stdout.log",
    "  ▲ Next.js 16.0.0",
    "--- /var/lib/rbw/logs/umami.stderr.log",
    "PrismaClientKnownRequestError: Unique constraint failed on the fields: (`session_id`)",
    "",
  ].join("\n"),
  timedOut: false,
};

describe("opening a session", () => {
  it("audits the planted projection, starts a capped offline container by digest, overlays, snapshots, then builds and starts", async () => {
    const { kit, opened, session } = await open();
    expect(opened.audit.verdict).toBe("pass");
    expect(opened.digest).toBe(IMAGE_ID);
    expect(opened.planted_sha256).toBe(sha256(PLANTED));
    expect(opened.initial.ok).toBe(true);
    const [run] = kit.docker.named("run");
    expect(run).toEqual([
      "run", "--detach", "--name", "rbw-solver-uc1-test-on-01",
      "--network", "none", "--cpus", "4", "--memory", "8g", "--security-opt", "no-new-privileges",
      IMAGE_ID, "tail", "-f", "/dev/null",
    ]);
    expect(kit.files.get(TARGET)?.bytes.toString()).toBe(PLANTED);
    expect(kit.ran).toEqual(["cat-build-outputs", "rbw-place", "rbw-tracked", "rbw-snapshot", "rbw-check-cold", "rbw-build-app", "rbw-start"]);
    await session.close();
  });

  it("refuses before any container when the planted projection's audit does not pass", async () => {
    const kit = new SessionKit({ extra: [{ name: "app/README.md", content: `# Synthetic app ${STRICT_TERM}\n` }] });
    const opening = Session.open(options(kit), { docker: kit.docker, clock: kit.clock });
    await expect(opening).rejects.toBeInstanceOf(SessionRefusal);
    await expect(opening).rejects.toThrow(/audit_not_passed/);
    expect(kit.docker.named("run")).toEqual([]);
    expect(kit.docker.named("exec")).toEqual([]);
  });

  it("removes the container when its tracked files are not the audited projection", async () => {
    const kit = new SessionKit({
      tamper: (files) => {
        files.set("src/index.ts", { bytes: Buffer.from("export const index = 2;\n"), mode: 0o644 });
      },
    });
    const opening = Session.open(options(kit), { docker: kit.docker, clock: kit.clock });
    await expect(opening).rejects.toThrow(/overlay_mismatch: .*src\/index\.ts/);
    expect(kit.docker.named("rm").at(-1)).toEqual(["rm", "--force", "rbw-solver-uc1-test-on-01"]);
    expect(kit.ran).not.toContain("rbw-build-app");
  });

  it("refuses an image whose build-outputs list is not the repository's", async () => {
    const kit = new SessionKit({ buildOutputs: "dir .next\n" });
    await expect(Session.open(options(kit), { docker: kit.docker, clock: kit.clock })).rejects.toThrow(/build_outputs_mismatch/);
    expect(kit.docker.named("rm").at(-1)).toEqual(["rm", "--force", "rbw-solver-uc1-test-on-01"]);
  });

  it("refuses an image that does not resolve to the expected digest, before any container", async () => {
    const kit = new SessionKit();
    const opening = Session.open(options(kit, { expectedDigest: `sha256:${"8".repeat(64)}` }), { docker: kit.docker, clock: kit.clock });
    await expect(opening).rejects.toBeInstanceOf(SessionRefusal);
    await expect(opening).rejects.toThrow(/image_mismatch: rbw-umami-kit:test is sha256:7{64}, not the expected sha256:8{64}/);
    expect(kit.docker.named("run")).toEqual([]);
    expect(kit.docker.named("create")).toEqual([]);
  });

  it("runs an image that resolves to the expected digest and records the digest in the submission", async () => {
    const { session } = await open({}, { expectedDigest: IMAGE_ID });
    await session.submit();
    expect(JSON.parse(readFileSync(join(session.work, "submission", "submission.json"), "utf8"))).toMatchObject({ image_digest: IMAGE_ID });
  });

  it("does not remove a container it did not create when docker run fails", async () => {
    const kit = new SessionKit({ run: () => failed(125, 'docker: Error response from daemon: Conflict. The container name "/rbw-solver-uc1-test-on-01" is already in use.\n') });
    await expect(Session.open(options(kit), { docker: kit.docker, clock: kit.clock })).rejects.toThrow(/container_start_failed: .*already in use/);
    expect(kit.docker.named("rm").filter((call) => call.includes("rbw-solver-uc1-test-on-01"))).toEqual([]);
    expect(kit.docker.named("cp").filter((call) => call[1]?.startsWith("rbw-solver-uc1-test-on-01:"))).toEqual([]);
  });

  it("reports the original failure when removing the container also fails", async () => {
    const kit = new SessionKit({
      buildOutputs: "dir .next\n",
      rm: (container) => (container === "rbw-solver-uc1-test-on-01" ? failed(1, "Error: cannot remove container\n") : ok()),
    });
    await expect(Session.open(options(kit), { docker: kit.docker, clock: kit.clock })).rejects.toThrow(/build_outputs_mismatch/);
  });

  it("removes the container and fails when the first start fails", async () => {
    const kit = new SessionKit({ start: (call) => (call === 1 ? LOG_TAIL_FAILURE : ok(START_OK)) });
    const opening = Session.open(options(kit), { docker: kit.docker, clock: kit.clock });
    await expect(opening).rejects.toBeInstanceOf(SessionError);
    await expect(opening).rejects.toThrow(/initial_start_failed/);
    expect(kit.docker.named("rm").at(-1)).toEqual(["rm", "--force", "rbw-solver-uc1-test-on-01"]);
  });

  it("fails as an infrastructure error, without building, when the fresh container is not cold", async () => {
    const kit = new SessionKit({ checkCold: () => ({ ...failed(1), stdout: Buffer.from("cache present: .turbo\n") }) });
    await expect(Session.open(options(kit), { docker: kit.docker, clock: kit.clock })).rejects.toThrow(/not_cold: cache present: \.turbo/);
    expect(kit.ran).not.toContain("rbw-build-app");
    expect(kit.docker.named("rm").at(-1)).toEqual(["rm", "--force", "rbw-solver-uc1-test-on-01"]);
  });

  it("refuses a work directory that is not empty and an ID that cannot name a container", async () => {
    const kit = new SessionKit();
    await expect(Session.open(options(kit, { id: "UC1 attempt" }), { docker: kit.docker, clock: kit.clock })).rejects.toThrow(/bad_id/);
    await expect(Session.open(options(kit, { work: kit.root }), { docker: kit.docker, clock: kit.clock })).rejects.toThrow(/work_not_empty/);
  });
});

describe("rebuild_restart", () => {
  it("stops, resets the build outputs, checks the build is cold, builds and starts", async () => {
    const { kit, session } = await open();
    kit.ran.length = 0;
    const result = await session.rebuildRestart();
    expect(kit.ran).toEqual(["rbw-stop", "rbw-kill-app", "rbw-reset", "rbw-check-cold", "rbw-build-app", "rbw-start"]);
    expect(result).toMatchObject({ ok: true, refused: null, build: { exit_code: 0 }, start: { exit_code: 0, output: START_OK, withheld_lines: 0 } });
  });

  it("scrubs the runtime log tails rbw-start prints, in both arms, and keeps them for the harness", async () => {
    for (const serverLogs of [true, false]) {
      const { session } = await open({ start: (call) => (call === 2 ? LOG_TAIL_FAILURE : ok(START_OK)) }, { serverLogs });
      const result = await session.rebuildRestart();
      expect(result.ok).toBe(false);
      expect(result.start?.output).toBe("postgres_ready_ms=640\nrbw-start: Umami exited before answering the heartbeat\n[5 lines of runtime output withheld]\n");
      expect(JSON.stringify(result)).not.toMatch(/Prisma|Unique constraint|Next\.js|umami\.stderr/);
      const raw = readFileSync(join(session.work, "rebuilds", "rebuild-01.json"), "utf8");
      expect(raw).toContain("Unique constraint failed");
    }
  });

  it("returns a failed build's output and does not start the app", async () => {
    const { kit, session } = await open({ build: (call) => (call === 2 ? { ...failed(1), stdout: Buffer.from("Type error: ';' expected.\nbuild_exit=1\n") } : ok("build_exit=0\n")) });
    kit.ran.length = 0;
    const result = await session.rebuildRestart();
    expect(result).toMatchObject({ ok: false, start: null, build: { exit_code: 1 } });
    expect(result.build.output).toContain("Type error");
    expect(kit.ran).not.toContain("rbw-start");
  });

  it("returns a warm tree after the reset as the agent's failed rebuild, without building", async () => {
    const warm = { ...failed(1), stdout: Buffer.from("pnpm store present: /tmp/.pnpm-store\n") };
    const { kit, session } = await open({ checkCold: (call) => (call === 2 ? warm : ok()) });
    kit.ran.length = 0;
    const result = await session.rebuildRestart();
    expect(result).toMatchObject({ ok: false, refused: "not_cold", build: { exit_code: null }, start: null });
    expect(result.build.output).toContain("pnpm store present: /tmp/.pnpm-store");
    expect(kit.ran).toEqual(["rbw-stop", "rbw-kill-app", "rbw-reset", "rbw-check-cold"]);
    expect(await session.rebuildRestart()).toMatchObject({ ok: true });
  });

  it("holds the pre-registered cap of 8 rebuilds by default", async () => {
    expect(DEFAULT_LIMITS.maxRebuilds).toBe(8);
    const { kit, session } = await open();
    for (let index = 0; index < 8; index += 1) expect(await session.rebuildRestart()).toMatchObject({ ok: true });
    const before = kit.docker.calls.length;
    expect(await session.rebuildRestart()).toMatchObject({ ok: false, refused: "rebuild_cap" });
    expect(kit.docker.calls.length).toBe(before);
  });

  it("refuses past the rebuild cap without running anything", async () => {
    const { kit, session } = await open({}, { limits: { maxRebuilds: 1 } });
    await session.rebuildRestart();
    const before = kit.docker.calls.length;
    expect(await session.rebuildRestart()).toMatchObject({ ok: false, refused: "rebuild_cap", start: null });
    expect(kit.docker.calls.length).toBe(before);
  });
});

describe("the agent's other tools", () => {
  it("runs a command as rbw-app through rbw-launch with a timeout and an output cap", async () => {
    const { kit, session } = await open();
    expect(await session.run("ls src")).toEqual({ exit_code: 0, stdout: "ran: ls src\n", stderr: "", timed_out: false });
    expect(kit.execs().at(-1)).toEqual(["/opt/rbw/bin/rbw-launch", "--as", "app", "--cwd", "/workspace/app", "--timeout-ms", "120000", "--max-stream-bytes", "65536", "--", "/bin/sh", "-c", "ls src"]);
    expect(await session.run("sleep 999")).toMatchObject({ exit_code: 124, timed_out: true });
  });

  it("reads a file as rbw-app, capped, and reports a read error", async () => {
    const { session } = await open({}, { limits: { readBytes: 10 } });
    expect(await session.readFile(TARGET)).toEqual({ ok: true, content: PLANTED.slice(0, 10), truncated: true });
    expect(await session.readFile("missing.ts")).toEqual({ ok: false, reason: "head: /workspace/app/missing.ts: No such file or directory" });
  });

  it("writes only tracked files under the app", async () => {
    const { kit, session } = await open();
    for (const path of ["src/proxy.ts", ".next/server.js", "../../etc/passwd", "/etc/passwd", "src/../../x"]) {
      expect(await session.writeFile(path, "x")).toEqual({ ok: false, reason: "not_tracked" });
    }
    expect(await session.writeFile(`/workspace/app/${TARGET}`, CLEAN)).toEqual({ ok: true, sha256: sha256(CLEAN), bytes: Buffer.byteLength(CLEAN) });
    expect(kit.files.get(TARGET)?.bytes.toString()).toBe(CLEAN);
  });

  it("refuses a file above the write limit without copying anything in", async () => {
    const { kit, session } = await open({}, { limits: { writeBytes: 16 } });
    const before = kit.docker.named("cp").length;
    expect(await session.writeFile(TARGET, "x".repeat(17))).toEqual({ ok: false, reason: "too_large" });
    expect(kit.docker.named("cp")).toHaveLength(before);
    expect(kit.files.get(TARGET)?.bytes.toString()).toBe(PLANTED);
    expect(await session.writeFile(TARGET, "x".repeat(16))).toMatchObject({ ok: true, bytes: 16 });
  });

  it("runs parallel calls one at a time, so parallel writes each land in their own file", async () => {
    const { kit, session } = await open();
    const [target, readme] = await Promise.all([session.writeFile(TARGET, CLEAN), session.writeFile("README.md", "# changed\n")]);
    expect(target).toEqual({ ok: true, sha256: sha256(CLEAN), bytes: Buffer.byteLength(CLEAN) });
    expect(readme).toEqual({ ok: true, sha256: sha256("# changed\n"), bytes: 10 });
    expect(kit.files.get(TARGET)?.bytes.toString()).toBe(CLEAN);
    expect(kit.files.get("README.md")?.bytes.toString()).toBe("# changed\n");
    const stagings = kit.docker.named("cp").map((call) => call[2]).filter((to) => to?.includes("/incoming"));
    expect(new Set(stagings).size).toBe(stagings.length);
  });

  it("ends the attempt once when end is called twice at the same time", async () => {
    const { kit, session } = await open();
    kit.ran.length = 0;
    const [first, second] = await Promise.all([session.end("cap"), session.submit()]);
    expect(second).toBe(first);
    expect(kit.ran.filter((name) => name === "rbw-tracked")).toHaveLength(1);
  });

  it("serves server logs by cursor in the on arm", async () => {
    const { kit, session } = await open({}, { limits: { logBytes: 8 } });
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "first line\nsecond\n");
    const tail = await session.serverLogs();
    expect(tail).toMatchObject({ ok: true, umami: { text: "\nsecond\n", size: 18, more: false, restarted: false }, cursor: { generation: 1, umami: 18, postgres: 0 } });
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "first line\nsecond\nthird line\n");
    const next = await session.serverLogs(tail.ok ? tail.cursor : null);
    expect(next).toMatchObject({ ok: true, umami: { text: "third li", more: true }, cursor: { umami: 26 } });
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "new\n");
    expect(await session.serverLogs({ generation: 1, umami: 26, postgres: 0 })).toMatchObject({ ok: true, umami: { text: "new\n", restarted: true }, cursor: { umami: 4 } });
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "new\n12345678");
    expect(await session.serverLogs({ generation: 1, umami: 12, postgres: 0 })).toMatchObject({ ok: true, umami: { text: "", size: 12, more: false, restarted: false }, cursor: { umami: 12 } });
  });

  it("reads a log from its start after a rebuild, even when the new log is longer than the old cursor", async () => {
    const { kit, session } = await open({}, { limits: { logBytes: 64 } });
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "first start\n");
    kit.logs.set("/var/lib/rbw/logs/postgres.stderr.log", "pg first\n");
    const before = await session.serverLogs();
    if (!before.ok) throw new Error("server logs refused");
    expect(before.cursor).toEqual({ generation: 1, umami: 12, postgres: 9 });
    await session.rebuildRestart();
    kit.logs.set("/var/lib/rbw/logs/umami.stderr.log", "Error: P1001 cannot reach the database\n");
    kit.logs.set("/var/lib/rbw/logs/postgres.stderr.log", "pg second start, longer\n");
    const after = await session.serverLogs(before.cursor);
    expect(after).toMatchObject({
      ok: true,
      umami: { text: "Error: P1001 cannot reach the database\n", restarted: true },
      postgres: { text: "pg second start, longer\n", restarted: true },
      cursor: { generation: 2, umami: 39, postgres: 24 },
    });
    if (!after.ok) throw new Error("server logs refused");
    expect(await session.serverLogs(after.cursor)).toMatchObject({ ok: true, umami: { text: "", restarted: false } });
  });

  it("refuses server logs in the off arm without reading them", async () => {
    const { kit, session } = await open({}, { serverLogs: false });
    const before = kit.docker.calls.length;
    expect(await session.serverLogs()).toEqual({ ok: false, reason: "server_logs_unavailable" });
    expect(kit.docker.calls.length).toBe(before);
  });
});

describe("submit and close", () => {
  it("leaves the build's tracked outputs out of write_file and the submission's scope", async () => {
    const output = "src/tracker/index.d.ts";
    const kit: SessionKit = new SessionKit({
      sourceFiles: { ...SOURCE_FILES, [output]: "export {};\n" },
      build: (call) => {
        // A rebuild regenerates the tracked output from the changed source.
        if (call === 2) kit.files.set(output, { bytes: Buffer.from("export declare const zone: string;\n"), mode: 0o644 });
        return ok("build_exit=0\n");
      },
    });
    const { session } = await Session.open(options(kit), { docker: kit.docker, clock: kit.clock });
    expect(await session.writeFile(output, "x")).toEqual({ ok: false, reason: "not_tracked" });
    await session.writeFile(TARGET, CLEAN);
    await session.rebuildRestart();
    expect(await session.submit()).toMatchObject({ scope: "in_scope", changed: [{ path: TARGET, change: "modified" }] });
  });

  it("still finds a build output that differs from the projection before any build", async () => {
    const output = "src/tracker/index.d.ts";
    const kit = new SessionKit({
      sourceFiles: { ...SOURCE_FILES, [output]: "export {};\n" },
      tamper: (files) => {
        files.set(output, { bytes: Buffer.from("stale\n"), mode: 0o644 });
      },
    });
    await expect(Session.open(options(kit), { docker: kit.docker, clock: kit.clock })).rejects.toThrow(/overlay_mismatch: .*src\/tracker\/index\.d\.ts/);
  });

  it("hands over the target file's bytes and diff when only the target changed", async () => {
    const { session } = await open();
    await session.writeFile(TARGET, CLEAN);
    const result = await session.submit();
    expect(result).toMatchObject({ scope: "in_scope", changed: [{ path: TARGET, change: "modified" }], target_sha256: sha256(CLEAN) });
    expect(result.target_patch).toContain("-  return range(unit);\n+  return range(unit, zone);\n");
    expect(readFileSync(join(session.work, "submission", "target.bin"), "utf8")).toBe(CLEAN);
    expect(JSON.parse(readFileSync(join(session.work, "submission", "submission.json"), "utf8"))).toMatchObject({ ended_by: "submit", scope: "in_scope" });
    await expect(session.run("ls")).rejects.toBeInstanceOf(SessionError);
  });

  it("marks a submission out of scope when another tracked file changed", async () => {
    const { session } = await open();
    await session.writeFile(TARGET, CLEAN);
    await session.writeFile("README.md", "# changed\n");
    expect(await session.end("cap")).toMatchObject({ scope: "out_of_scope", changed: [{ path: "README.md", change: "modified" }, { path: TARGET, change: "modified" }] });
  });

  it("copies the logs out and removes the container once", async () => {
    const { kit, session } = await open();
    await session.close();
    await session.close();
    expect(kit.docker.named("cp").filter((call) => call[1] === "rbw-solver-uc1-test-on-01:/var/lib/rbw/logs")).toHaveLength(1);
    expect(kit.docker.named("rm").filter((call) => call[2] === "rbw-solver-uc1-test-on-01")).toHaveLength(1);
    await expect(session.readFile(TARGET)).rejects.toThrow(/session_closed/);
    expect(existsSync(join(session.work, "events.jsonl"))).toBe(true);
  });

  it("keeps the container and fails when the runtime logs cannot be copied out, then retries", async () => {
    const { kit, session } = await open({ copyLogs: (call) => (call === 1 ? failed(1, "Error response from daemon: transient\n") : ok()) });
    await expect(session.close()).rejects.toThrow(/logs_copy_failed/);
    expect(kit.docker.named("rm").filter((call) => call[2] === "rbw-solver-uc1-test-on-01")).toHaveLength(0);
    await expect(session.readFile(TARGET)).rejects.toThrow(/session_closed/);
    await session.close();
    expect(kit.docker.named("cp").filter((call) => call[1] === "rbw-solver-uc1-test-on-01:/var/lib/rbw/logs")).toHaveLength(2);
    expect(kit.docker.named("rm").filter((call) => call[2] === "rbw-solver-uc1-test-on-01")).toHaveLength(1);
  });
});
