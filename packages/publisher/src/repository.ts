import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Budget } from "./limits.ts";
import type { Logger } from "./log.ts";
import { baseEnvironment, type ProcessResult, type ProcessRunner } from "./process.ts";

export const COMMIT_IDENTITY = "Random Bug Walk";

export class RepositoryUnavailable extends Error {
  constructor(step: string) {
    super(`repository unavailable: ${step}`);
    this.name = "RepositoryUnavailable";
  }
}

export interface RepositorySettings {
  /** The publisher's own bare repository in the state directory. */
  gitDir: string;
  /** URL for fetch. In real mode the public HTTPS URL, read without credentials. */
  readUrl: string;
  /** URL for the push. In real mode the SSH URL derived from output_repository. */
  pushUrl: string;
  branch: string;
  /** Variables only the push process receives, such as GIT_SSH_COMMAND. */
  pushEnv: Record<string, string>;
}

export interface TreeEntry {
  path: string;
  bytes: Uint8Array;
}

// Hooks, credential helpers, signing, fsmonitor and line-ending conversion are all off for every command.
const SAFETY = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "core.fsmonitor=false",
  "-c", "core.autocrlf=false",
  "-c", "commit.gpgSign=false",
  "-c", "protocol.version=2",
];

/** git CLI plumbing: exact blobs without a worktree, filters or hooks, and fast-forward pushes only. */
export class Repository {
  private readonly settings: RepositorySettings;
  private readonly runner: ProcessRunner;
  private readonly env: Record<string, string>;
  private readonly logger: Logger;
  private readonly budget: Budget;

  constructor(settings: RepositorySettings, runner: ProcessRunner, sourceEnv: Readonly<Record<string, string | undefined>>, logger: Logger, budget: Budget) {
    this.settings = settings;
    this.runner = runner;
    // Global and system configuration are ignored; trace variables never pass the allowlist.
    this.env = { ...baseEnvironment(sourceEnv), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    this.logger = logger;
    this.budget = budget;
  }

  private async git(args: readonly string[], options: { input?: Uint8Array; env?: Record<string, string>; gitDir?: boolean } = {}): Promise<ProcessResult> {
    const prefix = options.gitDir === false ? SAFETY : [...SAFETY, `--git-dir=${this.settings.gitDir}`];
    const call = { command: "git", args: [...prefix, ...args], cwd: tmpdir(), env: { ...this.env, ...options.env } };
    return this.runner(options.input === undefined ? call : { ...call, input: options.input });
  }

  private async output(args: readonly string[], step: string, options: { input?: Uint8Array; env?: Record<string, string> } = {}): Promise<string> {
    const result = await this.git(args, options);
    if (result.code !== 0) throw new RepositoryUnavailable(step);
    return result.stdout.toString("utf8").trim();
  }

  async init(): Promise<void> {
    const result = await this.git(["init", "--quiet", "--bare", this.settings.gitDir], { gitDir: false });
    if (result.code !== 0) throw new RepositoryUnavailable("init");
  }

  /**
   * Fetches the remote branch head in one request, which counts toward the metadata limit.
   * Returns null when the branch does not exist yet.
   */
  async fetchHead(): Promise<string | null> {
    const ref = `refs/heads/${this.settings.branch}`;
    this.budget.spend("metadataRequests", 1);
    this.logger.event("fetch", { branch: this.settings.branch });
    // LC_ALL=C keeps git's message untranslated, so a missing branch is told apart from a failure.
    const result = await this.git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", this.settings.readUrl, `+${ref}:refs/rbw/head`], {
      env: { LC_ALL: "C" },
    });
    if (result.code !== 0) {
      if (result.stderr.toString("utf8").includes(`couldn't find remote ref ${ref}`)) return null;
      throw new RepositoryUnavailable("fetch");
    }
    const head = await this.output(["rev-parse", "--verify", "refs/rbw/head^{commit}"], "fetch");
    if (!/^[0-9a-f]{40}$/.test(head)) throw new RepositoryUnavailable("fetch");
    return head;
  }

  /** The tree ID at `path` in a commit, or null when the path does not exist. */
  async treeAt(commit: string, path: string): Promise<string | null> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", `${commit}:${path}`]);
    if (result.code !== 0) return null;
    return result.stdout.toString("utf8").trim();
  }

  /** The bytes of the file at `path` in a commit, or null when there is no file there. */
  async blobAt(commit: string, path: string): Promise<Buffer | null> {
    const type = await this.git(["cat-file", "-t", `${commit}:${path}`]);
    if (type.code !== 0 || type.stdout.toString("utf8").trim() !== "blob") return null;
    const result = await this.git(["cat-file", "blob", `${commit}:${path}`]);
    if (result.code !== 0) throw new RepositoryUnavailable("cat-file");
    return result.stdout;
  }

  /** The oldest commit reachable from `head` that added `path`. */
  async addedBy(head: string, path: string): Promise<string> {
    const log = await this.output(["log", "--format=%H", "--diff-filter=A", head, "--", path], "log");
    const commit = log.split("\n").filter((line) => line.length > 0).at(-1);
    if (commit === undefined) throw new RepositoryUnavailable("log");
    return commit;
  }

  private async writeBlobs(entries: readonly TreeEntry[], prefix: string): Promise<string> {
    const lines: string[] = [];
    for (const entry of entries) {
      const oid = await this.output(["hash-object", "-w", "--no-filters", "--stdin"], "hash-object", { input: entry.bytes });
      lines.push(`100644 ${oid}\t${prefix}${entry.path}\n`);
    }
    return lines.join("");
  }

  /** Builds a tree in a temporary index: optionally the head's tree, plus the entries under `prefix`. */
  private async buildTree(entries: readonly TreeEntry[], prefix: string, base: string | null): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "rbw-publisher-index-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      if (base !== null) await this.output(["read-tree", base], "read-tree", { env });
      const info = await this.writeBlobs(entries, prefix);
      await this.output(["update-index", "--add", "--index-info"], "update-index", { env, input: new TextEncoder().encode(info) });
      return await this.output(["write-tree"], "write-tree", { env });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The tree a run directory would have. */
  async runTree(entries: readonly TreeEntry[]): Promise<string> {
    return this.buildTree(entries, "", null);
  }

  /** One commit on top of `head` (or a first commit) that adds the entries below `prefix`. */
  async commit(head: string | null, prefix: string, entries: readonly TreeEntry[], message: string): Promise<string> {
    const tree = await this.buildTree(entries, prefix, head);
    const date = `${String(Math.floor(Date.now() / 1000))} +0000`;
    const env = {
      GIT_AUTHOR_NAME: COMMIT_IDENTITY,
      GIT_AUTHOR_EMAIL: "",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: COMMIT_IDENTITY,
      GIT_COMMITTER_EMAIL: "",
      GIT_COMMITTER_DATE: date,
    };
    const parents = head === null ? [] : ["-p", head];
    const commit = await this.output(["commit-tree", tree, ...parents, "-m", message], "commit-tree", { env });
    this.logger.event("commit", { commit });
    return commit;
  }

  /** Pushes fast-forward only: no force, no tags, no hooks. Returns false when the push fails. */
  async push(commit: string): Promise<boolean> {
    this.budget.spend("pushAttempts", 1);
    this.logger.event("push", { commit, branch: this.settings.branch });
    const result = await this.git(["push", "--quiet", "--no-verify", "--no-follow-tags", this.settings.pushUrl, `${commit}:refs/heads/${this.settings.branch}`], {
      env: this.settings.pushEnv,
    });
    return result.code === 0;
  }
}
