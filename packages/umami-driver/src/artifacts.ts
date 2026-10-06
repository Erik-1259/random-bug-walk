// The trial's evidence files. Every file is listed with its kind, its key relative to the record
// set's root, SHA-256, size and media type; no unlisted file is evidence. Sizes are checked before
// anything is read, against a 64 MiB total per trial.
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex, validateRecord } from "@rbw/schema";
import type { ArtifactEntry } from "@rbw/schema";
import type { CapturedStream } from "./process.ts";

export const TRIAL_ARTIFACT_LIMIT_BYTES = 64 * 1024 * 1024;

export type AddStatus = "stored" | "missing" | "refused";

export interface AddFileResult {
  entry: ArtifactEntry | null;
  /** The stored bytes, for parsing; null unless stored. The parsed bytes are always the hashed bytes. */
  bytes: Buffer | null;
  status: AddStatus;
}

export class ArtifactStore {
  private readonly outDir: string;
  private readonly prefix: string;
  private readonly limitBytes: number;
  private readonly stored: ArtifactEntry[] = [];
  private readonly keys = new Set<string>();
  private readonly refusedList: { key: string; size_bytes: number }[] = [];
  private readonly truncatedList: string[] = [];
  private used = 0;

  /** Keys are given below `prefix`, the trial's artifact directory relative to the record set's root `outDir`. */
  constructor(outDir: string, prefix: string, limitBytes: number = TRIAL_ARTIFACT_LIMIT_BYTES) {
    this.outDir = outDir;
    this.prefix = prefix;
    this.limitBytes = limitBytes;
  }

  entries(): ArtifactEntry[] {
    return [...this.stored];
  }

  refused(): { key: string; size_bytes: number }[] {
    return [...this.refusedList];
  }

  /** Keys of artifacts that are cut short or were refused; their content is never parsed as evidence. */
  truncated(): string[] {
    return [...this.truncatedList];
  }

  limitExceeded(): boolean {
    return this.refusedList.length > 0;
  }

  usedBytes(): number {
    return this.used;
  }

  /** The full key of a key below the prefix; throws for a key that is not a relative path or is already used. */
  private claim(name: string): string {
    const key = `${this.prefix}/${name}`;
    if (validateRecord("RelativePath", key).length > 0) throw new Error(`artifact key ${key} must be a relative POSIX path inside the record set`);
    if (this.keys.has(key)) throw new Error(`duplicate artifact key ${key}`);
    this.keys.add(key);
    return key;
  }

  private refuse(key: string, size: number): void {
    this.refusedList.push({ key, size_bytes: size });
    this.truncatedList.push(key);
  }

  private async write(kind: string, key: string, bytes: Uint8Array, mediaType: string): Promise<ArtifactEntry> {
    const path = join(this.outDir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    this.used += bytes.length;
    const entry = { kind, key, sha256: sha256Hex(bytes), size_bytes: bytes.length, media_type: mediaType };
    this.stored.push(entry);
    return entry;
  }

  /**
   * Stores bytes the driver produced. `force` is for the driver's own summaries (phase timings,
   * diagnostics), which are written even after the limit is reached, so a trial always explains itself.
   */
  async addBytes(kind: string, name: string, bytes: Uint8Array, mediaType: string, force = false): Promise<ArtifactEntry | null> {
    const key = this.claim(name);
    if (!force && this.used + bytes.length > this.limitBytes) {
      this.refuse(key, bytes.length);
      return null;
    }
    return this.write(kind, key, bytes, mediaType);
  }

  /** Stores a captured output stream; a stream cut at its limit is stored and marked truncated. */
  async addStream(kind: string, name: string, stream: CapturedStream): Promise<ArtifactEntry | null> {
    const entry = await this.addBytes(kind, name, stream.bytes, "text/plain");
    if (entry !== null && stream.truncated) this.truncatedList.push(entry.key);
    return entry;
  }

  /**
   * Copies a file the copy's tests or processes wrote. Its size is checked before it is read;
   * symlinks are refused. With `maxBytes`, a longer file keeps only its first `maxBytes` bytes and is
   * marked truncated, and its bytes are never returned for parsing.
   */
  async addFile(kind: string, name: string, source: string, mediaType: string, maxBytes?: number): Promise<AddFileResult> {
    const key = this.claim(name);
    let size: number;
    try {
      const stat = await lstat(source);
      if (!stat.isFile()) return { entry: null, bytes: null, status: "missing" };
      size = stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entry: null, bytes: null, status: "missing" };
      throw error;
    }
    if (maxBytes !== undefined && size > maxBytes) {
      const head = await readHead(source, maxBytes);
      if (this.used + head.length > this.limitBytes) {
        this.refuse(key, head.length);
        return { entry: null, bytes: null, status: "refused" };
      }
      this.truncatedList.push(key);
      return { entry: await this.write(kind, key, head, mediaType), bytes: null, status: "stored" };
    }
    if (this.used + size > this.limitBytes) {
      this.refuse(key, size);
      return { entry: null, bytes: null, status: "refused" };
    }
    const bytes = await readFile(source);
    if (this.used + bytes.length > this.limitBytes) {
      this.refuse(key, bytes.length);
      return { entry: null, bytes: null, status: "refused" };
    }
    return { entry: await this.write(kind, key, bytes, mediaType), bytes, status: "stored" };
  }
}

/** The first `length` bytes of a file, read without loading the rest. */
async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
