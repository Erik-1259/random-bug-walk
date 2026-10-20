import { contentViolations, loadTerms, type ScanUnit } from "./checks.ts";
import { runGitleaks, ScanUnavailable, type GitleaksBlob } from "./gitleaks.ts";
import { DEFAULT_TIMEOUT_MS, toolEnvironment } from "./run.ts";
import { collectFileUnits, collectGitUnits, type CollectedUnits, type FilesScanSource, type GitScanSource } from "./sources.ts";

export type { FilesScanSource, GitScanSource } from "./sources.ts";

export interface TextScanItem {
  /** Synthetic location name matching [A-Za-z0-9._-]+, for example pr-body. */
  name: string;
  content: Uint8Array;
}

export interface ScanRequest {
  /** Path of the private pattern file. */
  patternFile: string;
  /** `<owner>/<repo>` whose own repository URLs are exempt from the pattern check. */
  repository?: string;
  /** gitleaks command; `{dir}` tokens become the scan's temporary directory. Default `gitleaks`. */
  gitleaksCommand?: string;
  /** Time limit for each git child, in milliseconds; the default is DEFAULT_TIMEOUT_MS.git. */
  gitTimeoutMs?: number;
  /** Time limit for each gitleaks child, in milliseconds; the default is DEFAULT_TIMEOUT_MS.gitleaks. */
  gitleaksTimeoutMs?: number;
  git?: GitScanSource;
  files?: FilesScanSource;
  texts?: readonly TextScanItem[];
}

/**
 * A request for the public-source route: the same inputs and tool settings, but no pattern
 * file and no repository URL exception, because that route runs no pattern check.
 */
export type PublicScanRequest = Omit<ScanRequest, "patternFile" | "repository">;

export type ScanResult =
  | { outcome: "clean" }
  | { outcome: "blocked"; locations: string[] } // "<location>:<line>", sorted, unique
  | { outcome: "unavailable" };

export interface DetailedScanResult {
  result: ScanResult;
  /** Generic category for an unavailable result; never names content or terms. */
  category?: string;
}

const TEXT_NAME = /^[A-Za-z0-9._-]+$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validTextName(name: string): boolean {
  return TEXT_NAME.test(name) && name !== "." && name !== "..";
}

function validateRequest(request: unknown): ScanRequest {
  if (!isRecord(request) || typeof request.patternFile !== "string") throw new ScanUnavailable("usage");
  validateInputs(request);
  return request as unknown as ScanRequest;
}

function validatePublicRequest(request: unknown): PublicScanRequest {
  if (!isRecord(request) || "patternFile" in request || "repository" in request) throw new ScanUnavailable("usage");
  validateInputs(request);
  return request;
}

function validateInputs(request: Record<string, unknown>): void {
  const { repository, gitleaksCommand, gitTimeoutMs, gitleaksTimeoutMs, git, files, texts } = request;
  if (repository !== undefined && (typeof repository !== "string" || !REPOSITORY.test(repository))) throw new ScanUnavailable("usage");
  if (gitleaksCommand !== undefined && typeof gitleaksCommand !== "string") throw new ScanUnavailable("usage");
  for (const limit of [gitTimeoutMs, gitleaksTimeoutMs]) {
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) throw new ScanUnavailable("usage");
  }
  if (git !== undefined && files !== undefined) throw new ScanUnavailable("usage");
  if (git !== undefined) {
    if (!isRecord(git) || typeof git.repository !== "string" || typeof git.head !== "string") throw new ScanUnavailable("usage");
    if (!Array.isArray(git.exclude) || !git.exclude.every((item) => typeof item === "string")) throw new ScanUnavailable("usage");
    if (git.licenseRevision !== undefined && typeof git.licenseRevision !== "string") throw new ScanUnavailable("usage");
  }
  if (files !== undefined) {
    if (!isRecord(files) || typeof files.root !== "string" || !Array.isArray(files.paths)) throw new ScanUnavailable("usage");
    if (files.paths.length === 0 || !files.paths.every((item) => typeof item === "string")) throw new ScanUnavailable("usage");
    if (files.licenseFile !== undefined && typeof files.licenseFile !== "string") throw new ScanUnavailable("usage");
  }
  if (texts !== undefined) {
    if (!Array.isArray(texts)) throw new ScanUnavailable("usage");
    for (const item of texts as unknown[]) {
      if (!isRecord(item) || typeof item.name !== "string" || !validTextName(item.name) || !(item.content instanceof Uint8Array)) {
        throw new ScanUnavailable("usage");
      }
    }
  }
  const textCount = Array.isArray(texts) ? texts.length : 0;
  if (git === undefined && files === undefined && textCount === 0) throw new ScanUnavailable("usage");
}

