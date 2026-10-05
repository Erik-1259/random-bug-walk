import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildPolicy, parseRecord, type ProjectPolicy, type RootRun, type RootRunStatus, type RunManifest } from "@rbw/schema";
import { runProcess } from "../src/process.ts";
import type { CliResult } from "../src/cli.ts";
import type { FetchFunction } from "../src/store.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const LARGE_FILE_BYTES = 1024 * 1024 + 4096;

// Synthetic values are assembled at runtime so that no source line holds them as a literal.
const FORBIDDEN_TERM = ["synthetic", "proof", "forbidden", "term"].join("-");
const LISTED_VALUE = ["synthetic", "proof", "listed", "value"].join("-");
const HEADER_VALUE = ["synthetic", "proof", "header", "value"].join("-");

export interface ProofOptions {
  work: string;
  patterns: string | null;
  scanner: string | null;
  gitleaks: string | null;
  real: { policyFile: string; branch: string } | null;
}

export interface ProofDeps {
  /** Runs the publisher CLI with the given arguments. */
  publish: (argv: string[]) => Promise<CliResult>;
  /** Maps the public repository URL to the URL the proof reads from without credentials. */
  readUrl: (url: string) => string;
  /** Reads public store objects without credentials. */
  fetch: FetchFunction;
  print: (line: string) => void;
}

