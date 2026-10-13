import type pg from "pg";
import { describe, expect, it } from "vitest";
import { CONNECT_TIMEOUT_MS, databaseLedger, LedgerError } from "../../src/database-ledger.ts";

const DATABASE_URL = "postgresql://synthetic-user:synthetic-db-password-41@db.example.invalid/synthetic";

/** A synthetic pg client whose connect fails with the next queued error, or connects. */
function clients(failures: (Error | undefined)[]) {
  const made: { connected: boolean; ended: boolean; queries: number }[] = [];
  const configs: pg.ClientConfig[] = [];
  const createClient = (config: pg.ClientConfig) => {
    configs.push(config);
    const state = { connected: false, ended: false, queries: 0 };
    made.push(state);
    const failure = failures.shift();
    return {
      on: () => undefined,
      connect: () => {
        if (failure !== undefined) return Promise.reject(failure);
        state.connected = true;
        return Promise.resolve();
      },
      query: () => {
        state.queries += 1;
        return Promise.reject(Object.assign(new Error("synthetic: the query failed"), { code: "ECONNRESET" }));
      },
      end: () => {
        state.ended = true;
        return Promise.resolve();
      },
    } as unknown as pg.Client;
  };
  return { made, configs, createClient };
}

const error = (code: string, message = "synthetic: failed") => Object.assign(new Error(message), { code });

/** A wait that records its length and returns at once. */
function record(waits: number[]): (ms: number) => Promise<void> {
  return (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
}

describe("the database ledger's initial connect", () => {
  it("retries a transient connect failure twice, waiting about 1 s and then 2 s, with a fresh client each time", async () => {
    const waits: number[] = [];
    const { made, createClient } = clients([error("ECONNREFUSED"), error("57P03", "synthetic: the database system is starting up")]);
    const ledger = await databaseLedger(DATABASE_URL, () => new Date(0), { createClient, sleep: record(waits) });
    expect(ledger.kind).toBe("database");
    expect(waits).toEqual([1000, 2000]);
    expect(made.map((client) => client.connected)).toEqual([false, false, true]);
    // A failed client is ended before the next attempt.
    expect(made.slice(0, 2).every((client) => client.ended)).toBe(true);
    await ledger.close();
  });

  it("retries each transient kind: refused, reset, timeout, a terminated connection and a compute that is starting", async () => {
    const transient = [
      error("ECONNREFUSED"),
      error("ECONNRESET"),
      error("ETIMEDOUT"),
      error("EAI_AGAIN"),
      error("57P01", "synthetic: terminating connection due to administrator command"),
      error("57P03"),
      error("08006"),
      new Error("Connection terminated unexpectedly"),
      new Error("timeout expired"),
    ];
    for (const failure of transient) {
      const { made, createClient } = clients([failure]);
      await databaseLedger(DATABASE_URL, () => new Date(0), { createClient, sleep: () => Promise.resolve() });
      expect(made).toHaveLength(2);
    }
  });

  it("gives up after three attempts, well under 10 s of waiting, with an error that names no URL, user or password", async () => {
    const waits: number[] = [];
    const { made, createClient } = clients([error("ECONNREFUSED"), error("ECONNREFUSED"), error("ETIMEDOUT")]);
    const failed = databaseLedger(DATABASE_URL, () => new Date(0), { createClient, sleep: record(waits) });
    await expect(failed).rejects.toThrow(LedgerError);
    await expect(failed).rejects.toThrow("driver error code ETIMEDOUT");
    const message = await failed.catch((caught: unknown) => (caught instanceof Error ? caught.message : ""));
    for (const hidden of [DATABASE_URL, "synthetic-user", "synthetic-db-password-41", "db.example.invalid"]) expect(message).not.toContain(hidden);
    expect(made).toHaveLength(3);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(10_000);
  });

  it("bounds each connect attempt with a timeout, so a hung connect is retried", async () => {
    const { made, configs, createClient } = clients([new Error("timeout expired")]);
    await databaseLedger(DATABASE_URL, () => new Date(0), { createClient, sleep: () => Promise.resolve() });
    expect(made).toHaveLength(2);
    expect(configs.every((config) => config.connectionTimeoutMillis === CONNECT_TIMEOUT_MS)).toBe(true);
  });

  it("never retries an authentication or other error", async () => {
    for (const failure of [error("28P01", "synthetic: password authentication failed"), error("28000"), error("3D000"), new Error("synthetic: something else")]) {
      const waits: number[] = [];
      const { made, createClient } = clients([failure, undefined]);
      await expect(databaseLedger(DATABASE_URL, () => new Date(0), { createClient, sleep: record(waits) })).rejects.toThrow(LedgerError);
      expect(made).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });

  it("never retries a ledger query once connected", async () => {
    const { made, createClient } = clients([]);
    const ledger = await databaseLedger(DATABASE_URL, () => new Date(0), { createClient, sleep: () => Promise.reject(new Error("synthetic: no wait expected")) });
    await expect(ledger.spend.slotStatus({ slot_key: "judge" })).rejects.toThrow();
    expect(made).toHaveLength(1);
    expect(made[0]?.queries).toBe(1);
    await ledger.close();
  });
});
