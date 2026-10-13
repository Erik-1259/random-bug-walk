// The diff of an attempt against its neutral commit, over tracked files only. The kit image has
// no git, so the neutral commit is the audited projection's (made on the host by
// @rbw/projection's commitNeutral during the audit), and the comparison runs on the host: the
// container's tracked files are read out as one tar stream and compared with the projection's,
// file by file, for content, type and the executable bit. Untracked files are not compared.
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { gitDiff } from "@rbw/local-runner";
import type { Docker } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { structuredPatch } from "diff";
import { extract } from "tar-stream";
import type { SubmitResult } from "./tools.ts";

export interface TrackedEntry {
  type: "file" | "symlink" | "directory" | "other";
  bytes: Buffer;
  linkname: string | null;
  executable: boolean;
}

export type Change = SubmitResult["changed"][number];

export class TrackedReadError extends Error {
  override name = "TrackedReadError";
}

/** Lists the tracked paths that exist, then archives exactly those, from /workspace/app. */
export const TRACKED_TAR_SCRIPT = `set -eu
cd /workspace/app
list=/var/lib/rbw/session/tracked.list
: > "$list"
for p do
  if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\\n' "$p" >> "$list"; fi
done
exec tar -cf - -T "$list"
`;

const READ_TIMEOUT_MS = 300_000;

/** The container's entries for the given tracked paths; a path that is absent is not in the map. */
export async function readContainerTracked(docker: Docker, container: string, paths: readonly string[]): Promise<Map<string, TrackedEntry>> {
  const wanted = new Set(paths);
  const found = new Map<string, TrackedEntry>();
  const archive = extract();
  archive.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk as Uint8Array));
    });
    stream.on("end", () => {
      const name = header.name.replace(/^\.\//, "").replace(/\/+$/, "");
      if (wanted.has(name)) {
        const type = header.type === "file" || header.type === "symlink" || header.type === "directory" ? header.type : "other";
        found.set(name, { type, bytes: Buffer.concat(chunks), linkname: header.type === "symlink" ? header.linkname : null, executable: (header.mode & 0o100) !== 0 });
      }
      next();
    });
    stream.resume();
  });
  const finished = new Promise<void>((resolve, reject) => {
    archive.on("finish", resolve);
    archive.on("error", reject);
  });
  const result = await docker.run(["exec", "--user", "0:0", container, "/bin/sh", "-c", TRACKED_TAR_SCRIPT, "rbw-tracked", ...paths], { stdout: archive, timeoutMs: READ_TIMEOUT_MS });
  if (result.code !== 0) throw new TrackedReadError(`reading the tracked files exited ${String(result.code)}: ${result.stderr.trim()}`);
  await finished;
  return found;
}

/** A tracked file of the neutral commit, from the projection directory. */
export function baselineEntry(projection: string, path: string): TrackedEntry {
  const absolute = join(projection, path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return { type: "symlink", bytes: Buffer.alloc(0), linkname: readlinkSync(absolute), executable: false };
  if (stat.isFile()) return { type: "file", bytes: readFileSync(absolute), linkname: null, executable: (stat.mode & 0o100) !== 0 };
  return { type: stat.isDirectory() ? "directory" : "other", bytes: Buffer.alloc(0), linkname: null, executable: false };
}

/** How one tracked path differs from the neutral commit, or null when it does not. */
export function compareEntry(base: TrackedEntry, current: TrackedEntry | undefined): Change["change"] | null {
  if (current === undefined) return "deleted";
  if (current.type !== base.type) return "type";
  if (base.type === "symlink") return current.linkname === base.linkname ? null : "modified";
  if (!current.bytes.equals(base.bytes)) return "modified";
  if (current.executable !== base.executable) return "mode";
  return null;
}

export interface Comparison {
  changed: Change[];
  /** The target file's current bytes, or null when it is missing or not a regular file. */
  target: Buffer | null;
}

/** Every tracked path that differs, sorted by path, and the target file's current bytes. */
export function compareTracked(projection: string, paths: readonly string[], current: ReadonlyMap<string, TrackedEntry>, target: string): Comparison {
  const changed: Change[] = [];
  for (const path of [...paths].sort()) {
    const change = compareEntry(baselineEntry(projection, path), current.get(path));
    if (change !== null) changed.push({ path, change });
  }
  const entry = current.get(target);
  return { changed, target: entry?.type === "file" ? entry.bytes : null };
}

/** The submission: out of scope when anything but the target file changed. */
export function submission(projection: string, comparison: Comparison, target: string): SubmitResult {
  const outOfScope = comparison.changed.some((item) => item.path !== target);
  const before = readFileSync(join(projection, target));
  const after = comparison.target;
  const patch =
    after === null || after.equals(before)
      ? ""
      : gitDiff(target, structuredPatch("a", "b", before.toString("utf8"), after.toString("utf8"), undefined, undefined, { context: 3 }).hunks);
  return {
    scope: outOfScope ? "out_of_scope" : "in_scope",
    changed: comparison.changed,
    target_sha256: after === null ? null : sha256Hex(after),
    target_patch: patch,
  };
}
