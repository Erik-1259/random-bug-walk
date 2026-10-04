// Runs the publication scanner for the public-safety and names-attribution CI jobs.
// CI logs are public, so this prints only the outcome, well-formed "<location>:<line>" lines,
// a generic reason when the scan is unavailable, and how many scanner lines it dropped.
// Exit codes: 0 clean, 1 blocked, 2 unavailable or unsupported.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isEntryPoint, runMain } from "./main.ts";

const MODES = ["public-safety", "names-attribution"] as const;
type Mode = (typeof MODES)[number];

const FULL_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** A failure whose message is a fixed, generic phrase that is safe to print. */
export class ScanFailure extends Error {
  readonly outcome: "unavailable" | "unsupported";

  constructor(outcome: "unavailable" | "unsupported", reason: string) {
    super(reason);
    this.outcome = outcome;
  }
}

export interface TextBlob {
  name: string;
  content: string;
}

export interface ScanInputs {
  range: string;
  texts: TextBlob[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Counts pattern terms the way the scanner does: non-blank lines that do not start with "#". */
export function countTerms(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#")).length;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new ScanFailure("unavailable", "event payload malformed");
  }
  return value;
}

/** Derives the revision range and, for names-attribution on pull requests, the title and body blobs. */
export function resolveInputs(
  mode: Mode,
  eventName: string,
  payload: unknown,
  commitExists: (commit: string) => boolean,
): ScanInputs {
  if (!isRecord(payload)) {
    throw new ScanFailure("unavailable", "event payload malformed");
  }
  let base: string;
  let head: string;
  const texts: TextBlob[] = [];
  if (eventName === "pull_request") {
    const pullRequest = payload.pull_request;
    if (!isRecord(pullRequest) || !isRecord(pullRequest.base) || !isRecord(pullRequest.head)) {
      throw new ScanFailure("unavailable", "event payload malformed");
    }
    base = sha(pullRequest.base.sha);
    head = sha(pullRequest.head.sha);
    if (mode === "names-attribution") {
      const { title, body } = pullRequest;
      if (typeof title !== "string" || (typeof body !== "string" && body !== null)) {
        throw new ScanFailure("unavailable", "event payload malformed");
      }
      texts.push({ name: "pr-title", content: title }, { name: "pr-body", content: body ?? "" });
    }
  } else if (eventName === "push") {
    base = sha(payload.before);
    head = sha(payload.after);
    if (ZERO_SHA.test(base) || ZERO_SHA.test(head)) {
      throw new ScanFailure("unsupported", "push without a previous commit");
    }
  } else {
    throw new ScanFailure("unsupported", "event not supported");
  }
  if (!commitExists(base) || !commitExists(head)) {
    throw new ScanFailure("unsupported", "commit not in checkout");
  }
  return { range: `${base}..${head}`, texts };
}

/** What the scan covered, so that only locations it could legitimately report are printed. */
export interface KnownLocations {
  textNames: ReadonlySet<string>;
  /** Paths added, changed or deleted by the commits in the range. */
  paths: ReadonlySet<string>;
  /** The first 12 hex characters of each commit in the range. */
  commits: ReadonlySet<string>;
}

/** Rejects text the Actions runner could read as a workflow command ("::" after trimming, or "##[" anywhere). */
function isInertInLog(location: string): boolean {
  return (
    location === location.trim() &&
    !location.startsWith("::") &&
    !location.includes("##[") &&
    !/\p{Cc}/u.test(location)
  );
}

export function isLocationLine(line: string, known: KnownLocations): boolean {
  const match = /^(.+):([1-9][0-9]*)$/.exec(line);
  const location = match?.[1];
  if (location === undefined || !isInertInLog(location)) {
    return false;
  }
  const commit = /^(?:commit|paths)-([0-9a-f]{12})$/.exec(location)?.[1];
  if (commit !== undefined) {
    return known.commits.has(commit);
  }
  return known.textNames.has(location) || known.paths.has(location);
}

export interface ScannerRun {
  status: number | null;
  signal: string | null;
  errorCode: string | undefined;
  stdout: string;
  stderr: string;
}

export interface Interpretation {
  outcome: "clean" | "blocked" | "unavailable";
  reason?: string;
  locations: string[];
  dropped: number;
}

function outputLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** Accepts only well-formed scanner results; anything else is unavailable. */
export function interpret(run: ScannerRun, known: KnownLocations): Interpretation {
  const stdoutLines = outputLines(run.stdout);
  const stderrCount = outputLines(run.stderr).length;
  const unavailable = (reason: string): Interpretation => ({
    outcome: "unavailable",
    reason,
    locations: [],
    dropped: stdoutLines.length + stderrCount,
  });
  if (run.errorCode === "ETIMEDOUT") {
    return unavailable("scanner timed out");
  }
  if (run.errorCode !== undefined) {
    return unavailable("scanner failed to run");
  }
  if (run.signal !== null) {
    return unavailable("scanner crashed");
  }
  const [first, ...rest] = stdoutLines;
  if (run.status === 0 && first === "clean" && rest.length === 0) {
    return { outcome: "clean", locations: [], dropped: stderrCount };
  }
  if (run.status === 1 && first === "blocked") {
    const locations = rest.filter((line) => isLocationLine(line, known));
    if (locations.length > 0) {
      return { outcome: "blocked", locations, dropped: rest.length - locations.length + stderrCount };
    }
  }
  if (run.status === 2 && first === "unavailable") {
    return unavailable("scanner reported unavailable");
  }
  if (run.status !== 0 && run.status !== 1 && run.status !== 2) {
    return unavailable("unexpected exit code");
  }
  return unavailable("malformed scanner output");
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function commitExists(commit: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" }).status === 0;
}

function gitOutput(args: readonly string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new ScanFailure("unavailable", "range not readable");
  }
  return result.stdout;
}

/** Lists the paths and commits of the range from the content checkout. */
function rangeLocations(range: string, textNames: ReadonlySet<string>): KnownLocations {
  const paths = gitOutput(["log", "--format=", "--name-only", "--no-renames", "-z", range])
    .split("\0")
    .map((path) => path.replace(/^\n+/, ""))
    .filter((path) => path !== "");
  const commits = gitOutput(["rev-list", range])
    .split("\n")
    .filter((commit) => commit !== "")
    .map((commit) => commit.slice(0, 12));
  return { textNames, paths: new Set(paths), commits: new Set(commits) };
}

function readPayload(): { eventName: string; payload: unknown } {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined || eventPath === "") {
    throw new ScanFailure("unavailable", "event payload unavailable");
  }
  try {
    return { eventName, payload: JSON.parse(readFileSync(eventPath, "utf8")) };
  } catch {
    throw new ScanFailure("unavailable", "event payload unavailable");
  }
}

