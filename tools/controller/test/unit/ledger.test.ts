import { describe, expect, it, vi } from "vitest";

// A synthetic pg client that connects and ends cleanly; the test emits a dropped connection on it.
const { clients, Client } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const made: InstanceType<typeof EventEmitter>[] = [];
  class SyntheticClient extends EventEmitter {
    constructor() {
      super();
      made.push(this);
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    query(): Promise<never> {
      return Promise.reject(new Error("synthetic: not used"));
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { clients: made, Client: SyntheticClient };
});
vi.mock("pg", () => ({ default: { Client } }));

const { databaseLedger } = await import("../../src/ledger.ts");

describe("the database ledger's close", () => {
  it("does not throw after the connection reported an error, so the job's own outcome stands", async () => {
    const ledger = await databaseLedger("postgresql://synthetic@db.example.invalid/synthetic", () => new Date(0));
    clients.at(-1)?.emit("error", Object.assign(new Error("synthetic: connection dropped"), { code: "ECONNRESET" }));
    await expect(ledger.close()).resolves.toBeUndefined();
  });
});
