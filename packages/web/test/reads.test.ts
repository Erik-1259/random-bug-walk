// The results directory is validated once per directory per process, and the file route serves
// from that validated index, so a build reads each published file a fixed number of times.
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateStaticParams, GET } from "../app/runs/[root]/[...path]/route.ts";
import { loadResults } from "../src/release.ts";
import { cleanup, copyFixture, DEVELOPMENT, DEVELOPMENT_ROOT, publishedEntry, readManifest, runDir, writeFile, writeManifest } from "./support/results.ts";

const reads = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>();
  const readFile = (...args: Parameters<typeof original.readFile>) => {
    const [path] = args;
    reads.paths.push(typeof path === "string" ? path : "");
    return original.readFile(...args);
  };
  return { ...original, default: { ...original, readFile }, readFile };
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

/** A copy of the development fixture whose run also publishes `count` extra report files. */
function withFiles(count: number): string {
  const dir = copyFixture(DEVELOPMENT);
  const manifest = readManifest(dir, DEVELOPMENT_ROOT);
  const added = Array.from({ length: count }, (_, index) => {
    const path = `reports/synthetic-${String(index).padStart(4, "0")}.json`;
    const bytes = Buffer.from(`{"synthetic":${String(index)}}`);
    writeFile(join(runDir(dir, DEVELOPMENT_ROOT), path), bytes);
    return publishedEntry(path, DEVELOPMENT_ROOT, bytes);
  });
  writeManifest(dir, { ...manifest, entries: [...manifest.entries, ...added] });
  return dir;
}

/** Prerenders every file route of a results directory, as next build does, and counts the reads below it. */
async function buildReads(dir: string): Promise<{ files: number; reads: number }> {
  vi.stubEnv("RBW_RESULTS_DIR", dir);
  reads.paths.length = 0;
  const params = await generateStaticParams();
  for (const param of params) {
    const response = await GET(new Request("https://example.invalid/"), { params: Promise.resolve(param) });
    expect(response.status).toBe(200);
  }
  return { files: params.length, reads: reads.paths.filter((path) => path.startsWith(dir)).length };
}

describe("validated results index", () => {
  it("reads each published file a fixed number of times, so a build's reads grow linearly", async () => {
    const small = await buildReads(withFiles(20));
    const large = await buildReads(withFiles(120));
    expect(large.files - small.files).toBe(100);
    // Each added file is read once to check its hash and once to serve it.
    expect(large.reads - small.reads).toBe(2 * 100);
  });

  it("validates a directory once per process and returns the same index afterwards", async () => {
    const dir = withFiles(3);
    reads.paths.length = 0;
    const first = await loadResults(dir);
    const firstReads = reads.paths.length;
    expect(firstReads).toBeGreaterThan(0);
    expect(await loadResults(dir)).toBe(first);
    expect(await loadResults(`${dir}/`)).toBe(first);
    expect(reads.paths).toHaveLength(firstReads);
  });
});
