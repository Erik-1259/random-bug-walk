// The kit image as built (kit/umami, see its README): its layout, its own build, start and stop
// scripts, the launcher's exit statuses, and the owner role's connection. The scripts run as root
// and start every app and database process through rbw-launch as rbw-app or rbw-db, so the driver
// never re-derives those command lines.
import { join } from "node:path";
import type { TrialReason } from "@rbw/schema";
import type { FixtureDatabase } from "./database.ts";
import { verifyExternalIdentity, verifyKitIdentity } from "./environment.ts";
import type { ProcView, VerifiedIdentity } from "./environment.ts";
import type { Timers } from "./limits.ts";
import { DEFAULT_STOP, stopProcessGroup } from "./process.ts";
import type { CommandSpec, GroupControl, LongProcess, ProcessRunner, StopRecord } from "./process.ts";
import type { AppStack, StepResult, StopReport } from "./trial.ts";

export const KIT = {
  appDir: "/workspace/app",
  etcDir: "/opt/rbw/etc",
  verifierDir: "/opt/rbw/verifier",
  resultsDir: "/var/lib/rbw/results",
  logsDir: "/var/lib/rbw/logs",
  pgdata: "/var/lib/rbw/pgdata",
  host: "127.0.0.1",
  appPort: 3000,
  /** rbw-app's UID, as rbw-launch sets it. */
  appUid: 2001,
  /** Where rbw-start writes the launchers' PID files. */
  runDir: "/run/rbw",
  cgroupDir: "/sys/fs/cgroup",
} as const;

export const KIT_BASE_URL = `http://${KIT.host}:${String(KIT.appPort)}`;

export const KIT_SCRIPTS = {
  build: "/opt/rbw/bin/rbw-build-app",
  start: "/opt/rbw/bin/rbw-start",
  stop: "/opt/rbw/bin/rbw-stop",
} as const;

/** The owner role, which the kit lets in only through the Postgres socket in /run/rbw-pg (etc/owner.environment). */
export const OWNER_DATABASE_URL = "postgresql://umami_owner@localhost/umami?host=/run/rbw-pg";

/** Holds the application role's connection string, with its synthetic password. */
export const APP_ENVIRONMENT_FILE = `${KIT.etcDir}/app.environment`;

/** The logs rbw-start writes for Postgres and Umami, by name under /var/lib/rbw/logs. */
export const KIT_LOG_FILES = ["postgres.stdout", "postgres.stderr", "umami.stdout", "umami.stderr"] as const;

/** The PATH for the kit's root scripts, which call pg_isready, curl and the shell tools. */
const ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Where the kit puts each verifier part. The driver and the fixture come from --build-context rbw-kit=<dir>. */
export function verifierPaths(verifierDir: string) {
  return {
    suite: join(verifierDir, "suite"),
    closureList: join(verifierDir, "closure.sha256"),
    marker: join(verifierDir, "package.json"),
    nodeModules: join(verifierDir, "node_modules"),
    lock: join(verifierDir, "pnpm-lock.yaml"),
    node: join(verifierDir, "node", "bin", "node"),
    manifest: join(verifierDir, "original-suite.json"),
    fixture: join(verifierDir, "kit", "umami-fixture"),
  };
}

export type VerifierPaths = ReturnType<typeof verifierPaths>;

/** Umami's default administrator, which its migrations create in every fresh database. */
export const KIT_ADMIN = { username: "admin", password: "umami" } as const;

/** The launcher's exit statuses, which rbw-build-app passes on: 124 timeout, 125 launch error, 130 INT and 143 TERM. */
export function launcherExit(code: number | null): "ok" | "failed" | "timeout" | "launch_error" | "stopped" {
  switch (code) {
    case 0:
      return "ok";
    case 124:
      return "timeout";
    case 125:
      return "launch_error";
    case 130:
    case 143:
      return "stopped";
    default:
      return "failed";
  }
}

/** After a reset, Umami's pool reconnects on its next request; the heartbeat must answer within this long. */
export const RESET_READY_MS = 30000;

