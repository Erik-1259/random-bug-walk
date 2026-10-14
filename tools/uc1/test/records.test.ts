// The run directory's writer: a record is replaced whole or not at all.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAtomic } from "../src/records.ts";

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
