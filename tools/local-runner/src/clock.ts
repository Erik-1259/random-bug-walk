// The runner's one clock. Tests replace it with a fake that moves only when a sleep fires.

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    }),
};

/** A UTC time with whole seconds, as the shared schema's UtcTime takes it. */
export function utcSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}
