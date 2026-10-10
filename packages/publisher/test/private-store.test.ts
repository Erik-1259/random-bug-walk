import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidInput,
  LimitExceeded,
  LocalPrivateStore,
  StoreError,
  VercelPrivateStore,
  privateStoreFromEnv,
  type PrivateBlobClient,
  type PrivateStore,
} from "../src/private-store.ts";

// Low-entropy placeholders without any real token prefix, assembled at runtime.
const STORE_ID = ["synthetic", "private", "store", "placeholder"].join("-");
const OIDC_TOKEN = ["synthetic", "oidc", "credential", "placeholder"].join("-");

interface FakeCall {
  method: "put" | "get" | "list";
  pathname?: string;
  options: Record<string, unknown>;
}

/** An in-memory stand-in for the SDK's private store: lists two keys per page and refuses an overwrite unless allowed. */
function fakeClient(): { client: PrivateBlobClient; calls: FakeCall[]; objects: Map<string, Uint8Array> } {
  const calls: FakeCall[] = [];
  const objects = new Map<string, Uint8Array>();
  const client: PrivateBlobClient = {
    put(pathname, body, options) {
      calls.push({ method: "put", pathname, options: { ...options } });
      if (objects.has(pathname) && !options.allowOverwrite) return Promise.reject(new Error("synthetic: blob already exists"));
      objects.set(pathname, Uint8Array.from(body));
      return Promise.resolve();
    },
    get(pathname, options) {
      calls.push({ method: "get", pathname, options: { ...options } });
      const bytes = objects.get(pathname);
      return Promise.resolve(bytes === undefined ? null : { stream: new Response(Buffer.from(bytes)).body ?? new ReadableStream() });
    },
    list(options) {
      calls.push({ method: "list", options: { ...options } });
      const keys = [...objects.keys()].filter((key) => key.startsWith(options.prefix)).sort().reverse();
      const start = options.cursor === undefined ? 0 : Number(options.cursor);
      const page = keys.slice(start, start + 2);
      const hasMore = start + 2 < keys.length;
      return Promise.resolve({ blobs: page.map((pathname) => ({ pathname })), hasMore, ...(hasMore ? { cursor: String(start + 2) } : {}) });
    },
  };
  return { client, calls, objects };
}

const bytes = (text: string): Uint8Array => Buffer.from(text);
const text = (value: Uint8Array | null): string | null => (value === null ? null : Buffer.from(value).toString());

const implementations: [string, () => PrivateStore][] = [
  ["LocalPrivateStore", () => new LocalPrivateStore(mkdtempSync(join(tmpdir(), "rbw-private-store-")))],
  ["VercelPrivateStore", () => new VercelPrivateStore({ storeId: STORE_ID, oidcToken: OIDC_TOKEN, client: fakeClient().client })],
];

