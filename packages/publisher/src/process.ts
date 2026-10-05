import { spawn } from "node:child_process";

export interface ProcessCall {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  input?: Uint8Array;
  timeoutMs?: number;
}

export interface ProcessResult {
  /** Exit status, or null when the process could not start, was killed or timed out. */
  code: number | null;
  spawnFailed: boolean;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

/** Runs one child process. Tests inject their own runner. */
export type ProcessRunner = (call: ProcessCall) => Promise<ProcessResult>;

/** Spawns without a shell. It never rejects; failures show in the result. */
export const runProcess: ProcessRunner = (call) =>
  new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, spawnFailed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, spawnFailed, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const child = spawn(call.command, call.args, { cwd: call.cwd, env: call.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const timer =
      call.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, call.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => {
      finish(null, true);
    });
    child.on("close", (code) => {
      finish(code, false);
    });
    // A child that exits before reading its input raises EPIPE here; the exit status reports it.
    child.stdin.on("error", () => undefined);
    child.stdin.end(call.input ?? new Uint8Array());
  });

const LOCALE_VARIABLE = /^(?:LANG|LANGUAGE|LC_[A-Z_]+)$/;

/** True for the names child processes inherit: PATH, HOME and the locale variables. */
export function passesAllowlist(name: string): boolean {
  return name === "PATH" || name === "HOME" || LOCALE_VARIABLE.test(name);
}

/**
 * The allowlisted environment for every child process: PATH, HOME and the locale variables.
 * Only the names that pass the allowlist are read, so credential variables are never touched.
 */
export function baseEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of Object.keys(source)) {
    if (!passesAllowlist(name)) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Splits a configured command on ASCII spaces, without quoting rules. */
export function splitCommand(command: string): string[] {
  return command.split(" ").filter((token) => token.length > 0);
}
