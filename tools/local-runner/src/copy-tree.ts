// Copies a directory tree into a run or job directory. Node 24's fs.cpSync copies a recursive
// directory with no filter in C++, which creates each file write-only (mode 0200) before it sets
// the file's mode, and a Docker Desktop bind mount refuses that create with EACCES. This walk
// creates each file with copyFileSync, which opens it with the source file's mode.
import { copyFileSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Copies `src` into `dest` as `cpSync(src, dest, { recursive: true, verbatimSymlinks: true })`
 * does: directories are created as needed, each file keeps its mode and replaces a file already
 * at its path, and each symbolic link is copied with its target as written.
 */
export function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`${from} is not a file, directory or symbolic link`);
  }
}
