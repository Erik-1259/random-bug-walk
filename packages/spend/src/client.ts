import type pg from "pg";

/**
 * The one database client interface the package uses. `query` runs a single statement with
 * parameters; `exec` runs a parameterless script that may hold several statements (migrations).
 * A PGlite instance satisfies it directly; wrap a node-postgres client with `fromPg`.
 */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  exec(sql: string): Promise<unknown>;
}

/** Adapts a node-postgres `Client` or `PoolClient`. */
export function fromPg(client: pg.ClientBase): SqlClient {
  return {
    async query(text, params) {
      const result = await client.query<Record<string, unknown>>(text, params);
      return { rows: result.rows };
    },
    async exec(sql) {
      await client.query(sql);
    },
  };
}

/** A driver error code such as ECONNREFUSED or a SQLSTATE; never the message, which can name the host or user. */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
  }
  return "unknown";
}
