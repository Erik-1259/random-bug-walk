// The real bindings, checked without a network or a database: the fetch a live screen uses and the
// ledger connection's handling of a dropped connection.
import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConnect, screenFetch } from "../src/wiring.ts";

/** A stand-in for pg.Client: an event emitter that connects and ends without a server. */
class FakeClient extends EventEmitter {
  ended = false;
  connect(): Promise<void> {
    return Promise.resolve();
  }
  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
  query(): Promise<{ rows: unknown[] }> {
    return Promise.resolve({ rows: [] });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("screenFetch", () => {
  it("sends each request with its own dispatcher, so a long completion is not cut off at Node's default header timeout", async () => {
    const seen: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve(new Response("{}"));
    });
    await screenFetch()("https://synthetic.invalid/v1/chat/completions", { method: "POST", body: "{}" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", body: "{}" });
    expect((seen[0] as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });
});

describe("makeConnect", () => {
  it("survives a connection error event and reports it when the connection is closed", async () => {
    const client = new FakeClient();
    const connect = makeConnect(() => client as unknown as pg.Client);
    const connection = await connect("postgres://synthetic.invalid/x");
    // With no listener, an 'error' event would throw here and, in a real run, end the process.
    expect(() => client.emit("error", new Error("terminating connection due to idle timeout"))).not.toThrow();
    await expect(connection.close()).rejects.toThrow(/1 connection error/);
    expect(client.ended).toBe(true);
  });

  it("closes quietly when the connection had no error", async () => {
    const client = new FakeClient();
    const connection = await makeConnect(() => client as unknown as pg.Client)("postgres://synthetic.invalid/x");
    await expect(connection.close()).resolves.toBeUndefined();
    expect(client.ended).toBe(true);
  });
});