describe.each(implementations)("%s", (_name, create) => {
  it("stores a new key with putNew and accepts the same bytes again", async () => {
    const store = create();
    await store.putNew("judge-jobs/synthetic-release/job.json", bytes("first"), "application/json");
    await store.putNew("judge-jobs/synthetic-release/job.json", bytes("first"), "application/json");
    expect(text(await store.get("judge-jobs/synthetic-release/job.json", 1024))).toBe("first");
  });

  it("refuses different bytes on putNew with store_mismatch and keeps the first bytes", async () => {
    const store = create();
    await store.putNew("judge/synthetic-root/root-run.json", bytes("prepared"), "application/json");
    const error = await store.putNew("judge/synthetic-root/root-run.json", bytes("other"), "application/json").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe("store_mismatch");
    const longer = await store.putNew("judge/synthetic-root/root-run.json", bytes("prepared-and-more"), "application/json").catch((caught: unknown) => caught);
    expect((longer as StoreError).code).toBe("store_mismatch");
    expect(text(await store.get("judge/synthetic-root/root-run.json", 1024))).toBe("prepared");
  });

  it("overwrites with put", async () => {
    const store = create();
    await store.put("judge/synthetic-root/progress.json", bytes("running"), "application/json");
    await store.put("judge/synthetic-root/progress.json", bytes("finished"), "application/json");
    expect(text(await store.get("judge/synthetic-root/progress.json", 1024))).toBe("finished");
  });

  it("returns null for a missing key", async () => {
    expect(await create().get("judge/synthetic-root/absent.json", 1024)).toBeNull();
  });

  it("refuses a body over maxBytes with LimitExceeded and returns one at the limit", async () => {
    const store = create();
    await store.put("judge/synthetic-root/run/log.txt", bytes("0123456789"), "text/plain");
    await expect(store.get("judge/synthetic-root/run/log.txt", 9)).rejects.toBeInstanceOf(LimitExceeded);
    expect(text(await store.get("judge/synthetic-root/run/log.txt", 10))).toBe("0123456789");
  });

  it("lists every key under a prefix, sorted", async () => {
    const store = create();
    for (const key of ["judge/b/progress.json", "judge/a/root-run.json", "judge/a/run/x.txt", "judge/c/progress.json", "judge-jobs/r/job.json", "other/judge/x"]) {
      await store.put(key, bytes(key), "text/plain");
    }
    expect(await store.list("judge/")).toEqual(["judge/a/root-run.json", "judge/a/run/x.txt", "judge/b/progress.json", "judge/c/progress.json"]);
    expect(await store.list("judge/a/")).toEqual(["judge/a/root-run.json", "judge/a/run/x.txt"]);
    expect(await store.list("absent/")).toEqual([]);
  });
});

describe("LocalPrivateStore", () => {
  it("lists a directory that does not exist yet as an empty store", async () => {
    const store = new LocalPrivateStore(join(mkdtempSync(join(tmpdir(), "rbw-private-store-")), "not-yet-created"));
    expect(await store.list("judge/")).toEqual([]);
    await store.put("judge/a", bytes("a"), "text/plain");
    expect(await store.list("judge/")).toEqual(["judge/a"]);
  });
});

