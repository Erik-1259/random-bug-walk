import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseResponse, REQUEST_ID, type PublicationResponse } from "./protocol.ts";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * The host-only state directory: stored request bytes, records of finished requests,
 * markers for PR attempts, helper-owned bare repositories and temporary files.
 */
export class StateStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  get logFile(): string {
    return this.path("helper.log");
  }

  /** Where claimed requests are moved; agents cannot reach it. */
  get claimedDirectory(): string {
    return this.path("claimed");
  }

  get ghDirectory(): string {
    return this.path("gh-cwd");
  }

  repository(worktreeId: string): string {
    return this.path("repositories", `${worktreeId}.git`);
  }

  temporary(requestId: string): string {
    return this.path("tmp", requestId);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const sub of ["claimed", "requests", "records", "attempts", "starts", "repositories", "tmp", "gh-cwd"]) {
      await mkdir(this.path(sub), { recursive: true, mode: 0o700 });
    }
  }

  private async atomicWrite(target: string, content: Uint8Array | string): Promise<void> {
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }

  /**
   * Takes the single-instance lock: a file holding this process's id, created exclusively.
   * A lock left by a process that no longer runs is replaced only while holding an
   * exclusively created takeover file, and only if it still holds what was read, so two
   * helpers starting together cannot both replace it. "held" when another helper holds
   * the lock or replaced it first; "takeover-left" when a takeover file exists.
   */
  async lock(): Promise<"locked" | "held" | "takeover-left"> {
    const path = this.path("helper.lock");
    const takeover = this.path("helper.lock.takeover");
    const own = `${String(process.pid)}\n`;
    const create = async (target: string): Promise<boolean> => {
      try {
        await writeFile(target, own, { flag: "wx", mode: 0o600 });
        return true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        return false;
      }
    };
    if (await create(path)) return "locked";
    const stale = await readOrNull(path);
    if (stale === null) return (await create(path)) ? "locked" : "held";
    const holder = Number(stale.trim());
    if (Number.isInteger(holder) && holder > 0 && processRuns(holder)) return "held";
    if (!(await create(takeover))) return "takeover-left";
    try {
      if ((await readOrNull(path)) !== stale) return "held";
      await rm(path, { force: true });
      return (await create(path)) ? "locked" : "held";
    } finally {
      await unlink(takeover);
    }
  }

  async unlock(): Promise<void> {
    await unlink(this.path("helper.lock"));
  }

  async hasStored(requestId: string): Promise<boolean> {
    return exists(this.path("requests", `${requestId}.json`));
  }

  /** Stores the claimed bytes once; a copy that already exists is kept. */
  async store(requestId: string, bytes: Uint8Array): Promise<void> {
    if (await this.hasStored(requestId)) return;
    await this.atomicWrite(this.path("requests", `${requestId}.json`), bytes);
  }

  readStored(requestId: string): Promise<Buffer> {
    return readFile(this.path("requests", `${requestId}.json`));
  }

  /** Stored request ids, oldest first. */
  async storedIds(): Promise<string[]> {
    return idsByAge(this.path("requests"));
  }

  async recordedIds(): Promise<string[]> {
    return idsByAge(this.path("records"));
  }

  async readRecord(requestId: string): Promise<PublicationResponse | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path("records", `${requestId}.json`));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    const response = parseResponse(bytes, requestId);
    if (response === null) throw new Error("corrupt record");
    return response;
  }

  async writeRecord(response: PublicationResponse): Promise<void> {
    await this.atomicWrite(this.path("records", `${response.requestId}.json`), `${JSON.stringify(response)}\n`);
  }

  async markAttempt(requestId: string): Promise<void> {
    await writeFile(this.path("attempts", requestId), "", { mode: 0o600 });
  }

  hasAttempt(requestId: string): Promise<boolean> {
    return exists(this.path("attempts", requestId));
  }

  /** Counts one more start of work on a stored request and returns how many came before. */
  async countStart(requestId: string): Promise<number> {
    const path = this.path("starts", requestId);
    const before = Number((await readOrNull(path)) ?? "0");
    const previous = Number.isInteger(before) && before > 0 ? before : 0;
    await this.atomicWrite(path, String(previous + 1));
    return previous;
  }

  async clearTemporary(requestId: string): Promise<void> {
    await rm(this.temporary(requestId), { recursive: true, force: true });
  }
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function idsByAge(dir: string): Promise<string[]> {
  const entries: { id: string; time: number }[] = [];
  for (const name of await readdir(dir)) {
    const match = /^(.+)\.json$/.exec(name);
    if (match?.[1] === undefined || !REQUEST_ID.test(match[1])) continue;
    entries.push({ id: match[1], time: (await stat(join(dir, name))).mtimeMs });
  }
  return entries.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1)).map((entry) => entry.id);
}
