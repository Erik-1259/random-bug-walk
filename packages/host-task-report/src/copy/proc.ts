// Process helpers for the copy driver: a bounded foreground command and a background service whose
// exit is observed. Output goes to files or is discarded; nothing a child prints reaches the records
// except through those files.
import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { openSync, closeSync } from "node:fs";

export interface RunResult {
  code: number | null;
  timed_out: boolean;
  duration_ms: number;
}

/** Runs a command to completion, killing its process group after `timeoutMs`. Output is appended to `logFile` or discarded. */
export function runCommand(command: string, args: readonly string[], options: { timeoutMs: number; logFile?: string; cwd?: string; env?: Record<string, string> }): Promise<RunResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const fd = options.logFile === undefined ? null : openSync(options.logFile, "a");
    const stdio: StdioOptions = fd === null ? "ignore" : ["ignore", fd, fd];
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio, detached: true, cwd: options.cwd, env: options.env ?? { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
    } catch {
      if (fd !== null) closeSync(fd);
      resolve({ code: null, timed_out: false, duration_ms: 0 });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      if (fd !== null) closeSync(fd);
      resolve({ code, timed_out: timedOut, duration_ms: Math.round(performance.now() - started) });
    };
    child.once("error", () => {
      finish(null);
    });
    child.once("exit", (code) => {
      finish(code);
    });
  });
}

export interface Service {
  readonly child: ChildProcess;
  /** Null while running; the exit code (or -1 for a signal) once it exited. */
  exitCode(): number | null;
  /** Sends TERM to the launcher (which stops its process group) and waits up to `limitMs` for it to exit. */
  stop(limitMs: number): Promise<boolean>;
}

/** Starts a long-running command (an rbw-launch invocation) in the background. */
export function startService(command: string, args: readonly string[]): Service {
  const child = spawn(command, args, { stdio: "ignore", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
  const state: { exited: number | null } = { exited: null };
  const done = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      state.exited = code ?? -1;
      resolve();
    });
    child.once("error", () => {
      state.exited = -1;
      resolve();
    });
  });
  const exitCode = (): number | null => state.exited;
  return {
    child,
    exitCode,
    stop: async (limitMs) => {
      if (exitCode() !== null) return true;
      child.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, limitMs);
        }),
      ]);
      clearTimeout(timer);
      return exitCode() !== null;
    },
  };
}
