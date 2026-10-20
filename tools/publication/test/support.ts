import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

export const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const cliPath = join(packageDir, "src", "cli.ts");
export const helperPath = join(packageDir, "src", "helper.ts");
export const wrapperPath = join(packageDir, "bin", "rbw-publish");
export const hookPath = join(packageDir, "hooks", "pre-push");

export const PINNED_GITLEAKS_VERSION = "8.30.1";
export const STUB_LEAK_MARKER = ["SYNTHETIC", "STUB", "LEAK"].join("-");

/**
 * A stub leakPattern for `marker` (letters, "-" and "." only) that, like many gitleaks rules,
 * needs a word boundary before the secret and a space, quote, ";" or line end after it. With
 * `before` set to "space", it needs a space or the line start before the secret instead, like
 * gitleaks' azure-ad-client-secret rule.
 */
export function boundedLeakPattern(marker: string, before: "boundary" | "space" = "boundary"): string {
  const left = before === "space" ? String.raw`(?:^|\s)` : String.raw`(?:^|\W)`;
  return left + marker.replaceAll(".", String.raw`\.`) + String.raw`(?=[\s'"\x60;]|$)`;
}

// Attribution forms are assembled at runtime so this file passes its own scan.
export const forms = {
  coauthored: ["Co", "authored", "by"].join("-"),
  signedOff: ["Signed", "off", "by"].join("-"),
  reviewedTrailer: ["Reviewed", "by"].join("-"),
  acked: ["Acked", "by"].join("-"),
  helped: ["Helped", "by"].join("-"),
  suggested: ["Suggested", "by"].join("-"),
  generatedWith: ["Generated", "with"].join(" "),
  generatedBy: ["Generated", "by"].join(" "),
  robot: String.fromCodePoint(0x1f916),
  editedNote: ["edited", "by"].join(" "),
  reviewedNote: ["reviewed", "by"].join(" "),
  requestedNote: ["requested", "by"].join(" "),
  approvedNote: ["approved", "by"].join(" "),
  behalfNote: ["on", "behalf", "of"].join(" "),
  authorTag: "@" + "author",
};

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = "rbw-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

export const gitIdentityEnv: Record<string, string> = {
  GIT_AUTHOR_NAME: "synthetic-author",
  GIT_AUTHOR_EMAIL: "synthetic-author@example.invalid",
  GIT_COMMITTER_NAME: "synthetic-author",
  GIT_COMMITTER_EMAIL: "synthetic-author@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...gitIdentityEnv, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

export function initBare(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--bare", "-b", "main"]);
  return dir;
}

export function writeFile(path: string, content: string | Uint8Array, mode?: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

/** Writes files (null deletes), stages everything and commits with the exact message; returns the SHA. */
export function commit(
  repo: string,
  files: Record<string, string | Uint8Array | null>,
  message: string,
  extraEnv: Record<string, string> = {},
): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(repo, path), { force: true });
    else writeFile(join(repo, path), content);
  }
  git(repo, ["add", "-A"]);
  const messageFile = join(tempDir(), "message.txt");
  writeFileSync(messageFile, message);
  git(repo, ["commit", "-q", "--allow-empty", "--no-verify", "--cleanup=verbatim", "-F", messageFile], extraEnv);
  return git(repo, ["rev-parse", "HEAD"]);
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? packageDir,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 50_000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

/** Environment for child processes without inherited GIT_ or RBW_ variables. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("GIT_") || key.startsWith("RBW_") || key.startsWith("GH_")) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export function runCli(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  return run(process.execPath, [cliPath, ...args], { cwd: options.cwd, env: options.env ?? cleanEnv() });
}

export function writePatterns(dir: string, content: string | Uint8Array): string {
  return writeFile(join(dir, "patterns.txt"), content);
}

export interface StubGitleaksOptions {
  version?: string;
  exitStatus?: number;
  report?: "normal" | "unparseable" | "missing";
  /** Bytes written to a file when gitleaks runs, to change inputs mid-scan. */
  onRun?: { path: string; content: string };
  /** Skips files whose path matches this expression, like gitleaks' global path allowlist. */
  skipPaths?: string;
  /** Adds a Docker-style `{dir}:{dir}` argument that must arrive substituted inside the token. */
  mountArgument?: boolean;
  /** When gitleaks runs, moves this directory to `<path>-replaced` and creates a new one in its place. */
  replaceDirectory?: string;
  /** Never exits from a `dir` scan. */
  hang?: boolean;
  /** Kills the calling process with SIGKILL from a `dir` scan. */
  killParent?: boolean;
  /**
   * Reports a line only when this expression matches it, like a gitleaks rule that needs a
   * boundary after the secret. By default every line containing STUB_LEAK_MARKER is reported.
   */
  leakPattern?: string;
  /**
   * Matches this expression against each chunk's whole text instead of line by line, like a
   * gitleaks rule whose match can run across line breaks: matches do not overlap, and each is
   * reported at the line where it starts. Replaces the line-by-line check.
   */
  spanPattern?: string;
  /** Skips a file whose content starts with one of these, like gitleaks' check for binary file types. */
  binaryPrefixes?: string[];
  /**
   * Reads each file in chunks of `size` characters, like gitleaks, extending a chunk by up to
   * `peek` characters so that it ends at an empty line; a line split between two chunks is
   * matched as two parts.
   */
  chunk?: { size: number; peek: number };
}

export interface StubGitleaks {
  command: string;
  violationMarker: string;
  callsLog: string;
  /** One JSON line per file a `dir` scan reads: its path inside the scanned directory, its size and whether it starts like a path list. */
  filesLog: string;
}

