// The superuser monitor of the F3 check: snapshots of the app role's backends (which only a
// privileged role can see in full) and direct reads of the completions table as supporting
// evidence. It never writes.
import pg from "pg";
import type { BackendSnapshot } from "./classify.ts";

export interface Monitor {
  backends(): Promise<BackendSnapshot>;
  /** Rows on the UTC date, and whether the given completion row exists (null when no ID is given). */
  directRead(date: string, completionId: string | null): Promise<{ date_count: number; x_row_present: boolean | null }>;
  close(): Promise<void>;
}

const BACKENDS_QUERY = `SELECT count(*)::int AS n,
       count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiting,
       count(*) FILTER (WHERE state IN ('idle in transaction', 'idle in transaction (aborted)'))::int AS idle_in_transaction
  FROM pg_stat_activity WHERE usename = $1 AND datname = current_database()`;

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();
}

export async function openMonitor(url: string, appRole: string): Promise<Monitor> {
  const client = new pg.Client({ connectionString: url, application_name: "rbw-monitor", connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  client.on("error", () => undefined);
  await client.connect();
  return {
    backends: async () => {
      const result = await client.query<{ n: number; lock_waiting: number; idle_in_transaction: number }>(BACKENDS_QUERY, [appRole]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("monitor: no backend row");
      return { app_backends: row.n, lock_waiting: row.lock_waiting, idle_in_transaction: row.idle_in_transaction };
    },
    directRead: async (date, completionId) => {
      const count = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM completions WHERE completed_at >= $1::timestamptz AND completed_at < $2::timestamptz",
        [`${date}T00:00:00.000Z`, nextDay(date)],
      );
      let present: boolean | null = null;
      if (completionId !== null) {
        const row = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM completions WHERE id = $1::uuid", [completionId]);
        present = (row.rows[0]?.n ?? 0) > 0;
      }
      return { date_count: count.rows[0]?.n ?? 0, x_row_present: present };
    },
    close: async () => {
      await client.end().catch(() => undefined);
    },
  };
}
