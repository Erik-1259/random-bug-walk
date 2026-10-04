import { spawn } from "node:child_process";

export interface ProcessResult {
  /** Exit status, or null when the process could not start, ended by a signal or timed out. */
  code: number | null;
  /** True when the process could not be started at all. */
  spawnFailed: boolean;
  /** True when the process group was killed because the time limit ran out. */
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

export interface ProcessOptions {
  cwd: string;
  env: Record<string, string>;
  /** Bytes sent through a pipe; without input, stdin is not connected at all. */
  input?: Uint8Array;
  /** Time limit after which the whole process group is killed with SIGKILL. */
  timeoutMs?: number;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone; the exit event settles the result.
  }
}

/**
 * Runs a command without a shell. It never rejects; failures show in the result. The
 * child runs in a new session, so it has no controlling terminal, and its stdin is not
 * the helper's. On timeout its whole process group is killed.
 */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, spawnFailed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, spawnFailed, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, options.timeoutMs);
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => {
      finish(null, true);
    });
    child.on("exit", () => {
      // A descendant outside the group may hold the pipes open; a timed-out run ends at exit.
      if (!timedOut) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, false);
    });
    child.on("close", (code) => {
      finish(code, false);
    });
    if (child.stdin !== null) {
      // A child that exits before reading its input raises EPIPE here; the exit status reports the failure.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
  });
}

const LOCALE_VARIABLE = /^(?:LANG|LANGUAGE|LC_[A-Z_]+)$/;

/**
 * Builds the environment for git, gh and gitleaks from an allowlist: PATH, HOME and the
 * locale variables, plus any extra names the caller passes. Inherited GIT_* and GH_*
 * variables never pass unless named as extras, and the fixed settings below always win.
 */
export function toolEnvironment(source: NodeJS.ProcessEnv, extraNames: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (name === "PATH" || name === "HOME" || LOCALE_VARIABLE.test(name)) env[name] = value;
  }
  for (const name of extraNames) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_GRAFT_FILE = "/dev/null";
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  return env;
}

/**
 * Options placed before every git subcommand: hooks off, no fsmonitor, and history read
 * from the commit objects themselves, never from replace refs or a commit-graph file.
 */
export const GIT_SAFETY_OPTIONS: readonly string[] = [
  "--no-replace-objects",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.commitGraph=false",
];

/** Splits a configured command on ASCII spaces, without quoting rules. */
export function splitCommand(command: string): string[] {
  return command.split(" ").filter((token) => token.length > 0);
}

/** Default time limits for child processes, in milliseconds; the helper's flags override them. */
export const DEFAULT_TIMEOUT_MS = { git: 300_000, gh: 120_000, gitleaks: 600_000 } as const;
