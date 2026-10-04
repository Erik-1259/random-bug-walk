import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanEnv,
  gitIdentityEnv,
  commit,
  git,
  helperPath,
  initBare,
  initRepo,
  readJsonLines,
  run,
  tempDir,
  writeFile,
  writeStubGitleaks,
  type RunResult,
  type StubGitleaks,
  type StubGitleaksOptions,
} from "./support.ts";

export const HELPER_TERM = "synthetic-helper-term";
export const OWNER = "synthetic-owner";
export const REPOSITORY = `${OWNER}/synthetic-repo`;
export const BRANCH = "synthetic/feature";
export const WORKTREE_ID = "synthetic-worktree";

export interface StubPullRequest {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  state: "OPEN" | "CLOSED";
  isDraft: boolean;
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string };
  comments: { body: string }[];
}

export interface StubGhOptions {
  pullRequests?: StubPullRequest[];
  /** Kill the calling helper with SIGKILL the first time a create or comment call is made. */
  kill?: "none" | "after-post" | "before-post";
  /** Exit non-zero after a create or comment call. */
  fail?: "none" | "after-post" | "without-post";
  /** Exit non-zero for every call. */
  broken?: boolean;
  /** Never exit from a `pr list` call. */
  hang?: boolean;
}

export interface StubGh {
  command: string;
  calls(): { args: string[]; bodyFile: string | null }[];
  state(): { pullRequests: StubPullRequest[] };
}

export function writeStubGh(dir: string, options: StubGhOptions = {}): StubGh {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "stub-gh.mjs");
  const stateFile = join(dir, "stub-gh-state.json");
  const callsFile = join(dir, "stub-gh-calls.jsonl");
  const killMarker = join(dir, "stub-gh-killed");
  writeFileSync(stateFile, JSON.stringify({ pullRequests: options.pullRequests ?? [] }));
  const settings = {
    stateFile,
    callsFile,
    killMarker,
    kill: options.kill ?? "none",
    fail: options.fail ?? "none",
    broken: options.broken ?? false,
    hang: options.hang ?? false,
  };
  const script = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const settings = ${JSON.stringify(settings)};