export const defaultDeps: ProofDeps = {
  publish: async (argv) => {
    const result = await runProcess({ command: process.execPath, args: [cliPath, ...argv], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
    return { code: result.code ?? -1, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  },
  readUrl: (url) => url,
  fetch: (url, init) => fetch(url, init),
  print: (line) => {
    process.stdout.write(`${line}\n`);
  },
};

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const gitEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(gitDir: string, args: string[]): Buffer {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", `--git-dir=${gitDir}`, ...args], {
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Writes one synthetic staged run: one child, one trial, one large file, one not_produced and one withheld entry. */
function stageRun(dir: string, root: string, child: string, extra: Record<string, string> = {}): void {
  write(join(dir, "report.md"), "# Synthetic proof report\n");
  write(join(dir, "inputs", "task.md"), "Synthetic proof task.\n");
  write(join(dir, "logs", child, "trial-01", "agent.log"), `start\nAuthorization: Bearer ${HEADER_VALUE}\r\nvalue ${LISTED_VALUE} end\nfinish\n`);
  const block = Buffer.from(`${root}\n`);
  write(join(dir, "results", child, "trial-01", "large.bin"), Buffer.concat(Array.from({ length: Math.ceil(LARGE_FILE_BYTES / block.length) }, () => block)).subarray(0, LARGE_FILE_BYTES));
  write(
    join(dir, "omissions.json"),
    JSON.stringify({
      schema_version: 1,
      entries: [
        { outcome: "not_produced", path: `results/${child}/trial-01/score.json`, execution_id: child, trial_id: "trial-01", reason: "stage_failed" },
        { outcome: "withheld_private", execution_id: child, trial_id: "trial-01", reason: "private_material" },
      ],
      redactions: [{ path: "inputs/task.md", category: "private_material", count: 1 }],
    }),
  );
  for (const [path, content] of Object.entries(extra)) write(join(dir, path), content);
}

function writeRootRun(path: string, policy: ProjectPolicy, policySha256: string, root: string, child: string, status: RootRunStatus): void {
  const run: RootRun = {
    schema_version: 1,
    project_id: policy.project_id,
    root_execution_id: root,
    project_policy_sha256: policySha256,
    kind: "factory",
    declared_stages: ["prepare", "run_trial"],
    child_execution_ids: [child],
    status,
    outcome: status === "terminal" ? "completed" : null,
  };
  write(path, JSON.stringify(run));
}

interface Observation {
  commits: number;
  files: Map<string, Buffer> | null;
}

interface ScenarioResult {
  name: string;
  expected: string;
  actual: string;
  exit: number;
  commitDelta: number;
  uploads: number;
  hashes: "match" | "mismatch" | "n/a";
  extra: string[];
}

export async function runProof(options: ProofOptions, deps: ProofDeps = defaultDeps): Promise<number> {
  const work = resolve(options.work);
  mkdirSync(work, { recursive: true });
  const synthetic = join(work, "synthetic");
  const syntheticPatterns = join(synthetic, "patterns.txt");
  write(syntheticPatterns, `# synthetic proof pattern list\n${FORBIDDEN_TERM}\n`);
  const values = join(synthetic, "redaction-values.txt");
  write(values, `# synthetic proof redaction values\ncredential\t${LISTED_VALUE}\n`);
  const state = join(work, "state");

  let policyFile: string;
  let destinationArgs: string[];
  let localStore: string | null = null;
  let remoteGitDir: string | null = null;
  if (options.real === null) {
    policyFile = join(synthetic, "policy.json");
    write(
      policyFile,
      buildPolicy({
        projectId: "00000000-0000-4000-8000-000000000001",
        outputRepository: "https://example.invalid/synthetic-owner/synthetic-results",
        publicArtifactBaseUri: "https://example.invalid/synthetic-store/test-prefix/",
        policyVersion: 1,
      }).bytes,
    );
    remoteGitDir = join(work, "remote.git");
    if (!existsSync(remoteGitDir)) execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remoteGitDir], { env: gitEnv });
    localStore = join(work, "store");
    mkdirSync(localStore, { recursive: true });
    destinationArgs = ["--local-remote", remoteGitDir, "--local-store", localStore];
  } else {
    policyFile = resolve(options.real.policyFile);
    destinationArgs = [];
  }
  const policyBytes = readFileSync(policyFile);
  const policy = parseRecord("ProjectPolicy", policyBytes);
  const policySha256 = sha256(policyBytes);
  const branch = options.real?.branch ?? "main";
  const repositoryUrl = policy.output_repository ?? "";
  const baseUri = policy.public_artifact_base_uri ?? "";
  if (options.real !== null) destinationArgs = ["--real", "--repository-url", repositoryUrl, "--artifact-base-uri", baseUri, "--branch", branch];

  const inspectDir = join(work, "inspect.git");
  if (remoteGitDir === null && !existsSync(inspectDir)) execFileSync("git", ["init", "--quiet", "--bare", inspectDir], { env: gitEnv });

  /** Reads the branch without credentials: commit count and, for one root, every file. */
  const observe = (root: string | null): Observation => {
    let gitDir = remoteGitDir;
    let ref = `refs/heads/${branch}`;
    if (gitDir === null) {
      gitDir = inspectDir;
      const listing = git(gitDir, ["ls-remote", "--heads", deps.readUrl(repositoryUrl), ref]).toString("utf8");
      if (!listing.includes(ref)) return { commits: 0, files: root === null ? null : new Map() };
      git(gitDir, ["fetch", "--quiet", "--no-tags", deps.readUrl(repositoryUrl), `+${ref}:refs/proof/head`]);
      ref = "refs/proof/head";
    } else if (git(gitDir, ["for-each-ref", ref]).length === 0) {
      return { commits: 0, files: root === null ? null : new Map() };
    }
    const commits = Number(git(gitDir, ["rev-list", "--count", ref]).toString("utf8").trim());
    if (root === null) return { commits, files: null };
    const files = new Map<string, Buffer>();
    const listing = git(gitDir, ["ls-tree", "-r", ref, `runs/${root}/`]).toString("utf8");
    for (const line of listing.split("\n").filter((item) => item.length > 0)) {
      const [meta = "", path = ""] = line.split("\t");
      const oid = meta.split(" ")[2] ?? "";
      files.set(path.slice(`runs/${root}/`.length), git(gitDir, ["cat-file", "blob", oid]));
    }
    return { commits, files };
  };

  const readObject = async (uri: string): Promise<Buffer | null> => {
    if (localStore !== null) {
      // Local mode maps the policy base URI to the store directory.
      const path = join(localStore, uri.slice(baseUri.length));
      return uri.startsWith(baseUri) && existsSync(path) ? readFileSync(path) : null;
    }
    const response = await deps.fetch(uri, { cache: "no-store" });
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  };

  /** Checks every published byte against the manifest. */
  const checkHashes = async (files: Map<string, Buffer>): Promise<{ ok: boolean; manifest: RunManifest | null }> => {
    const manifestBytes = files.get("manifest.json");
    if (manifestBytes === undefined) return { ok: false, manifest: null };
    const manifest = parseRecord("RunManifest", manifestBytes);
    let ok = true;
    for (const entry of manifest.entries) {
      if (entry.outcome !== "published" && entry.outcome !== "truncated") continue;
      const bytes = entry.public_uri === null ? files.get(entry.path) : await readObject(entry.public_uri);
      if (bytes?.length !== entry.size_bytes || sha256(bytes) !== entry.sha256) ok = false;
      if (entry.public_uri !== null && files.has(entry.path)) ok = false;
    }
    return { ok, manifest };
  };

  const statusObject = async (root: string): Promise<Record<string, unknown> | null> => {
    const bytes = await readObject(`${baseUri}status/${root}.json`);
    return bytes === null ? null : (JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
  };

  // Objects under sha256/ in the local store; real mode has no credential-free listing, so it counts uploads only.
  const storeObjects = (): number => (localStore !== null && existsSync(join(localStore, "sha256")) ? readdirSync(join(localStore, "sha256")).length : 0);

  const publish = async (rootRunFile: string, staging: string, patterns: string): Promise<CliResult> => {
    const argv = ["publish", "--policy", policyFile, "--root-run", rootRunFile, "--staging", staging, "--state", state, "--patterns", patterns, "--redaction-values", values, ...destinationArgs];
    if (options.scanner !== null) argv.push("--scanner", options.scanner);
    if (options.gitleaks !== null) argv.push("--gitleaks", options.gitleaks);
    return deps.publish(argv);
  };

  const uploads = (result: CliResult): number => result.stderr.split("\n").filter((line) => line.includes("event=store_put ")).length;
  /** The status field of the printed record or status object. */
  const printedStatus = (result: CliResult): string => {
    let printed: unknown;
    try {
      printed = JSON.parse(result.stdout);
    } catch {
      return "none";
    }
    const status = typeof printed === "object" && printed !== null && "status" in printed ? printed.status : undefined;
    return typeof status === "string" ? status : "none";
  };

  const results: ScenarioResult[] = [];
  const roots = { a: randomUUID(), c: randomUUID(), d: randomUUID() };
  const child = randomUUID();
  const runPatterns = options.patterns ?? syntheticPatterns;

  // a: publish, then check every blob and object against the manifest.
  {
    const staging = join(work, "staging-a");
    stageRun(staging, roots.a, child);
    const rootRunFile = join(work, "root-a.json");
    writeRootRun(rootRunFile, policy, policySha256, roots.a, child, "terminal");
    const before = observe(null).commits;
    const objectsBefore = storeObjects();
    const result = await publish(rootRunFile, staging, runPatterns);
    const after = observe(roots.a);
    const check = after.files === null ? { ok: false, manifest: null } : await checkHashes(after.files);
    const log = after.files?.get(`logs/${child}/trial-01/agent.log`)?.toString("utf8") ?? "";
    const markers = log.includes("[redacted:auth_header]") && log.includes("[redacted:credential]") && !log.includes(LISTED_VALUE) && !log.includes(HEADER_VALUE);
    const agentEntry = check.manifest?.entries.find((entry) => entry.path === `logs/${child}/trial-01/agent.log`);
    const declared = JSON.stringify(agentEntry?.redactions ?? []) === JSON.stringify([{ category: "auth_header", count: 1 }, { category: "credential", count: 1 }]);
    const manifestText = after.files?.get("manifest.json")?.toString("utf8") ?? "";
    const clean = !manifestText.includes(LISTED_VALUE) && !manifestText.includes(sha256(LISTED_VALUE));
    results.push({
      name: "a",
      expected: "published",
      actual: printedStatus(result),
      exit: result.code,
      commitDelta: after.commits - before,
      uploads: uploads(result),
      hashes: check.ok ? "match" : "mismatch",
      extra: [`markers=${markers && clean ? "yes" : "no"}`, `redactions=${declared ? "category-count" : "wrong"}`, `objects=${String(storeObjects() - objectsBefore)}`],
    });
    // b: publish again; no new commit and no new object.
    const again = await publish(rootRunFile, staging, runPatterns);
    const second = observe(null).commits;
    results.push({
      name: "b",
      expected: "published",
      actual: printedStatus(again),
      exit: again.code,
      commitDelta: second - after.commits,
      uploads: uploads(again),
      hashes: again.stdout === result.stdout ? "match" : "mismatch",
      extra: [`objects=${String(storeObjects() - objectsBefore - 1)}`],
    });
  }

  // c: a synthetic forbidden term, always against the script's own synthetic pattern file.
  {
    const staging = join(work, "staging-c");
    stageRun(staging, roots.c, child, { "inputs/notes.md": `mentions ${FORBIDDEN_TERM}\n` });
    const rootRunFile = join(work, "root-c.json");
    writeRootRun(rootRunFile, policy, policySha256, roots.c, child, "terminal");
    const before = observe(null).commits;
    const objectsBefore = storeObjects();
    const result = await publish(rootRunFile, staging, syntheticPatterns);
    const status = await statusObject(roots.c);
    const leaked = result.stdout.includes(FORBIDDEN_TERM) || result.stderr.includes(FORBIDDEN_TERM);
    results.push({
      name: "c",
      expected: "blocked",
      actual: printedStatus(result),
      exit: result.code,
      commitDelta: observe(null).commits - before,
      uploads: uploads(result),
      hashes: "n/a",
      extra: [`status_object=${status === null ? "absent" : String(status.publication_status)}`, `term_printed=${leaked ? "yes" : "no"}`, `objects=${String(storeObjects() - objectsBefore)}`],
    });
  }

  // d: a running root; only the status object is written.
  {
    const rootRunFile = join(work, "root-d.json");
    writeRootRun(rootRunFile, policy, policySha256, roots.d, child, "running");
    const before = observe(null).commits;
    const objectsBefore = storeObjects();
    const result = await publish(rootRunFile, join(work, "staging-d-never-read"), runPatterns);
    const status = await statusObject(roots.d);
    results.push({
      name: "d",
      expected: "running",
      actual: printedStatus(result),
      exit: result.code,
      commitDelta: observe(null).commits - before,
      uploads: uploads(result),
      hashes: "n/a",
      extra: [`status_object=${status === null ? "absent" : String(status.status)}`, `objects=${String(storeObjects() - objectsBefore)}`],
    });
  }

  const expectations: Record<string, (item: ScenarioResult) => boolean> = {
    a: (item) => item.exit === 0 && item.commitDelta === 1 && item.uploads === 1 && item.hashes === "match" && item.extra.includes("markers=yes") && item.extra.includes("redactions=category-count"),
    b: (item) => item.exit === 0 && item.commitDelta === 0 && item.uploads === 0 && item.hashes === "match",
    c: (item) => item.exit === 1 && item.commitDelta === 0 && item.uploads === 0 && item.extra.includes("term_printed=no") && !item.extra.some((part) => part.startsWith("status_object=") && part !== "status_object=absent" && part !== "status_object=blocked"),
    d: (item) => item.exit === 3 && item.commitDelta === 0 && item.uploads === 0 && item.extra.includes("status_object=running"),
  };
  let failures = 0;
  for (const item of results) {
    const local = localStore === null || item.extra.every((part) => !part.startsWith("objects=") || part === (item.name === "a" ? "objects=1" : "objects=0"));
    const pass = item.actual === item.expected && (expectations[item.name]?.(item) ?? false) && local;
    if (!pass) failures += 1;
    deps.print(
      [
        `scenario=${item.name}`,
        `expected=${item.expected}`,
        `actual=${item.actual}`,
        `exit=${String(item.exit)}`,
        `commits=+${String(item.commitDelta)}`,
        `uploads=${String(item.uploads)}`,
        `hashes=${item.hashes}`,
        ...item.extra.filter((part) => localStore !== null || !part.startsWith("objects=")),
        pass ? "PASS" : "FAIL",
      ].join(" "),
    );
  }
  const status = await deps.publish(["status", "--state", state]);
  for (const line of status.stdout.split("\n").filter((item) => item.length > 0)) deps.print(`status ${line}`);
  deps.print(failures === 0 ? "proof: all scenarios match" : `proof: ${String(failures)} scenario(s) did not match`);
  return failures === 0 ? 0 : 1;
}

function parseOptions(argv: string[]): ProofOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      work: { type: "string" },
      patterns: { type: "string" },
      scanner: { type: "string" },
      gitleaks: { type: "string" },
      real: { type: "boolean" },
      policy: { type: "string" },
      branch: { type: "string" },
    },
  });
  if (values.work === undefined) throw new Error("--work is required");
  if (values.real === true && (values.policy === undefined || values.branch === undefined)) throw new Error("--real needs --policy and --branch");
  return {
    work: values.work,
    patterns: values.patterns ?? null,
    scanner: values.scanner ?? null,
    gitleaks: values.gitleaks ?? null,
    real: values.real === true ? { policyFile: values.policy ?? "", branch: values.branch ?? "" } : null,
  };
}

if (import.meta.main) {
  try {
    process.exitCode = await runProof(parseOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`proof: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 2;
  }
}
