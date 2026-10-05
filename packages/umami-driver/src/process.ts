// Runs commands without a shell, each in its own process group, with bounded output capture, and
// stops a group with TERM, a short wait, then KILL, confirming that the group has ended.
import { spawn } from "node:child_process";
import type { Timers } from "./limits.ts";

/** Each stdout and stderr stream is cut at 1 MiB; the rest is counted but not kept. */
export const STREAM_LIMIT_BYTES = 1024 * 1024;

export interface CapturedStream {
  bytes: Buffer;
  total_bytes: number;
  truncated: boolean;
}

export interface CommandSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The child's whole environment; nothing is inherited from the driver. */
  env: Readonly<Record<string, string>>;
  /** Aborting stops the command's process group. */
  signal?: AbortSignal;
}

export interface StopRecord {
  pgid: number;
  term_sent: boolean;
  kill_sent: boolean;
  /** True only when the group was confirmed gone. */
  ended: boolean;
  waited_ms: number;
}

export interface CommandResult {
  /** Exit status, or null when the command could not start or ended by a signal. */
  code: number | null;
  signal: string | null;
  spawn_failed: boolean;
  /** True when the command was stopped because its signal was aborted. */
  aborted: boolean;
  stdout: CapturedStream;
  stderr: CapturedStream;
  stop: StopRecord | null;
}

export interface LongProcess {
  /** Process ID, which is also the process group ID. */
  pid: number;
  /** Settles when the process exits. */
  result: Promise<CommandResult>;
}

export interface ProcessRunner {
  /** Runs a command to completion, stopping its group if the signal aborts. */
  run(spec: CommandSpec): Promise<CommandResult>;
  /** Starts a long-running command; the caller stops its group. */
  start(spec: CommandSpec): LongProcess;
}

export interface GroupControl {
  signal(pgid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** True while any process in the group exists. */
  alive(pgid: number): boolean;
}

export const realGroups: GroupControl = {
  signal(pgid, signal) {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
  alive(pgid) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  },
};

export interface StopOptions {
  graceMs: number;
  killWaitMs: number;
  pollMs: number;
}

/**
 * The grace before KILL is longer than the kit launcher's own stop (TERM, 5 s, KILL, up to 5 s,
 * then up to 5 s to drain its output), so a launcher in a group the driver stops can stop its own
 * group first.
 */
export const DEFAULT_STOP: StopOptions = { graceMs: 20000, killWaitMs: 5000, pollMs: 100 };

async function waitGone(pgid: number, control: GroupControl, timers: Timers, limitMs: number, pollMs: number): Promise<boolean> {
  const start = timers.now();
  for (;;) {
    if (!control.alive(pgid)) return true;
    if (timers.now() - start >= limitMs) return false;
    await timers.sleep(pollMs);
  }
}

/** TERM, a wait of up to `graceMs`, then KILL and a wait of up to `killWaitMs`; reports whether the group ended. */
export async function stopProcessGroup(
  pgid: number,
  options: StopOptions & { control: GroupControl; timers: Timers },
): Promise<StopRecord> {
  const { control, timers } = options;
  const start = timers.now();
  control.signal(pgid, "SIGTERM");
  if (await waitGone(pgid, control, timers, options.graceMs, options.pollMs)) {
    return { pgid, term_sent: true, kill_sent: false, ended: true, waited_ms: timers.now() - start };
  }
  control.signal(pgid, "SIGKILL");
  const ended = await waitGone(pgid, control, timers, options.killWaitMs, options.pollMs);
  return { pgid, term_sent: true, kill_sent: true, ended, waited_ms: timers.now() - start };
}

/** Keeps the first `limit` bytes of a stream and counts the rest. */
export function captureStream(limit: number): { push(chunk: Buffer): void; result(): CapturedStream } {
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      if (keptBytes < limit) {
        const part = chunk.subarray(0, limit - keptBytes);
        kept.push(part);
        keptBytes += part.length;
      }
    },
    result() {
      return { bytes: Buffer.concat(kept), total_bytes: total, truncated: total > keptBytes };
    },
  };
}

export function createProcessRunner(
  timers: Timers,
  stopOptions: StopOptions = DEFAULT_STOP,
  control: GroupControl = realGroups,
): ProcessRunner {
  const launch = (spec: CommandSpec): LongProcess & { stopped: () => Promise<StopRecord> } => {
    const stdout = captureStream(STREAM_LIMIT_BYTES);
    const stderr = captureStream(STREAM_LIMIT_BYTES);
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stopping: Promise<StopRecord> | null = null;
    let aborted = false;
    const stop = (): Promise<StopRecord> => {
      const pid = child.pid;
      if (pid === undefined) return Promise.resolve({ pgid: 0, term_sent: false, kill_sent: false, ended: true, waited_ms: 0 });
      stopping ??= stopProcessGroup(pid, { ...stopOptions, control, timers });
      return stopping;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    const onAbort = (): void => {
      aborted = true;
      void stop();
    };
    const result = new Promise<CommandResult>((resolve) => {
      let settled = false;
      const finish = async (code: number | null, signal: string | null, spawnFailed: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        spec.signal?.removeEventListener("abort", onAbort);
        const record = stopping === null ? null : await stopping;
        resolve({
          code,
          signal,
          spawn_failed: spawnFailed,
          aborted,
          stdout: stdout.result(),
          stderr: stderr.result(),
          stop: record,
        });
      };
      child.on("error", () => {
        void finish(null, null, true);
      });
      child.on("close", (code, signal) => {
        void finish(code, signal, false);
      });
    });
    if (spec.signal?.aborted === true) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });
    return { pid: child.pid ?? 0, result, stopped: stop };
  };
  return {
    run: (spec) => launch(spec).result,
    start: (spec) => {
      const { pid, result } = launch(spec);
      return { pid, result };
    },
  };
}
