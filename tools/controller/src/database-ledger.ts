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

function driverCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
}

/** The spend ledger in the database named by `databaseUrl`; the migrations must already be applied there. */
export async function databaseLedger(databaseUrl: string, now: () => Date): Promise<Ledger> {
  const client = new pg.Client({ connectionString: databaseUrl });
  // A dropped connection surfaces as a failed ledger call, which the controller turns into
  // needs_reconciliation; the listener only keeps the error from crashing the process.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    throw new LedgerError(`could not connect to the database named by DATABASE_URL (driver error code ${driverCode(error)})`);
  }
  return {
    spend: createSpend({ client: fromPg(client), clock: now }),
    kind: "database",
    // Closing never throws, so it cannot hide the job outcome already written.
    close: () => client.end().catch(() => undefined),
  };
}
