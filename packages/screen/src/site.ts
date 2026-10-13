// The planted site: where the planted file differs from the clean one, found by trimming the lines
// both files share at the start and at the end. One contiguous region covers a one-hunk mutation
// exactly, and the span of every hunk when a mutation has several.
import { createHash } from "node:crypto";

export interface PlantedSite {
  /** First and last line (1-based, inclusive) of the changed region in the planted file. */
  start_line: number;
  end_line: number;
  /** The changed lines of the planted file, empty when the mutation only deleted lines. */
  planted_lines: string[];
  /** The lines the clean file has in their place: the clean form. */
  clean_lines: string[];
  /** A unified diff of the region from clean (`-`) to planted (`+`), with up to three lines of context. */
  mutation: string;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function splitLines(text: string): string[] {
  return text.split("\n");
}

const CONTEXT = 3;

/**
 * The changed region between the clean and planted texts. Throws when they are identical. When the
 * mutation only deleted lines, the site is the planted lines on both sides of the deletion.
 */
export function plantedSite(clean: string, planted: string): PlantedSite {
  if (clean === planted) {
    throw new Error("the planted file is identical to the clean file");
  }
  const a = splitLines(clean);
  const b = splitLines(planted);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1;
  }
  const cleanLines = a.slice(prefix, a.length - suffix);
  const plantedLines = b.slice(prefix, b.length - suffix);
  let start = prefix + 1;
  let end = prefix + plantedLines.length;
  if (plantedLines.length === 0) {
    start = Math.max(1, prefix);
    end = Math.min(b.length, prefix + 1);
  }
  return {
    start_line: start,
    end_line: end,
    planted_lines: plantedLines,
    clean_lines: cleanLines,
    mutation: unifiedHunk(a, b, prefix, cleanLines.length, plantedLines.length),
  };
}

/** One hunk from clean (`-`) to planted (`+`), with context, as `git diff` would print it. */
function unifiedHunk(a: string[], b: string[], prefix: number, removed: number, added: number): string {
  const before = Math.min(CONTEXT, prefix);
  const after = Math.min(CONTEXT, a.length - prefix - removed);
  const head = a.slice(prefix - before, prefix);
  const tail = a.slice(prefix + removed, prefix + removed + after);
  const cleanStart = prefix - before + 1;
  const cleanCount = before + removed + after;
  const plantedCount = before + added + after;
  const lines = [
    `@@ -${String(cleanCount === 0 ? cleanStart - 1 : cleanStart)},${String(cleanCount)} +${String(plantedCount === 0 ? cleanStart - 1 : cleanStart)},${String(plantedCount)} @@`,
    ...head.map((line) => ` ${line}`),
    ...a.slice(prefix, prefix + removed).map((line) => `-${line}`),
    ...b.slice(prefix, prefix + added).map((line) => `+${line}`),
    ...tail.map((line) => ` ${line}`),
  ];
  return `${lines.join("\n")}\n`;
}
