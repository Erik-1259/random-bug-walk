import { gitOutput } from "./git.ts";
import {
  HEX40,
  HEX64,
  InputError,
  arrayField,
  canonicalJson,
  compareUtf8,
  isRepoPath,
  parseJson,
  sha256Hex,
  strictObject,
  stringField,
} from "./input.ts";

export type FileMode = "100644" | "100755";

export interface ManifestFile {
  path: string;
  mode: FileMode;
  size_bytes: number;
  sha256: string;
}

export interface Manifest {
  host_commit: string;
  files: ManifestFile[];
}

/** The manifest's canonical bytes, which are both its file content and the input of its SHA-256. */
export function manifestBytes(manifest: Manifest): Buffer {
  return Buffer.from(canonicalJson(manifest), "utf8");
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

/** Parses `git ls-tree -r -l -z` (or without `-l`) output. */
export function parseLsTree(output: Buffer, withSize: boolean): TreeEntry[] | null {
  const entries: TreeEntry[] = [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return null;
  }
  const pattern = withSize ? /^(\d{6}) (\w+) ([0-9a-f]+) +(?:\d+|-)\t([^]*)$/ : /^(\d{6}) (\w+) ([0-9a-f]+)\t([^]*)$/;
  for (const record of text.split("\0")) {
    if (record === "") continue;
    const match = pattern.exec(record);
    if (match === null) return null;
    const [, mode, type, oid, path] = match;
    if (mode === undefined || type === undefined || oid === undefined || path === undefined) return null;
    entries.push({ mode, type, oid, path });
  }
  return entries;
}

/** Reads blobs with one `git cat-file --batch` call, in the order given. */
function readBlobs(repo: string, oids: readonly string[]): Buffer[] {
  const output = gitOutput(["-C", repo, "cat-file", "--batch"], { input: Buffer.from(oids.map((oid) => `${oid}\n`).join("")) });
  if (output === null) throw new InputError("git_failed");
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const oid of oids) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new InputError("git_failed");
    const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (header[0] !== oid || header[1] !== "blob" || !Number.isSafeInteger(size)) throw new InputError("git_failed");
    blobs.push(output.subarray(headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  return blobs;
}

export class UnsupportedEntry extends InputError {
  readonly path: string;

  constructor(code: string, path: string) {
    super(code);
    this.path = path;
  }
}

/**
 * ADM-01: the tracked-source manifest comes from the pinned commit's tree and blob bytes,
 * never from a working tree.
 */
export function buildManifest(repo: string, commit: string): Manifest {
  if (!HEX40.test(commit)) throw new InputError("invalid_commit");
  const resolved = gitOutput(["-C", repo, "rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{commit}`]);
  if (resolved?.toString("utf8").trim() !== commit) throw new InputError("invalid_commit");
  const listing = gitOutput(["-C", repo, "ls-tree", "-r", "-l", "-z", "--full-tree", commit]);
  const entries = listing === null ? null : parseLsTree(listing, true);
  if (entries === null) throw new InputError("git_failed");
  for (const entry of entries) {
    // ADM-01: symlinks and submodules cannot be compared byte for byte, so the manifest refuses them.
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new UnsupportedEntry("unsupported_tracked_entry", entry.path);
    }
    if (!isRepoPath(entry.path)) throw new UnsupportedEntry("unsupported_path", entry.path);
  }
  const blobs = readBlobs(
    repo,
    entries.map((entry) => entry.oid),
  );
  const files = entries.map((entry, index): ManifestFile => {
    const bytes = blobs[index] ?? Buffer.alloc(0);
    return { path: entry.path, mode: entry.mode as FileMode, size_bytes: bytes.length, sha256: sha256Hex(bytes) };
  });
  files.sort((a, b) => compareUtf8(a.path, b.path));
  return { host_commit: commit, files };
}

const MANIFEST = "malformed_manifest";

export function parseManifest(text: string): Manifest {
  const top = strictObject(parseJson(text, MANIFEST), ["files", "host_commit"], [], MANIFEST);
  const hostCommit = stringField(top, "host_commit", MANIFEST);
  if (!HEX40.test(hostCommit)) throw new InputError(MANIFEST);
  const files: ManifestFile[] = [];
  let previous: string | null = null;
  for (const item of arrayField(top, "files", MANIFEST)) {
    const entry = strictObject(item, ["mode", "path", "sha256", "size_bytes"], [], MANIFEST);
    const path = stringField(entry, "path", MANIFEST);
    const mode = stringField(entry, "mode", MANIFEST);
    const hash = stringField(entry, "sha256", MANIFEST);
    const size = entry.size_bytes;
    if (!isRepoPath(path) || path === ".git" || path.startsWith(".git/")) throw new InputError(MANIFEST);
    if (mode !== "100644" && mode !== "100755") throw new InputError(MANIFEST);
    if (!HEX64.test(hash) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new InputError(MANIFEST);
    if (previous !== null && compareUtf8(previous, path) >= 0) throw new InputError(MANIFEST);
    previous = path;
    files.push({ path, mode, size_bytes: size, sha256: hash });
  }
  return { host_commit: hostCommit, files };
}
