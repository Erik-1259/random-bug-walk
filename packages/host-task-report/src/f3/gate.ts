// The row-lock gate, copied from the custom host harness at baseline 2 with only its
// configuration type, its comments and one redundant string conversion changed. Two connections as the gate role: L holds
// `SELECT ... FOR UPDATE` on exactly the target rows in one transaction, and M polls, in
// autocommit, how many app-role backends are blocked behind L directly or through another waiter.
// Release is ROLLBACK, so the gate never writes. A failure throws GateFailure naming only the
// step; no SQL text, backend PID or error text is ever recorded.
import pg from "pg";

export interface GateConfig {
  lock_statement: string;
  lock_timeout_ms: number;
  idle_in_transaction_session_timeout_ms: number;
}

export type GateStep = "connect" | "session" | "begin" | "lock" | "lock_rows" | "gate_pid" | "poll" | "release";

export class GateFailure extends Error {
  override name = "GateFailure";
  readonly step: GateStep;
  constructor(step: GateStep) {
    super(`gate step failed: ${step}`);
    this.step = step;
  }
}

export interface PollResult {
  /** App-role backends in this database blocked behind the gate, directly or through another waiter. */
  blocked: number;
  /** pg_locks lock types those backends are waiting on (not granted), sorted and distinct. */
  lockTypes: string[];
}

export interface GateSession {
  lock(taskIds: readonly string[]): Promise<void>;
  poll(): Promise<PollResult>;
  /** ROLLBACK on L. On failure L is closed, which also ends its transaction, and GateFailure is thrown. */
  release(): Promise<void>;
  /** Ends both connections (rolling back first if needed). Never throws. */
  close(): Promise<void>;
}

export interface PgGateOptions {
  gateUrl: string;
  appRole: string;
  config: GateConfig;
}

/**
 * The blocked-backend count with the waiters' ungranted lock types. $1 is the gate's backend PID
 * and $2 the app role. pg_blocking_pids counts both hard and soft blocks, and the recursion covers
 * a waiter that queues behind another.
 */
export const BLOCKED_CHAIN_QUERY = `WITH RECURSIVE chain(pid) AS (
  SELECT a.pid FROM pg_stat_activity a
   WHERE a.datname = current_database() AND a.usename = $2 AND $1::int = ANY(pg_blocking_pids(a.pid))
  UNION
  SELECT a.pid FROM pg_stat_activity a JOIN chain c ON c.pid = ANY(pg_blocking_pids(a.pid))
   WHERE a.datname = current_database() AND a.usename = $2)
SELECT (SELECT count(*) FROM chain)::int AS blocked,
       ARRAY(SELECT DISTINCT l.locktype FROM pg_locks l JOIN chain c ON c.pid = l.pid WHERE NOT l.granted ORDER BY 1) AS lock_types`;

const CONNECT_TIMEOUT_MS = 5000;
const END_LIMIT_MS = 2000;
/** Client-side bound on one gate statement beyond its server-side limits. */
const STEP_MARGIN_MS = 3000;

function msSetting(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new GateFailure("session");
  return `'${String(value)}ms'`;
}

async function endClient(client: pg.Client): Promise<void> {
  await Promise.race([client.end().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, END_LIMIT_MS).unref())]);
}

/** Connects L and M as the gate role, in parallel. Throws GateFailure("connect") when either fails. */
export async function openPgGate(options: PgGateOptions): Promise<GateSession> {
  const { config } = options;
  const lockClient = new pg.Client({ connectionString: options.gateUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: "rbw-gate-l", statement_timeout: 10_000 });
  const pollClient = new pg.Client({ connectionString: options.gateUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: "rbw-gate-m", statement_timeout: 2000 });
  let broken = false;
  // An asynchronous connection error must never crash the check; it marks the gate broken.
  lockClient.on("error", () => {
    broken = true;
  });
  pollClient.on("error", () => {
    broken = true;
  });
  const connected = await Promise.allSettled([lockClient.connect(), pollClient.connect()]);
  if (connected.some((result) => result.status === "rejected")) {
    await Promise.all([endClient(lockClient), endClient(pollClient)]);
    throw new GateFailure("connect");
  }

  let inTransaction = false;
  let gatePid: number | null = null;
  let lockClosed = false;

  const closeLock = async (): Promise<void> => {
    lockClosed = true;
    inTransaction = false;
    await endClient(lockClient);
  };

  const step = async <T>(name: GateStep, run: () => Promise<T>, limitMs: number = STEP_MARGIN_MS): Promise<T> => {
    if (broken || lockClosed) throw new GateFailure(name);
    let timer: NodeJS.Timeout | undefined;
    try {
      const pending = run();
      pending.catch(() => undefined);
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // A statement that outlives its bound leaves the connection unusable for the check.
            broken = true;
            reject(new Error("limit"));
          }, limitMs);
        }),
      ]);
    } catch {
      throw new GateFailure(name);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    lock: async (taskIds) => {
      gatePid = null;
      try {
        await step("session", () => lockClient.query(`SET idle_in_transaction_session_timeout = ${msSetting(config.idle_in_transaction_session_timeout_ms)}`));
        await step("begin", () => lockClient.query("BEGIN"));
        inTransaction = true;
        await step("session", () => lockClient.query(`SET LOCAL lock_timeout = ${msSetting(config.lock_timeout_ms)}`));
        const locked = await step("lock", () => lockClient.query<{ id: string }>(config.lock_statement, [[...taskIds]]), config.lock_timeout_ms + STEP_MARGIN_MS);
        const got = locked.rows.map((row) => row.id.toLowerCase()).sort();
        const want = taskIds.map((id) => id.toLowerCase()).sort();
        if (got.length !== want.length || got.some((id, index) => id !== want[index])) throw new GateFailure("lock_rows");
        const pid = await step("gate_pid", () => lockClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"));
        const value = pid.rows[0]?.pid;
        if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new GateFailure("gate_pid");
        gatePid = value;
      } catch (error) {
        if (inTransaction) {
          try {
            await step("release", () => lockClient.query("ROLLBACK"));
            inTransaction = false;
          } catch {
            await closeLock();
          }
        }
        throw error instanceof GateFailure ? error : new GateFailure("lock");
      }
    },
    poll: async () => {
      const pid = gatePid;
      if (pid === null || !inTransaction) throw new GateFailure("poll");
      const result = await step("poll", () => pollClient.query<{ blocked: number; lock_types: string[] }>(BLOCKED_CHAIN_QUERY, [pid, options.appRole]));
      const row = result.rows[0];
      if (row === undefined || typeof row.blocked !== "number" || !Array.isArray(row.lock_types)) throw new GateFailure("poll");
      return { blocked: row.blocked, lockTypes: row.lock_types.map(String) };
    },
    release: async () => {
      gatePid = null;
      if (!inTransaction) throw new GateFailure("release");
      try {
        await step("release", () => lockClient.query("ROLLBACK"));
        inTransaction = false;
      } catch {
        await closeLock();
        throw new GateFailure("release");
      }
    },
    close: async () => {
      gatePid = null;
      if (inTransaction && !lockClosed) {
        await step("release", () => lockClient.query("ROLLBACK")).catch(() => undefined);
        inTransaction = false;
      }
      if (!lockClosed) await closeLock();
      await endClient(pollClient);
    },
  };
}
