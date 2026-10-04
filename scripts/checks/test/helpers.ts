import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

export const checksDir = fileURLToPath(new URL("..", import.meta.url));
export const repositoryRoot = join(checksDir, "..", "..");

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Git settings that keep test repositories independent of any user or system configuration. */
export const isolatedGitEnv: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Synthetic Author",
  GIT_AUTHOR_EMAIL: "synthetic-author@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Author",
  GIT_COMMITTER_EMAIL: "synthetic-author@example.invalid",
};

export function runScript(script: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(process.execPath, [join(checksDir, script), ...args], {
    cwd: options.cwd ?? checksDir,
    input: options.input ?? "",
    env: { ...process.env, ...isolatedGitEnv, ...options.env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Creates a temporary directory that is removed when the current test finishes. */
export function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `synthetic-${label}-`));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...isolatedGitEnv },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function initRepository(dir: string): void {
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
}

/** Stages everything and commits; returns the new commit's SHA. */
export function commitAll(dir: string, message: string): string {
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "--quiet", "--allow-empty", "--message", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}
