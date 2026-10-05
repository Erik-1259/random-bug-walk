import { describe, expect, it } from "vitest";
import { SAMPLE_INTERVAL_MS, parseCpuUsage, startSampler } from "../../src/samples.ts";
import type { SampleSources } from "../../src/samples.ts";
import { FakeTimers } from "../helpers.ts";

function sources(overrides: Partial<SampleSources> = {}): { sources: SampleSources; reads: string[] } {
  const reads: string[] = [];
  let memory = 1000;
  return {
    reads,
    sources: {
      readText: (path) => {
        reads.push(path);
        if (path.endsWith("memory.current")) {
          memory += 1000;
          return Promise.resolve(`${String(memory)}\n`);
        }
        return Promise.resolve("usage_usec 250\nuser_usec 200\nsystem_usec 50\n");
      },
      statfs: () => Promise.resolve({ bsize: 512, blocks: 100, bfree: 40, bavail: 30 }),
      ...overrides,
    },
  };
}

describe("resource samples", () => {
  it("samples at the start and every 30 seconds, reading cgroup v2 files and statfs", async () => {
    const timers = new FakeTimers();
    const { sources: src, reads } = sources();
    const sampler = startSampler({ timers, sources: src, cgroupDir: "/sys/fs/cgroup", paths: ["/var/lib/rbw/pgdata"] });
    timers.advance(95000);
    const samples = await sampler.stop();
    expect(SAMPLE_INTERVAL_MS).toBe(30000);
    expect(samples.map((sample) => sample.elapsed_ms)).toEqual([0, 30000, 60000, 90000, 95000]);
    expect(samples[1]).toEqual({
      at: "2026-10-05T00:00:30.000Z",
      elapsed_ms: 30000,
      memory_current_bytes: 3000,
      cpu_usage_usec: 250,
      disks: [{ path: "/var/lib/rbw/pgdata", total_bytes: 51200, free_bytes: 20480, available_bytes: 15360 }],
    });
    expect(reads).toContain("/sys/fs/cgroup/memory.current");
    expect(reads).toContain("/sys/fs/cgroup/cpu.stat");
  });

  it("records null for a cgroup file it cannot read, and leaves out a path statfs cannot read", async () => {
    const timers = new FakeTimers();
    const { sources: src } = sources({
      readText: () => Promise.reject(new Error("ENOENT")),
      statfs: () => Promise.reject(new Error("ENOENT")),
    });
    const sampler = startSampler({ timers, sources: src, cgroupDir: "/sys/fs/cgroup", paths: ["/missing"] });
    const samples = await sampler.stop();
    expect(samples).toEqual([
      { at: "2026-10-05T00:00:00.000Z", elapsed_ms: 0, memory_current_bytes: null, cpu_usage_usec: null, disks: [] },
    ]);
  });

  it("stops sampling once stopped", async () => {
    const timers = new FakeTimers();
    const sampler = startSampler({ timers, sources: sources().sources, cgroupDir: "/sys/fs/cgroup", paths: [] });
    timers.advance(1000);
    const samples = await sampler.stop();
    timers.advance(120000);
    expect(samples).toHaveLength(2);
  });

  it("reads usage_usec from cpu.stat", () => {
    expect(parseCpuUsage("usage_usec 123\nuser_usec 100\n")).toBe(123);
    expect(parseCpuUsage("user_usec 100\n")).toBeNull();
  });
});
