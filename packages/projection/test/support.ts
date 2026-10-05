import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished } from "vitest";
import { runCli } from "../src/run.ts";

export const STRICT = "synthetic-strict-canary";
export const STRICT_PHRASE = "synthetic strict phrase";
export const GENERIC = "synthetic-generic-word";
export const NEUTRAL = { name: "workspace", email: "workspace@example.invalid", date: "2000-01-01T00:00:00Z", message: "Initial commit" };
export const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

export type FileSpec = string | Buffer | { content: string | Buffer; mode: number };
export type Tree = Record<string, FileSpec>;

export const MUTATED_PATH = "src/query.ts";
export const ORIGINAL_QUERY = "line one\nline two\nconst rows = select(unit, timezone);\nline four\nline five\n";
export const RESULT_QUERY = "line one\nline two\nconst rows = select(unit);\nline four\nline five\n";

export const BASE_TREE: Tree = {
  "README.md": "# Synthetic app\n\nA synthetic fixture for the projection audit.\n",
  "docs/guide.md": "Guide text.\n",
  "src/app.ts": `export const word = "${GENERIC}";\n`,
  [MUTATED_PATH]: ORIGINAL_QUERY,
  "src/app.test.ts": "synthetic original test\n",
  "answers/notes.txt": "synthetic notes\n",
  "answers/deep/more.txt": "synthetic more notes\n",
  "bin/run.sh": { content: "#!/bin/sh\necho run\n", mode: 0o755 },
  "tests/api/coverage/bundle.js.map": "{}\n",
  "tests/api/coverage/lcov.info": "TN:\n",
};

export const EXCLUSIONS = [
  { path: "src/app.test.ts", category: "original_test" },
  { path: "answers/", category: "answer_metadata" },
];

export const TERMS = `# synthetic term list\nstrict:${STRICT}\nstrict: ${STRICT_PHRASE} \ngeneric:${GENERIC}\n\n`;

/** Environment for fixture git commands: no global or system configuration, a synthetic upstream identity. */
export function fixtureGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Synthetic Upstream",
    GIT_AUTHOR_EMAIL: "upstream@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Upstream",
    GIT_COMMITTER_EMAIL: "upstream@example.invalid",
    GIT_AUTHOR_DATE: "2001-02-03T04:05:06Z",
    GIT_COMMITTER_DATE: "2001-02-03T04:05:06Z",
    ...extra,
  };
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = fixtureGitEnv()): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function writeSpec(root: string, path: string, spec: FileSpec): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  if (typeof spec === "string" || Buffer.isBuffer(spec)) {
    writeFileSync(file, spec);
    chmodSync(file, 0o644);
  } else {
    writeFileSync(file, spec.content);
    chmodSync(file, spec.mode);
  }
}