function patternListUsable(path: string): boolean {
  try {
    return countTerms(readFileSync(path, "utf8")) > 0;
  } catch {
    return false;
  }
}

interface Options {
  mode: Mode;
  scanner: string;
  patterns: string;
  gitleaks: string | undefined;
  repository: string | undefined;
  timeoutMs: number;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      scanner: { type: "string" },
      patterns: { type: "string" },
      gitleaks: { type: "string" },
      repository: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const mode = MODES.find((candidate) => candidate === values.mode);
  const timeoutMs = values["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(values["timeout-ms"]);
  if (
    mode === undefined ||
    values.scanner === undefined ||
    values.patterns === undefined ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    (values.repository !== undefined && !REPOSITORY.test(values.repository))
  ) {
    throw new Error("usage: scan.ts --mode <public-safety|names-attribution> --scanner <cli.ts> --patterns <file> [--gitleaks <command>] [--repository <owner>/<repo>] [--timeout-ms <ms>]");
  }
  return { mode, scanner: values.scanner, patterns: values.patterns, gitleaks: values.gitleaks, repository: values.repository, timeoutMs };
}

function runScanner(options: Options, inputs: ScanInputs, known: KnownLocations): Interpretation {
  const textDir = mkdtempSync(join(tmpdir(), "rbw-scan-"));
  try {
    const args = [options.scanner, "scan", "--patterns", options.patterns];
    if (options.repository !== undefined) {
      args.push("--repository", options.repository);
    }
    if (options.gitleaks !== undefined) {
      args.push("--gitleaks", options.gitleaks);
    }
    args.push("--range", inputs.range);
    for (const text of inputs.texts) {
      const file = join(textDir, text.name);
      writeFileSync(file, text.content, { mode: 0o600 });
      args.push("--text", `${text.name}=${file}`);
    }
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const run: ScannerRun = {
      status: result.status,
      signal: result.signal,
      errorCode: errorCode(result.error),
      stdout: result.stdout,
      stderr: result.stderr,
    };
    return interpret(run, known);
  } finally {
    rmSync(textDir, { recursive: true, force: true });
  }
}

function main(): number {
  const options = parseOptions();
  const report = (line: string): void => {
    process.stdout.write(`${options.mode}: ${line}\n`);
  };
  try {
    if (!patternListUsable(options.patterns)) {
      throw new ScanFailure("unavailable", "pattern list unavailable");
    }
    if (!existsSync(options.scanner)) {
      throw new ScanFailure("unavailable", "scanner missing");
    }
    const { eventName, payload } = readPayload();
    const inputs = resolveInputs(options.mode, eventName, payload, commitExists);
    const known = rangeLocations(inputs.range, new Set(inputs.texts.map((text) => text.name)));
    const result = runScanner(options, inputs, known);
    report(result.reason === undefined ? result.outcome : `${result.outcome} (${result.reason})`);
    for (const location of result.locations) {
      process.stdout.write(`${location}\n`);
    }
    process.stdout.write(`dropped ${String(result.dropped)} scanner output lines\n`);
    return result.outcome === "clean" ? 0 : result.outcome === "blocked" ? 1 : 2;
  } catch (error) {
    if (error instanceof ScanFailure) {
      report(`${error.outcome} (${error.message})`);
      return 2;
    }
    throw error;
  }
}

if (isEntryPoint(import.meta)) {
  runMain("scan", main, { genericErrors: true });
}
