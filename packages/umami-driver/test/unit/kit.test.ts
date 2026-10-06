import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FixtureDatabase } from "../../src/database.ts";
import type { ProcView } from "../../src/environment.ts";
import { KIT, KIT_LOG_FILES, KIT_SCRIPTS, ExternalStack, KitStack, OWNER_DATABASE_URL, heartbeat, launcherExit, verifierPaths } from "../../src/kit.ts";
import { DEFAULT_STOP } from "../../src/process.ts";
import type { CommandResult, CommandSpec, GroupControl, LongProcess, ProcessRunner } from "../../src/process.ts";
import { FakeTimers, commandResult } from "../helpers.ts";

const KIT_DIR = new URL("../../../../kit/umami/", import.meta.url);

/** A runner whose started commands settle when the test says so, and whose short commands answer from a script. */
class KitRunner implements ProcessRunner {
  readonly started: { pid: number; spec: CommandSpec }[] = [];
  readonly ran: CommandSpec[] = [];
  private readonly answer: (spec: CommandSpec) => CommandResult;
  private readonly startResult: CommandResult;

  constructor(answer: (spec: CommandSpec) => CommandResult = () => commandResult(), startResult: CommandResult = commandResult()) {
    this.answer = answer;
    this.startResult = startResult;
  }

  run(spec: CommandSpec): Promise<CommandResult> {
    this.ran.push(spec);
    return Promise.resolve(this.answer(spec));
  }

  start(spec: CommandSpec): LongProcess {
    const pid = 500 + this.started.length * 100;
    this.started.push({ pid, spec });
    return { pid, result: Promise.resolve(this.startResult) };
  }
}

/**
 * The start group 500 holds the launcher 510, named by /run/rbw/umami.pid, whose child 520 runs as
 * rbw-app and leads the Umami group; the socket on 127.0.0.1:3000 is rbw-app's. Process 610 is a
 * root process outside the start group.
 */
const PROCESSES = [
  { pid: 510, ppid: 1, pgrp: 500, uid: 0, alive: true },
  { pid: 520, ppid: 510, pgrp: 520, uid: KIT.appUid, alive: true },
  { pid: 530, ppid: 520, pgrp: 520, uid: KIT.appUid, alive: true },
  { pid: 610, ppid: 1, pgrp: 610, uid: 0, alive: true },
];

function proc(overrides: Partial<ProcView> = {}): ProcView {
  return {
    listeningSockets: () => Promise.resolve([{ host: "127.0.0.1", port: 3000, inode: 5, uid: KIT.appUid }]),
    processes: () => Promise.resolve(PROCESSES),
    pidFile: (name) => Promise.resolve(name === "umami" ? 510 : null),
    ...overrides,
  };
}

function groups(alive: (pgid: number) => boolean = () => false): GroupControl & { signals: string[] } {
  const signals: string[] = [];
  return {
    signals,
    signal(pgid, signal) {
      signals.push(`${signal} ${String(pgid)}`);
    },
    alive,
  };
}

function database(events: string[], overrides: Partial<FixtureDatabase> = {}): FixtureDatabase {
  return {
    createTemplate: () => {
      events.push("template");
      return Promise.resolve();
    },
    reset: () => {
      events.push("reset");
      return Promise.resolve();
    },
    appCanConnect: () => {
      events.push("app-connect");
      return Promise.resolve({ ok: true });
    },
    ...overrides,
  };
}

function stack(
  runner: KitRunner,
  options: { db?: FixtureDatabase | null; control?: GroupControl; view?: ProcView; heartbeat?: () => Promise<boolean> } = {},
) {
  const timers = new FakeTimers();
  const events: string[] = [];
  const kit = new KitStack({
    runner,
    timers,
    proc: options.view ?? proc(),
    groups: options.control ?? groups(),
    database: options.db === undefined ? database(events) : options.db,
    heartbeat: options.heartbeat ?? (() => Promise.resolve(true)),
  });
  return { kit, timers, events };
}

