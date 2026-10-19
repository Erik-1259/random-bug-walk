import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScanHook } from "../src/export.ts";
import { readPreparedIndex } from "../src/prepared.ts";
import { PREPARE_EXIT_CODES, runPrepareCli, type ModuleLoader } from "../src/run-cli.ts";
import { SYNTHETIC_LICENSE, syntheticAdapter, syntheticIdentity } from "../src/synthetic.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "case-package-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) } };
}

function loader(scan: ScanHook = () => Promise.resolve({ outcome: "clean" })): ModuleLoader {
  const adapter = syntheticAdapter({ seeds: ["01", "02"], workdir: join(dir, "inputs") });
  const modules: Record<string, Record<string, unknown>> = {
    registry: { HOST_REGISTRY: { list: () => [{ host_id: "task-report", license: SYNTHETIC_LICENSE, adapter }] } },
    identity: { CASE_IDENTITY: syntheticIdentity },
    scan: { SCAN_HOOK: scan },
  };
  return (specifier) => {
    const module = modules[specifier];
    return module === undefined ? Promise.reject(new Error(`no module ${specifier}`)) : Promise.resolve(module);
  };
}

describe("case-package prepare", () => {
  it("exports every entry of the registry into the prepared directory", async () => {
    const capture = io();
    const out = join(dir, "prepared");
    const code = await runPrepareCli(["prepare", "--registry", "registry", "--identity", "identity", "--scan-hook", "scan", "--out", out], capture.io, loader());
    expect(code).toBe(PREPARE_EXIT_CODES.prepared);
    const index = await readPreparedIndex(out);
    expect(index.entries.map((entry) => [entry.entry_id, entry.scanned])).toEqual([["synthetic-task-report-01", true], ["synthetic-task-report-02", true]]);
    expect((await readdir(out)).filter((name) => name.endsWith(".tar.gz"))).toHaveLength(4);
  });

  it("exports only the named entries, and records an export without a scan", async () => {
    const out = join(dir, "prepared");
    const code = await runPrepareCli(["prepare", "--registry", "registry", "--identity", "identity", "--no-scan", "--entry", "synthetic-task-report-02", "--out", out], io().io, loader());
    expect(code).toBe(PREPARE_EXIT_CODES.prepared);
    expect((await readPreparedIndex(out)).entries.map((entry) => [entry.entry_id, entry.scanned])).toEqual([["synthetic-task-report-02", false]]);
  });

  it("refuses to write anything when the scan blocks a part", async () => {
    const capture = io();
    const out = join(dir, "prepared");
    const blocked: ScanHook = () => Promise.resolve({ outcome: "blocked", locations: ["bug-case.json:1"] });
    const code = await runPrepareCli(["prepare", "--registry", "registry", "--identity", "identity", "--scan-hook", "scan", "--out", out], capture.io, loader(blocked));
    expect(code).toBe(PREPARE_EXIT_CODES.refused);
    expect(capture.err.join("")).toMatch(/scan_blocked/);
    await expect(readdir(out)).rejects.toThrow();
  });

  it("needs exactly one of --scan-hook and --no-scan, and known hosts and entries", async () => {
    const out = join(dir, "prepared");
    const base = ["prepare", "--registry", "registry", "--identity", "identity", "--out", out];
    expect(await runPrepareCli(base, io().io, loader())).toBe(PREPARE_EXIT_CODES.usage);
    expect(await runPrepareCli([...base, "--no-scan", "--scan-hook", "scan"], io().io, loader())).toBe(PREPARE_EXIT_CODES.usage);
    expect(await runPrepareCli([...base, "--no-scan", "--host", "umami"], io().io, loader())).toBe(PREPARE_EXIT_CODES.usage);
    expect(await runPrepareCli([...base, "--no-scan", "--entry", "synthetic-missing"], io().io, loader())).toBe(PREPARE_EXIT_CODES.usage);
  });
});
