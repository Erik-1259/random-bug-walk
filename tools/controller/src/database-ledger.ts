// The controller's spend ledger in the Postgres named by DATABASE_URL, apart from ledger.ts (which
// adds the in-memory PGlite ledger) so the judge web routes load only pg. Connection errors name
// only DATABASE_URL and a driver error code.
import pg from "pg";
import { createSpend, fromPg } from "@rbw/spend";
import type { Spend } from "@rbw/spend";

export interface Ledger {
  spend: Spend;
  kind: "database" | "in_memory";
  close: () => Promise<void>;
}

export class LedgerError extends Error {
  override name = "LedgerError";
}

/** The waits between connect attempts: three attempts, 3 s of waiting at most. */
export const CONNECT_WAITS_MS: readonly number[] = [1000, 2000];

/**
 * Connect failures worth one more try: the network refused, reset or timed out, or the server is
 * shutting down or starting up (a suspended Neon compute waking). Never an authentication error.
 */
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // SQLSTATE: admin_shutdown ("terminating connection"), crash_shutdown, cannot_connect_now ("starting up").
  "57P01",
  "57P02",
  "57P03",
  // SQLSTATE class 08: connection_exception, sqlclient_unable_to_establish_sqlconnection, connection_does_not_exist, connection_failure.
  "08000",
  "08001",
  "08003",
  "08006",
]);

/** pg's own message when the server closes the socket during the handshake; pg gives it no code. */
const TERMINATED = "Connection terminated unexpectedly";

export interface DatabaseLedgerOptions {
  createClient?: (config: pg.ClientConfig) => pg.Client;
  sleep?: (ms: number) => Promise<void>;
}

function driverCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
}

function transient(error: unknown): boolean {
  return TRANSIENT_CODES.has(driverCode(error)) || (error instanceof Error && driverCode(error) === "unknown" && error.message === TERMINATED);
}

/**
 * The spend ledger in the database named by `databaseUrl`; the migrations must already be applied
 * there. Only the initial connect is retried, and only for a transient failure; no query is.
 */
export async function databaseLedger(databaseUrl: string, now: () => Date, options: DatabaseLedgerOptions = {}): Promise<Ledger> {
  const createClient = options.createClient ?? ((config) => new pg.Client(config));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    const client = createClient({ connectionString: databaseUrl });
    // A dropped connection surfaces as a failed ledger call, which the controller turns into
    // needs_reconciliation; the listener only keeps the error from crashing the process.
    client.on("error", () => undefined);
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      const wait = CONNECT_WAITS_MS[attempt];
      if (wait !== undefined && transient(error)) {
        await sleep(wait);
        continue;
      }
      throw new LedgerError(`could not connect to the database named by DATABASE_URL (driver error code ${driverCode(error)})`);
    }
    return {
      spend: createSpend({ client: fromPg(client), clock: now }),
      kind: "database",
      // Closing never throws, so it cannot hide the job outcome already written.
      close: () => client.end().catch(() => undefined),
    };
  }
}
