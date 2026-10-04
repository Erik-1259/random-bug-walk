import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { ScanUnit } from "./checks.ts";
import { copyrightLine } from "./checks.ts";
import { ScanUnavailable } from "./gitleaks.ts";
import { GIT_SAFETY_OPTIONS, runProcess } from "./run.ts";

export interface GitScanSource {
  /** Repository directory (a working copy or a bare repository). */
  repository: string;
  head: string;
  /** Revisions whose history is excluded; with none, all of head's history is scanned. */
  exclude: readonly string[];
  /** Revision whose root LICENSE holds the trusted copyright line. */
  licenseRevision?: string;
}

export interface FilesScanSource {
  /** Directory the paths are relative to; a path outside it is refused. */
  root: string;
  paths: readonly string[];
  /** The trusted LICENSE file. */
  licenseFile?: string;
}

export interface CollectedUnits {
  units: ScanUnit[];
  trustedCopyright: Uint8Array | null;
}

const SUBMODULE_MODE = "160000";
const TREE_MODE = "040000";

/** How git commands that read a repository run: their environment and time limit. */
export interface GitRunner {
  env: Record<string, string>;
  timeoutMs: number;
}

async function git(repository: string, args: readonly string[], runner: GitRunner, input?: Uint8Array): Promise<Buffer> {
  const result = await runProcess("git", [...GIT_SAFETY_OPTIONS, "-C", repository, ...args], {
    cwd: repository,
    env: runner.env,
    input,
    timeoutMs: runner.timeoutMs,
  });
  if (result.timedOut) throw new ScanUnavailable("timeout");
  if (result.code !== 0) throw new ScanUnavailable("git");
  return result.stdout;
}

function isRevision(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !/[\s\0]/.test(value);
}

/** Path list text: one path per line; a line break inside a path becomes a space. */
function pathListContent(paths: readonly Buffer[]): Uint8Array {
  return Buffer.from(paths.map((path) => path.toString("utf8").replace(/[\r\n]/g, " ")).join("\n"));
}

interface TreeChange {
  path: Buffer;
  mode: string;
  oid: string;
}

function parseRawDiff(output: Buffer): TreeChange[] {
  const changes: TreeChange[] = [];
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0, offset);
    const pathEnd = output.indexOf(0, headerEnd + 1);
    if (headerEnd === -1 || pathEnd === -1) throw new ScanUnavailable("git");
    const header = output.subarray(offset, headerEnd).toString("latin1");
    const path = output.subarray(headerEnd + 1, pathEnd);
    offset = pathEnd + 1;
    const match = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])\d*$/.exec(header);
    if (match === null) throw new ScanUnavailable("git");
    const [, mode = "", oid = "", status = ""] = match;
    if (status === "D") continue;
    changes.push({ path, mode, oid });
  }
  return changes;
}

