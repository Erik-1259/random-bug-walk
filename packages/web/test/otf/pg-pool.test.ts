import { describe, expect, it } from "vitest";
import { otfPoolFromPg, type PgPoolLike } from "../../src/otf/store.ts";

/** A pool that records which connection ran each statement. */
function recordingPool(): { pool: PgPoolLike; ran: string[]; connects: number; releases: number } {
  const state = { ran: [] as string[], connects: 0, releases: 0 };
  const pool: PgPoolLike = {
    query: (text) => {
      state.ran.push(`pool:${text}`);
      return Promise.resolve({ rows: [] });
    },
    connect: () => {
      state.connects += 1;
      const name = `client${String(state.connects)}`;
      return Promise.resolve({
        query: (text: string) => {
          state.ran.push(`${name}:${text}`);
          return Promise.resolve({ rows: [] });
        },
        release: () => {
          state.releases += 1;
        },
      });
    },
  };
  return { pool, get ran() { return state.ran; }, get connects() { return state.connects; }, get releases() { return state.releases; } };
}

describe("otfPoolFromPg", () => {
  it("runs store calls made inside a transaction on its connection, and nested transactions in it", async () => {
    const r = recordingPool(); const sql = otfPoolFromPg(r.pool);
    await sql.transaction(async (tx) => {
      await tx.query("SELECT 1");
      await sql.query("SELECT 2");
      await Promise.all([sql.query("SELECT 3"), sql.transaction((inner) => inner.query("SELECT 4"))]);
    });
    await sql.query("SELECT 5");
    expect(r.connects).toBe(1); expect(r.releases).toBe(1);
    expect(r.ran).toEqual(["client1:BEGIN", "client1:SELECT 1", "client1:SELECT 2", "client1:SELECT 3", "client1:SELECT 4", "client1:COMMIT", "pool:SELECT 5"]);
  });

  it("sends a statement started after the transaction ended to the pool", async () => {
    const r = recordingPool(); const sql = otfPoolFromPg(r.pool);
    let late: Promise<unknown> = Promise.resolve();
    await sql.transaction(() => {
      // A continuation scheduled inside the callback keeps its async context after COMMIT.
      late = new Promise((resolve) => setTimeout(resolve, 5)).then(() => sql.query("SELECT late"));
      return Promise.resolve();
    });
    await late;
    expect(r.ran).toEqual(["client1:BEGIN", "client1:COMMIT", "pool:SELECT late"]);
  });

  it("rolls back and releases the connection when the callback throws", async () => {
    const r = recordingPool(); const sql = otfPoolFromPg(r.pool);
    await expect(sql.transaction(async () => {
      await sql.query("SELECT 1");
      throw new Error("synthetic failure");
    })).rejects.toThrow("synthetic failure");
    expect(r.ran).toEqual(["client1:BEGIN", "client1:SELECT 1", "client1:ROLLBACK"]); expect(r.releases).toBe(1);
  });
});
