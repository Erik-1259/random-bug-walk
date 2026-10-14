// The run directory's writer: a record is replaced whole or not at all.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendStop, readStops, writeAtomic } from "../src/records.ts";

describe("writeAtomic", () => {
  it("writes the bytes and leaves no temporary file beside them", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-uc1-records-"));
    const path = join(dir, "root-run.json");
    writeAtomic(path, "first");
    writeAtomic(path, Buffer.from("second"));
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["root-run.json"]);
  });

  it("keeps the previous record whole when the new write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-uc1-records-"));
    const path = join(dir, "root-run.json");
    writeFileSync(path, "previous");
    // The temporary path cannot be written, as when the process stops partway: the record is untouched.
    mkdirSync(`${path}.tmp`);
    expect(() => {
      writeAtomic(path, "next");
    }).toThrow();
    expect(readFileSync(path, "utf8")).toBe("previous");
  });
});

describe("the stop log", () => {
  const first = { reason: "spend_refused", detail: "first", at: "2026-10-14T12:00:00.000Z" };
  const second = { reason: "session_refused", detail: "second", at: "2026-10-14T12:01:00.000Z" };

  it("ignores a final line cut off by an interrupted append", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-uc1-records-"));
    writeFileSync(join(dir, "stops.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify(second).slice(0, 20)}`);
    expect(readStops(dir)).toEqual([first]);
  });

  it("drops an interrupted final fragment before appending the next record", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-uc1-records-"));
    writeFileSync(join(dir, "stops.jsonl"), `${JSON.stringify(first)}\n{"reason":"cut`);
    appendStop(dir, second);
    expect(readFileSync(join(dir, "stops.jsonl"), "utf8")).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    expect(readStops(dir)).toEqual([first, second]);
  });

  it("still refuses a complete line that does not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbw-uc1-records-"));
    writeFileSync(join(dir, "stops.jsonl"), `${JSON.stringify(first)}\nnot json\n`);
    expect(() => readStops(dir)).toThrow();
  });
});
