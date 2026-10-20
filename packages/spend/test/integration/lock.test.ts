import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromPg } from "../../src/client.ts";
import { createFactoryRecords } from "../../src/factory.ts";
import { withFactoryLock } from "../../src/lock.ts";
import type { Spend } from "../../src/spend.ts";
import { budgetRequest, recordRequest } from "../factory-helpers.ts";
import { expectOk, hex, uuid } from "../helpers.ts";
import { openTestDatabase, suffix, waitFor, type TestDatabase } from "./support.ts";

let database: TestDatabase;
let dropDatabase: (() => Promise<void>) | undefined;
let admin: Spend;
let observer: pg.Client;
let n = 0;

beforeAll(async () => {
  database = await openTestDatabase();
  dropDatabase = () => database.drop();
  const connection = await database.connect();
  admin = connection.spend;
  observer = connection.client;
});

afterAll(async () => {
  await dropDatabase?.();
});

/** A connection whose lock waits fail after 10 s, so a lock wait that never ends fails the test instead of hanging it. */
async function connect(): Promise<{ client: pg.Client; pid: number }> {
  const { client } = await database.connect();
  await client.query("SET lock_timeout = '10s'");
  const rows = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return { client, pid: rows.rows[0]?.pid ?? 0 };
}

/** True once the backend `pid` waits for an advisory lock. */
async function waitingOnAdvisoryLock(pid: number): Promise<boolean> {
  const rows = await observer.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted",
    [pid],
  );
  return (rows.rows[0]?.n ?? 0) > 0;
}

function deferred(): { promise: Promise<void>; resolve: () => void; settled: () => boolean } {
  let done = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => {
      done = true;
      r();
    };
  });
  return { promise, resolve, settled: () => done };
}

describe("factory start locks against a real Postgres", () => {
  it("runs two holders of one request ID one at a time, while record calls on other connections go ahead", async () => {
    const poolKey = `synthetic-factory-${suffix()}`;
    expectOk(await admin.createPool({ pool_key: poolKey, cap_microusd: 10_000_000, allocations: [], actor_role: "owner", reason: "synthetic integration pool" }));
    n += 1;
    const requestId = uuid(91_000 + n);
    const budget = { budget_key: hex(92_000 + n), root_execution_id: uuid(92_000 + n) };
    const first = await connect();
    const second = await connect();
    const records = createFactoryRecords({ client: fromPg((await connect()).client), schema: database.schema });
    const order: string[] = [];
    const entered = deferred();
    const leave = deferred();

    const firstRun = withFactoryLock(fromPg(first.client), "request", requestId, async () => {
      order.push("first:start");
      // The record functions take a lock of their own on the request ID inside their transaction.
      // Sharing that key would make this call wait for the lock held above, which never ends.
      const accepted = await records.acceptRequest({
        budget: budgetRequest(n, { ...budget, pool_key: poolKey }),
        request: recordRequest(n, { ...budget, request_id: requestId }),
        accepted_message: "Request accepted.",
      });
      entered.resolve();
      await leave.promise;
      order.push("first:end");
      return accepted;
    });
    await waitFor(() => Promise.resolve(entered.settled()), "the first holder's record call to finish");
    const secondRun = withFactoryLock(fromPg(second.client), "request", requestId, async () => {
      order.push("second:start");
      return records.readRequest({ request_id: requestId, after: 0, limit: 10 });
    });
    await waitFor(() => waitingOnAdvisoryLock(second.pid), "the second holder to wait for the lock");
    leave.resolve();
    const [accepted, read] = await Promise.all([firstRun, secondRun]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(expectOk(accepted).replay).toBe(false);
    expect(expectOk(read).events.map((e) => e.type)).toEqual(["request_accepted"]);
  });

  it("lets other IDs and the validation scope go ahead while one request ID is held", async () => {
    const holder = await connect();
    const other = await connect();
    const held = uuid(93_001);
    const leave = deferred();
    const entered = deferred();
    const holding = withFactoryLock(fromPg(holder.client), "request", held, async () => {
      entered.resolve();
      await leave.promise;
    });
    await waitFor(() => Promise.resolve(entered.settled()), "the holder to take the lock");
    try {
      expect(await withFactoryLock(fromPg(other.client), "request", uuid(93_002), () => Promise.resolve("other request"))).toBe("other request");
      expect(await withFactoryLock(fromPg(other.client), "validation", held, () => Promise.resolve("same ID, validation scope"))).toBe(
        "same ID, validation scope",
      );
    } finally {
      leave.resolve();
      await holding;
    }
  });

  it("frees the ID for the next holder when fn throws", async () => {
    const holder = await connect();
    const next = await connect();
    const id = uuid(93_003);
    const failure = new Error("synthetic failure inside the lock");
    await expect(withFactoryLock(fromPg(holder.client), "request", id, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(await withFactoryLock(fromPg(next.client), "request", id, () => Promise.resolve("next"))).toBe("next");
  });
});
