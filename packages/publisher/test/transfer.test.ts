import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitExceeded } from "../src/limits.ts";
import { VercelBlobStore } from "../src/store.ts";
import { BASE_URI, ROOT_ID, bigFileBytes, createWorld, expectNotPublished, printed, publish, sha256, stage, write, writeRootRun } from "./support.ts";

function usedTransfer(state: string): number {
  const stored = JSON.parse(readFileSync(join(state, "roots", ROOT_ID, "limits.json"), "utf8")) as { used: { transferBytes: number } };
  return stored.used.transferBytes;
}

describe("transfer accounting of existing objects", () => {
  it("charges the full length of an oversized stored object before store_mismatch", async () => {
    const world = createWorld();
    stage(world.staging);
    const oversized = Buffer.alloc(5000, "z");
    write(join(world.store, "sha256", sha256(bigFileBytes())), oversized);
    const result = await publish(world, writeRootRun(world));
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "store_mismatch" });
    expect(usedTransfer(world.state)).toBe(oversized.length);
    expectNotPublished(result, world);
  });

  it("charges up to the allowance and reports limit_exceeded when the object is larger than it", async () => {
    const world = createWorld();
    stage(world.staging);
    const expected = bigFileBytes().length;
    const allowance = expected + 100;
    write(join(world.store, "sha256", sha256(bigFileBytes())), Buffer.alloc(allowance + 500, "z"));
    const result = await publish(world, writeRootRun(world), ["--limit-transfer-bytes", String(allowance)]);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(usedTransfer(world.state)).toBeLessThanOrEqual(allowance);
  });

  it("refuses a Content-Length above the allowance without reading the body", async () => {
    let pulled = false;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const store = new VercelBlobStore({
      baseUri: BASE_URI,
      token: "synthetic-token",
      client: { put: () => Promise.reject(new Error("unused")) },
      fetch: () => Promise.resolve(new Response(body, { status: 200, headers: { "content-length": "1000" } })),
    });
    await expect(store.read("sha256/x", 999)).rejects.toBeInstanceOf(LimitExceeded);
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("still returns a body within the allowance", async () => {
    const store = new VercelBlobStore({
      baseUri: BASE_URI,
      token: "synthetic-token",
      client: { put: () => Promise.reject(new Error("unused")) },
      fetch: () => Promise.resolve(new Response(Buffer.from("abc"), { status: 200 })),
    });
    expect(Buffer.from((await store.read("sha256/x", 3)) ?? new Uint8Array()).toString()).toBe("abc");
  });
});

describe("reading a response body against the transfer limit", () => {
  /** A body of 100-byte chunks that records how many chunks were pulled and whether it was cancelled. */
  function chunked(total: number, headers: Record<string, string>): { response: Response; state: { pulls: number; cancelled: boolean } } {
    const state = { pulls: 0, cancelled: false };
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulls += 1;
          const size = Math.min(100, total - sent);
          sent += size;
          controller.enqueue(new Uint8Array(size).fill(97));
          if (sent >= total) controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { response: new Response(body, { status: 200, headers }), state };
  }

  function storeFor(response: Response): VercelBlobStore {
    return new VercelBlobStore({
      baseUri: BASE_URI,
      token: "synthetic-token",
      client: { put: () => Promise.reject(new Error("unused")) },
      fetch: () => Promise.resolve(response),
    });
  }

  it.each([
    ["no Content-Length", {}],
    ["an understated Content-Length", { "content-length": "10" }],
  ])("cuts off a body with %s at the limit", async (_label, headers) => {
    const { response, state } = chunked(100_000, headers);
    const error = await storeFor(response).read("sha256/x", 250).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LimitExceeded);
    expect((error as LimitExceeded).received).toBe(300);
    expect(state.pulls).toBe(3);
    expect(state.cancelled).toBe(true);
  });

  it("reads a body that is exactly at the limit in full", async () => {
    const { response, state } = chunked(300, {});
    const bytes = await storeFor(response).read("sha256/x", 300);
    expect(bytes?.length).toBe(300);
    expect(state.cancelled).toBe(false);
  });

  it("charges the bytes received before the cut-off", async () => {
    const world = createWorld();
    stage(world.staging);
    const allowance = bigFileBytes().length + 100;
    write(join(world.store, "sha256", sha256(bigFileBytes())), Buffer.alloc(allowance + 500, "z"));
    const result = await publish(world, writeRootRun(world), ["--limit-transfer-bytes", String(allowance)]);
    expect(printed(result)).toMatchObject({ status: "failed", failure_reason: "limit_exceeded" });
    expect(usedTransfer(world.state)).toBe(allowance);
  });
});
