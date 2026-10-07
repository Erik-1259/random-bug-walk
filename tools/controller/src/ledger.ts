// The controller's spend ledger: the Postgres in DATABASE_URL for Sandbox runs, or, for the
// conductor's local Docker checks, an in-memory PGlite ledger with every @rbw/spend migration and
// the controller's slot keys, as the local runner's recorded mode uses. Connection errors name
// only DATABASE_URL and a driver error code.
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { createSpend, fromPg, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import { DEVELOPMENT, JUDGE } from "./limits.ts";

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
  const errors: string[] = [];
  client.on("error", (error) => errors.push(driverCode(error)));
  try {
    await client.connect();
  } catch (error) {
    throw new LedgerError(`could not connect to the database named by DATABASE_URL (driver error code ${driverCode(error)})`);
  }
  return {
    spend: createSpend({ client: fromPg(client), clock: now }),
    kind: "database",
    close: async () => {
      await client.end();
      if (errors.length > 0) throw new LedgerError(`the connection to the database named by DATABASE_URL failed (driver error code ${errors.join(", ")})`);
    },
  };
}

/** A fresh in-memory ledger for local Docker checks: the seeded pools and the controller's two slot keys. */
export async function inMemoryLedger(now: () => Date): Promise<Ledger> {
  const db = await PGlite.create();
  await migrate(db, { schema: "public" });
  const spend = createSpend({ client: db, schema: "public", clock: now });
  for (const key of [DEVELOPMENT.slot_key, JUDGE.slot_key]) {
    const created = await spend.createSlotKey({ slot_key: key, actor_role: "owner", reason: "in-memory ledger for a local Docker check" });
    if (!created.ok) throw new LedgerError(`the in-memory ledger refused slot key ${key} (${created.code})`);
  }
  return { spend, kind: "in_memory", close: () => db.close() };
}
