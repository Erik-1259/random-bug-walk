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
  return request as unknown as ScanRequest;
}

function gitleaksPath(unit: ScanUnit): string {
  if (unit.kind === "file") return unit.location;
  return unit.kind === "message" ? "message.txt" : "text.txt";
}

function compareLocations(a: [string, number], b: [string, number]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] - b[1];
}

async function scanChecked(request: ScanRequest): Promise<ScanResult> {
  const env = toolEnvironment(process.env);
  const terms = await loadTerms(request.patternFile);
  if (terms === null) throw new ScanUnavailable("pattern-file");

  const collected: CollectedUnits = { units: [], trustedCopyright: null };
  const runner = { env, timeoutMs: request.gitTimeoutMs ?? DEFAULT_TIMEOUT_MS.git };
  if (request.git !== undefined) Object.assign(collected, await collectGitUnits(request.git, runner));
  if (request.files !== undefined) Object.assign(collected, await collectFileUnits(request.files));
  for (const text of request.texts ?? []) {
    collected.units.push({ kind: "text", location: text.name, content: text.content, isLicense: false });
  }
  const { units, trustedCopyright } = collected;
  const context = { terms, trustedCopyright, repository: request.repository ?? null };

  const lines = units.map((unit) => contentViolations(unit, context));
  const scanned = units.flatMap((unit, index) => (unit.kind === "paths" ? [] : [{ unit, index }]));
  const blobs: GitleaksBlob[] = scanned.map(({ unit }) => ({ path: gitleaksPath(unit), content: unit.content }));
  const gitleaks = { env, timeoutMs: request.gitleaksTimeoutMs ?? DEFAULT_TIMEOUT_MS.gitleaks };
  for (const finding of await runGitleaks(request.gitleaksCommand ?? "gitleaks", blobs, gitleaks)) {
    const target = scanned[finding.blob];
    if (target !== undefined) lines[target.index]?.add(finding.line);
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

/** Like scan(), and also returns a generic category for an unavailable result. */
export async function scanDetailed(request: unknown): Promise<DetailedScanResult> {
  try {
    return { result: await scanChecked(validateRequest(request)) };
  } catch (error) {
    return { result: { outcome: "unavailable" }, category: error instanceof ScanUnavailable ? error.category : "internal" };
  }
}

/**
 * PUB-02 scanner entry: checks content against the private pattern list, attribution
 * forms and gitleaks. It never throws; any failure gives `unavailable`, never `clean`.
 */
export async function scan(request: ScanRequest): Promise<ScanResult> {
  return (await scanDetailed(request)).result;
}