/**
 * Writes a Node script that imitates gitleaks: `version` prints a version and `dir`
 * reports a finding for each line containing STUB_LEAK_MARKER, or matching the
 * leakPattern option. It records a marker file when `{dir}` was not substituted or a
 * path argument lies outside it.
 */
export function writeStubGitleaks(dir: string, options: StubGitleaksOptions = {}): StubGitleaks {
  const scriptPath = join(dir, "stub-gitleaks.mjs");
  const violationMarker = join(dir, "stub-gitleaks-violation");
  const callsLog = join(dir, "stub-gitleaks-calls.jsonl");
  const filesLog = join(dir, "stub-gitleaks-files.jsonl");
  const settings = {
    version: options.version ?? PINNED_GITLEAKS_VERSION,
    exitStatus: options.exitStatus ?? null,
    report: options.report ?? "normal",
    onRun: options.onRun ?? null,
    skipPaths: options.skipPaths ?? null,
    mountArgument: options.mountArgument ?? false,
    replaceDirectory: options.replaceDirectory ?? null,
    hang: options.hang ?? false,
    killParent: options.killParent ?? false,
    leakPattern: options.leakPattern ?? null,
    spanPattern: options.spanPattern ?? null,
    binaryPrefixes: options.binaryPrefixes ?? [],
    chunk: options.chunk ?? null,
    violationMarker,
    callsLog,
    filesLog,
    leakMarker: STUB_LEAK_MARKER,
  };
  const script = `
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
const settings = ${JSON.stringify(settings)};
const args = process.argv.slice(2);
appendFileSync(settings.callsLog, JSON.stringify(args) + "\\n");
const violation = (why) => { writeFileSync(settings.violationMarker, why); process.exit(9); };
if (args[0] !== "--stub-dir") violation("missing --stub-dir");
const stubDir = args[1];
if (stubDir === "{dir}" || !isAbsolute(stubDir) || !statSync(stubDir).isDirectory()) violation("dir not substituted");
let rest = args.slice(2);
if (settings.mountArgument) {
  if (rest[0] !== "--stub-mount" || rest[1] !== stubDir + ":" + stubDir) violation("mount argument not substituted");
  rest = rest.slice(2);
}
if (rest[0] === "version") { process.stdout.write(settings.version + "\\n"); process.exit(0); }
if (rest[0] !== "dir") violation("unexpected subcommand");
const flagValue = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
const target = rest[1];
const pathArgs = [target, flagValue("--report-path"), flagValue("--config"), flagValue("--gitleaks-ignore-path")];
for (const p of pathArgs) {
  if (p === undefined || !resolve(p).startsWith(stubDir + "/")) violation("path outside dir");
}
if (!rest.includes("--ignore-gitleaks-allow")) violation("allow comments not ignored");
if (settings.onRun) writeFileSync(settings.onRun.path, settings.onRun.content);
if (settings.replaceDirectory) {
  renameSync(settings.replaceDirectory, settings.replaceDirectory + "-replaced");
  mkdirSync(settings.replaceDirectory);
}
if (settings.hang) await new Promise(() => setInterval(() => undefined, 1000));
if (settings.killParent) process.kill(process.ppid, "SIGKILL");
const findings = [];
const leakPattern = settings.leakPattern === null ? null : new RegExp(settings.leakPattern);
const leaks = (line) => (leakPattern === null ? line.includes(settings.leakMarker) : leakPattern.test(line));
const spanPattern = settings.spanPattern === null ? null : new RegExp(settings.spanPattern, "g");
const chunks = (text) => {
  if (settings.chunk === null) return [text];
  const parts = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + settings.chunk.size, text.length);
    const limit = Math.min(end + settings.chunk.peek, text.length);
    while (end < limit && !(text[end - 1] === "\\n" && text[end - 2] === "\\n")) end += 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
};
const walk = (d) => {
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.isFile() && !(settings.skipPaths !== null && new RegExp(settings.skipPaths).test(p))) {
      const text = readFileSync(p, "latin1");
      appendFileSync(settings.filesLog, JSON.stringify({ path: relative(target, p), size: st.size, pathList: text.startsWith("path list\\n\\n") }) + "\\n");
      if (settings.binaryPrefixes.some((prefix) => text.startsWith(prefix))) continue;
      let first = 1;
      for (const part of chunks(text)) {
        const lines = part.split("\\n");
        const report = (line) => findings.push({ RuleID: "stub", File: p, StartLine: line, Secret: "REDACTED", Match: "REDACTED" });
        if (spanPattern !== null) {
          for (const match of part.matchAll(spanPattern)) report(first + part.slice(0, match.index).split("\\n").length - 1);
        } else {
          lines.forEach((line, i) => {
            if (leaks(line)) report(first + i);
          });
        }
        first += lines.length - 1;
      }
    }
  }
};
walk(target);
const reportPath = flagValue("--report-path");
if (settings.report === "unparseable") writeFileSync(reportPath, "{not json");
else if (settings.report === "normal") writeFileSync(reportPath, JSON.stringify(findings));
if (settings.exitStatus !== null) process.exit(settings.exitStatus);
process.stdout.write("stub raw output " + settings.leakMarker + "\\n");
process.exit(findings.length > 0 ? Number(flagValue("--exit-code")) : 0);
`;
  writeFile(scriptPath, script);
  const mount = settings.mountArgument ? " --stub-mount {dir}:{dir}" : "";
  return { command: `${process.execPath} ${scriptPath} --stub-dir {dir}${mount}`, violationMarker, callsLog, filesLog };
}

export function readJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export function outputLines(result: RunResult): string[] {
  return result.stdout.split("\n").filter((line) => line.length > 0);
}