/** A temporary directory, removed when the current test finishes. */
export function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rbw-projection-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function cli(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

export function spawnCli(args: string[], env: NodeJS.ProcessEnv = process.env): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export interface Finding {
  reason: string;
  path: string;
  line: number | null;
}

export interface AuditResult extends CliResult {
  reportText: string;
  report: {
    verdict: string;
    exit_code: number;
    findings: Finding[];
    review: string[];
    prose_files: string[];
    exclusions: { path: string; category: string }[];
    counts: { included: number; excluded: number; mutated: number };
    manifest_sha256: string;
    policy_sha256: string;
    terms_sha256: string;
    git: unknown;
    error?: string;
  };
}

export interface FixtureOptions {
  tree?: Tree;
  result?: string;
  mutatedPath?: string;
}

/**
 * A synthetic upstream repository with two commits, its manifest, a policy, a declared
 * mutation, a synthetic term list and a copy directory. Each step writes into its own
 * temporary root; tests change the inputs or the copy between steps.
 */
export class Fixture {
  readonly root = tempRoot();
  readonly repo = join(this.root, "upstream");
  readonly copy = join(this.root, "copy");
  readonly inputs = join(this.root, "inputs");
  readonly tree: Tree;
  readonly mutatedPath: string;
  readonly result: string;
  readonly hostCommit: string;
  manifestPath = join(this.inputs, "manifest.json");
  policyPath = join(this.inputs, "policy.json");
  mutationPath = join(this.inputs, "mutation.json");
  termsPath = join(this.inputs, "terms.txt");
  reportPath = join(this.inputs, "report.json");
  diff = "";

  constructor(options: FixtureOptions = {}) {
    this.tree = options.tree ?? BASE_TREE;
    this.mutatedPath = options.mutatedPath ?? MUTATED_PATH;
    this.result = options.result ?? RESULT_QUERY;
    mkdirSync(this.inputs, { recursive: true });
    mkdirSync(this.repo);
    git(this.repo, ["init", "-q", "--initial-branch=main"]);
    writeSpec(this.repo, this.mutatedPath, "an older upstream version\n");
    git(this.repo, ["add", "-A"]);
    git(this.repo, ["commit", "-q", "-m", "Older upstream commit"]);
    for (const [path, spec] of Object.entries(this.tree)) writeSpec(this.repo, path, spec);
    git(this.repo, ["add", "-A"]);
    git(this.repo, ["commit", "-q", "-m", "Pinned upstream commit"]);
    this.hostCommit = git(this.repo, ["rev-parse", "HEAD"]);
  }

  async writeManifest(): Promise<CliResult> {
    return cli(["manifest", "--repo", this.repo, "--commit", this.hostCommit, "--out", this.manifestPath]);
  }

  writePolicy(policy: unknown = { dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: NEUTRAL }): void {
    writeFileSync(this.policyPath, JSON.stringify(policy));
  }

  /** Writes the declared mutation, taking the diff from `git diff` in the upstream working tree. */
  writeMutation(edit: (mutation: Record<string, unknown>) => void = () => undefined): void {
    const file = join(this.repo, this.mutatedPath);
    const original = readFileSync(file);
    writeFileSync(file, this.result);
    this.diff = execFileSync("git", ["diff", "--no-color", "--no-ext-diff", "--", this.mutatedPath], {
      cwd: this.repo,
      env: fixtureGitEnv(),
      encoding: "utf8",
    });
    writeFileSync(file, original);
    const mutation: Record<string, unknown> = {
      diff: this.diff,
      files: [{ mode: "100644", original_sha256: sha256(original), path: this.mutatedPath, result_sha256: sha256(this.result) }],
      host_commit: this.hostCommit,
    };
    edit(mutation);
    writeFileSync(this.mutationPath, JSON.stringify(mutation));
  }

  writeTerms(text: string = TERMS): void {
    writeFileSync(this.termsPath, text);
  }

  /** Writes every pinned file except the exclusions, with the mutation applied. */
  buildCopy(): void {
    mkdirSync(this.copy, { recursive: true });
    for (const [path, spec] of Object.entries(this.tree)) {
      if (path === "src/app.test.ts" || path.startsWith("answers/")) continue;
      writeSpec(this.copy, path, path === this.mutatedPath ? this.result : spec);
    }
  }

  async commitNeutral(): Promise<CliResult> {
    return cli(["commit-neutral", "--dir", this.copy, "--policy", this.policyPath]);
  }

  /** Manifest, policy, mutation and term list, with no copy yet. */
  async prepareInputs(): Promise<void> {
    expect((await this.writeManifest()).code).toBe(0);
    this.writePolicy();
    this.writeMutation();
    this.writeTerms();
  }

  /** Inputs and copy, without history. */
  async prepare(): Promise<void> {
    await this.prepareInputs();
    this.buildCopy();
  }

  /** Inputs, copy and neutral history, ready for the audit. */

  async ready(): Promise<void> {
    await this.prepare();
    expect((await this.commitNeutral()).code).toBe(0);
  }

  auditArgs(): string[] {
    return [
      "audit",
      "--manifest",
      this.manifestPath,
      "--policy",
      this.policyPath,
      "--mutation",
      this.mutationPath,
      "--terms",
      this.termsPath,
      "--copy",
      this.copy,
      "--report",
      this.reportPath,
    ];
  }

  async audit(): Promise<AuditResult> {
    const result = await cli(this.auditArgs());
    let reportText: string;
    try {
      reportText = readFileSync(this.reportPath, "utf8");
    } catch {
      reportText = "{}";
    }
    return { ...result, reportText, report: JSON.parse(reportText) as AuditResult["report"] };
  }

  copyGit(args: string[], env: NodeJS.ProcessEnv = fixtureGitEnv()): string {
    return git(this.copy, args, env);
  }
}

export function reasons(result: AuditResult): string[] {
  return [...new Set(result.report.findings.map((finding) => finding.reason))].sort();
}

export function locations(result: AuditResult, reason: string): string[] {
  return result.report.findings
    .filter((finding) => finding.reason === reason)
    .map((finding) => (finding.line === null ? finding.path : `${finding.path}:${String(finding.line)}`));
}

/** Asserts that no output channel mentions a synthetic strict term, in any case. */
export function expectNoTerm(result: CliResult & { reportText?: string }, terms: string[] = [STRICT, STRICT_PHRASE, "synthetic strict"]): void {
  for (const text of [result.stdout, result.stderr, result.reportText ?? ""]) {
    for (const term of terms) expect(text.toLowerCase()).not.toContain(term.toLowerCase());
  }
}
