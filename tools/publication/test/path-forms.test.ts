import { describe, expect, it } from "vitest";
import { FORMS_FILE_LIMIT, entryFiles, entryPosition, pathForms, type EntryFile } from "../src/scan.ts";
import { STUB_LEAK_MARKER } from "./support.ts";

/** Every printable ASCII character that is not a letter or a digit. */
const NEIGHBORS = Array.from({ length: 95 }, (_unused, index) => String.fromCharCode(32 + index)).filter((character) => !/[A-Za-z0-9]/.test(character));

/**
 * The rule the forms must meet, written out directly: every part of `path` that starts at its
 * start or right after a character other than an ASCII letter or digit, ends at its end or right
 * before such a character, and has 1 to 256 characters. A character outside the BMP is one
 * character.
 */
function boundedParts(path: string): string[] {
  const characters = Array.from(path);
  const offsets = [0];
  for (const character of characters) offsets.push((offsets.at(-1) ?? 0) + character.length);
  const separator = (index: number): boolean => !/^[A-Za-z0-9]$/.test(characters[index] ?? "");
  const parts: string[] = [];
  for (let start = 0; start < characters.length; start += 1) {
    if (start > 0 && !separator(start - 1)) continue;
    for (let end = start + 1; end <= characters.length; end += 1) {
      if (end < characters.length && !separator(end)) continue;
      const part = path.slice(offsets[start], offsets[end]);
      if (part.length <= 256) parts.push(part);
    }
  }
  return parts;
}

/** The text of `file` as lines. */
function fileLines(file: EntryFile): string[] {
  return Buffer.from(file.content).toString("utf8").split("\n");
}

describe("PUB-02 path forms", () => {
  const marker = STUB_LEAK_MARKER;
  const samples = [
    ...NEIGHBORS.flatMap((neighbor, index) => {
      const next = NEIGHBORS[(index + 1) % NEIGHBORS.length] ?? neighbor;
      return [
        `cfg/x${neighbor}${marker}${neighbor}y.md`,
        `cfg/x${neighbor}${marker}${next}y.md`,
        `${neighbor}${marker}`,
        `${marker}${neighbor}`,
        `${neighbor}${neighbor}${marker}${neighbor}${neighbor}`,
      ];
    }),
    `données/é${marker}é.txt`,
    `keys/\u{1f511}${marker}\u{1f511}.md`,
    `x-${marker}-${"a".repeat(300)}`,
    "a.b-c_d~e+f@g=h,i(j k)l[m]n{o}p'q\"r`s;t:u<v>w?x*y|z\\0!1#2$3%4^5&6",
  ];

  it.each(samples)("gives every part bounded by characters other than letters and digits as a form of %j", (path) => {
    const forms = pathForms(path);
    const missing = boundedParts(path).filter((part) => !forms.has(part));
    expect(missing).toEqual([]);
    if (path.includes(marker)) expect(forms.has(marker)).toBe(true);
  });

  it("bounds the span forms at 256 characters", () => {
    expect(pathForms(`x-${"a".repeat(256)}-y`).has("a".repeat(256))).toBe(true);
    expect(pathForms(`x-${"a".repeat(257)}-y`).has("a".repeat(257))).toBe(false);
  });

  it("keeps the forms with separators as spaces and the prefixes", () => {
    const forms = pathForms(`cfg/x.${marker}.md`);
    for (const form of [`cfg x ${marker} md`, "cfg", `cfg/x`, `cfg/x.${marker}`, "cfg x", `cfg x.${marker}`, `cfg x.${marker}.md`]) {
      expect(forms.has(form)).toBe(true);
    }
  });

  it("writes entries as the fixed first line, then each entry and five empty lines", () => {
    const [file, ...rest] = entryFiles(
      [
        { entries: ["a", "b"], position: 1 },
        { entries: ["c"], position: 2 },
      ],
      Infinity,
    );
    expect(rest).toEqual([]);
    if (file === undefined) throw new Error("no file");
    expect(Buffer.from(file.content).toString("utf8")).toBe("path list\n\na\n\n\n\n\n\nb\n\n\n\n\n\nc\n\n\n\n\n");
    const positions = fileLines(file).map((_line, index) => entryPosition(file, index + 1));
    expect(positions).toEqual([undefined, undefined, 1, ...Array<undefined>(5), 1, ...Array<undefined>(5), 2, ...Array<undefined>(5)]);
    expect(entryPosition(file, 0)).toBeUndefined();
    expect(entryPosition(file, positions.length + 1)).toBeUndefined();
  });

  it("splits entries into files of at most the limit, never splitting one path's block", () => {
    const blocks = Array.from({ length: 40 }, (_unused, index) => ({
      entries: Array.from({ length: 1 + (index % 4) }, (_entry, entry) => `p${String(index)}-${String(entry)}-${"x".repeat(index % 7)}`),
      position: index + 1,
    }));
    blocks[20] = { entries: Array.from({ length: 30 }, (_entry, entry) => `big-${String(entry)}`), position: 21 };
    const limit = 200;
    const files = entryFiles(blocks, limit);
    expect(files.length).toBeGreaterThan(5);
    const seen: { entry: string; position: number }[] = [];
    for (const file of files) {
      const lines = fileLines(file);
      expect(lines.slice(0, 2)).toEqual(["path list", ""]);
      // Only a file that holds a single block may be larger than the limit.
      if (new Set(file.positions).size > 1) expect(file.content.length).toBeLessThanOrEqual(limit);
      lines.forEach((line, index) => {
        if (index < 2) return;
        const position = entryPosition(file, index + 1);
        if (position === undefined) expect(line).toBe("");
        else seen.push({ entry: line, position });
      });
    }
    // Every entry once, in order, each with its block's position; each block lies in one file.
    expect(seen).toEqual(blocks.flatMap((block) => block.entries.map((entry) => ({ entry, position: block.position }))));
    const fileOf = new Map<number, number>();
    files.forEach((file, index) => {
      for (const position of file.positions) {
        expect(fileOf.get(position) ?? index).toBe(index);
        fileOf.set(position, index);
      }
    });
    expect(files.some((file) => file.content.length > limit && new Set(file.positions).size === 1)).toBe(true);
  });

  it("limits forms files to 32 MiB", () => {
    expect(FORMS_FILE_LIMIT).toBe(32 * 1024 * 1024);
  });
});
