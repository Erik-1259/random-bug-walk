import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LimitExceeded } from "./limits.ts";

export type StoreFailure = "store_unavailable" | "store_mismatch";

export class StoreError extends Error {
  readonly code: StoreFailure;

  constructor(code: StoreFailure) {
    super(code);
    this.name = "StoreError";
    this.code = code;
  }
}

/** The public artifact store. Keys are relative to public_artifact_base_uri. */
export interface PublicStore {
  /** The public URI of a key: the base URI plus the key. */
  uri(key: string): string;
  /**
   * Reads an object back without credentials; null when it does not exist. An object announced
   * as larger than maxBytes is refused with LimitExceeded before its body is read.
   */
  read(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Creates an object and never overwrites one. */
  create(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  /** Writes the one mutable key, the status object, with the shortest cache lifetime. */
  writeStatus(key: string, bytes: Uint8Array): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Local mode: the policy's base URI maps to a directory under a test prefix. */
export class FilesystemStore implements PublicStore {
  private readonly dir: string;
  private readonly baseUri: string;

  constructor(dir: string, baseUri: string) {
    this.dir = dir;
    this.baseUri = baseUri;
  }

  uri(key: string): string {
    return `${this.baseUri}${key}`;
  }

  read(key: string, maxBytes: number): Promise<Uint8Array | null> {
    try {
      const path = join(this.dir, key);
      const size = statSync(path).size;
      if (size > maxBytes) return Promise.reject(new LimitExceeded("transferBytes", size));
      return Promise.resolve(readFileSync(path));
    } catch (error) {
      if (isMissing(error)) return Promise.resolve(null);
      return Promise.reject(new StoreError("store_unavailable"));
    }
  }

  create(key: string, bytes: Uint8Array): Promise<void> {
    const path = join(this.dir, key);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { flag: "wx" });
      return Promise.resolve();
    } catch (error) {
      const exists = error instanceof Error && "code" in error && error.code === "EEXIST";
      return Promise.reject(new StoreError(exists ? "store_mismatch" : "store_unavailable"));
    }
  }

  writeStatus(key: string, bytes: Uint8Array): Promise<void> {
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
}

export interface BlobPutOptions {
  access: "public";
  addRandomSuffix: false;
  allowOverwrite: boolean;
  token: string;
  contentType: string;
  cacheControlMaxAge?: number;
}

/** The part of the Vercel Blob SDK the publisher uses. Tests inject a fake. */
export interface BlobClient {
  put(pathname: string, body: Uint8Array, options: BlobPutOptions): Promise<{ url: string }>;
}

/** Reads a body chunk by chunk and stops, cancelling the rest, once more than maxBytes have arrived. */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        // The refusal below is the outcome; a failure to close the unread body adds nothing.
        await reader.cancel().catch(() => undefined);
        throw new LimitExceeded("transferBytes", received);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof LimitExceeded) throw error;
    throw new StoreError("store_unavailable");
  }
  return Buffer.concat(chunks);
}

export type FetchFunction = (url: string, init?: RequestInit) => Promise<Response>;

/** The real SDK, loaded only when real destinations are configured. The token is always passed explicitly. */
export const vercelBlobClient: BlobClient = {
  async put(pathname, body, options) {
    const { put } = await import("@vercel/blob");
    const result = await put(pathname, Buffer.from(body), options);
    return { url: result.url };
  },
};

/** Real mode: Vercel Blob for writes, plain public HTTPS reads for every read-back. */
export class VercelBlobStore implements PublicStore {
  private readonly baseUri: string;
  private readonly token: string;
  private readonly client: BlobClient;
  private readonly fetch: FetchFunction;

  constructor(options: { baseUri: string; token: string; client: BlobClient; fetch: FetchFunction }) {
    this.baseUri = options.baseUri;
    this.token = options.token;
    this.client = options.client;
    this.fetch = options.fetch;
  }

  uri(key: string): string {
    return `${this.baseUri}${key}`;
  }

  private pathname(key: string): string {
    return `${new URL(this.baseUri).pathname.slice(1)}${key}`;
  }

  async read(key: string, maxBytes: number): Promise<Uint8Array | null> {
    let response: Response;
    try {
      response = await this.fetch(this.uri(key), { cache: "no-store", headers: { "cache-control": "no-cache" } });
    } catch {
      throw new StoreError("store_unavailable");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new StoreError("store_unavailable");
    const announced = Number(response.headers.get("content-length"));
    if (response.headers.has("content-length") && announced > maxBytes) {
      // The refusal below is the outcome; a failure to close the unread body adds nothing.
      await response.body?.cancel().catch(() => undefined);
      throw new LimitExceeded("transferBytes");
    }
    return readLimited(response, maxBytes);
  }

  private async put(key: string, bytes: Uint8Array, options: { contentType: string; allowOverwrite: boolean; cacheControlMaxAge?: number }): Promise<void> {
    let url: string;
    try {
      ({ url } = await this.client.put(this.pathname(key), bytes, { access: "public", addRandomSuffix: false, token: this.token, ...options }));
    } catch {
      throw new StoreError("store_unavailable");
    }
    if (url !== this.uri(key)) throw new StoreError("store_mismatch");
  }

  create(key: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    return this.put(key, bytes, { contentType: mediaType, allowOverwrite: false });
  }

  writeStatus(key: string, bytes: Uint8Array): Promise<void> {
    // 60 seconds is the shortest cache lifetime Vercel Blob accepts.
    return this.put(key, bytes, { contentType: "application/json", allowOverwrite: true, cacheControlMaxAge: 60 });
  }
}
