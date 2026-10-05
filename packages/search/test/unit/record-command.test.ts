import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectoryRecordStore, installWireTap, runRecord } from "../../src/index.ts";
import type { Recording } from "../support/replay-server.ts";
import { ALL_OK, CONTEXT, SEARCH_INPUT, SLOT, wireBody } from "../support/fixtures.ts";
import { makeWorld } from "../support/harness.ts";
import type { World } from "../support/harness.ts";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let world: World | undefined;
const dirs: string[] = [];

afterEach(async () => {
  if (world !== undefined) {
    expect(world.server.unmatched).toEqual([]);
    await world.close();
    world = undefined;
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-record-"));
  dirs.push(dir);
  return dir;
}

async function holder(w: World): Promise<string | null> {
  const status = await w.rawSpend.slotStatus({ slot_key: SLOT });
  if (!status.ok) {
    throw new Error("slot status refused");
  }
  return status.holder;
}

describe("record command wiring", () => {
  it("runs six reserved and settled calls, writes live recordings and records, and releases the slot", async () => {
    const out = outDir();
    world = await makeWorld({ recordings: ALL_OK, store: createDirectoryRecordStore(out), holdSlot: false });
    const lines: string[] = [];
    const tap = installWireTap();
    const result = await runRecord({
      searcher: world.searcher,
      spend: world.spend,
      context: CONTEXT,
      input: SEARCH_INPUT,
      slotKey: SLOT,
      outDir: out,
      tap,
      write: (line) => lines.push(line),
    });
    tap.remove();

    expect(result.exitCode).toBe(0);
    expect(world.log.filter((entry) => entry === "reserve")).toHaveLength(6);
    expect(world.log.filter((entry) => entry === "settle")).toHaveLength(6);
    expect(world.server.requests.map((r) => r.endpoint)).toEqual([
      "search",
      "search",
      "extract",
      "search",
      "search",
      "search",
    ]);
    expect(await holder(world)).toBeNull();

    expect(result.summaries.map((s) => s.name)).toEqual(["source-1", "source-2", "docs-1", "phrase-1", "phrase-2", "phrase-3"]);
    expect(result.summaries[0]).toMatchObject({
      outcome: "complete",
      reserved_microusd: 16_000n,
      settled_microusd: 8_000n,
      reported_credits: 1,
    });
    expect(result.summaries[3]?.outcome).toBe("no_public_match");
    expect(result.summaries[0]?.operation_id).toMatch(/^[0-9a-f]{64}$/);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("source-1");
    expect(lines[0]).toContain(result.summaries[0]?.operation_id ?? "missing");

    const files = readdirSync(out).sort();
    expect(files.filter((f) => f.endsWith(".recording.json"))).toHaveLength(6);
    expect(files.filter((f) => f.endsWith(".record.json"))).toHaveLength(6);
    const recording = JSON.parse(readFileSync(join(out, "docs-1.recording.json"), "utf8")) as Recording;
    expect(recording).toMatchObject({ provenance: "live", endpoint: "extract", schema_version: 1 });
    expect(recording.request_body).toEqual(wireBody("docs-1"));
    expect(recording.response.status).toBe(200);
    const everything = files.map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    expect(everything).not.toMatch(/api_key|authorization|bearer|synthetic-key-for-tests/i);
  });

  it("stops at the first spend refusal, exits non-zero and leaves the slot held", async () => {
    const out = outDir();
    world = await makeWorld({ recordings: ALL_OK, store: createDirectoryRecordStore(out), holdSlot: false, cap: 20_000 });
    const tap = installWireTap();
    const result = await runRecord({
      searcher: world.searcher,
      spend: world.spend,
      context: CONTEXT,
      input: SEARCH_INPUT,
      slotKey: SLOT,
      outDir: out,
      tap,
      write: () => undefined,
    });
    tap.remove();
    expect(result.exitCode).not.toBe(0);
    expect(result.summaries.map((s) => s.name)).toEqual(["source-1", "source-2"]);
    expect(result.summaries[1]?.reason).toBe("spend_refused:insufficient_funds");
    expect(world.server.requests).toHaveLength(1);
    expect(await holder(world)).toBe(CONTEXT.root_execution_id);
  });

  it("stops at an uncertain operation and leaves the slot held", async () => {
    const out = outDir();
    world = await makeWorld({
      recordings: [],
      store: createDirectoryRecordStore(out),
      holdSlot: false,
      fault: () => "reset",
    });
    const tap = installWireTap();
    const result = await runRecord({
      searcher: world.searcher,
      spend: world.spend,
      context: CONTEXT,
      input: SEARCH_INPUT,
      slotKey: SLOT,
      outDir: out,
      tap,
      write: () => undefined,
    });
    tap.remove();
    expect(result.exitCode).not.toBe(0);
    expect(result.summaries).toHaveLength(1);
    expect(world.server.requests).toHaveLength(1);
    expect(await holder(world)).toBe(CONTEXT.root_execution_id);
  });

  it("records a provider error as incomplete and continues with the next call", async () => {
    const out = outDir();
    world = await makeWorld({
      recordings: ["source-1.500", "source-2.ok", "docs-1.ok", "phrase-1.zero-results", "phrase-2.zero-results", "phrase-3.zero-results"],
      store: createDirectoryRecordStore(out),
      holdSlot: false,
    });
    const tap = installWireTap();
    const result = await runRecord({
      searcher: world.searcher,
      spend: world.spend,
      context: CONTEXT,
      input: SEARCH_INPUT,
      slotKey: SLOT,
      outDir: out,
      tap,
      write: () => undefined,
    });
    tap.remove();
    expect(result.summaries).toHaveLength(6);
    expect(result.summaries[0]).toMatchObject({ outcome: "incomplete", reason: "provider_error" });
    expect(result.summaries[1]?.outcome).toBe("complete");
    expect(result.exitCode).toBe(0);
    const failed = JSON.parse(readFileSync(join(out, "source-1.recording.json"), "utf8")) as Recording;
    expect(failed.response.status).toBe(500);
  });
});

describe("recorded exchanges and provider request IDs", () => {
  const withRequestId = (recording: Recording): Recording => ({
    ...recording,
    response: {
      ...recording.response,
      body: { ...(recording.response.body as Record<string, unknown>), request_id: "synthetic-provider-request-id" },
    },
  });

  it("writes no request_id into any saved file and the saved exchange still replays", async () => {
    const out = outDir();
    world = await makeWorld({
      recordings: ALL_OK,
      store: createDirectoryRecordStore(out),
      holdSlot: false,
      mapRecording: withRequestId,
    });
    const tap = installWireTap();
    const result = await runRecord({
      searcher: world.searcher,
      spend: world.spend,
      context: CONTEXT,
      input: SEARCH_INPUT,
      slotKey: SLOT,
      outDir: out,
      tap,
      write: () => undefined,
    });
    tap.remove();
    expect(result.exitCode).toBe(0);
    const files = readdirSync(out);
    const everything = files.map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    expect(everything).not.toMatch(/request_?id|synthetic-provider-request-id/i);
    const saved = files
      .filter((f) => f.endsWith(".recording.json"))
      .map((f) => JSON.parse(readFileSync(join(out, f), "utf8")) as Recording);
    expect(saved).toHaveLength(6);
    await world.close();

    world = await makeWorld({ recordings: [], extraRecordings: saved });
    const replay = await world.searcher.searchSource("source-1", SEARCH_INPUT);
    expect(replay).toMatchObject({ status: "recorded", record: { outcome: "complete" } });
  });

  it("keeps request_id out of the committed synthetic recordings", () => {
    const dir = join(PACKAGE_DIR, "recordings", "synthetic");
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/request_?id/i);
    }
  });
});

describe("record command line", () => {
  function run(env: Record<string, string>, args: string[] = []): { status: number | null; stderr: string; stdout: string } {
    const result = spawnSync("node", ["src/record-cli.ts", ...args], {
      cwd: PACKAGE_DIR,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  }
  const ARGS = ["--context", "c.json", "--rate-sheet", "r.json", "--input", "i.json", "--out", "o", "--slot-key", "s", "--pool", "p"];

  it("exits non-zero naming DATABASE_URL when it is unset", () => {
    const result = run({ TAVILY_API_KEY: "synthetic-key-for-tests" }, ARGS);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.stderr).not.toContain("synthetic-key-for-tests");
  });

  it("exits non-zero naming TAVILY_API_KEY when it is unset", () => {
    const result = run({ DATABASE_URL: "postgres://synthetic-user:synthetic-pass@127.0.0.1:1/synthetic" }, ARGS);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TAVILY_API_KEY");
    expect(result.stderr + result.stdout).not.toContain("synthetic-pass");
  });

  it("exits non-zero with usage when an argument is missing", () => {
    const result = run({ DATABASE_URL: "x", TAVILY_API_KEY: "y" }, ["--context", "c.json"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });
});
