import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect } from "vitest";
import { buildPolicy } from "@rbw/schema";
import type { RootRun, RootRunOutcome, RootRunStatus, RunManifest } from "@rbw/schema";
import { runCli, type CliDeps, type CliResult } from "../src/cli.ts";
import { runProcess, type ProcessCall, type ProcessRunner } from "../src/process.ts";
import type { BlobClient, BlobPutOptions } from "../src/store.ts";

export const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repositoryRoot = join(packageDir, "..", "..");
export const scannerCli = join(repositoryRoot, "tools", "publication", "src", "cli.ts");

export const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
export const ROOT_ID = "00000000-0000-4000-8000-000000000101";
export const CHILD_ID = "00000000-0000-4000-8000-000000000201";
export const OTHER_ROOT_ID = "00000000-0000-4000-8000-000000000102";
export const REPOSITORY_URL = "https://example.invalid/synthetic-owner/synthetic-results";
export const BASE_URI = "https://example.invalid/synthetic-store/test-prefix/";
export const THRESHOLD = 1024;
export const GITHUB_REPOSITORY = "https://github.com/synthetic-owner/synthetic-results";
export const SSH_REMOTE = "git@github.com:synthetic-owner/synthetic-results.git";

// Synthetic values are assembled at runtime so no source line holds them as a literal.
export const FORBIDDEN_TERM = ["synthetic", "forbidden", "term"].join("-");
export const LISTED_VALUE = ["synthetic", "listed", "value", "one"].join("-");
export const LISTED_PROVIDER_VALUE = ["synthetic", "provider", "id"].join("-");
export const HEADER_SECRET = ["synthetic", "header", "value"].join("-");
export const COOKIE_SECRET = ["synthetic", "cookie", "value"].join("-");

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    chmodTree(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function chmodTree(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    return;
  }
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) chmodTree(path);
  }
}

export function tempDir(prefix = "rbw-publisher-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

export function write(path: string, content: string | Uint8Array): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "synthetic-author",
  GIT_AUTHOR_EMAIL: "synthetic-author@example.invalid",
  GIT_COMMITTER_NAME: "synthetic-author",
  GIT_COMMITTER_EMAIL: "synthetic-author@example.invalid",
};

