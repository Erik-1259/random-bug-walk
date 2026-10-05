// Phase limits and the whole-copy deadline. Each phase gets an abort signal that fires at the
// earlier of its own limit and the whole-copy deadline; starting a phase never moves that deadline.

/** Phase limits in milliseconds. `finish_ms` covers setup, artifacts and stop; `total_ms` caps the whole copy. */
export interface PhaseLimits {
  build_ms: number;
  readiness_ms: number;
  tests_ms: number;
  finish_ms: number;
  total_ms: number;
}

/** The tests phase holds the original suite, every reset and every round. */
export const DEFAULT_PHASE_LIMITS: PhaseLimits = {
  build_ms: 240000,
  readiness_ms: 60000,
  tests_ms: 240000,
  finish_ms: 60000,
  total_ms: 600000,
};

export interface Timers {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Runs `fn` after `ms`; returns a function that cancels it. */
  setTimeout(fn: () => void, ms: number): () => void;
  sleep(ms: number): Promise<void>;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  },
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** `enforce` stops a phase at its limit; `record-only` (development) lets it run and records the overrun. */
export type LimitsMode = "enforce" | "record-only";

/** `overrun`: the phase passed its limit in record-only mode and was not stopped. */
export type PhaseOutcome = "ok" | "failed" | "timeout" | "overrun" | "skipped";

export interface PhaseTiming {
  name: string;
  repeat_index: number | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  /** The phase's own limit; null for a nested timing (a round, or the suite inside the tests phase). */
  limit_ms: number | null;
  /** Milliseconds from the phase's start to its effective deadline (its limit or the whole-copy deadline). */
  deadline_ms: number | null;
  overrun_ms: number;
  outcome: PhaseOutcome;
}

export interface PhaseHandle {
  readonly signal: AbortSignal;
  /** Ends the phase. A phase that was stopped at its deadline, or that ran past it, is recorded as such. */
  end(outcome: "ok" | "failed" | "skipped"): PhaseTiming;
}

export interface CopyTiming {
  started_at: string;
  limit_ms: number;
  elapsed_ms: number;
  overrun_ms: number;
}

export interface Budget {
  readonly mode: LimitsMode;
  begin(name: string, limitMs: number | null, repeatIndex?: number | null): PhaseHandle;
  copy(): CopyTiming;
  /** Cancels the deadline timers of phases that never ended, after an unexpected error. */
  close(): void;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createBudget(options: { timers: Timers; mode: LimitsMode; totalMs: number }): Budget {
  const { timers, mode, totalMs } = options;
  const copyStart = timers.now();
  const copyDeadline = copyStart + totalMs;
  const open = new Set<() => void>();
  return {
    mode,
    begin(name, limitMs, repeatIndex = null) {
      const start = timers.now();
      const controller = new AbortController();
      const deadline = limitMs === null ? null : Math.min(start + limitMs, copyDeadline);
      let stopped = false;
      let cancel = (): void => undefined;
      if (deadline !== null && mode === "enforce") {
        const fire = (): void => {
          stopped = true;
          controller.abort(new Error(`${name} reached its time limit`));
        };
        if (deadline <= start) fire();
        else cancel = timers.setTimeout(fire, deadline - start);
      }
      open.add(cancel);
      return {
        signal: controller.signal,
        end(outcome) {
          cancel();
          open.delete(cancel);
          const end = timers.now();
          const duration = end - start;
          // A phase that starts after the whole-copy deadline has no allowance at all.
          const allowed = deadline === null ? null : Math.max(0, deadline - start);
          const overrun = allowed === null ? 0 : Math.max(0, duration - allowed);
          let recorded: PhaseOutcome = outcome;
          if (stopped) recorded = "timeout";
          else if (overrun > 0) recorded = mode === "enforce" ? "timeout" : "overrun";
          return {
            name,
            repeat_index: repeatIndex,
            started_at: iso(start),
            ended_at: iso(end),
            duration_ms: duration,
            limit_ms: limitMs,
            deadline_ms: allowed,
            overrun_ms: overrun,
            outcome: recorded,
          };
        },
      };
    },
    close() {
      for (const cancel of open) cancel();
      open.clear();
    },
    copy() {
      const elapsed = timers.now() - copyStart;
      return { started_at: iso(copyStart), limit_ms: totalMs, elapsed_ms: elapsed, overrun_ms: Math.max(0, elapsed - totalMs) };
    },
  };
}
