import { cpSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECORDED_SYNTHETIC_DIR, RecordedModeError, loadRecordedDir, runRecorded } from "../../src/recorded.ts";
import type { RecordedContext } from "../../src/recorded.ts";
import { FakeClock } from "../support/fakes.ts";
import { tempDir } from "../support/synthetic.ts";

const CONTEXT: RecordedContext = {
  project_id: "00000000-0000-4000-8000-000000000001",
  project_policy_sha256: "0".repeat(64),
  batch_id: "00000000-0000-4000-8000-000000000002",
  task_revision: "1".repeat(64),
  root_execution_id: "00000000-0000-4000-8000-000000000003",
  execution_id: "00000000-0000-4000-8000-000000000004",
  parent_execution_id: "00000000-0000-4000-8000-000000000003",
};

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

function copyWithout(file: string): string {
  const dir = join(tempDir(), "recorded");
  cpSync(RECORDED_SYNTHETIC_DIR, dir, { recursive: true });
  rmSync(join(dir, file));
  return dir;
}

async function refusal(run: Promise<unknown>): Promise<RecordedModeError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RecordedModeError) return error;
    throw error;
  }
  throw new Error("expected the recorded run to fail closed");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("card, issue and phrase searches in recorded mode", () => {
  it("writes the card and the issue and runs the three exact-phrase searches from the shipped synthetic recordings", async () => {
    const result = await runRecorded(loadRecordedDir(RECORDED_SYNTHETIC_DIR), CONTEXT, { clock: new FakeClock() });
    expect(result.provenance).toEqual(["synthetic"]);
    expect(result.card).toMatchObject({ status: "completed", card: { bug_class: "time_and_date" } });
    expect(result.issue).toMatchObject({ status: "completed", report: { status: "ready_for_review" } });
    expect(result.search.records.map((record) => [record.call_name, record.outcome])).toEqual([
      ["phrase-1", "no_public_match"],
      ["phrase-2", "no_public_match"],
      ["phrase-3", "no_public_match"],
    ]);
    expect(result.search.novelty.status).toBe("clear");
    expect(result.ledger.slot_released).toBe(true);
    expect(result.ledger.operations.every((operation) => operation.state === "reconciled" || operation.state === "terminal")).toBe(true);
  });

  it("fails closed when the issue recording is missing", async () => {
    const error = await refusal(runRecorded(loadRecordedDir(copyWithout("writer/issue-valid.json")), CONTEXT, { clock: new FakeClock() }));
    expect(error.code).toBe("recording_missing");
    expect(error.message).toContain("writer.issue");
  });

  it("fails closed when a phrase-search recording is missing", async () => {
    const error = await refusal(runRecorded(loadRecordedDir(copyWithout("search/phrase-2.json")), CONTEXT, { clock: new FakeClock() }));
    expect(error.code).toBe("recording_missing");
    expect(error.message).toContain("phrase-2");
  });

  it("refuses a recordings directory with two recordings for one search request", () => {
    const dir = join(tempDir(), "recorded");
    cpSync(RECORDED_SYNTHETIC_DIR, dir, { recursive: true });
    cpSync(join(dir, "search", "phrase-1.json"), join(dir, "search", "phrase-1-again.json"));
    expect(() => loadRecordedDir(dir)).toThrow(RecordedModeError);
  });

  it("reads no API key variable and opens no socket", async () => {
    const read: string[] = [];
    const original = process.env;
    process.env = new Proxy(original, {
      get(target, key, receiver) {
        if (typeof key === "string") read.push(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
      has(target, key) {
        if (typeof key === "string") read.push(key);
        return Reflect.has(target, key);
      },
    });
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    try {
      await runRecorded(loadRecordedDir(RECORDED_SYNTHETIC_DIR), CONTEXT, { clock: new FakeClock() });
    } finally {
      process.env = original;
    }
    expect(read.filter((key) => /KEY|TOKEN|SECRET/i.test(key))).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("ships byte copies of the writer's and the search package's synthetic recordings", () => {
    const writer = join(REPO, "packages", "writer", "test", "fixtures", "recordings");
    for (const file of readdirSync(join(RECORDED_SYNTHETIC_DIR, "writer"))) {
      expect(readFileSync(join(RECORDED_SYNTHETIC_DIR, "writer", file)).equals(readFileSync(join(writer, file)))).toBe(true);
    }
    const search = join(REPO, "packages", "search", "recordings", "synthetic");
    for (const file of readdirSync(join(RECORDED_SYNTHETIC_DIR, "search"))) {
      const source = file.replace(".json", ".zero-results.json");
      expect(readFileSync(join(RECORDED_SYNTHETIC_DIR, "search", file)).equals(readFileSync(join(search, source)))).toBe(true);
    }
  });

  it("hashes every input file of the recordings directory", () => {
    const dir = loadRecordedDir(RECORDED_SYNTHETIC_DIR);
    expect(Object.keys(dir.files)).toEqual([
      "search-input.json",
      "search-rates.json",
      "search/phrase-1.json",
      "search/phrase-2.json",
      "search/phrase-3.json",
      "writer-input.json",
      "writer-rates.json",
      "writer/card-valid.json",
      "writer/issue-valid.json",
    ]);
    expect(Object.values(dir.files).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });
});
