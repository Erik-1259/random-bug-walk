import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSubject, parseScreenInput } from "../../src/inputs.ts";
import { numbered, screenPrompt } from "../../src/prompt.ts";
import { sha256Hex } from "../../src/site.ts";
import { CLEAN_REPORT, PLANTED_REPORT } from "../fixtures/synthetic-source.ts";
import { SYNTHETIC_INPUT, syntheticTree, tempDir } from "../support.ts";

const base = (): Record<string, unknown> => JSON.parse(readFileSync(SYNTHETIC_INPUT, "utf8")) as Record<string, unknown>;

describe("parseScreenInput", () => {
  it("accepts the synthetic input", () => {
    expect(parseScreenInput(base()).target_path).toBe("src/report.ts");
  });

  it("refuses paths that leave the tree, a target not shown and a repeated file", () => {
    expect(() => parseScreenInput({ ...base(), files: ["src/report.ts", "../outside.ts"] })).toThrow();
    expect(() => parseScreenInput({ ...base(), files: ["/etc/hosts", "src/report.ts"] })).toThrow();
    expect(() => parseScreenInput({ ...base(), files: ["src/format.ts"] })).toThrow(/target_path/);
    expect(() => parseScreenInput({ ...base(), files: ["src/report.ts", "src/report.ts"] })).toThrow(/twice/);
    expect(() => parseScreenInput({ ...base(), extra: true })).toThrow();
  });
});

describe("loadSubject", () => {
  it("reads the shown files sorted, hashes both copies and finds the site", async () => {
    const tree = syntheticTree();
    const subject = await loadSubject(parseScreenInput(base()), tree.tree, tree.clean);
    expect(subject.files.map((file) => file.path)).toEqual(["src/format.ts", "src/report.ts"]);
    expect(subject.planted_sha256).toBe(sha256Hex(PLANTED_REPORT));
    expect(subject.clean_sha256).toBe(sha256Hex(CLEAN_REPORT));
    expect([subject.site.start_line, subject.site.end_line]).toEqual([12, 12]);
  });

  it("refuses a shown file that is a symlink out of the tree", async () => {
    const tree = syntheticTree();
    const outside = join(tempDir(), "secret.ts");
    writeFileSync(outside, "export const secret = 1;\n");
    symlinkSync(outside, join(tree.tree, "src", "linked.ts"));
    const input = parseScreenInput({ ...base(), files: ["src/report.ts", "src/linked.ts"] });
    await expect(loadSubject(input, tree.tree, tree.clean)).rejects.toThrow(/outside the planted tree/);
  });
});

describe("screenPrompt", () => {
  it("shows the symptom and the files by path order, numbered, and nothing of the clean form", async () => {
    const tree = syntheticTree({ files: ["src/report.ts", "src/format.ts"] });
    const subject = await loadSubject(parseScreenInput(base()), tree.tree, tree.clean);
    const prompt = screenPrompt(subject.input.symptom, subject.files);
    expect(prompt.user.startsWith(`=== Bug report ===\n${subject.input.symptom}\n=== end ===`)).toBe(true);
    expect(prompt.user.indexOf("File: src/format.ts")).toBeLessThan(prompt.user.indexOf("File: src/report.ts"));
    expect(prompt.user).toContain("12|   return formatTotal(total, rounding);");
    expect(prompt.user).not.toContain("return formatTotal(total, rounding, currency);\n}\n\nexport function buildSummary");
    expect(prompt.user).not.toContain("12|   return formatTotal(total, rounding, currency);");
    const both = `${prompt.system}\n${prompt.user}`.toLowerCase();
    for (const word of ["planted", "clean", "mutation", "screen"]) {
      expect(both).not.toContain(word);
    }
  });

  it("numbers lines from 1, padded to the widest number", () => {
    expect(numbered(Array.from({ length: 10 }, (_, i) => `l${String(i + 1)}`).join("\n")).split("\n").slice(8)).toEqual([" 9| l9", "10| l10"]);
  });
});