function gitleaksPath(unit: ScanUnit): string {
  if (unit.kind === "file") return unit.location;
  return unit.kind === "message" ? "message.txt" : "text.txt";
}

/** The longest span form of a path, in characters. */
const SPAN_LIMIT = 256;

/**
 * The span forms of a path: each part of it that starts at its start or right after any
 * character other than an ASCII letter or digit, ends at its end or right before such a
 * character, is not empty and has at most SPAN_LIMIT characters. Written on its own line, each
 * part has a line start before it and a line end after it, which give it every boundary a rule
 * may need on either side of the secret. A character outside the BMP counts as one character,
 * so no part starts or ends inside it. The limit keeps their number linear in the path's length.
 */
function spanForms(path: string): string[] {
  // Each such character ends one part and starts the next; 0 and the path's length are its ends.
  const starts = [0];
  const ends: number[] = [];
  for (const separator of path.matchAll(/[^A-Za-z0-9]/gu)) {
    ends.push(separator.index);
    starts.push(separator.index + separator[0].length);
  }
  ends.push(path.length);
  const spans: string[] = [];
  let first = 0;
  for (const start of starts) {
    while ((ends[first] ?? Infinity) <= start) first += 1;
    for (let next = first; next < ends.length; next += 1) {
      const end = ends[next] ?? Infinity;
      if (end - start > SPAN_LIMIT) break;
      spans.push(path.slice(start, end));
    }
  }
  return spans;
}

/**
 * The other forms of a path that gitleaks scans, each distinct form once. Many gitleaks rules
 * need a space, a quote or a line end after the secret, so a credential followed by "/" or "."
 * in a path would pass. The path is also given with "/" and "." as spaces, and as each prefix
 * that ends before a "/" or "." (each directory, and the name without each extension), which
 * keeps a credential with a "." or "/" inside it whole. Each of those prefixes, and the path
 * itself, is given again with "/" as spaces when it holds a "/", for a rule that also needs a
 * space before the secret. A rule's boundary can also fail on any other character next to the
 * credential, such as the "-" in cfg/x-<secret>.md, so the path is also given as its span forms.
 */
export function pathForms(path: string): Set<string> {
  const ends = [...path.matchAll(/[/.]/g)].map((separator) => separator.index).filter((end) => end > 0);
  const prefixes = ends.map((end) => path.slice(0, end));
  const forms = new Set([path.replace(/[/.]/g, " "), ...prefixes]);
  for (const prefix of [...prefixes, path]) if (prefix.includes("/")) forms.add(prefix.replaceAll("/", " "));
  for (const span of spanForms(path)) forms.add(span);
  return forms;
}

/**
 * Empty lines after each path-list entry. gitleaks' generic-api-key rule allows up to five
 * line breaks, spaces, quotes or "=" between a key's operator and its value, so with fewer
 * line breaks an entry ending in a key and "=" took the next entry as its value, and gitleaks
 * then never matched that next entry on its own. Six line breaks keep each match of that rule
 * inside one entry.
 */
const ENTRY_GAP = 5;

/** The fixed first line and the empty line before the first entry. */
const FIRST_LINES = "path list\n\n";

/** The largest gitleaks input file of a path list's forms, in bytes, unless one path's forms alone are larger. */
export const FORMS_FILE_LIMIT = 32 * 1024 * 1024;

/** One gitleaks input file of path-list entries, and the path-list position of each entry, in order. */
export interface EntryFile {
  content: Uint8Array;
  positions: number[];
}

