import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withFactoryLock } from "../../src/lock.ts";
import { openDb, uuid } from "../helpers.ts";

// PGlite has one connection, so these tests check what the lock holds and when it ends; the
// integration suite checks that a second holder waits and that record calls never do.
let db: PGlite;

beforeAll(async () => {
  db = await openDb();
});

afterAll(async () => {
  await db.close();
});

const ID = uuid(9100);

/** The advisory locks this session holds, as [namespace hash, ID hash] pairs. */
async function advisoryLocks(): Promise<{ namespace: number; id: number }[]> {
  const { rows } = await db.query<{ namespace: number; id: number }>(
    `SELECT classid::bigint::bit(32)::int AS namespace, objid::bigint::bit(32)::int AS id
     FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted ORDER BY 1, 2`,
  );
  return rows;
}

async function hashes(...texts: string[]): Promise<number[]> {
  const { rows } = await db.query<{ h: number }>("SELECT hashtext(t) AS h FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i) ORDER BY i", [texts]);
  return rows.map((r) => r.h);
}

describe("factory start locks", () => {
  it("holds one lock on the ID while fn runs, returns fn's result and holds nothing afterwards", async () => {
    const result = await withFactoryLock(db, "request", ID, async () => {
      const [namespace, id] = await hashes("factory_request_start", ID);
      expect(await advisoryLocks()).toEqual([{ namespace, id }]);
      return "started";
    });
    expect(result).toBe("started");
    expect(await advisoryLocks()).toEqual([]);
  });

  it("uses a namespace of its own for each scope, never one the record functions take", async () => {
    const seen: number[] = [];
    for (const scope of ["request", "validation"] as const) {
      await withFactoryLock(db, scope, ID, async () => {
        const locks = await advisoryLocks();
        expect(locks).toHaveLength(1);
        seen.push(locks[0]?.namespace ?? 0);
      });
    }
    const taken = await hashes("spend_reserve", "spend_budget", "spend_budget_root", "factory_request", "factory_validation", "spend_migrate");
    expect(new Set(seen).size).toBe(2);
    expect(seen.filter((namespace) => taken.includes(namespace))).toEqual([]);
    expect(seen).toEqual(await hashes("factory_request_start", "factory_validation_start"));
  });

  it("releases the lock and rethrows fn's error when fn throws", async () => {
    const failure = new Error("synthetic failure inside the lock");
    await expect(
      withFactoryLock(db, "validation", ID, async () => {
        expect(await advisoryLocks()).toHaveLength(1);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await advisoryLocks()).toEqual([]);
  });

  it("leaves the lock client outside any transaction, also after fn throws", async () => {
    await withFactoryLock(db, "request", ID, () => Promise.resolve());
    await expect(withFactoryLock(db, "request", ID, () => Promise.reject(new Error("synthetic")))).rejects.toThrow("synthetic");
    // Inside a transaction, now() stays at the transaction's start; outside one, each statement starts its own.
    const first = await db.query<{ t: string }>("SELECT now()::text AS t");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await db.query<{ t: string }>("SELECT now()::text AS t");
    expect(second.rows[0]?.t).not.toBe(first.rows[0]?.t);
  });
});
