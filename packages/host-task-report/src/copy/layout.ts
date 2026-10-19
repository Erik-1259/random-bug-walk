// Paths and fixed settings of the task-report copy image (kit/task-report). The app tree and its
// baseline dependencies live in /workspace/app, readable by the app user; everything under
// /opt/rbw/evaluator and every record and log under /var/lib/rbw/results is root-only, so the app
// user can read neither the checks nor its own captured log.
export const APP_DIR = "/workspace/app";
export const EVALUATOR_DIR = "/opt/rbw/evaluator";
export const EVALUATOR_SUITE_DIR = `${EVALUATOR_DIR}/suite`;
/** Per-instance suite copies; inside the evaluator tree so the suite resolves its Playwright there. */
export const EVALUATOR_WORK_DIR = `${EVALUATOR_DIR}/work`;
export const PLAYWRIGHT_DIR = `${EVALUATOR_DIR}/node_modules/@playwright/test`;
export const ETC_DIR = "/opt/rbw/etc";
export const LAUNCH = "/opt/rbw/bin/rbw-launch";
export const RESULTS_DIR = "/var/lib/rbw/results";
export const INSTANCES_DIR = "/var/lib/rbw/instances";
export const PG_SOCKET_DIR = "/run/rbw-pg";
export const PG_PORT = 5432;
export const APP_PORT = 3000;
export const BASE_URL = `http://127.0.0.1:${String(APP_PORT)}`;

/** The evaluator's roles connect through the Unix socket, which only root and the database user can reach. */
export function socketUrl(role: string, database: string): string {
  return `postgresql://${role}@localhost/${database}?host=${encodeURIComponent(PG_SOCKET_DIR)}`;
}

export const SUPERUSER = "postgres";
export const DATABASE = "taskapp";

/** Phase limits, as in the custom host harness at baseline 2. */
export const LIMITS = {
  db_ready_ms: 60_000,
  migrate_ms: 120_000,
  heartbeat_ms: 60_000,
  typecheck_ms: 120_000,
  psql_ms: 60_000,
  stop_ms: 30_000,
} as const;

/** Captured bytes per log stream. */
export const LOG_BYTES = 16 * 1024 * 1024;
