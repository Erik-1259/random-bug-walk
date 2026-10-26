// The pre-write scan hook for `case-package prepare --scan-hook`: runs the full publication scan (the
// private pattern list, the attribution rules and gitleaks) over every member of one package part.
//   RBW_SCAN_PATTERNS=<pattern file> RBW_GITLEAKS_COMMAND=<gitleaks command> \
//     node tools/case-package/src/cli.ts prepare ... --scan-hook tools/publication/src/prepare-scan-hook.ts
// Both settings come only from the environment, so nothing private is committed; without either one the
// hook answers `unavailable`. It prints nothing and answers with locations only, never matched text.
// A finding at a known upstream line (`known-upstream-lines.ts`) is dropped; every other finding blocks.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GITLEAKS_COMMAND_VARIABLE } from "./config.ts";
import { isSafeRelativePath } from "./gitleaks.ts";
import { KNOWN_UPSTREAM_LINES, type KnownUpstreamLine } from "./known-upstream-lines.ts";
import { scan, type ScanResult } from "./scan.ts";

/** Environment variable that names the private pattern file. */
export const PATTERN_FILE_VARIABLE = "RBW_SCAN_PATTERNS";
export { GITLEAKS_COMMAND_VARIABLE };

/** One part as `case-package` hands it over (its ScanInput); kept structural so this package depends on nothing. */
export interface PreparedPart {
  part: string;
  members: readonly { path: string; bytes: Uint8Array }[];
}

const UNAVAILABLE: ScanResult = { outcome: "unavailable" };

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value === undefined || value.trim() === "" ? null : value;
}

function isPart(input: unknown): input is PreparedPart {
  if (typeof input !== "object" || input === null) return false;
  const { part, members } = input as { part?: unknown; members?: unknown };
  return (
    typeof part === "string" &&
    Array.isArray(members) &&
    members.length > 0 &&
    members.every(
      (member: unknown) =>
        typeof member === "object" &&
        member !== null &&
        typeof (member as { path?: unknown }).path === "string" &&
        (member as { bytes?: unknown }).bytes instanceof Uint8Array,
    )
  );
}

const LINE_NUMBER = /^[1-9][0-9]*$/;
const LF = 0x0a;
const CR = 0x0d;

/** The bytes of 1-based line `line` (split on LF, one trailing CR removed), or null past the last line. */
function lineBytes(bytes: Uint8Array, line: number): Uint8Array | null {
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const end = bytes.indexOf(LF, start);
    if (end === -1) return null;
    start = end + 1;
  }
  const next = bytes.indexOf(LF, start);
  let end = next === -1 ? bytes.length : next;
  if (end > start && bytes[end - 1] === CR) end -= 1;
  return bytes.subarray(start, end);
}

/** Whether an entry of `list` exempts `location` (`<path>:<line>`) of part `part`; `paths:<n>` never is. */
function isExempt(location: string, part: string, members: ReadonlyMap<string, Uint8Array>, list: readonly KnownUpstreamLine[]): boolean {
  const colon = location.lastIndexOf(":");
  if (colon === -1) return false;
  const path = location.slice(0, colon);
  const lineText = location.slice(colon + 1);
  if (path === "paths" || !LINE_NUMBER.test(lineText)) return false;
  const line = Number(lineText);
  const entries = list.filter((entry) => entry.part === part && entry.line === line && entry.path.test(path));
  const bytes = members.get(path);
  if (entries.length === 0 || bytes === undefined) return false;
  const text = lineBytes(bytes, line);
  if (text === null) return false;
  const digest = createHash("sha256").update(text).digest("hex");
  return entries.some((entry) => entry.sha256 === digest);
}

/**
 * Drops from a `blocked` result each location that an entry of `list` exempts: same part, a path the
 * entry's expression matches, the same line, a member with exactly that path, and the SHA-256 of that
 * member line's text equal to the entry's. Answers `clean` when nothing remains, otherwise `blocked` with
 * the remaining locations in their original order; `clean` and `unavailable` pass through unchanged. Any
 * error answers `unavailable`, never `clean`.
 */
export function exemptKnownLines(
  result: ScanResult,
  part: string,
  members: PreparedPart["members"],
  list: readonly KnownUpstreamLine[],
): ScanResult {
  if (result.outcome !== "blocked") return result;
  try {
    const byPath = new Map<string, Uint8Array>();
    for (const member of members) {
      if (byPath.has(member.path)) throw new Error("duplicate member path");
      byPath.set(member.path, member.bytes);
    }
    const locations = result.locations.filter((location) => !isExempt(location, part, byPath, list));
    return locations.length === 0 ? { outcome: "clean" } : { outcome: "blocked", locations };
  } catch {
    return UNAVAILABLE;
  }
}

/** Writes each member as a new regular file under `root`; an unsafe path or one that already exists throws. */
async function writeMembers(root: string, members: PreparedPart["members"]): Promise<void> {
  for (const member of members) {
    if (!isSafeRelativePath(member.path)) throw new Error("unsafe member path");
    const target = join(root, ...member.path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(member.bytes);
    } finally {
      await handle.close();
    }
  }
}

/**
 * Scans one part with the settings in `env`. The members are written to a new temporary directory and
 * scanned in files mode, so a finding is reported as `<member path>:<line>` (or `paths:<n>` for a path
 * that is itself a violation). Findings at lines of `knownLines` are then dropped (see `exemptKnownLines`).
 * Answers `unavailable` when a setting is missing, the input is malformed or anything fails; never throws.
 */
export async function scanPreparedPart(
  input: unknown,
  env: NodeJS.ProcessEnv,
  knownLines: readonly KnownUpstreamLine[] = KNOWN_UPSTREAM_LINES,
): Promise<ScanResult> {
  const patternFile = setting(env, PATTERN_FILE_VARIABLE);
  const gitleaksCommand = setting(env, GITLEAKS_COMMAND_VARIABLE);
  if (patternFile === null || gitleaksCommand === null || !isPart(input)) return UNAVAILABLE;
  let root: string | null = null;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "rbw-prepare-scan-")));
    await writeMembers(root, input.members);
    const result = await scan({ patternFile, gitleaksCommand, files: { root, paths: input.members.map((member) => member.path) } });
    return exemptKnownLines(result, input.part, input.members, knownLines);
  } catch {
    return UNAVAILABLE;
  } finally {
    if (root !== null) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The hook `case-package prepare --scan-hook` loads; it reads its settings from the process environment. */
export const SCAN_HOOK = (input: PreparedPart): Promise<ScanResult> => scanPreparedPart(input, process.env);
