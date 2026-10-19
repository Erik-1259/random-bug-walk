// The results hash of a copy (CollectedCopy.results_sha256): the SHA-256 of a deterministic
// tar of the copy's results directory. Runners (the docker runner here, the sandbox runner in the worker)
// compute it the same way, and a CopyRecord's evidence_sha256 is this value.
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@rbw/schema";
import { compareUtf8 } from "./archive.ts";
import { packTar, type TarEntry } from "./tar.ts";

async function walk(root: string, relative: string, entries: TarEntry[]): Promise<void> {
  const directory = relative === "" ? root : join(root, relative);
  for (const name of await readdir(directory)) {
    const path = relative === "" ? name : `${relative}/${name}`;
    const full = join(root, path);
    const stats = await lstat(full);
    if (stats.isDirectory()) await walk(root, path, entries);
    else if (stats.isSymbolicLink()) entries.push({ kind: "symlink", path, target: await readlink(full) });
    else if (stats.isFile()) entries.push({ kind: "file", path, bytes: new Uint8Array(await readFile(full)) });
    else throw new Error("results: a results tree holds an entry that is neither a file, a directory nor a link");
  }
}

/**
 * The tar of a results directory: regular files and symbolic links (recorded by target, never followed),
 * sorted by UTF-8 path, mode 0644 (links 0777), owner 0, mtime 0; directories are implied by paths.
 */
export async function resultsTar(dir: string): Promise<Uint8Array> {
  const entries: TarEntry[] = [];
  await walk(dir, "", entries);
  entries.sort((a, b) => compareUtf8(a.path, b.path));
  return packTar(entries);
}

export async function resultsSha256(dir: string): Promise<string> {
  return sha256Hex(await resultsTar(dir));
}
