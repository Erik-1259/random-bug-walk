// Memory, CPU and disk samples every 30 seconds while a trial runs: cgroup v2 memory.current and
// cpu.stat's usage_usec, and statfs on the writable paths.
import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { iso } from "./limits.ts";
import type { Timers } from "./limits.ts";

export const SAMPLE_INTERVAL_MS = 30000;

export interface DiskSample {
  path: string;
  total_bytes: number;
  free_bytes: number;
  available_bytes: number;
}

export interface ResourceSample {
  at: string;
  elapsed_ms: number;
  /** Null when the cgroup file could not be read. */
  memory_current_bytes: number | null;
  cpu_usage_usec: number | null;
  /** One entry per writable path that statfs could read. */
  disks: DiskSample[];
}

export interface StatfsResult {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

export interface SampleSources {
  readText(path: string): Promise<string>;
  statfs(path: string): Promise<StatfsResult>;
}

export const realSampleSources: SampleSources = {
  readText: (path) => readFile(path, "utf8"),
  statfs: (path) => statfs(path),
};

export function parseCpuUsage(text: string): number | null {
  const match = /^usage_usec (\d+)$/m.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function parseCount(text: string): number | null {
  const value = text.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

/** A sample value that cannot be read is recorded as absent; the sampler never fails the trial. */
async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function takeSample(
  at: number,
  elapsed: number,
  sources: SampleSources,
  cgroupDir: string,
  paths: readonly string[],
): Promise<ResourceSample> {
  const memory = await attempt(() => sources.readText(join(cgroupDir, "memory.current")));
  const cpu = await attempt(() => sources.readText(join(cgroupDir, "cpu.stat")));
  const disks: DiskSample[] = [];
  for (const path of paths) {
    const result = await attempt(() => sources.statfs(path));
    if (result === null) continue;
    disks.push({
      path,
      total_bytes: result.blocks * result.bsize,
      free_bytes: result.bfree * result.bsize,
      available_bytes: result.bavail * result.bsize,
    });
  }
  return {
    at: iso(at),
    elapsed_ms: elapsed,
    memory_current_bytes: memory === null ? null : parseCount(memory),
    cpu_usage_usec: cpu === null ? null : parseCpuUsage(cpu),
    disks,
  };
}

/** Samples now and every interval after, until stopped; stopping takes one final sample. */
export function startSampler(options: {
  timers: Timers;
  sources: SampleSources;
  cgroupDir: string;
  paths: readonly string[];
  intervalMs?: number;
}): { stop(): Promise<ResourceSample[]> } {
  const { timers, sources, cgroupDir, paths } = options;
  const interval = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const start = timers.now();
  const pending: Promise<ResourceSample>[] = [];
  let stopped = false;
  let cancel = (): void => undefined;
  const sample = (): void => {
    const now = timers.now();
    pending.push(takeSample(now, now - start, sources, cgroupDir, paths));
  };
  const schedule = (count: number): void => {
    cancel = timers.setTimeout(() => {
      if (stopped) return;
      sample();
      schedule(count + 1);
    }, start + count * interval - timers.now());
  };
  sample();
  schedule(1);
  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        cancel();
        if (timers.now() - start > 0) sample();
      }
      return Promise.all(pending);
    },
  };
}
