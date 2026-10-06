// The one place the runner starts a process: the docker CLI, with an argument list and no shell.
// Tests replace the whole layer with a fake that records the arguments.
import { spawn } from "node:child_process";

export interface CommandResult {
  /** The exit status, or null when the process could not start or was ended by a signal. */
  code: number | null;
  /** Empty when stdout was streamed into `RunOptions.stdout`. */
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  /** Ends the command with TERM, then KILL after 5 s, once this many milliseconds have passed. */
  timeoutMs?: number;
  /** Receives stdout instead of the result, with backpressure (for `docker cp <container>:<path> -`). */
  stdout?: ByteSink;
}

/** A writable that may ask its producer to wait for "drain"; Node and streamx writables both are one. */
export interface ByteSink {
  write(chunk: Buffer): boolean;
  end(chunk?: Buffer): unknown;
  once(event: "drain", listener: () => void): unknown;
}

export interface Docker {
  run(args: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

/** stderr kept per command; docker's own messages are short. */
const STDERR_LIMIT = 64 * 1024;

export function createDocker(binary = "docker"): Docker {
  return {
    run(args, options = {}) {
      return new Promise((resolve) => {
        const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        let err = "";
        let timedOut = false;
        let settled = false;
        const finish = (code: number | null, extra = ""): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          resolve({ code, stdout: Buffer.concat(out), stderr: `${err}${extra}`, timedOut });
        };
        let killTimer: NodeJS.Timeout | undefined;
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
              }, options.timeoutMs);
        const sink = options.stdout;
        if (sink === undefined) {
          child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        } else {
          child.stdout.on("data", (chunk: Buffer) => {
            if (!sink.write(chunk)) {
              child.stdout.pause();
              sink.once("drain", () => child.stdout.resume());
            }
          });
          child.stdout.on("end", () => {
            sink.end();
          });
        }
        child.stderr.on("data", (chunk: Buffer) => {
          if (err.length < STDERR_LIMIT) err += chunk.toString("utf8").slice(0, STDERR_LIMIT - err.length);
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          finish(null, `${error.code ?? "spawn_error"}\n`);
        });
        child.on("close", (code) => {
          finish(code);
        });
      });
    },
  };
}

/** A docker command written out, for the dry run and for messages. */
export function commandLine(args: readonly string[]): string {
  return ["docker", ...args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))].join(" ");
}