describe("kit layout and interface", () => {
  it("names the kit's own build, start and stop scripts, which exist in the kit", () => {
    expect(KIT_SCRIPTS).toEqual({ build: "/opt/rbw/bin/rbw-build-app", start: "/opt/rbw/bin/rbw-start", stop: "/opt/rbw/bin/rbw-stop" });
    for (const script of Object.values(KIT_SCRIPTS)) {
      expect(existsSync(new URL(`bin/${script.split("/").at(-1) ?? ""}`, KIT_DIR))).toBe(true);
    }
  });

  it("checks the listener against the app user's UID as the kit's launcher sets it", () => {
    const launcher = readFileSync(new URL("bin/rbw-launch", KIT_DIR), "utf8");
    expect(launcher).toContain(`app) uid=${String(KIT.appUid)};`);
    expect(KIT.runDir).toBe("/run/rbw");
    expect(readFileSync(new URL("bin/rbw-start", KIT_DIR), "utf8")).toContain('echo $! > "$RUN/umami.pid"');
  });

  it("uses the kit's owner connection string, over the socket and without a password", () => {
    const ownerEnvironment = readFileSync(new URL("etc/owner.environment", KIT_DIR), "utf8");
    expect(ownerEnvironment).toContain(`DATABASE_URL=${OWNER_DATABASE_URL}\n`);
    expect(OWNER_DATABASE_URL).toBe("postgresql://umami_owner@localhost/umami?host=/run/rbw-pg");
  });

  it("finds each verifier part where the kit puts it", () => {
    expect(verifierPaths(KIT.verifierDir)).toEqual({
      suite: "/opt/rbw/verifier/suite",
      closureList: "/opt/rbw/verifier/closure.sha256",
      marker: "/opt/rbw/verifier/package.json",
      nodeModules: "/opt/rbw/verifier/node_modules",
      lock: "/opt/rbw/verifier/pnpm-lock.yaml",
      node: "/opt/rbw/verifier/node/bin/node",
      manifest: "/opt/rbw/verifier/original-suite.json",
      fixture: "/opt/rbw/verifier/kit/umami-fixture",
    });
    const dockerfile = readFileSync(new URL("Dockerfile", KIT_DIR), "utf8");
    for (const path of ["/opt/rbw/verifier/suite", "/opt/rbw/verifier/node_modules", "/opt/rbw/verifier/node/bin/node", "/opt/rbw/verifier/closure.sha256", "/opt/rbw/verifier/kit/"]) {
      expect(dockerfile).toContain(path);
    }
  });

  it("keeps the logs rbw-start writes", () => {
    const start = readFileSync(new URL("bin/rbw-start", KIT_DIR), "utf8");
    for (const name of KIT_LOG_FILES) expect(start).toContain(`$LOGS/${name}.log`);
  });

  it.each([
    [0, "ok"],
    [1, "failed"],
    [124, "timeout"],
    [125, "launch_error"],
    [130, "stopped"],
    [143, "stopped"],
    [null, "failed"],
  ] as const)("reads launcher exit status %s as %s", (code, meaning) => {
    expect(launcherExit(code)).toBe(meaning);
  });
});

