// One fresh instance inside the copy image, with processes instead of Compose. The phases follow
// the custom host harness at baseline 2: a new database cluster (initdb), the
// server, the provisioning SQL as the superuser (owner, app and gate roles and the database), the
// app's own migration as the owner, the post-migration grant for the gate role, the app, and its
// heartbeat. The database runs as rbw-db and the app as rbw-app, each under rbw-launch; the app's
// log goes to an evaluator-owned file. Stopping ends the app, then the server.
import { copyFileSync, appendFileSync, chownSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { APP_DIR, APP_PORT, ETC_DIR, INSTANCES_DIR, LAUNCH, LIMITS, LOG_BYTES, PG_PORT, PG_SOCKET_DIR, SUPERUSER, DATABASE } from "./layout.ts";
import { runCommand, startService } from "./proc.ts";
import type { Service } from "./proc.ts";

export const DB_UID = 2002;
export const DB_GID = 2002;

export const INSTANCE_FAILURES = {
  db_init: "startup_failed",
  db_start: "startup_failed",
  provision: "startup_failed",
  migrate: "migration_failed",
  provision_after_migrate: "startup_failed",
  app_start: "startup_failed",
  heartbeat: "heartbeat_failed",
} as const;
export type InstancePhase = keyof typeof INSTANCE_FAILURES;

export interface PhaseRecord {
  name: string;
  ok: boolean;
  duration_ms: number;
  detail: string | null;
}

export interface RunningInstance {
  id: string;
  dir: string;
  logs: string;
  appLog: string;
  phases: PhaseRecord[];
  /** The phase that failed, or null when the instance is ready. */
  failed: InstancePhase | null;
  stop(): Promise<PhaseRecord>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function heartbeatOk(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port: APP_PORT, path: "/api/heartbeat", method: "GET", agent: false, timeout: 2000 }, (response) => {
      response.resume();
      response.on("end", () => {
        resolve(response.statusCode === 200);
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => {
      resolve(false);
    });
    request.end();
  });
}

function psqlArgs(database: string, file: string): string[] {
  return ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", PG_SOCKET_DIR, "-p", String(PG_PORT), "-U", SUPERUSER, "-d", database, "-f", file];
}

/** Brings up instance `id` (i01, i02, ...) under `resultsDir`; on a failed phase it stops what it started. */
export async function startInstance(id: string, resultsDir: string): Promise<RunningInstance> {
  const dir = join(INSTANCES_DIR, id);
  const pgdata = join(dir, "pgdata");
  const logs = join(resultsDir, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  mkdirSync(pgdata, { mode: 0o700 });
  chownSync(pgdata, DB_UID, DB_GID);
  const toolLog = join(logs, "phases.log");
  const phases: PhaseRecord[] = [];
  let postgres: Service | null = null;
  let app: Service | null = null;
  const dbEnv = join(ETC_DIR, "db.environment");

  const stop = async (): Promise<PhaseRecord> => {
    const began = performance.now();
    let ok = true;
    if (app !== null) ok = (await app.stop(LIMITS.stop_ms)) && ok;
    if (postgres !== null && postgres.exitCode() === null) {
      const result = await runCommand(LAUNCH, ["--as", "db", "--env-file", dbEnv, "--timeout-ms", "90000", "--", "pg_ctl", "-D", pgdata, "-m", "fast", "-w", "-t", "60", "stop"], { timeoutMs: 100_000, logFile: toolLog });
      ok = result.code === 0 && ok;
      ok = (await postgres.stop(LIMITS.stop_ms)) && ok;
    }
    return { name: "stop", ok, duration_ms: Math.round(performance.now() - began), detail: null };
  };

  const phase = async (name: InstancePhase, work: () => Promise<string | null>): Promise<boolean> => {
    const began = performance.now();
    let detail: string | null;
    try {
      detail = await work();
    } catch (error) {
      detail = error instanceof Error ? error.name : "error";
    }
    phases.push({ name, ok: detail === null, duration_ms: Math.round(performance.now() - began), detail });
    return detail === null;
  };

  const instance: RunningInstance = { id, dir, logs, appLog: join(logs, "app.stderr.log"), phases, failed: null, stop };
  const steps: [InstancePhase, () => Promise<string | null>][] = [
    [
      "db_init",
      async () => {
        const init = await runCommand(LAUNCH, ["--as", "db", "--env-file", dbEnv, "--", "initdb", "-D", pgdata, "-U", SUPERUSER, "-E", "UTF8", "--locale=C", "--auth-local=trust", "--auth-host=reject"], {
          timeoutMs: LIMITS.psql_ms,
          logFile: toolLog,
        });
        if (init.code !== 0) return `initdb exit ${String(init.code)}`;
        appendFileSync(join(pgdata, "postgresql.conf"), readFileSync(join(ETC_DIR, "postgresql.task-report.conf")));
        copyFileSync(join(ETC_DIR, "pg_hba.conf"), join(pgdata, "pg_hba.conf"));
        chownSync(join(pgdata, "pg_hba.conf"), DB_UID, DB_GID);
        chmodSync(join(pgdata, "pg_hba.conf"), 0o600);
        return null;
      },
    ],
    [
      "db_start",
      async () => {
        postgres = startService(LAUNCH, [
          "--as",
          "db",
          "--env-file",
          dbEnv,
          "--max-stream-bytes",
          String(LOG_BYTES),
          "--stdout",
          join(logs, "postgres.stdout.log"),
          "--stderr",
          join(logs, "postgres.stderr.log"),
          "--",
          "postgres",
          "-D",
          pgdata,
        ]);
        const deadline = performance.now() + LIMITS.db_ready_ms;
        while (performance.now() < deadline) {
          const ready = await runCommand("pg_isready", ["-q", "-h", PG_SOCKET_DIR, "-p", String(PG_PORT)], { timeoutMs: 5000 });
          if (ready.code === 0) return null;
          if (postgres.exitCode() !== null) return "the server exited";
          await sleep(100);
        }
        return "the server did not accept connections in time";
      },
    ],
    [
      "provision",
      async () => {
        const result = await runCommand("psql", psqlArgs("postgres", join(ETC_DIR, "provision", "00-roles.sql")), { timeoutMs: LIMITS.psql_ms, logFile: toolLog });
        return result.code === 0 ? null : `psql exit ${String(result.code)}`;
      },
    ],
    [
      "migrate",
      async () => {
        const result = await runCommand(
          LAUNCH,
          ["--as", "db", "--cwd", APP_DIR, "--env-file", join(ETC_DIR, "migrate.environment"), "--timeout-ms", String(LIMITS.migrate_ms), "--", "node", "src/db/migrate.ts", "apply"],
          { timeoutMs: LIMITS.migrate_ms + 15_000, logFile: toolLog },
        );
        return result.code === 0 ? null : `migrate exit ${String(result.code)}`;
      },
    ],
    [
      "provision_after_migrate",
      async () => {
        const result = await runCommand("psql", psqlArgs(DATABASE, join(ETC_DIR, "provision", "10-after-migrate.sql")), { timeoutMs: LIMITS.psql_ms, logFile: toolLog });
        return result.code === 0 ? null : `psql exit ${String(result.code)}`;
      },
    ],
    [
      "app_start",
      () => {
        app = startService(LAUNCH, [
          "--as",
          "app",
          "--cwd",
          APP_DIR,
          "--env-file",
          join(ETC_DIR, "app.environment"),
          "--max-stream-bytes",
          String(LOG_BYTES),
          "--stdout",
          join(logs, "app.stdout.log"),
          "--stderr",
          instance.appLog,
          "--",
          "node",
          "src/main.ts",
        ]);
        return Promise.resolve(null);
      },
    ],
    [
      "heartbeat",
      async () => {
        const deadline = performance.now() + LIMITS.heartbeat_ms;
        while (performance.now() < deadline) {
          if (await heartbeatOk()) return null;
          if (app?.exitCode() !== null) return "the app exited before its heartbeat answered";
          await sleep(250);
        }
        return "no heartbeat in time";
      },
    ],
  ];
  for (const [name, work] of steps) {
    if (!(await phase(name, work))) {
      instance.failed = name;
      phases.push(await stop());
      return instance;
    }
  }
  return instance;
}
