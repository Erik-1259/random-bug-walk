import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { gitOutput, runGit, withEmptyDirectory } from "./git.ts";
import { parseLsTree } from "./manifest.ts";
import { BRANCH, INDEX_SETTINGS, identityLine } from "./neutral.ts";
import type { NeutralCommit } from "./policy.ts";
import { matchSpans, textHasTerm, type Term } from "./terms.ts";

export interface Finding {
  reason: string;
  path: string;
  line: number | null;
}

export interface AuditedFile {
  mode: "100644" | "100755";
  bytes: Buffer;
}

export interface Identity {
  name: string;
  email: string;
  date: string;
  timezone: string;
}

export interface CommitSummary {
  commit: string;
  author: Identity | null;
  committer: Identity | null;
  message_matches_policy: boolean;
}

export interface HistoryResult {
  findings: Finding[];
  summary: CommitSummary | null;
}

const WITHHELD = "[withheld]";
// Top-level entries a neutral .git may hold, with the type each must have; each gets its own check below.
const KNOWN_GIT_ENTRIES = new Map<string, "file" | "directory">([
  ["HEAD", "file"],
  ["config", "file"],
  ["index", "file"],
  ["packed-refs", "file"],
  ["objects", "directory"],
  ["refs", "directory"],
  ["hooks", "directory"],
  ["logs", "directory"],
]);
const LOOSE_DIRECTORY = /^[0-9a-f]{2}$/;
const LOOSE_OBJECT = /^[0-9a-f]+$/;
const OBJECT_HEADER = /^(blob|tree|commit|tag) (\d+)$/;
const IDENT = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/;

type Add = (reason: string, path: string, line?: number | null) => void;

interface GitEntry {
  path: string;
  absolute: string;
  /** "other" is a symlink, FIFO, socket, device or unreadable directory, which is never opened. */
  kind: "file" | "directory" | "other";
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Lists every entry under a directory, depth first, without following symlinks. */
function listAll(directory: string, prefix: string): GitEntry[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [{ path: prefix, absolute: directory, kind: "other" }];
  }
  const found: GitEntry[] = [];
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push({ path, absolute, kind: "directory" }, ...listAll(absolute, path));
    else found.push({ path, absolute, kind: entry.isFile() ? "file" : "other" });
  }
  return found;
}

// Names git itself gives (fixed directories and hash-derived object names) are not scanned.
const FIXED_PREFIXES = [".git/logs/refs/heads/", ".git/logs/refs/tags/", ".git/logs/refs/", ".git/logs/", ".git/refs/heads/", ".git/refs/tags/", ".git/refs/", ".git/hooks/", ".git/info/", ".git/"];
const FIXED_NAMES = new Set(["HEAD", "config", "index", "packed-refs", "objects", "refs", "hooks", "logs", "info", "heads", "tags"]);

/** The part of a .git path that was chosen by whoever wrote it, or null when git chose all of it. */
function chosenName(path: string): string | null {
  if (path === ".git/objects") return null;
  if (path.startsWith(".git/objects/")) {
    const rest = path.slice(".git/objects/".length);
    const gitLayout = /^[0-9a-f]{2}(?:\/[0-9a-f]+)?$/.test(rest) || ["pack", "info", "info/alternates", "info/http-alternates"].includes(rest);
    return gitLayout ? null : rest;
  }
  const prefix = FIXED_PREFIXES.find((candidate) => path.startsWith(candidate)) ?? ".git/";
  const rest = path.slice(prefix.length);
  return rest === "" || FIXED_NAMES.has(rest) ? null : rest;
}

/**
 * HEAD must point at the one branch, a loose ref must hold exactly one object id, and there is no
 * packed-refs file, as commit-neutral leaves them.
 */
function checkRefFile(file: GitEntry, add: Add): void {
  if (file.path === ".git/packed-refs") {
    add("git_extra_ref", file.path);
    return;
  }
  let text: string;
  try {
    text = readFileSync(file.absolute, "latin1");
  } catch {
    add("git_history", file.path);
    return;
  }
  const expected = file.path === ".git/HEAD" ? text === `ref: ${BRANCH}\n` : /^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(text);
  if (!expected) add("git_extra_ref", file.path);
}