describe("kit stack", () => {
  it("builds with rbw-build-app as root, from /, with a fixed PATH and nothing else", async () => {
    const runner = new KitRunner();
    const { kit } = stack(runner);
    expect((await kit.build(new AbortController().signal)).reason).toBeNull();
    expect(runner.ran[0]).toMatchObject({ command: "/opt/rbw/bin/rbw-build-app", args: [], cwd: "/" });
    expect(Object.keys(runner.ran[0]?.env ?? {})).toEqual(["PATH"]);
  });

  it.each([
    [2, "build_failed"],
    [125, "build_failed"],
    [124, "timeout"],
  ] as const)("gives %s from rbw-build-app the reason %s", async (code, reason) => {
    const { kit } = stack(new KitRunner(() => commandResult({ code })));
    const result = await kit.build(new AbortController().signal);
    expect(result.reason).toBe(reason);
    expect(result.logs.map((log) => log.name)).toEqual(["build"]);
  });

  it("leaves a build stopped by the phase deadline to the phase timing", async () => {
    const { kit } = stack(new KitRunner(() => commandResult({ code: 143, aborted: true })));
    expect((await kit.build(new AbortController().signal)).reason).toBeNull();
  });

  it("starts with rbw-start, then copies the migrated database to the fixture template once", async () => {
    const runner = new KitRunner();
    const { kit, events } = stack(runner);
    const result = await kit.start(new AbortController().signal);
    expect(result.reason).toBeNull();
    expect(runner.started.map((item) => item.spec.command)).toEqual(["/opt/rbw/bin/rbw-start"]);
    expect(events).toEqual(["template"]);
    expect(result.logs.map((log) => log.name)).toEqual(["start"]);
  });

  it("gives startup_failed when rbw-start fails, and makes no template", async () => {
    const runner = new KitRunner(() => commandResult(), commandResult({ code: 1 }));
    const { kit, events } = stack(runner);
    expect((await kit.start(new AbortController().signal)).reason).toBe("startup_failed");
    expect(events).toEqual([]);
  });

  it("gives seed_failed when the template copy fails, without passing on the error text", async () => {
    const events: string[] = [];
    const db = database(events, { createTemplate: () => Promise.reject(new Error("synthetic connection detail")) });
    const { kit } = stack(new KitRunner(), { db });
    const result = await kit.start(new AbortController().signal);
    expect(result.reason).toBe("seed_failed");
    expect(result.detail).not.toContain("synthetic connection detail");
  });

  it("confirms the app's identity through the launcher that rbw-start started", async () => {
    const runner = new KitRunner();
    const { kit } = stack(runner);
    await kit.start(new AbortController().signal);
    expect(await kit.verifyIdentity()).toEqual({ kind: "kit", base_url: "http://127.0.0.1:3000", host: "127.0.0.1", port: 3000, pid: 520 });
  });

  it("refuses an identity whose launcher is outside the start group, or whose listener is not rbw-app's", async () => {
    const outside = stack(new KitRunner(), { view: proc({ pidFile: () => Promise.resolve(610) }) }).kit;
    await outside.start(new AbortController().signal);
    expect(await outside.verifyIdentity()).toBeNull();
    const rootListener = proc({ listeningSockets: () => Promise.resolve([{ host: "127.0.0.1", port: 3000, inode: 5, uid: 0 }]) });
    const other = stack(new KitRunner(), { view: rootListener }).kit;
    await other.start(new AbortController().signal);
    expect(await other.verifyIdentity()).toBeNull();
  });

  it("refuses an identity when nothing listens on the expected port, or before the stack started", async () => {
    const view = proc({ listeningSockets: () => Promise.resolve([{ host: "127.0.0.1", port: 3001, inode: 5, uid: KIT.appUid }]) });
    const { kit } = stack(new KitRunner(), { view });
    expect(await kit.verifyIdentity()).toBeNull();
    await kit.start(new AbortController().signal);
    expect(await kit.verifyIdentity()).toBeNull();
  });

  it("resets through the fixture, then checks the application role and the heartbeat", async () => {
    let beats = 0;
    const { kit, events } = stack(new KitRunner(), {
      heartbeat: () => {
        events.push("heartbeat");
        beats += 1;
        return Promise.resolve(beats > 1);
      },
    });
    const result = await kit.resetFixture(1, new AbortController().signal);
    expect(result.reason).toBeNull();
    expect(events).toEqual(["reset", "app-connect", "heartbeat", "heartbeat"]);
  });

  it("gives seed_failed when the reset throws, without passing on the error text", async () => {
    const events: string[] = [];
    const db = database(events, { reset: () => Promise.reject(new Error("synthetic connection detail")) });
    const { kit } = stack(new KitRunner(), { db });
    const result = await kit.resetFixture(1, new AbortController().signal);
    expect(result.reason).toBe("seed_failed");
    expect(result.detail).not.toContain("synthetic connection detail");
  });

  it("gives seed_failed when the application role cannot connect to the recreated database", async () => {
    const events: string[] = [];
    const db = database(events, { appCanConnect: () => Promise.resolve({ ok: false, code: "28P01" }) });
    const { kit } = stack(new KitRunner(), { db });
    const result = await kit.resetFixture(2, new AbortController().signal);
    expect(result).toMatchObject({ reason: "seed_failed" });
    expect(result.detail).toContain("28P01");
  });

  it("gives startup_failed when Umami stops answering after the reset", async () => {
    const { kit, timers } = stack(new KitRunner(), { heartbeat: () => Promise.resolve(false) });
    const before = timers.now();
    expect((await kit.resetFixture(1, new AbortController().signal)).reason).toBe("startup_failed");
    expect(timers.now() - before).toBeLessThanOrEqual(30000);
  });

  it("stops with rbw-stop and confirms the start group has ended", async () => {
    const runner = new KitRunner();
    const control = groups();
    const { kit } = stack(runner, { control });
    await kit.start(new AbortController().signal);
    const report = await kit.stop(new AbortController().signal);
    expect(runner.ran.map((spec) => spec.command)).toEqual(["/opt/rbw/bin/rbw-stop"]);
    expect(report.ok).toBe(true);
    expect(report.records).toEqual([{ pgid: 500, term_sent: false, kill_sent: false, ended: true, waited_ms: 0 }]);
    expect(control.signals).toEqual([]);
    expect(report.logs.map((log) => log.name)).toEqual(["stop"]);
  });

  it("sends TERM, then KILL, to a start group that outlives rbw-stop, and reports a failed stop", async () => {
    const runner = new KitRunner((spec) => commandResult({ code: spec.command === KIT_SCRIPTS.stop ? 1 : 0 }));
    let killed = false;
    const control = groups(() => !killed);
    const signal = control.signal.bind(control);
    control.signal = (pgid, name) => {
      signal(pgid, name);
      if (name === "SIGKILL") killed = true;
    };
    const { kit } = stack(runner, { control });
    await kit.start(new AbortController().signal);
    const report = await kit.stop(new AbortController().signal);
    expect(control.signals).toEqual(["SIGTERM 500", "SIGKILL 500"]);
    expect(report.records[0]).toMatchObject({ pgid: 500, term_sent: true, kill_sent: true, ended: true });
    expect(report.ok).toBe(false);
  });

  it("stops within the stop phase's deadline: rbw-stop gets its signal, and a late group is killed without the grace", async () => {
    const runner = new KitRunner();
    let killed = false;
    const control = groups(() => !killed);
    const signal = control.signal.bind(control);
    control.signal = (pgid, name) => {
      signal(pgid, name);
      if (name === "SIGKILL") killed = true;
    };
    const { kit, timers } = stack(runner, { control });
    await kit.start(new AbortController().signal);
    const deadline = new AbortController();
    deadline.abort(new Error("stop reached its time limit"));
    const before = timers.now();
    const report = await kit.stop(deadline.signal);
    expect(runner.ran.find((spec) => spec.command === KIT_SCRIPTS.stop)?.signal).toBe(deadline.signal);
    expect(control.signals).toEqual(["SIGTERM 500", "SIGKILL 500"]);
    expect(report.records[0]).toMatchObject({ ended: true, kill_sent: true });
    expect(timers.now() - before).toBeLessThan(DEFAULT_STOP.graceMs);
  });

  it("lists the kit's process logs under their names", () => {
    const { kit } = stack(new KitRunner());
    expect(kit.logFiles()).toEqual(KIT_LOG_FILES.map((name) => ({ name, path: `/var/lib/rbw/logs/${name}.log` })));
  });
});

describe("heartbeat", () => {
  it("answers false, instead of throwing, once a phase deadline has aborted its signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("readiness reached its time limit"));
    expect(await heartbeat("http://127.0.0.1:9", controller.signal)).toBe(false);
  });
});

describe("external stack (development)", () => {
  it("cannot reset the fixture and stops nothing", async () => {
    const external = new ExternalStack("http://host.example.invalid:3100/", new FakeTimers());
    expect(external.baseUrl).toBe("http://host.example.invalid:3100");
    expect((await external.resetFixture()).reason).toBe("seed_failed");
    expect(await external.stop()).toEqual({ ok: true, records: [], logs: [] });
    expect(external.logFiles()).toEqual([]);
  });
});
