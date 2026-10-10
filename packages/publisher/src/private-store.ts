import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { InvalidInput } from "./errors.ts";
import { LimitExceeded, StoreError, readLimited } from "./store.ts";

export { InvalidInput, LimitExceeded, StoreError };

/** The private Vercel Blob store of the judge path. Keys are pathnames in the store. */
export interface PrivateStore {
  /** Creates an object. An existing object with the same bytes counts as stored; different bytes are refused with store_mismatch. */
  putNew(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Creates or overwrites an object. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The current bytes of an object, or null when it does not exist. A body over maxBytes is refused with LimitExceeded. */
  get(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Every key that starts with the prefix, sorted. */
  list(prefix: string): Promise<string[]>;
}

/** Bodies over this size are uploaded with the SDK's multipart upload. */
const MULTIPART_THRESHOLD = 100 * 1024 * 1024;

/**
 * Options of `@vercel/blob` 2.8.0. `storeId` and `oidcToken` are `BlobCommandOptions` fields that
 * `put`, `get` and `list` all accept (dist/create-folder-*.d.ts: "Use this together with
 * `storeId` (or `BLOB_STORE_ID`) when you want to pass OIDC credentials explicitly"). Both are
 * always passed and `token` never is, so `resolveBlobAuth` (src/helpers.ts) takes its OIDC branch
 * with these values and never falls back to `BLOB_STORE_ID`, `BLOB_READ_WRITE_TOKEN` or a
 * request-context token. `get` with `access: "private"` and `useCache: false` reads from origin
 * and returns null on a 404 (src/get.ts); `list` pages with `prefix`, `cursor` and `hasMore`
 * and takes no `access` (src/list.ts).
 */
export interface PrivateBlobPutOptions {
  access: "private";
  addRandomSuffix: false;
  allowOverwrite: boolean;
  contentType: string;
  multipart: boolean;
  storeId: string;
  oidcToken: string;
}

export interface PrivateBlobGetOptions {
  access: "private";
  useCache: false;
  storeId: string;
  oidcToken: string;
}

export interface PrivateBlobListOptions {
  prefix: string;
  cursor?: string;
  storeId: string;
  oidcToken: string;
}

/** The part of the Vercel Blob SDK the private store uses. Tests inject a fake. */
export interface PrivateBlobClient {
  put(pathname: string, body: Uint8Array, options: PrivateBlobPutOptions): Promise<unknown>;
  get(pathname: string, options: PrivateBlobGetOptions): Promise<{ stream: ReadableStream<Uint8Array> } | null>;
  list(options: PrivateBlobListOptions): Promise<{ blobs: { pathname: string }[]; cursor?: string; hasMore: boolean }>;
}

/** The real SDK, loaded on first use. */
export const vercelPrivateBlobClient: PrivateBlobClient = {
  async put(pathname, body, options) {
    const { put } = await import("@vercel/blob");
    await put(pathname, Buffer.from(body), options);
  },
  async get(pathname, options) {
    const { get } = await import("@vercel/blob");
    const result = await get(pathname, options);
    if (result === null) return null;
    // A 304 needs ifNoneMatch, which is never sent.
    if (result.statusCode !== 200) throw new StoreError("store_unavailable");
    return { stream: result.stream };
  },
  async list(options) {
    const { list } = await import("@vercel/blob");
    const result = await list(options);
    return { blobs: result.blobs.map((blob) => ({ pathname: blob.pathname })), hasMore: result.hasMore, ...(result.cursor === undefined ? {} : { cursor: result.cursor }) };
  },
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);
}

/** Real mode: the private store, with the store ID and OIDC token passed explicitly on every call. */
export class VercelPrivateStore implements PrivateStore {
  private readonly storeId: string;
  private readonly oidcToken: string;
  private readonly client: PrivateBlobClient;

  constructor(options: { storeId: string; oidcToken: string; client?: PrivateBlobClient }) {
    this.storeId = options.storeId;
    this.oidcToken = options.oidcToken;
    this.client = options.client ?? vercelPrivateBlobClient;
  }

  private async write(key: string, bytes: Uint8Array, contentType: string, allowOverwrite: boolean): Promise<void> {
    await this.client.put(key, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite,
      contentType,
      multipart: bytes.length > MULTIPART_THRESHOLD,
      storeId: this.storeId,
      oidcToken: this.oidcToken,
    });
  }