describe("VercelPrivateStore with the SDK", () => {
  it("follows the cursor across pages", async () => {
    const fake = fakeClient();
    const store = new VercelPrivateStore({ storeId: STORE_ID, oidcToken: OIDC_TOKEN, client: fake.client });
    for (const key of ["judge/1", "judge/2", "judge/3"]) await store.put(key, bytes(key), "text/plain");
    expect(await store.list("judge/")).toEqual(["judge/1", "judge/2", "judge/3"]);
    const lists = fake.calls.filter((call) => call.method === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0]?.options.cursor).toBeUndefined();
    expect(lists[1]?.options.cursor).toBe("2");
  });

  it("passes the store ID and OIDC token on every call, never a token, and access private on put and get only", async () => {
    const fake = fakeClient();
    const store = new VercelPrivateStore({ storeId: STORE_ID, oidcToken: OIDC_TOKEN, client: fake.client });
    await store.putNew("k/new.json", bytes("a"), "application/json");
    await store.putNew("k/new.json", bytes("a"), "application/json");
    await store.put("k/mutable.json", bytes("b"), "text/plain");
    await store.get("k/new.json", 10);
    await store.list("k/");
    expect(new Set(fake.calls.map((call) => call.method))).toEqual(new Set(["put", "get", "list"]));
    for (const call of fake.calls) {
      expect(call.options.storeId).toBe(STORE_ID);
      expect(call.options.oidcToken).toBe(OIDC_TOKEN);
      expect(call.options).not.toHaveProperty("token");
      if (call.method === "list") {
        expect(call.options).not.toHaveProperty("access");
        expect(call.options.prefix).toBe("k/");
      } else {
        expect(call.options.access).toBe("private");
      }
      if (call.method === "get") expect(call.options.useCache).toBe(false);
      if (call.method === "put") expect(call.options.addRandomSuffix).toBe(false);
    }
    const puts = fake.calls.filter((call) => call.method === "put");
    expect(puts.map((call) => [call.pathname, call.options.allowOverwrite, call.options.contentType])).toEqual([
      ["k/new.json", false, "application/json"],
      ["k/new.json", false, "application/json"],
      ["k/mutable.json", true, "text/plain"],
    ]);
  });

  it("asks for a multipart upload only for a body over 100 MB", async () => {
    const seen: { size: number; multipart: boolean }[] = [];
    const client: PrivateBlobClient = {
      put: (_pathname, body, options) => {
        seen.push({ size: body.length, multipart: options.multipart });
        return Promise.resolve();
      },
      get: () => Promise.resolve(null),
      list: () => Promise.resolve({ blobs: [], hasMore: false }),
    };
    const store = new VercelPrivateStore({ storeId: STORE_ID, oidcToken: OIDC_TOKEN, client });
    const limit = 100 * 1024 * 1024;
    await store.put("k/at-limit", new Uint8Array(limit), "application/octet-stream");
    await store.putNew("k/over-limit", new Uint8Array(limit + 1), "application/octet-stream");
    expect(seen).toEqual([
      { size: limit, multipart: false },
      { size: limit + 1, multipart: true },
    ]);
  });

  it("reports a failing client as store_unavailable without the credentials", async () => {
    const failing: PrivateBlobClient = {
      put: () => Promise.reject(new Error(`synthetic failure ${OIDC_TOKEN}`)),
      get: () => Promise.reject(new Error(`synthetic failure ${OIDC_TOKEN}`)),
      list: () => Promise.reject(new Error(`synthetic failure ${OIDC_TOKEN}`)),
    };
    const store = new VercelPrivateStore({ storeId: STORE_ID, oidcToken: OIDC_TOKEN, client: failing });
    for (const attempt of [store.put("k", bytes("a"), "text/plain"), store.putNew("k", bytes("a"), "text/plain"), store.get("k", 10), store.list("k/")]) {
      const error = await attempt.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("store_unavailable");
      expect((error as Error).message).not.toContain(OIDC_TOKEN);
    }
  });
});

describe("privateStoreFromEnv", () => {
  it("builds a store from BLOB_PRIVATE_STORE_ID and VERCEL_OIDC_TOKEN", () => {
    expect(privateStoreFromEnv({ BLOB_PRIVATE_STORE_ID: STORE_ID, VERCEL_OIDC_TOKEN: OIDC_TOKEN })).toBeInstanceOf(VercelPrivateStore);
  });

  it.each([
    ["the store ID is unset", { VERCEL_OIDC_TOKEN: OIDC_TOKEN }, "store_id_unset"],
    ["the store ID is empty", { BLOB_PRIVATE_STORE_ID: "", VERCEL_OIDC_TOKEN: OIDC_TOKEN }, "store_id_unset"],
    ["the store ID is blank", { BLOB_PRIVATE_STORE_ID: " ", VERCEL_OIDC_TOKEN: OIDC_TOKEN }, "store_id_unset"],
    ["the OIDC token is unset", { BLOB_PRIVATE_STORE_ID: STORE_ID }, "oidc_token_unset"],
    ["the OIDC token is empty", { BLOB_PRIVATE_STORE_ID: STORE_ID, VERCEL_OIDC_TOKEN: "" }, "oidc_token_unset"],
    ["only the SDK's default variables are set", { BLOB_STORE_ID: STORE_ID, BLOB_READ_WRITE_TOKEN: OIDC_TOKEN, VERCEL_OIDC_TOKEN: OIDC_TOKEN }, "store_id_unset"],
  ])("refuses an environment where %s", (_label, env: Record<string, string>, code) => {
    const error = ((): unknown => {
      try {
        privateStoreFromEnv(env);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(InvalidInput);
    expect((error as InvalidInput).code).toBe(code);
    expect((error as Error).message).not.toContain(OIDC_TOKEN);
  });
});
