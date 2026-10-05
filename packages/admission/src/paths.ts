import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

export type KeyRead = { kind: "ok"; bytes: Buffer } | { kind: "missing" } | { kind: "unsafe" };

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/**
 * One job's record-set directory. Every key is resolved against the root; a key that is
 * absolute, has an empty, "." or ".." segment, or resolves outside the root (including through
 * a symlink) is refused before it is read.
 */
export class RecordSetDir {
  readonly root: string;
  private readonly realRoot: string;

  constructor(root: string) {
    this.root = root;
    this.realRoot = realpathSync(root);
  }

  read(key: string): KeyRead {
    const segments = key.split("/");
    if (key.startsWith("/") || key.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) return { kind: "unsafe" };
    const path = join(this.realRoot, ...segments);
    try {
      const real = realpathSync(path);
      if (!real.startsWith(`${this.realRoot}${sep}`)) return { kind: "unsafe" };
      return { kind: "ok", bytes: readFileSync(real) };
    } catch (error) {
      if (MISSING_CODES.has(String(errorCode(error)))) return { kind: "missing" };
      throw error;
    }
  }

  /** Sorted names of the entries directly under a top-level directory; empty when it does not exist. */
  list(name: string): string[] {
    try {
      return readdirSync(join(this.realRoot, name)).sort();
    } catch (error) {
      if (MISSING_CODES.has(String(errorCode(error)))) return [];
      throw error;
    }
  }
}

