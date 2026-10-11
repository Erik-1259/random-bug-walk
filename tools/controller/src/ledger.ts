// The controller's spend ledger: the Postgres in DATABASE_URL for Sandbox runs (database-ledger.ts),
// or, for the conductor's local Docker checks, an in-memory PGlite ledger with every @rbw/spend
// migration and the controller's slot keys, as the local runner's recorded mode uses.
import { PGlite } from "@electric-sql/pglite";
import { createSpend, migrate } from "@rbw/spend";
import { LedgerError } from "./database-ledger.ts";
import type { Ledger } from "./database-ledger.ts";
import { DEVELOPMENT, JUDGE } from "./limits.ts";

export { LedgerError, databaseLedger } from "./database-ledger.ts";
export type { Ledger } from "./database-ledger.ts";

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
