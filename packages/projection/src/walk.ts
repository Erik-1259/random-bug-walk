import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

export type EntryKind = "file" | "directory" | "symlink" | "special";

export interface CopyEntry {
  /** Repository-relative POSIX path. For a name that is not UTF-8, a lossy rendering. */
  path: string;
  /** The entry's own name, the last path segment. */
  name: string;
  absolute: string;
  kind: EntryKind;
  /** The name holds a backslash or a control character, or is not UTF-8. */
  unsafeName: boolean;
  /** The name is not UTF-8, so the entry cannot be opened by its rendered path. */
  undecodable: boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** A backslash, NUL or other control character. */
export function hasUnsafeCharacter(name: string): boolean {
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (char === "\\" || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function kindOf(entry: Dirent<Buffer>): EntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "special";
}

/**
 * Lists every entry under the copy without following symlinks, skipping only the top-level
 * `.git`. Directories with names that are not UTF-8 are listed but not entered.
 */
export function walkCopy(copy: string): CopyEntry[] {
  const entries: CopyEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const dirent of readdirSync(directory, { withFileTypes: true, encoding: "buffer" })) {
      let name: string;
      let undecodable = false;
      try {
        name = decoder.decode(dirent.name);
      } catch {
        name = dirent.name.toString("utf8");
        undecodable = true;
      }
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (prefix === "" && name === ".git") continue;
      const absolute = join(directory, name);
      const unsafeName = undecodable || hasUnsafeCharacter(name);
      const kind = kindOf(dirent);
      entries.push({ path, name, absolute, kind, unsafeName, undecodable });
      if (kind === "directory" && !undecodable) visit(absolute, path);
    }
  };
  visit(copy, "");
  return entries;
}