export function git(cwd: string, args: string[], input?: string | Uint8Array): string {
  return execFileSync("git", args, { cwd, env: gitEnv, input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").trim();
}

export function gitBytes(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, env: gitEnv, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

export function commitCount(remote: string, branch = "main"): number {
  try {
    return Number(git(remote, ["rev-list", "--count", `refs/heads/${branch}`]));
  } catch {
    return 0;
  }
}

export function headCommit(remote: string, branch = "main"): string | null {
  try {
    return git(remote, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  } catch {
    return null;
  }
}

/** Files below the store's sha256/ prefix, keyed by name. */
export function storeObjects(store: string): string[] {
  const dir = join(store, "sha256");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(dir, path));
    }
  };
  walk(dir);
  return found;
}

/** Every byte under a directory, concatenated, for containment checks. */
export function allBytes(dir: string): Buffer {
  return Buffer.concat(listFiles(dir).map((path) => readFileSync(join(dir, path))));
}

/** Every object in a bare repository, for containment checks. */
export function allRepositoryBytes(remote: string): Buffer {
  if (headCommit(remote) === null) return Buffer.alloc(0);
  return gitBytes(remote, ["cat-file", "--batch-all-objects", "--batch"]);
}

/**
 * A gitleaks stand-in for hermetic tests: it reports the version C2's CLI pins and no
 * findings. The version is read from `cli.ts gitleaks-version`, never written here.
 */
export function writeGitleaksStub(dir: string): string {
  const version = execFileSync(process.execPath, [scannerCli, "gitleaks-version"], { encoding: "utf8" }).trim();
  const script = join(dir, "gitleaks-stub.mjs");
  write(
    script,
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "version") { process.stdout.write(${JSON.stringify(version)} + "\\n"); process.exit(0); }
const report = args[args.indexOf("--report-path") + 1];
writeFileSync(report, "[]");
process.exit(0);
`,
  );
  return `${process.execPath} ${script}`;
}

/** A scanner stand-in for unavailability tests: it ignores its arguments. */
export function writeFakeScanner(dir: string, behaviour: "exit2" | "exit7" | "sleep" | "signal" | "lie"): string {
  const script = join(dir, `fake-scanner-${behaviour}.mjs`);
  const bodies = {
    exit2: 'process.stdout.write("unavailable\\n"); process.exit(2);',
    exit7: 'process.stdout.write("clean\\n"); process.exit(7);',
    sleep: "setTimeout(() => process.exit(0), 30000);",
    signal: 'process.kill(process.pid, "SIGKILL");',
    lie: 'process.stdout.write("blocked\\n"); process.exit(0);',
  };
  write(script, `${bodies[behaviour]}\n`);
  return `${process.execPath} ${script}`;
}

export interface World {
  dir: string;
  policyFile: string;
  policySha256: string;
  staging: string;
  state: string;
  remote: string;
  store: string;
  patterns: string;
  values: string;
  gitleaks: string;
}

export function createWorld(): World {
  const dir = tempDir();
  const built = buildPolicy({
    projectId: PROJECT_ID,
    outputRepository: REPOSITORY_URL,
    publicArtifactBaseUri: BASE_URI,
    policyVersion: 1,
  });
  const policyFile = write(join(dir, "private", "policy.json"), built.bytes);
  const remote = join(dir, "remote.git");
  mkdirSync(remote);
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  const store = join(dir, "store");
  mkdirSync(store);
  const patterns = write(join(dir, "private", "patterns.txt"), `# synthetic pattern list\n\n${FORBIDDEN_TERM}\n`);
  const values = write(
    join(dir, "private", "redaction-values.txt"),
    `# synthetic redaction values\n\ncredential\t${LISTED_VALUE}\nprovider_identifier\t${LISTED_PROVIDER_VALUE}\n`,
  );
  return {
    dir,
    policyFile,
    policySha256: built.sha256,
    staging: join(dir, "staging"),
    state: join(dir, "private", "state"),
    remote,
    store,
    patterns,
    values,
    gitleaks: writeGitleaksStub(dir),
  };
}

export function writeRootRun(
  world: World,
  options: { root?: string; status?: RootRunStatus; outcome?: RootRunOutcome | null; children?: string[]; name?: string } = {},
): string {
  const status = options.status ?? "terminal";
  const root: RootRun = {
    schema_version: 1,
    project_id: PROJECT_ID,
    root_execution_id: options.root ?? ROOT_ID,
    project_policy_sha256: world.policySha256,
    kind: "factory",
    declared_stages: ["prepare", "plant_bug", "judge_01"],
    child_execution_ids: options.children ?? [CHILD_ID],
    status,
    outcome: options.outcome === undefined ? (status === "terminal" ? "completed" : null) : options.outcome,
  };
  return write(join(world.dir, "private", `${options.name ?? "root-run"}.json`), JSON.stringify(root));
}

export const AGENT_LOG = `logs/${CHILD_ID}/planted-01/agent.log`;
export const BIG_FILE = `results/${CHILD_ID}/planted-01/big.bin`;
export const RUN_LOG = "logs/run.log";

/** Bytes of the large staged file: above THRESHOLD, no redactable content. */
export function bigFileBytes(seed = "a"): Buffer {
  return Buffer.from(seed.repeat(1) + "0123456789abcdef\n".repeat(200));
}

export const RUN_LOG_BYTES = Buffer.from("first line  \r\nsecond line\t\r\nthird line with trailing spaces   \r\n");

export function agentLogBytes(): Buffer {
  return Buffer.from(
    [
      "start\n",
      `Authorization: Bearer ${HEADER_SECRET}\r\n`,
      `> cookie: session=${COOKIE_SECRET}\n`,
      `token ${LISTED_VALUE} end   \n`,
      'json {"authorization": "kept-for-the-values-rule"}\n',
      "Authorization:   \n",
      "done",
    ].join(""),
  );
}

export interface StageOptions {
  root?: string;
  child?: string;
  report?: boolean;
  extra?: Record<string, string | Uint8Array>;
  omissions?: unknown;
  big?: Buffer;
}

export function defaultOmissions(child = CHILD_ID): unknown {
  return {
    schema_version: 1,
    entries: [
      { outcome: "not_produced", path: `results/${child}/planted-01/score.json`, execution_id: child, trial_id: "planted-01", reason: "stage_failed" },
      { outcome: "withheld_private", execution_id: child, trial_id: "planted-01", reason: "private_material" },
    ],
    redactions: [{ path: `logs/${child}/planted-01/agent.log`, category: "credential", count: 1 }],
  };
}

/** Writes a synthetic staged run: one child, one trial, one large file, one not_produced and one withheld entry. */
export function stage(dir: string, options: StageOptions = {}): void {
  const child = options.child ?? CHILD_ID;
  if (options.report !== false) write(join(dir, "report.md"), "# Synthetic report\n\nNothing real here.\n");
  write(join(dir, "inputs", "task.md"), "Synthetic task description.\n");
  write(join(dir, "generated", child, "planted-01", "fix.patch"), "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n");
  write(join(dir, RUN_LOG), RUN_LOG_BYTES);
  write(join(dir, "logs", child, "planted-01", "agent.log"), agentLogBytes());
  write(join(dir, "results", child, "planted-01", "big.bin"), options.big ?? bigFileBytes());
  write(join(dir, "omissions.json"), JSON.stringify(options.omissions ?? defaultOmissions(child)));
  for (const [path, content] of Object.entries(options.extra ?? {})) write(join(dir, path), content);
}

export function publishArgv(world: World, rootRunFile: string, extra: string[] = []): string[] {
  return [
    "publish",
    "--policy",
    world.policyFile,
    "--root-run",
    rootRunFile,
    "--staging",
    world.staging,
    "--state",
    world.state,
    "--patterns",
    world.patterns,
    "--redaction-values",
    world.values,
    "--local-remote",
    world.remote,
    "--local-store",
    world.store,
    "--gitleaks",
    world.gitleaks,
    "--large-threshold-bytes",
    String(THRESHOLD),
    ...extra,
  ];
}

export function publish(world: World, rootRunFile: string, extra: string[] = [], deps: Partial<CliDeps> = {}): Promise<CliResult> {
  return runCli(publishArgv(world, rootRunFile, extra), { env: { PATH: process.env.PATH ?? "", HOME: world.dir }, ...deps });
}

export interface PrintedRecord {
  status: string;
  publication_id: string;
  manifest_sha256: string;
  repository_commit: string | null;
  failure_reason: string | null;
  artifacts: { path: string; sha256: string; size_bytes: number; public_uri: string | null }[];
  omissions: { category: string; reason: string }[];
}

export function printed(result: CliResult): PrintedRecord {
  const text = result.stdout.trim();
  return JSON.parse(text) as PrintedRecord;
}

/** Log lines for one event name. */
export function events(result: CliResult, name: string): string[] {
  return result.stderr.split("\n").filter((line) => line.includes(`event=${name} `) || line.endsWith(`event=${name}`));
}

export interface PublishedRun {
  manifest: RunManifest;
  manifestBytes: Buffer;
  files: Map<string, Buffer>;
  commit: string;
}

/** Reads runs/<root>/ from the remote and checks every byte against the manifest. */
export function readPublished(world: World, root = ROOT_ID): PublishedRun {
  const commit = headCommit(world.remote);
  if (commit === null) throw new Error("remote has no branch");
  const listing = git(world.remote, ["ls-tree", "-r", "--full-tree", commit, `runs/${root}/`]);
  const files = new Map<string, Buffer>();
  for (const line of listing.split("\n").filter((item) => item.length > 0)) {
    const [meta = "", path = ""] = line.split("\t");
    const [mode, type, oid = ""] = meta.split(" ");
    expect(mode).toBe("100644");
    expect(type).toBe("blob");
    files.set(path.slice(`runs/${root}/`.length), gitBytes(world.remote, ["cat-file", "blob", oid]));
  }
  const manifestBytes = files.get("manifest.json");
  if (manifestBytes === undefined) throw new Error("manifest missing");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as RunManifest;
  for (const entry of manifest.entries) {
    if (entry.outcome !== "published" && entry.outcome !== "truncated") {
      expect(files.has(entry.path)).toBe(false);
      continue;
    }
    let bytes: Buffer | undefined;
    if (entry.public_uri !== null) {
      expect(entry.public_uri).toBe(`${BASE_URI}sha256/${entry.sha256 ?? ""}`);
      expect(files.has(entry.path)).toBe(false);
      bytes = readFileSync(join(world.store, "sha256", entry.sha256 ?? "missing"));
    } else {
      bytes = files.get(entry.path);
    }
    if (bytes === undefined) throw new Error(`missing bytes for ${entry.path}`);
    expect(sha256(bytes)).toBe(entry.sha256);
    expect(bytes.length).toBe(entry.size_bytes);
  }
  const expectedFiles = manifest.entries
    .filter((entry) => (entry.outcome === "published" || entry.outcome === "truncated") && entry.public_uri === null)
    .map((entry) => entry.path);
  expect([...files.keys()].sort()).toEqual(["manifest.json", ...expectedFiles].sort());
  return { manifest, manifestBytes, files, commit };
}

export function statusObject(world: World, root = ROOT_ID): Record<string, unknown> | null {
  const path = join(world.store, "status", `${root}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Asserts that a failed or blocked call shows no trace of being published. */
export function expectNotPublished(result: CliResult, world: World, root = ROOT_ID): void {
  expect(result.code).not.toBe(0);
  if (result.stdout.trim().startsWith("{")) {
    const record = JSON.parse(result.stdout) as { status?: string; repository_commit?: unknown };
    expect(record.status).not.toBe("published");
    expect(record.repository_commit ?? null).toBeNull();
  }
  expect(result.stdout).not.toMatch(/"status":"published"/);
  const status = statusObject(world, root);
  if (status !== null) expect(status.publication_status).not.toBe("published");
}

export interface Harness {
  calls: ProcessCall[];
  puts: { pathname: string; options: BlobPutOptions }[];
  fetches: { url: string; headers: Record<string, string> }[];
  objects: Map<string, Uint8Array>;
  runner: ProcessRunner;
  blobClient: BlobClient;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Fake clients: git remotes map to the local bare repository, and the store lives in memory. */
export function harness(remote: string): Harness {
  const calls: ProcessCall[] = [];
  const puts: Harness["puts"] = [];
  const fetches: Harness["fetches"] = [];
  const objects = new Map<string, Uint8Array>();
  const runner: ProcessRunner = (call) => {
    calls.push({ ...call, args: [...call.args], env: { ...call.env } });
    if (call.command !== "git") return runProcess(call);
    const args = call.args.map((arg) => (arg === SSH_REMOTE || arg === GITHUB_REPOSITORY ? remote : arg));
    const env = { ...call.env };
    delete env.GIT_SSH_COMMAND;
    return runProcess({ ...call, args, env });
  };
  const blobClient: BlobClient = {
    put: (pathname, body, options) => {
      puts.push({ pathname, options: { ...options } });
      const url = `https://synthetic-store.example.invalid/${pathname}`;
      if (objects.has(url) && !options.allowOverwrite) return Promise.reject(new Error("blob already exists"));
      objects.set(url, Uint8Array.from(body));
      return Promise.resolve({ url });
    },
  };
  const fetchFake = (url: string, init?: RequestInit): Promise<Response> => {
    fetches.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const bytes = objects.get(url);
    return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(Buffer.from(bytes), { status: 200 }));
  };
  return { calls, puts, fetches, objects, runner, blobClient, fetch: fetchFake };
}
