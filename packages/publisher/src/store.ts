import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  /** Reads an object back without credentials; null when it does not exist. */
  read(key: string): Promise<Uint8Array | null>;
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

  read(key: string): Promise<Uint8Array | null> {
    try {
      return Promise.resolve(readFileSync(join(this.dir, key)));
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

  async read(key: string): Promise<Uint8Array | null> {
    let response: Response;
    try {
      response = await this.fetch(this.uri(key), { cache: "no-store", headers: { "cache-control": "no-cache" } });
    } catch {
      throw new StoreError("store_unavailable");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new StoreError("store_unavailable");
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new StoreError("store_unavailable");
    }
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
