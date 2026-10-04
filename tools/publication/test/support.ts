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
}

export interface StubGitleaks {
  command: string;
  violationMarker: string;
  callsLog: string;
}

/**
 * Writes a Node script that imitates gitleaks: `version` prints a version and `dir`
 * reports a finding for each line containing STUB_LEAK_MARKER. It records a marker
 * file when `{dir}` was not substituted or a path argument lies outside it.
 */
export function writeStubGitleaks(dir: string, options: StubGitleaksOptions = {}): StubGitleaks {
  const scriptPath = join(dir, "stub-gitleaks.mjs");
  const violationMarker = join(dir, "stub-gitleaks-violation");
  const callsLog = join(dir, "stub-gitleaks-calls.jsonl");
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
    violationMarker,
    callsLog,
    leakMarker: STUB_LEAK_MARKER,
  };
  const script = `
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
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
const walk = (d) => {
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.isFile() && !(settings.skipPaths !== null && new RegExp(settings.skipPaths).test(p))) {
      const lines = readFileSync(p, "latin1").split("\\n");
      lines.forEach((line, i) => {
        if (line.includes(settings.leakMarker)) findings.push({ RuleID: "stub", File: p, StartLine: i + 1, Secret: "REDACTED", Match: "REDACTED" });
      });
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
  return { command: `${process.execPath} ${scriptPath} --stub-dir {dir}${mount}`, violationMarker, callsLog };
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