/** The text of an EntryFile, built in chunks so that no one string grows with the file. */
class EntryFileText {
  private readonly chunks: Buffer[] = [Buffer.from(FIRST_LINES)];
  private pending: string[] = [];
  private pendingLength = 0;
  size = Buffer.byteLength(FIRST_LINES);
  readonly positions: number[] = [];

  add(entry: string, position: number): void {
    const text = entry + "\n".repeat(ENTRY_GAP + 1);
    this.pending.push(text);
    this.pendingLength += text.length;
    this.size += Buffer.byteLength(text);
    this.positions.push(position);
    if (this.pendingLength >= 1 << 20) this.flush();
  }

  private flush(): void {
    this.chunks.push(Buffer.from(this.pending.join("")));
    this.pending = [];
    this.pendingLength = 0;
  }

  /** The text ends with the last entry's empty lines, without a line break after the last one. */
  finish(): EntryFile {
    this.flush();
    const content = Buffer.concat(this.chunks);
    return { content: content.subarray(0, content.length - 1), positions: this.positions };
  }
}

/**
 * gitleaks input files for blocks of path-list entries, where each block holds the entries of
 * one path with that path's position. Each file is a fixed first line and an empty line, then
 * each entry followed by ENTRY_GAP empty lines. gitleaks skips a file whose first bytes look
 * like a binary type, such as an executable or a database, so the fixed line comes before the
 * first path in every file. It reads a large file in chunks and ends a chunk early only at an
 * empty line, so the empty lines after each entry also keep a chunk from splitting one. A file
 * holds whole blocks and ends before the block that would take it past `limit` bytes, so no file
 * grows with the path list; a single block larger than the limit gets a file of its own.
 */
export function entryFiles(blocks: Iterable<{ entries: Iterable<string>; position: number }>, limit: number): EntryFile[] {
  const files: EntryFile[] = [];
  let current = new EntryFileText();
  for (const { entries, position } of blocks) {
    const block = [...entries];
    const size = block.reduce((total, entry) => total + Buffer.byteLength(entry) + ENTRY_GAP + 1, 0);
    if (current.positions.length > 0 && current.size + size > limit) {
      files.push(current.finish());
      current = new EntryFileText();
    }
    for (const entry of block) current.add(entry, position);
  }
  files.push(current.finish());
  return files;
}

/** The path-list position of an entry line of `file` (1-based line), or undefined for any other line. */
export function entryPosition(file: EntryFile, line: number): number | undefined {
  // The first entry is on the line after the first lines.
  const offset = line - 1 - (FIRST_LINES.split("\n").length - 1);
  if (offset < 0 || offset % (ENTRY_GAP + 1) !== 0) return undefined;
  return file.positions[offset / (ENTRY_GAP + 1)];
}

/** Each path's forms with its path-list position, one path at a time, so that no more than one path's forms are held. */
function* formBlocks(paths: readonly string[]): Generator<{ entries: Set<string>; position: number }> {
  for (const [index, path] of paths.entries()) yield { entries: pathForms(path), position: index + 1 };
}

function compareLocations(a: [string, number], b: [string, number]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] - b[1];
}

async function scanChecked(request: ScanRequest): Promise<ScanResult> {
  const terms = await loadTerms(request.patternFile);
  if (terms === null) throw new ScanUnavailable("pattern-file");
  return scanUnits(request, terms, request.repository ?? null);
}

/**
 * Collects the request's units, runs the content checks with `terms` (none on the public
 * route, which leaves only the attribution check) and gitleaks, and maps every finding to
 * a location. gitleaks also scans each path list as text, and its other forms, so a
 * credential in a path is reported at its path-list position.
 */