/** Every entry under a directory except subdirectories. */
function listFiles(directory: string, prefix: string): GitEntry[] {
  return listAll(directory, prefix).filter((entry) => entry.kind !== "directory");
}

function objectHash(format: string): ReturnType<typeof createHash> {
  return createHash(format === "sha256" ? "sha256" : "sha1");
}

/** Whether a loose object file inflates completely, with nothing after its data, to an object whose hash is its name. */
function isValidLooseObject(file: string, oid: string, format: string): boolean {
  try {
    const raw = readFileSync(file);
    const { buffer, engine } = inflateSync(raw, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (engine.bytesWritten !== raw.length) return false;
    const nul = buffer.indexOf(0);
    const header = OBJECT_HEADER.exec(buffer.subarray(0, Math.max(nul, 0)).toString("latin1"));
    if (nul < 0 || header === null || Number(header[2]) !== buffer.length - nul - 1) return false;
    return objectHash(format).update(buffer).digest("hex") === oid;
  } catch {
    return false;
  }
}

/**
 * ADM-01: the object store holds only valid loose objects, as commit-neutral writes it. Packs,
 * pack indexes and any other file are refused, because their bytes cannot be checked object by
 * object; a loose object whose bytes do not hash to its name, or that carries trailing data, is
 * refused too.
 */
function checkObjectStore(objects: string, format: string, add: Add): void {
  if (lstatOrNull(objects)?.isDirectory() !== true) return;
  const length = format === "sha256" ? 64 : 40;
  for (const file of listAll(objects, ".git/objects")) {
    const [directory = "", name = "", extra] = file.path.slice(".git/objects/".length).split("/");
    if (file.kind === "directory") {
      const known = LOOSE_DIRECTORY.test(directory) || directory === "pack" || directory === "info";
      if (!known || name !== "") add("git_extra_object", file.path);
      continue;
    }
    if (directory === "info" && (name === "alternates" || name === "http-alternates") && extra === undefined) continue;
    const oid = directory + name;
    const loose = LOOSE_DIRECTORY.test(directory) && extra === undefined && LOOSE_OBJECT.test(name) && oid.length === length;
    if (file.kind !== "file" || !loose || !isValidLooseObject(file.absolute, oid, format)) add("git_extra_object", file.path);
  }
}

/** An author or committer line as reported, with any field that holds a strict term withheld. */
function parseIdentity(value: string | undefined, strict: readonly Term[]): Identity | null {
  const match = value === undefined ? null : IDENT.exec(value);
  if (match === null) return null;
  const [, name = "", email = "", seconds = "", tz = ""] = match;
  const epoch = Number(seconds);
  const date = Number.isSafeInteger(epoch) && epoch * 1000 <= 8.64e15 ? new Date(epoch * 1000).toISOString().replace(".000Z", "Z") : seconds;
  const hide = (text: string): string => (textHasTerm(text, strict) ? WITHHELD : text);
  return { name: hide(name), email: hide(email), date, timezone: tz };
}

function blobId(bytes: Buffer, format: string): string {
  return objectHash(format)
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * ADM-01: the copy's `.git` holds exactly one parentless commit with the neutral identity,
 * whose tree is the audited files, one branch, no hooks, no other object and nothing that
 * reaches other history. Git runs only plumbing commands against the copy, with global and
 * system configuration, hooks and replace refs off.
 */
export function checkHistory(copy: string, files: ReadonlyMap<string, AuditedFile>, neutral: NeutralCommit, strict: readonly Term[]): HistoryResult {
  const findings: Finding[] = [];
  const add = (reason: string, path: string, line: number | null = null): void => {
    findings.push({ reason, path, line });
  };
  const gitDir = join(copy, ".git");
  const stat = lstatOrNull(gitDir);
  if (stat?.isDirectory() !== true) {
    add("git_missing", ".git");
    return { findings, summary: null };
  }

  let topLevel;
  try {
    topLevel = readdirSync(gitDir, { withFileTypes: true });
  } catch {
    add("git_missing", ".git");
    return { findings, summary: null };
  }
  for (const entry of topLevel) {
    const path = `.git/${entry.name}`;
    const expected = KNOWN_GIT_ENTRIES.get(entry.name);
    if (entry.name !== "HEAD" && /^[A-Z_]+HEAD$/.test(entry.name)) {
      add("git_extra_ref", path);
    } else if (expected === undefined) {
      // ADM-01: any other git state (shallow, modules, messages, rebase or sequencer state, info files) can carry history.
      if (entry.name === "info" && entry.isDirectory()) for (const file of listFiles(join(gitDir, "info"), path)) add("git_history", file.path);
      else add("git_history", path);
    } else if (expected === "file" ? !entry.isFile() : !entry.isDirectory()) {
      add("git_history", path);
    }
  }
  if (lstatOrNull(join(gitDir, "hooks"))?.isDirectory() === true) {
    try {
      for (const name of readdirSync(join(gitDir, "hooks"))) add("git_hooks", `.git/hooks/${name}`);
    } catch {
      add("git_hooks", ".git/hooks");
    }
  }
  for (const path of ["objects/info/alternates", "objects/info/http-alternates"]) {
    if (lstatOrNull(join(gitDir, path)) !== null) add("git_history", `.git/${path}`);
  }
  if (lstatOrNull(join(gitDir, "logs"))?.isDirectory() === true) {
    for (const file of listFiles(join(gitDir, "logs"), ".git/logs")) add("git_history", file.path);
  }
  // ADM-07: every regular file in .git outside the object store gets the strict scan (config, refs,
  // messages). The index is required below to equal a fresh read of the commit tree, whose names
  // are the scanned copy paths. Anything that is not a regular file is refused without being opened.
  const everything = listAll(gitDir, ".git");
  for (const file of everything) {
    // ADM-07: names inside .git get the strict scan too, reported where a term is first complete.
    const name = chosenName(file.path);
    if (name !== null && textHasTerm(name, strict) && !textHasTerm(name.slice(0, Math.max(0, name.lastIndexOf("/"))), strict)) {
      add("strict_term", file.path);
    }
    if (file.kind === "other") {
      add("git_history", file.path);
      continue;
    }
    if (file.kind === "directory" || file.path.startsWith(".git/objects/") || file.path === ".git/index") continue;
    // Files whose whole content git writes are checked exactly instead of scanned, so a term made of
    // hex letters or git keywords never matches an object id or "ref: refs/heads/main".
    if (file.path === ".git/HEAD" || file.path === ".git/packed-refs" || file.path.startsWith(".git/refs/")) {
      checkRefFile(file, add);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file.absolute);
    } catch {
      add("git_history", file.path);
      continue;
    }
    for (const span of matchSpans(bytes, strict)) add("strict_term", file.path, span.start);
  }
  // git itself would block on a FIFO or fail on an unreadable directory, so no git command runs.
  if (everything.some((file) => file.kind === "other")) return { findings, summary: null };

  const options = { gitDir };
  const config = existsSync(join(gitDir, "config"))
    ? gitOutput(["config", "--file", join(gitDir, "config"), "--no-includes", "--null", "--name-only", "--list"])
    : Buffer.alloc(0);
  const format = gitOutput(["rev-parse", "--show-object-format"], options)?.toString("utf8").trim();
  if (config === null || format === undefined) {
    add("git_missing", ".git");
    return { findings, summary: null };
  }
  if (config.toString("utf8").split("\0").some((name) => name.toLowerCase().startsWith("remote."))) add("git_extra_ref", ".git/config");
  checkObjectStore(join(gitDir, "objects"), format, add);

  const refs = gitOutput(["for-each-ref", "--format=%(refname)"], options);
  const refNames = new Set(refs?.toString("utf8").split("\n").filter((ref) => ref !== ""));
  const refsDirectory = join(gitDir, "refs");
  if (lstatOrNull(refsDirectory)?.isDirectory() === true) {
    for (const file of listFiles(refsDirectory, "refs")) {
      // A file under refs/ that git does not read as a ref is still content in the copy.
      if (!refNames.has(file.path)) add("git_extra_ref", `.git/${file.path}`);
    }
  }
  for (const ref of refNames) {
    if (ref === BRANCH) continue;
    add("git_extra_ref", `.git/${ref}`);
    if (ref.startsWith("refs/replace/")) add("git_history", `.git/${ref}`);
  }
  if (gitOutput(["symbolic-ref", "--quiet", "HEAD"], options)?.toString("utf8").trim() !== BRANCH) add("git_extra_ref", ".git/HEAD");
  const count = gitOutput(["rev-list", "--all", "--count"], options);
  if (count?.toString("utf8").trim() !== "1") add("git_history", ".git");

  const resolve = (name: string): string | null =>
    gitOutput(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], options)?.toString("utf8").trim() ?? null;
  // Without the branch there is no single root commit; HEAD's commit is still checked so its identity and tree are reported.
  const branchCommit = resolve(BRANCH);
  if (branchCommit === null) add("git_history", ".git");
  const commit = branchCommit ?? resolve("HEAD");
  const reachable = new Set<string>();
  let summary: CommitSummary | null = null;
  if (commit === null) {
    add("git_history", ".git");
  } else {
    summary = checkCommit(commit, options, neutral, strict, add);
    checkTree(commit, options, files, format, add);
    checkIndex(commit, options, add);
    const listed = gitOutput(["rev-list", "--objects", "--no-object-names", commit], options);
    if (listed === null) add("git_history", ".git");
    for (const oid of listed?.toString("utf8").split("\n") ?? []) if (oid !== "") reachable.add(oid);
  }
  const all = gitOutput(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)", "--unordered"], options);
  if (all === null) add("git_history", ".git");
  for (const oid of all?.toString("utf8").split("\n") ?? []) {
    // ADM-01: an object no commit reaches, such as a stray blob of the original file.
    if (oid !== "" && !reachable.has(oid)) add("git_extra_object", `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
  }
  return { findings, summary };
}

function checkCommit(
  commit: string,
  options: { gitDir: string },
  neutral: NeutralCommit,
  strict: readonly Term[],
  add: (reason: string, path: string, line?: number | null) => void,
): CommitSummary | null {
  const raw = gitOutput(["cat-file", "commit", commit], options);
  if (raw === null) {
    add("git_history", ".git");
    return null;
  }
  // ADM-07: the commit message and identity get the strict scan too.
  // Object ids in the tree and parent lines are blanked, keeping line numbers, so only the identity
  // and message are scanned.
  const scanned = Buffer.from(raw.toString("latin1").replace(/^(tree|parent) [0-9a-f]+$/gm, (line) => " ".repeat(line.length)), "latin1");
  for (const span of matchSpans(scanned, strict)) add("strict_term", ".git", span.start);
  const text = raw.toString("utf8");
  const split = text.indexOf("\n\n");
  const headers = (split < 0 ? text : text.slice(0, split)).split("\n");
  const message = split < 0 ? "" : text.slice(split + 2);
  const values = new Map<string, string[]>();
  for (const header of headers) {
    if (header.startsWith(" ")) continue;
    const space = header.indexOf(" ");
    const key = space < 0 ? header : header.slice(0, space);
    values.set(key, [...(values.get(key) ?? []), space < 0 ? "" : header.slice(space + 1)]);
  }
  if (values.has("parent")) add("git_history", ".git");
  const expected = identityLine(neutral);
  const author = values.get("author") ?? [];
  const committer = values.get("committer") ?? [];
  const messageMatches = message === `${neutral.message}\n`;
  // The whole object must be exactly these lines, so no extra header, continuation line or second
  // tree can carry data. Parent lines are reported as history above, not as identity.
  const parents = (values.get("parent") ?? []).map((parent) => `parent ${parent}\n`).join("");
  const exact = `tree ${values.get("tree")?.[0] ?? ""}\n${parents}author ${expected}\ncommitter ${expected}\n\n${neutral.message}\n`;
  if (!raw.equals(Buffer.from(exact, "utf8"))) add("git_identity", ".git");
  return {
    commit,
    author: parseIdentity(author[0], strict),
    committer: parseIdentity(committer[0], strict),
    message_matches_policy: messageMatches,
  };
}

function checkTree(
  commit: string,
  options: { gitDir: string },
  files: ReadonlyMap<string, AuditedFile>,
  format: string,
  add: (reason: string, path: string, line?: number | null) => void,
): void {
  const listing = gitOutput(["ls-tree", "-r", "-t", "-z", "--full-tree", commit], options);
  const entries = listing === null ? null : parseLsTree(listing, false);
  if (entries === null) {
    add("git_tree_mismatch", ".git");
    return;
  }
  const directories = new Set<string>();
  for (const path of files.keys()) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) directories.add(segments.slice(0, depth).join("/"));
  }
  const seen = new Set<string>();
  let mismatches = 0;
  const mismatch = (path: string): void => {
    mismatches += 1;
    add("git_tree_mismatch", path);
  };
  for (const entry of entries) {
    // ADM-01: a subtree must hold audited files; an empty or extra subtree can carry a name or data.
    if (entry.type === "tree") {
      if (!directories.has(entry.path)) mismatch(entry.path);
      continue;
    }
    seen.add(entry.path);
    const file = files.get(entry.path);
    // ADM-01: git holds exactly the audited bytes and modes, and no other version of a file.
    if (file === undefined || entry.type !== "blob" || entry.mode !== file.mode || entry.oid !== blobId(file.bytes, format)) {
      mismatch(entry.path);
    }
  }
  for (const path of files.keys()) if (!seen.has(path)) mismatch(path);
  // ADM-01: the tree object itself is the one the audited files give, so no mode spelling or other
  // byte in a tree object can carry data that the listing above normalises away. Reported only when
  // no differing path already explains it.
  const actual = gitOutput(["rev-parse", "--verify", "--quiet", `${commit}^{tree}`], options)?.toString("utf8").trim();
  if (mismatches === 0 && actual !== expectedTreeId(files, format)) add("git_tree_mismatch", ".git");
}

/** The id of the tree git would write for exactly these files, built as git builds tree objects. */
export function expectedTreeId(files: ReadonlyMap<string, AuditedFile>, format: string): string {
  interface Directory {
    files: Map<string, AuditedFile>;
    directories: Map<string, Directory>;
  }
  const root: Directory = { files: new Map(), directories: new Map() };
  for (const [path, file] of files) {
    const segments = path.split("/");
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      let child = directory.directories.get(segment);
      if (child === undefined) {
        child = { files: new Map(), directories: new Map() };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.set(segments.at(-1) ?? "", file);
  }
  const write = (directory: Directory): string => {
    const entries: { sortKey: Buffer; bytes: Buffer }[] = [];
    for (const [name, file] of directory.files) {
      const header = Buffer.from(`${file.mode} ${name}\0`, "utf8");
      entries.push({ sortKey: Buffer.from(name, "utf8"), bytes: Buffer.concat([header, Buffer.from(blobId(file.bytes, format), "hex")]) });
    }
    for (const [name, child] of directory.directories) {
      const header = Buffer.from(`40000 ${name}\0`, "utf8");
      entries.push({ sortKey: Buffer.from(`${name}/`, "utf8"), bytes: Buffer.concat([header, Buffer.from(write(child), "hex")]) });
    }
    entries.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey));
    const content = Buffer.concat(entries.map((entry) => entry.bytes));
    return objectHash(format).update(`tree ${String(content.length)}\0`).update(content).digest("hex");
  };
  return write(root);
}

/**
 * ADM-01: the index is present, a regular file and byte for byte what `git read-tree` of the commit writes, as
 * commit-neutral leaves it, so it names no other file and carries no extension or other data.
 */
function checkIndex(commit: string, options: { gitDir: string }, add: Add): void {
  const index = join(options.gitDir, "index");
  if (lstatOrNull(index)?.isFile() !== true) {
    add("git_tree_mismatch", ".git/index");
    return;
  }
  const matches = withEmptyDirectory((directory) => {
    const fresh = join(directory, "index");
    try {
      const read = runGit([...INDEX_SETTINGS, "read-tree", commit], { ...options, env: { GIT_INDEX_FILE: fresh } });
      return read.status === 0 && readFileSync(fresh).equals(readFileSync(index));
    } finally {
      rmSync(fresh, { force: true });
    }
  });
  if (!matches) add("git_tree_mismatch", ".git/index");
}
