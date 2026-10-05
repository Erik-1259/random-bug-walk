import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitResult {
  status: number | null;
  stdout: Buffer;
}

export interface GitOptions {
  /** Runs with `GIT_DIR` set to this directory instead of discovering a repository. */
  gitDir?: string;
  cwd?: string;
  input?: Buffer;
  env?: Record<string, string>;
}

const MAX_OUTPUT = 1024 * 1024 * 1024;

/**
 * Environment for every git call: the caller's `GIT_*` variables are dropped, global and
 * system configuration are ignored, replace refs are not honoured and nothing prompts.
 */
function gitEnvironment(options: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  });
  if (options.gitDir !== undefined) env.GIT_DIR = options.gitDir;
  return { ...env, ...options.env };
}

/**
 * Runs git with hooks pointed at an empty directory. Its stderr is discarded so that
 * nothing git prints about the inputs reaches the output.
 */
export function runGit(args: readonly string[], options: GitOptions = {}): GitResult {
  return withEmptyDirectory((empty) => {
    const result = spawnSync("git", ["-c", `core.hooksPath=${empty}`, "-c", "core.fsmonitor=false", ...args], {
      cwd: options.cwd,
      env: gitEnvironment(options),
      input: options.input,
      maxBuffer: MAX_OUTPUT,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (result.error !== undefined) return { status: null, stdout: Buffer.alloc(0) };
    return { status: result.status, stdout: result.stdout };
  });
}

/** Runs git and returns its stdout, or null when it fails. */
export function gitOutput(args: readonly string[], options: GitOptions = {}): Buffer | null {
  const result = runGit(args, options);
  return result.status === 0 ? result.stdout : null;
}

export function withEmptyDirectory<T>(use: (path: string) => T): T {
  const path = mkdtempSync(join(tmpdir(), "rbw-projection-empty-"));
  try {
    return use(path);
  } finally {
    rmdirSync(path);
  }
}
