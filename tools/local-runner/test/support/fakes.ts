// A fake Docker command layer and a fake clock. The fake Docker records every argument list and
// answers through a handler; the fake clock moves only when a sleep that was not aborted fires.
import type { Clock } from "../../src/clock.ts";
import type { CommandResult, Docker, RunOptions } from "../../src/docker.ts";

export function ok(stdout: string | Buffer = ""): CommandResult {
  return { code: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: "", timedOut: false };
}

export function failed(code: number, stderr = "synthetic docker failure"): CommandResult {
  return { code, stdout: Buffer.alloc(0), stderr, timedOut: false };
}

export type Handler = (args: readonly string[], options: RunOptions) => CommandResult | Promise<CommandResult>;

export class FakeDocker implements Docker {
  readonly calls: string[][] = [];
  private readonly handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push([...args]);
    return this.handler(args, options);
  }

  /** The calls whose first argument is `subcommand`. */
  named(subcommand: string): string[][] {
    return this.calls.filter((call) => call[0] === subcommand);
  }
}

export class FakeClock implements Clock {
  current: number;
  readonly sleeps: number[] = [];
  private readonly manual: boolean;
  private readonly pending: { ms: number; signal: AbortSignal | undefined; resolve: () => void }[] = [];

  /** In manual mode a sleep fires only on release(); otherwise it fires on a later macrotask. */
  constructor(options: { start?: number; manual?: boolean } = {}) {
    this.current = options.start ?? Date.parse("2026-10-06T09:00:00.000Z");
    this.manual = options.manual ?? false;
  }

  now(): number {
    return this.current;
  }

  /** A command that has already answered wins a race with a sleep; an aborted sleep moves no time. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (this.manual) {
        this.pending.push({ ms, signal, resolve });
        signal?.addEventListener("abort", () => {
          resolve();
        });
        return;
      }
      setImmediate(() => {
        this.fire(ms, signal);
        resolve();
      });
    });
  }

  /** Fires every pending sleep that was not aborted (manual mode). */
  release(): void {
    for (const sleep of this.pending.splice(0)) {
      this.fire(sleep.ms, sleep.signal);
      sleep.resolve();
    }
  }

  private fire(ms: number, signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) {
      this.sleeps.push(ms);
      this.current += ms;
    }
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** A promise with its resolver, for a command that answers only when the test says so. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