  async putNew(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.write(key, bytes, contentType, false);
      return;
    } catch {
      // The SDK refuses an existing key; reading it back tells a stored object from a failure.
    }
    let existing: Uint8Array | null;
    try {
      existing = await this.get(key, bytes.length);
    } catch (error) {
      if (error instanceof LimitExceeded) throw new StoreError("store_mismatch");
      throw error;
    }
    if (existing === null) throw new StoreError("store_unavailable");
    if (!sameBytes(existing, bytes)) throw new StoreError("store_mismatch");
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.write(key, bytes, contentType, true);
    } catch {
      throw new StoreError("store_unavailable");
    }
  }

  async get(key: string, maxBytes: number): Promise<Uint8Array | null> {
    let result: { stream: ReadableStream<Uint8Array> } | null;
    try {
      result = await this.client.get(key, { access: "private", useCache: false, storeId: this.storeId, oidcToken: this.oidcToken });
    } catch {
      throw new StoreError("store_unavailable");
    }
    if (result === null) return null;
    return readLimited(new Response(result.stream), maxBytes);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    try {
      for (;;) {
        const page = await this.client.list({ prefix, storeId: this.storeId, oidcToken: this.oidcToken, ...(cursor === undefined ? {} : { cursor }) });
        keys.push(...page.blobs.map((blob) => blob.pathname));
        if (!page.hasMore) break;
        cursor = page.cursor;
      }
    } catch {
      throw new StoreError("store_unavailable");
    }
    return keys.sort();
  }
}

/** Builds the private store from `BLOB_PRIVATE_STORE_ID` and `VERCEL_OIDC_TOKEN` in the given environment, refusing an unset or blank value. */
export function privateStoreFromEnv(env: Readonly<Record<string, string | undefined>>): VercelPrivateStore {
  const storeId = env.BLOB_PRIVATE_STORE_ID;
  const oidcToken = env.VERCEL_OIDC_TOKEN;
  // The SDK trims both values and falls back to its defaults for a blank one.
  if (storeId === undefined || storeId.trim() === "") throw new InvalidInput("store_id_unset");
  if (oidcToken === undefined || oidcToken.trim() === "") throw new InvalidInput("oidc_token_unset");
  return new VercelPrivateStore({ storeId, oidcToken });
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** Local mode: keys are paths under a directory. */
export class LocalPrivateStore implements PrivateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  // The local store keeps no content type; each signature takes it so callers of the class match PrivateStore.
  putNew(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  putNew(key: string, bytes: Uint8Array): Promise<void> {
    const path = join(this.dir, key);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { flag: "wx" });
      return Promise.resolve();
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return Promise.reject(new StoreError("store_unavailable"));
    }
    try {
      return sameBytes(readFileSync(path), bytes) ? Promise.resolve() : Promise.reject(new StoreError("store_mismatch"));
    } catch {
      return Promise.reject(new StoreError("store_unavailable"));
    }
  }

  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  put(key: string, bytes: Uint8Array): Promise<void> {
    const path = join(this.dir, key);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
      writeFileSync(temporary, bytes, { flag: "wx" });
      renameSync(temporary, path);
      return Promise.resolve();
    } catch {
      return Promise.reject(new StoreError("store_unavailable"));
    }
  }

  get(key: string, maxBytes: number): Promise<Uint8Array | null> {
    try {
      const path = join(this.dir, key);
      const size = statSync(path).size;
      if (size > maxBytes) return Promise.reject(new LimitExceeded("transferBytes", size));
      return Promise.resolve(readFileSync(path));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Promise.resolve(null);
      return Promise.reject(new StoreError("store_unavailable"));
    }
  }

  list(prefix: string): Promise<string[]> {
    try {
      // A directory that does not exist yet is an empty store.
      if (statSync(this.dir, { throwIfNoEntry: false }) === undefined) return Promise.resolve([]);
      const entries = readdirSync(this.dir, { recursive: true, encoding: "utf8" });
      // An entry renamed away since the directory was read, such as a temporary file of a concurrent put, is skipped.
      return Promise.resolve(entries.filter((entry) => entry.startsWith(prefix) && statSync(join(this.dir, entry), { throwIfNoEntry: false })?.isFile() === true).sort());
    } catch {
      return Promise.reject(new StoreError("store_unavailable"));
    }
  }
}