const args = process.argv.slice(2);
const flag = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
  return undefined;
};
const bodyFile = flag("--body-file");
const body = bodyFile === undefined ? null : readFileSync(bodyFile).toString("base64");
appendFileSync(settings.callsFile, JSON.stringify({ args, bodyFile: body }) + "\\n");
if (settings.broken) process.exit(1);
if (settings.hang && args[0] === "pr" && args[1] === "list") await new Promise(() => setInterval(() => undefined, 1000));
const state = JSON.parse(readFileSync(settings.stateFile, "utf8"));
const save = () => writeFileSync(settings.stateFile, JSON.stringify(state));
const repo = flag("--repo");
const posting = args[0] === "pr" && (args[1] === "create" || args[1] === "comment");
const maybeKill = (when) => {
  if (posting && settings.kill === when && !existsSync(settings.killMarker)) {
    writeFileSync(settings.killMarker, "1");
    process.kill(process.ppid, "SIGKILL");
    process.exit(1);
  }
};
maybeKill("before-post");
if (posting && settings.fail === "without-post") process.exit(1);
if (args[0] === "pr" && args[1] === "list") {
  const head = flag("--head");
  const out = state.pullRequests
    .filter((pr) => pr.headRefName === head && pr.state === "OPEN")
    .map((pr) => ({ number: pr.number, title: pr.title, body: pr.body, isCrossRepository: pr.isCrossRepository, headRepositoryOwner: pr.headRepositoryOwner }));
  process.stdout.write(JSON.stringify(out));
} else if (args[0] === "pr" && args[1] === "create") {
  const number = 100 + state.pullRequests.length;
  state.pullRequests.push({
    number, title: flag("--title").trim(), body: Buffer.from(body, "base64").toString("utf8").replace(/\\n/g, "\\r\\n"),
    headRefName: flag("--head"), state: "OPEN", isDraft: args.includes("--draft"), isCrossRepository: false,
    headRepositoryOwner: { login: repo.split("/")[0].toUpperCase() }, comments: [],
  });
  save();
  process.stdout.write("https://github.com/" + repo + "/pull/" + number + "\\n");
} else if (args[0] === "pr" && args[1] === "comment") {
  const pr = state.pullRequests.find((p) => String(p.number) === args[2]);
  pr.comments.push({ body: Buffer.from(body, "base64").toString("utf8").replace(/\\n/g, "\\r\\n") });
  save();
  process.stdout.write("https://github.com/" + repo + "/pull/" + args[2] + "#issuecomment-1\\n");
} else if (args[0] === "pr" && args[1] === "view") {
  const pr = state.pullRequests.find((p) => String(p.number) === args[2]);
  process.stdout.write(JSON.stringify({ comments: pr ? pr.comments : [] }));
} else {
  process.exit(4);
}
maybeKill("after-post");
if (posting && settings.fail === "after-post") process.exit(1);
`;
  writeFile(scriptPath, script);
  return {
    command: `${process.execPath} ${scriptPath}`,
    calls: () => readJsonLines(callsFile) as { args: string[]; bodyFile: string | null }[],
    state: () => JSON.parse(readFileSync(stateFile, "utf8")) as { pullRequests: StubPullRequest[] },
  };
}

export interface RegistryEntry {
  path: string;
  remote: string;
  repository?: string;
  branch: string;
  approvedBase: string;
  identity: { name: string; email: string };
  token: string;
}

/** The identity every fixture commit carries; see gitIdentityEnv. */
export const IDENTITY = { name: gitIdentityEnv.GIT_AUTHOR_NAME ?? "", email: gitIdentityEnv.GIT_AUTHOR_EMAIL ?? "" };

export interface Request {
  version?: unknown;
  requestId?: unknown;
  worktreeId?: unknown;
  operation?: unknown;
  sha?: unknown;
  title?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

let requestCounter = 0;
export function newRequestId(): string {
  requestCounter += 1;
  return `req-${String(Date.now())}-${String(process.pid)}-${String(requestCounter)}`;
}

export class HelperFixture {
  readonly root: string;
  readonly inbox: string;
  readonly state: string;
  readonly registryPath: string;
  readonly patterns: string;
  readonly workingCopy: string;
  readonly remote: string;
  readonly approvedBase: string;
  readonly token = randomBytes(32).toString("hex");
  gitleaks: StubGitleaks;
  gh: StubGh;
  entry: RegistryEntry;

  constructor(options: { seedRemoteMain?: boolean; gitleaks?: StubGitleaksOptions; gh?: StubGhOptions; baseFiles?: Record<string, string> } = {}) {
    this.root = tempDir("rbw-helper-");
    this.inbox = join(this.root, "inbox");
    this.state = join(this.root, "state");
    this.registryPath = join(this.root, "host", "registry.json");
    this.patterns = writeFile(join(this.root, "host", "patterns.txt"), `# synthetic\n${HELPER_TERM}\n`);
    mkdirSync(this.inbox, { recursive: true });
    this.workingCopy = initRepo(join(this.root, "clone"));
    this.approvedBase = commit(this.workingCopy, options.baseFiles ?? { "README.md": "synthetic project\n" }, "chore: base\n");
    git(this.workingCopy, ["config", "rbw.worktreeId", WORKTREE_ID]);
    git(this.workingCopy, ["config", "rbw.worktreeToken", this.token]);
    this.remote = initBare(join(this.root, "remote.git"));
    if (options.seedRemoteMain ?? true) git(this.workingCopy, ["push", "-q", this.remote, `${this.approvedBase}:refs/heads/main`]);
    this.gitleaks = writeStubGitleaks(join(this.root, "host"), options.gitleaks);
    this.gh = writeStubGh(join(this.root, "host", "gh"), options.gh);
    this.entry = {
      path: this.workingCopy,
      remote: this.remote,
      repository: REPOSITORY,
      branch: BRANCH,
      approvedBase: this.approvedBase,
      identity: IDENTITY,
      token: this.token,
    };
    this.writeRegistry();
  }

  writeRegistry(worktrees: Record<string, unknown> = { [WORKTREE_ID]: this.entry }): void {
    writeFile(this.registryPath, JSON.stringify({ version: 1, worktrees }, null, 2));
  }

  get publication(): string {
    return join(this.inbox, "publication");
  }

  ensureLayout(): void {
    for (const dir of ["requests", "responses"]) mkdirSync(join(this.publication, dir), { recursive: true });
  }

  /** Where the helper keeps a claimed request: its private state directory. */
  claimedPath(requestId: string): string {
    return join(this.state, "claimed", `${requestId}.json`);
  }

  commitCandidate(files: Record<string, string | null>, message = "feat: synthetic change\n"): string {
    return commit(this.workingCopy, files, message);
  }

  writeRawRequest(name: string, content: string | Uint8Array): void {
    this.ensureLayout();
    writeFile(join(this.publication, "requests", name), content);
  }

  writeRequest(fields: Request, requestId = newRequestId()): string {
    const request = { version: 1, requestId, worktreeId: WORKTREE_ID, token: this.token, ...fields };
    this.writeRawRequest(`${requestId}.json`, JSON.stringify(request));
    return requestId;
  }

  pushRequest(sha: string): string {
    return this.writeRequest({ operation: "push", sha });
  }

  helperArgs(extra: string[] = []): string[] {
    return [
      "--inbox", this.inbox,
      "--registry", this.registryPath,
      "--state", this.state,
      "--patterns", this.patterns,
      "--gitleaks", this.gitleaks.command,
      "--gh", this.gh.command,
      ...extra,
    ];
  }

  runOnce(options: { extra?: string[]; env?: Record<string, string> } = {}): Promise<RunResult> {
    return run(process.execPath, [helperPath, "once", ...this.helperArgs(options.extra)], {
      cwd: this.root,
      env: cleanEnv(options.env),
    });
  }

  startServe(options: { extra?: string[]; env?: Record<string, string> } = {}): ChildProcess {
    return spawn(process.execPath, [helperPath, "serve", ...this.helperArgs(["--poll-interval-ms", "100", ...(options.extra ?? [])])], {
      cwd: this.root,
      env: cleanEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  responsePath(requestId: string): string {
    return join(this.publication, "responses", `${requestId}.json`);
  }

  readResponse(requestId: string): Record<string, unknown> | null {
    const path = this.responsePath(requestId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  }

  responses(): string[] {
    const dir = join(this.publication, "responses");
    return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : [];
  }

  log(): string {
    const path = join(this.state, "helper.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  logLine(requestId: string): string {
    return this.log().split("\n").filter((line) => line.includes(`request=${requestId} `)).join("\n");
  }

  remoteHead(branch = BRANCH): string | null {
    const out = git(this.root, ["ls-remote", this.remote, `refs/heads/${branch}`]);
    return out === "" ? null : (out.split("\t")[0] ?? null);
  }

  remoteHasObject(sha: string): boolean {
    return spawnSync("git", ["--git-dir", this.remote, "cat-file", "-e", `${sha}^{commit}`]).status === 0;
  }
}

const RESPONSE_KEYS = new Set(["version", "requestId", "requestedSha", "outcome", "publishedSha", "locations"]);

/** Checks the response carries only protocol fields, with publishedSha and locations where allowed. */
export function expectResponse(
  response: Record<string, unknown> | null,
  expected: { requestId: string; requestedSha: string | null; outcome: string; locations?: string[] },
): void {
  if (response === null) throw new Error("expected a response");
  for (const key of Object.keys(response)) if (!RESPONSE_KEYS.has(key)) throw new Error(`unexpected response key ${key}`);
  const wanted: Record<string, unknown> = {
    version: 1,
    requestId: expected.requestId,
    requestedSha: expected.requestedSha,
    outcome: expected.outcome,
  };
  if (expected.outcome === "published") wanted.publishedSha = expected.requestedSha;
  if (expected.outcome === "blocked") wanted.locations = expected.locations ?? [];
  if (JSON.stringify(sortKeys(response)) !== JSON.stringify(sortKeys(wanted))) {
    throw new Error(`response mismatch: ${JSON.stringify(response)} != ${JSON.stringify(wanted)}`);
  }
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (condition()) resolve();
      else if (Date.now() - start > timeoutMs) reject(new Error("timed out waiting for condition"));
      else setTimeout(tick, 50);
    };
    tick();
  });
}

export function waitForExit(child: ChildProcess, timeoutMs = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("process did not exit"));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