/** Reads objects through one `git cat-file --batch` process. */
async function readObjects(repository: string, oids: readonly string[], runner: GitRunner): Promise<Map<string, Buffer>> {
  const objects = new Map<string, Buffer>();
  if (oids.length === 0) return objects;
  const output = await git(repository, ["cat-file", "--batch"], runner, Buffer.from(oids.map((oid) => `${oid}\n`).join("")));
  let offset = 0;
  for (const oid of oids) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new ScanUnavailable("git");
    const match = /^([0-9a-f]+) (\w+) (\d+)$/.exec(output.subarray(offset, headerEnd).toString("latin1"));
    if (match?.[1] !== oid) throw new ScanUnavailable("git");
    const size = Number(match[3]);
    objects.set(oid, output.subarray(headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  return objects;
}

export interface ParsedCommit {
  parents: string[];
  /** The value of the author line in its expected place, or null when that line is missing. */
  author: Buffer | null;
  /** The value of the committer line in its expected place, or null when that line is missing. */
  committer: Buffer | null;
  /** The message followed by every header line not skipped by position. */
  scanned: Buffer;
}

/**
 * Splits a raw commit by position: the first tree line, the parent lines right after it,
 * then one author line and one committer line are skipped. Every other header line,
 * including repeated names and continuation lines, is appended to the message for scanning.
 */
export function parseCommit(raw: Buffer): ParsedCommit {
  const split = raw.indexOf("\n\n");
  const headerBytes = split === -1 ? raw : raw.subarray(0, split);
  const message = split === -1 ? Buffer.alloc(0) : raw.subarray(split + 2);
  const lines: Buffer[] = [];
  for (let start = 0; start < headerBytes.length; ) {
    const end = headerBytes.indexOf(0x0a, start);
    lines.push(headerBytes.subarray(start, end === -1 ? headerBytes.length : end));
    start = end === -1 ? headerBytes.length : end + 1;
  }
  let index = 0;
  const take = (name: string): Buffer | null => {
    const prefix = Buffer.from(`${name} `);
    const line = lines[index];
    if (!line?.subarray(0, prefix.length).equals(prefix)) return null;
    index += 1;
    return line.subarray(prefix.length);
  };
  const parents: string[] = [];
  let author: Buffer | null = null;
  let committer: Buffer | null = null;
  if (take("tree") !== null) {
    for (let parent = take("parent"); parent !== null; parent = take("parent")) parents.push(parent.toString("latin1"));
    author = take("author");
    if (author !== null) committer = take("committer");
  }
  const extra = lines.slice(index);
  if (extra.length === 0) return { parents, author, committer, scanned: message };
  const separator = message.length === 0 || message[message.length - 1] === 0x0a ? [] : [Buffer.from("\n")];
  const scanned = Buffer.concat([message, ...separator, ...extra.flatMap((line) => [line, Buffer.from("\n")])]);
  return { parents, author, committer, scanned };
}

/** The commits in head's history minus the excluded revisions, newest first, each read once. */
export async function readCommits(
  repository: string,
  head: string,
  exclude: readonly string[],
  runner: GitRunner,
): Promise<{ sha: string; commit: ParsedCommit }[]> {
  if (![head, ...exclude].every(isRevision)) throw new ScanUnavailable("input");
  const verified = async (revision: string): Promise<string> =>
    (await git(repository, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], runner)).toString("latin1").trim();
  const tip = await verified(head);
  const excluded = await Promise.all(exclude.map(verified));
  const shas = (await git(repository, ["rev-list", tip, ...(excluded.length > 0 ? ["--not", ...excluded] : [])], runner))
    .toString("latin1")
    .split("\n")
    .filter((line) => line.length > 0);
  const raw = await readObjects(repository, shas, runner);
  return shas.map((sha) => {
    const object = raw.get(sha);
    if (object === undefined) throw new ScanUnavailable("git");
    return { sha, commit: parseCommit(object) };
  });
}

/**
 * Collects the commits in head's history minus the excluded revisions: each commit's
 * message, its sorted list of added or changed paths relative to the first parent, and
 * the content of each added or changed blob. Author and committer fields are not used.
 */
export async function collectGitUnits(source: GitScanSource, runner: GitRunner): Promise<CollectedUnits> {
  const { repository } = source;
  if (source.licenseRevision !== undefined && !isRevision(source.licenseRevision)) throw new ScanUnavailable("input");
  const commits = await readCommits(repository, source.head, source.exclude, runner);
  const emptyTree = (await git(repository, ["hash-object", "-t", "tree", "/dev/null"], runner)).toString("latin1").trim();

  const units: ScanUnit[] = [];
  const blobRequests: { unit: ScanUnit; oid: string }[] = [];
  for (const { sha, commit } of commits) {
    const short = sha.slice(0, 12);
    units.push({ kind: "message", location: `commit-${short}`, content: commit.scanned, isLicense: false });
    // -t also lists directory entries, so the name of a directory without files is checked too.
    const diff = await git(
      repository,
      ["diff-tree", "-r", "-t", "-z", "--raw", "--no-renames", "--full-index", commit.parents[0] ?? emptyTree, sha],
      runner,
    );
    const changes = parseRawDiff(diff).sort((a, b) => Buffer.compare(a.path, b.path));
    const list = `paths-${short}`;
    units.push({ kind: "paths", location: list, content: pathListContent(changes.map((change) => change.path)), isLicense: false });
    changes.forEach((change, index) => {
      if (change.mode === SUBMODULE_MODE || change.mode === TREE_MODE) return;
      const path = change.path.toString("utf8");
      const unit: ScanUnit = {
        kind: "file",
        location: path,
        content: new Uint8Array(),
        isLicense: posix.basename(path) === "LICENSE",
        listed: { list, position: index + 1 },
      };
      units.push(unit);
      blobRequests.push({ unit, oid: change.oid });
    });
  }
  const blobs = await readObjects(repository, [...new Set(blobRequests.map((request) => request.oid))], runner);
  for (const request of blobRequests) {
    const content = blobs.get(request.oid);
    if (content === undefined) throw new ScanUnavailable("git");
    request.unit.content = content;
  }

  let trustedCopyright: Uint8Array | null = null;
  if (source.licenseRevision !== undefined) {
    const base = (await git(repository, ["rev-parse", "--verify", "--quiet", `${source.licenseRevision}^{commit}`], runner))
      .toString("latin1")
      .trim();
    const listing = await git(repository, ["ls-tree", "-z", base, "--", "LICENSE"], runner);
    const match = /^100(?:644|755) blob ([0-9a-f]+)\tLICENSE\0$/.exec(listing.toString("latin1"));
    if (match?.[1] !== undefined) {
      const license = (await readObjects(repository, [match[1]], runner)).get(match[1]);
      if (license !== undefined) trustedCopyright = copyrightLine(license);
    }
  }
  return { units, trustedCopyright };
}

/** Collects the given files (symlinks as their target) and the list of given paths. */
export async function collectFileUnits(source: FilesScanSource): Promise<CollectedUnits> {
  const root = resolve(source.root);
  const units: ScanUnit[] = [];
  const listed: string[] = [];
  for (const given of source.paths) {
    const absolute = resolve(root, given);
    const inside = relative(root, absolute);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new ScanUnavailable("input");
    const path = inside.split(sep).join("/");
    listed.push(path);
    let content: Uint8Array;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) content = Buffer.from(await readlink(absolute, { encoding: "buffer" }));
      else if (info.isFile()) content = await readFile(absolute);
      else throw new ScanUnavailable("input");
    } catch {
      throw new ScanUnavailable("input");
    }
    units.push({
      kind: "file",
      location: path,
      content,
      isLicense: posix.basename(path) === "LICENSE",
      listed: { list: "paths", position: listed.length },
    });
  }
  units.push({ kind: "paths", location: "paths", content: pathListContent(listed.map((path) => Buffer.from(path))), isLicense: false });
  let trustedCopyright: Uint8Array | null = null;
  if (source.licenseFile !== undefined) {
    try {
      trustedCopyright = copyrightLine(await readFile(resolve(root, source.licenseFile)));
    } catch {
      throw new ScanUnavailable("input");
    }
  }
  return { units, trustedCopyright };
}