/** True when GET <baseUrl>/api/heartbeat answers 2xx within two seconds. */
export async function heartbeat(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(2000);
  try {
    const response = await fetch(`${baseUrl}/api/heartbeat`, {
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    await response.body?.cancel();
    return response.ok;
  } catch (error) {
    // A phase deadline aborts the request with the phase's own reason, which is not a DOMException.
    if (signal?.aborted === true) return false;
    if (error instanceof TypeError || (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"))) {
      return false;
    }
    throw error;
  }
}

function rootCommand(script: string): CommandSpec {
  return { command: script, args: [], cwd: "/", env: { PATH: ROOT_PATH } };
}

function ok(logs: StepResult["logs"] = []): StepResult {
  return { reason: null, detail: "", logs };
}

function failed(reason: TrialReason, detail: string, logs: StepResult["logs"] = []): StepResult {
  return { reason, detail, logs };
}

/** An error's name or code, never its message, which may carry connection details. */
function errorName(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "unknown error";
}

/** The app copy inside the kit image, built, started and stopped by the kit's own scripts. */
export class KitStack implements AppStack {
  readonly kind = "kit" as const;
  readonly baseUrl = KIT_BASE_URL;
  private readonly runner: ProcessRunner;
  private readonly timers: Timers;
  private readonly proc: ProcView;
  private readonly groups: GroupControl;
  private readonly database: FixtureDatabase | null;
  private readonly heartbeat: (signal: AbortSignal) => Promise<boolean>;
  /** rbw-start's process group, which keeps the Postgres and Umami launchers after rbw-start exits. */
  private starter: LongProcess | null = null;

  constructor(options: {
    runner: ProcessRunner;
    timers: Timers;
    proc: ProcView;
    groups: GroupControl;
    database: FixtureDatabase | null;
    heartbeat?: (signal: AbortSignal) => Promise<boolean>;
  }) {
    this.runner = options.runner;
    this.timers = options.timers;
    this.proc = options.proc;
    this.groups = options.groups;
    this.database = options.database;
    this.heartbeat = options.heartbeat ?? ((signal) => heartbeat(this.baseUrl, signal));
  }

  async build(signal: AbortSignal): Promise<StepResult> {
    const result = await this.runner.run({ ...rootCommand(KIT_SCRIPTS.build), signal });
    const logs = [{ name: "build", result }];
    if (result.aborted) return ok(logs);
    switch (launcherExit(result.code)) {
      case "ok":
        return ok(logs);
      case "timeout":
        return failed("timeout", "the launcher stopped the build at its own time limit", logs);
      case "launch_error":
        return failed("build_failed", "the launcher could not run the build", logs);
      default:
        return failed("build_failed", `rbw-build-app exited with ${String(result.code ?? result.signal)}`, logs);
    }
  }

  /** Runs rbw-start, which waits for /api/heartbeat, then copies the migrated database to the fixture template. */
  async start(signal: AbortSignal): Promise<StepResult> {
    this.starter = this.runner.start({ ...rootCommand(KIT_SCRIPTS.start), signal });
    const result = await this.starter.result;
    const logs = [{ name: "start", result }];
    if (result.aborted) return ok(logs);
    if (result.code !== 0) return failed("startup_failed", `rbw-start exited with ${String(result.code ?? result.signal)}`, logs);
    if (this.database === null) return failed("seed_failed", "no fixture database is configured", logs);
    try {
      await this.database.createTemplate();
    } catch (error) {
      return failed("seed_failed", `the fixture template copy failed (${errorName(error)})`, logs);
    }
    return ok(logs);
  }

  verifyIdentity(): Promise<VerifiedIdentity | null> {
    if (this.starter === null) return Promise.resolve(null);
    return verifyKitIdentity({
      baseUrl: this.baseUrl,
      expectedHost: KIT.host,
      expectedPort: KIT.appPort,
      startGroup: this.starter.pid,
      appUid: KIT.appUid,
      launcher: "umami",
      proc: this.proc,
    });
  }

  /** Recreates the database from the template while Umami runs, then checks the application role and the app. */
  async resetFixture(_repeatIndex: number, signal: AbortSignal): Promise<StepResult> {
    if (this.database === null) return failed("seed_failed", "no fixture database is configured");
    try {
      await this.database.reset();
    } catch (error) {
      if (signal.aborted) return ok();
      return failed("seed_failed", `the fixture reset failed (${errorName(error)})`);
    }
    const access = await this.database.appCanConnect();
    if (!access.ok) return failed("seed_failed", `the application role could not connect after the reset (${access.code})`);
    const start = this.timers.now();
    while (!signal.aborted) {
      if (await this.heartbeat(signal)) return ok();
      if (this.timers.now() - start >= RESET_READY_MS) break;
      await this.timers.sleep(250);
    }
    if (signal.aborted) return ok();
    return failed("startup_failed", "Umami did not answer /api/heartbeat after the reset");
  }

  /** Runs rbw-stop, then confirms that rbw-start's group, which held both launchers, has ended. */
  async stop(): Promise<StopReport> {
    const result = await this.runner.run(rootCommand(KIT_SCRIPTS.stop));
    const logs = [{ name: "stop", result }];
    if (this.starter === null) return { ok: result.code === 0, records: [], logs };
    const pgid = this.starter.pid;
    this.starter = null;
    const record: StopRecord = this.groups.alive(pgid)
      ? await stopProcessGroup(pgid, { ...DEFAULT_STOP, control: this.groups, timers: this.timers })
      : { pgid, term_sent: false, kill_sent: false, ended: true, waited_ms: 0 };
    return { ok: result.code === 0 && record.ended, records: [record], logs };
  }

  logFiles(): { name: string; path: string }[] {
    return KIT_LOG_FILES.map((name) => ({ name, path: `${KIT.logsDir}/${name}.log` }));
  }
}

/** Readiness polling of an external app also ends after this long, so a record-only run cannot wait forever. */
const EXTERNAL_READINESS_CAP_MS = 600000;

/**
 * Development only: an app the driver did not start, such as Umami's test stack on a host. There
 * is nothing to build, start, reset or stop, and the identity check can only confirm the heartbeat.
 */
export class ExternalStack implements AppStack {
  readonly kind = "external" as const;
  readonly baseUrl: string;
  private readonly timers: Timers;

  constructor(baseUrl: string, timers: Timers) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timers = timers;
  }

  build(): Promise<StepResult> {
    return Promise.resolve(ok());
  }

  async start(signal: AbortSignal): Promise<StepResult> {
    const start = this.timers.now();
    while (!signal.aborted) {
      if (await heartbeat(this.baseUrl, signal)) return ok();
      if (this.timers.now() - start > EXTERNAL_READINESS_CAP_MS) break;
      await this.timers.sleep(1000);
    }
    if (signal.aborted) return ok();
    return failed("startup_failed", "the external app never answered /api/heartbeat");
  }

  verifyIdentity(): Promise<VerifiedIdentity | null> {
    return verifyExternalIdentity({ baseUrl: this.baseUrl, heartbeat: () => heartbeat(this.baseUrl) });
  }

  resetFixture(): Promise<StepResult> {
    return Promise.resolve(failed("seed_failed", "an external app cannot be reset by the driver"));
  }

  stop(): Promise<StopReport> {
    return Promise.resolve({ ok: true, records: [], logs: [] });
  }

  logFiles(): { name: string; path: string }[] {
    return [];
  }
}
