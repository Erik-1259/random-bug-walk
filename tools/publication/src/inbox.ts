import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { MAX_REQUEST_BYTES } from "./protocol.ts";

const DIRECTORIES = ["publication", "requests", "responses"] as const;
type Directory = (typeof DIRECTORIES)[number];

export interface PendingRequest {
  name: string;
  mtimeMs: number;
}

export type ClaimedRead = { kind: "bytes"; bytes: Buffer } | { kind: "invalid" };

/** Thrown when an inbox directory is no longer the one recorded at start. */
export class InboxChanged extends Error {}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function isRealDirectory(info: Stats | null): info is Stats {
  return info !== null && info.isDirectory() && !info.isSymbolicLink();
}

/**
 * The untrusted inbox. Agents can write anything inside requests/, so the helper never
 * follows a symlink there: publication/, requests/ and responses/ must be real directories,
 * their device and inode are recorded at start and re-checked around every claim, read and
 * response write, and request files are opened only when they are regular files. Claimed
 * requests move into the helper's private state directory.
 */
export class Inbox {
  private readonly root: string;
  private readonly claimedDir: string;
  private identities: Map<Directory, string> | null = null;

  constructor(inboxRoot: string, claimedDir: string) {
    this.root = inboxRoot;
    this.claimedDir = claimedDir;
  }

  private path(directory: Directory, name?: string): string {
    const dir = directory === "publication" ? join(this.root, "publication") : join(this.root, "publication", directory);
    return name === undefined ? dir : join(dir, name);
  }

  /**
   * Checks the layout and records its directories, creating a missing one only inside a
   * verified real parent. "invalid", with nothing written through a link, when any of them
   * is a symlink or not a directory; "other-device" when requests/ and the private claimed
   * directory are on different devices, so a claim could not be an atomic rename.
   */
  async prepare(): Promise<"ok" | "invalid" | "other-device"> {
    let parent: string;
    try {
      parent = await realpath(this.root);
    } catch {
      return "invalid";
    }
    if (!isRealDirectory(await lstatOrNull(parent))) return "invalid";
    const identities = new Map<Directory, string>();
    for (const directory of DIRECTORIES) {
      const path = this.path(directory);
      let info = await lstatOrNull(path);
      if (info === null) {
        try {
          await mkdir(path, { mode: 0o755 });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") return "invalid";
        }
        info = await lstatOrNull(path);
      }
      if (!isRealDirectory(info)) return "invalid";
      identities.set(directory, `${String(info.dev)}:${String(info.ino)}`);
    }
    const claimed = await lstatOrNull(this.claimedDir);
    if (!isRealDirectory(claimed)) return "invalid";
    if (claimed.dev !== (await lstat(this.path("requests"))).dev) return "other-device";
    this.identities = identities;
    return (await this.verify()) ? "ok" : "invalid";
  }

  /** True when every inbox directory is still the real directory recorded at start. */
  async verify(): Promise<boolean> {
    if (this.identities === null) return false;
    for (const directory of DIRECTORIES) {
      let info: Stats | null;
      try {
        info = await lstatOrNull(this.path(directory));
      } catch {
        return false;
      }
      if (!isRealDirectory(info) || `${String(info.dev)}:${String(info.ino)}` !== this.identities.get(directory)) return false;
    }
    return true;
  }

  private async ensureUnchanged(): Promise<void> {
    if (!(await this.verify())) throw new InboxChanged();
  }

  private static async list(dir: string): Promise<PendingRequest[]> {
    const entries: PendingRequest[] = [];
    for (const name of await readdir(dir)) {
      if (name.startsWith(".")) continue;
      try {
        entries.push({ name, mtimeMs: (await lstat(join(dir, name))).mtimeMs });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    return entries.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Visible entries in requests/, oldest first. */
  async listRequests(): Promise<PendingRequest[]> {
    await this.ensureUnchanged();
    return Inbox.list(this.path("requests"));
  }

  /** Visible entries in the private claimed directory, oldest first. */
  listClaimed(): Promise<PendingRequest[]> {
    return Inbox.list(this.claimedDir);
  }

  /**
   * Atomically moves a request into the private claimed directory. Returns "gone" when the
   * file disappeared (for example withdrawn by the wrapper) and "failed" when the rename is
   * refused, for example because an entry occupies the claimed name. Throws InboxChanged
   * when an inbox directory changed before or after the rename.
   */
  async claim(name: string): Promise<"claimed" | "gone" | "failed"> {
    await this.ensureUnchanged();
    let outcome: "claimed" | "gone" | "failed";
    try {
      await rename(this.path("requests", name), join(this.claimedDir, name));
      outcome = "claimed";
    } catch (error) {
      outcome = errorCode(error) === "ENOENT" ? "gone" : "failed";
    }
    await this.ensureUnchanged();
    return outcome;
  }

  /**
   * Reads a claimed file once. It must be a regular file: it is checked with lstat, opened
   * without following symlinks or blocking, and its fstat must show the same device and inode.
   */
  async readClaimed(name: string): Promise<ClaimedRead | null> {
    await this.ensureUnchanged();
    const path = join(this.claimedDir, name);
    const before = await lstatOrNull(path);
    if (before === null) return null;
    if (!before.isFile() || before.size > MAX_REQUEST_BYTES) return { kind: "invalid" };
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      return { kind: "invalid" };
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > MAX_REQUEST_BYTES) return { kind: "invalid" };
      const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > MAX_REQUEST_BYTES) return { kind: "invalid" };
      }
      return { kind: "bytes", bytes: Buffer.from(buffer.subarray(0, length)) };
    } finally {
      await handle.close();
      await this.ensureUnchanged();
    }
  }

  async responseExists(requestId: string): Promise<boolean> {
    await this.ensureUnchanged();
    return (await lstatOrNull(this.path("responses", `${requestId}.json`))) !== null;
  }

  /** Writes a response as a new file and renames it into place; throws InboxChanged when the layout changed. */
  async writeResponse(requestId: string, bytes: Uint8Array): Promise<void> {
    await this.ensureUnchanged();
    const temporary = this.path("responses", `.${requestId}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    if (!(await this.verify())) throw new InboxChanged();
    await rename(temporary, this.path("responses", `${requestId}.json`));
    await this.ensureUnchanged();
  }
}