async function scanUnits(request: PublicScanRequest, terms: readonly RegExp[], repository: string | null): Promise<ScanResult> {
  const env = toolEnvironment(process.env);
  const collected: CollectedUnits = { units: [], trustedCopyright: null };
  const runner = { env, timeoutMs: request.gitTimeoutMs ?? DEFAULT_TIMEOUT_MS.git };
  if (request.git !== undefined) Object.assign(collected, await collectGitUnits(request.git, runner));
  if (request.files !== undefined) Object.assign(collected, await collectFileUnits(request.files));
  for (const text of request.texts ?? []) {
    collected.units.push({ kind: "text", location: text.name, content: text.content, isLicense: false });
  }
  const { units, trustedCopyright } = collected;
  const context = { terms, trustedCopyright, repository };

  const lines = units.map((unit) => contentViolations(unit, context));
  const blobs: GitleaksBlob[] = units.map((unit) => ({ path: gitleaksPath(unit), content: unit.content }));
  // Each blob's unit, and for a path list and each file of its other forms the entries' positions.
  const targets: { unit: number; entries?: EntryFile }[] = units.map((_unit, index) => ({ unit: index }));
  units.forEach((unit, index) => {
    if (unit.kind !== "paths") return;
    const paths = Buffer.from(unit.content).toString("utf8").split("\n");
    const [listed] = entryFiles(
      paths.map((path, position) => ({ entries: [path], position: position + 1 })),
      Infinity,
    );
    if (listed === undefined) throw new ScanUnavailable("internal");
    blobs[index] = { path: gitleaksPath(unit), content: listed.content };
    targets[index] = { unit: index, entries: listed };
    for (const forms of entryFiles(formBlocks(paths), FORMS_FILE_LIMIT)) {
      blobs.push({ path: gitleaksPath(unit), content: forms.content });
      targets.push({ unit: index, entries: forms });
    }
  });
  const gitleaks = { env, timeoutMs: request.gitleaksTimeoutMs ?? DEFAULT_TIMEOUT_MS.gitleaks };
  for (const finding of await runGitleaks(request.gitleaksCommand ?? "gitleaks", blobs, gitleaks)) {
    const target = targets[finding.blob];
    const line = target?.entries === undefined ? finding.line : entryPosition(target.entries, finding.line);
    if (target === undefined || line === undefined) throw new ScanUnavailable("gitleaks-report");
    lines[target.unit]?.add(line);
  }

  // A path that is itself a violation is never printed: its file's violations are reported
  // under the path list position instead. Paths with line breaks are never printed either.
  const flaggedPositions = new Map<string, Set<number>>();
  units.forEach((unit, index) => {
    if (unit.kind === "paths") flaggedPositions.set(unit.location, lines[index] ?? new Set());
  });
  const found = new Map<string, [string, number]>();
  units.forEach((unit, index) => {
    for (const line of lines[index] ?? []) {
      let entry: [string, number] = [unit.location, line];
      if (unit.listed !== undefined) {
        const flagged = flaggedPositions.get(unit.listed.list)?.has(unit.listed.position) ?? false;
        if (flagged || /[\r\n]/.test(unit.location)) entry = [unit.listed.list, unit.listed.position];
      }
      found.set(`${entry[0]}:${String(entry[1])}`, entry);
    }
  });
  if (found.size === 0) return { outcome: "clean" };
  const locations = [...found.values()].sort(compareLocations).map(([location, line]) => `${location}:${String(line)}`);
  return { outcome: "blocked", locations };
}

async function detailed(run: () => Promise<ScanResult>): Promise<DetailedScanResult> {
  try {
    return { result: await run() };
  } catch (error) {
    return { result: { outcome: "unavailable" }, category: error instanceof ScanUnavailable ? error.category : "internal" };
  }
}

/** Like scan(), and also returns a generic category for an unavailable result. */
export async function scanDetailed(request: unknown): Promise<DetailedScanResult> {
  return detailed(() => scanChecked(validateRequest(request)));
}

/**
 * The public-source route's check: gitleaks and the attribution check over the same inputs,
 * without the private pattern list. A request that names a pattern file is a usage error.
 * Its result says nothing about private patterns; required CI runs that check before merge.
 */
export async function scanPublicDetailed(request: unknown): Promise<DetailedScanResult> {
  return detailed(() => scanUnits(validatePublicRequest(request), [], null));
}

/**
 * PUB-02 scanner entry: checks content against the private pattern list, attribution
 * forms and gitleaks. It never throws; any failure gives `unavailable`, never `clean`.
 */
export async function scan(request: ScanRequest): Promise<ScanResult> {
  return (await scanDetailed(request)).result;
}
