// The planted site: where the planted file differs from the clean one. A line diff (longest common
// subsequence over the region left after trimming the lines both files share at the start and at the
// end) splits the change into hunks, one per run of changed lines, so a mutation that touches two
// far-apart places has two small sites rather than one wide one.
import { createHash } from "node:crypto";

export interface PlantedHunk {
  /** First and last line (1-based, inclusive) of this hunk in the planted file. */
  start_line: number;
  end_line: number;
  /** The hunk's lines in the planted file, empty when it only deleted lines. */
  planted_lines: string[];
  /** The lines the clean file has in their place: the clean form. */
  clean_lines: string[];
}

export interface PlantedSite {
  /** First and last line (1-based, inclusive) of the span from the first hunk to the last. */
  start_line: number;
  end_line: number;
  /** The planted file's lines over that span, empty when the mutation only deleted lines. */
  planted_lines: string[];
  /** The clean file's lines over the same span. */
  clean_lines: string[];
  /** Every hunk, in file order. An answer locates the site when it is near any one of them. */
  hunks: PlantedHunk[];
  /** A unified diff from clean (`-`) to planted (`+`), with up to three lines of context. */
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
 * The largest changed region (clean lines times planted lines) diffed line by line. A larger region,
 * which no single planted bug produces, is kept as one hunk.
 */
export const MAX_DIFF_CELLS = 16_000_000;

/** One run of changed lines: `removed` clean lines at `cleanAt` replaced by `added` planted lines at `plantedAt` (0-based). */
interface Change {
  cleanAt: number;
  removed: number;
  plantedAt: number;
  added: number;
}

function lineChanges(a: string[], b: string[], prefix: number, suffix: number): Change[] {
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS) {
    return [{ cleanAt: prefix, removed: n, plantedAt: prefix, added: m }];
  }
  // lcs[i * width + j]: the longest common subsequence of the region's clean lines from i and planted lines from j.
  // With at most MAX_DIFF_CELLS cells, the shorter side has at most 4,000 lines, so the length fits 16 bits.
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[prefix + i] === b[prefix + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const changes: Change[] = [];
  let open: Change | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
      open = null;
      i += 1;
      j += 1;
      continue;
    }
    if (open === null) {
      open = { cleanAt: prefix + i, removed: 0, plantedAt: prefix + j, added: 0 };
      changes.push(open);
    }
    if (j >= m || (i < n && at(i + 1, j) >= at(i, j + 1))) {
      open.removed += 1;
      i += 1;
    } else {
      open.added += 1;
      j += 1;
    }
  }
  return changes;
}

function hunkOf(a: string[], b: string[], change: Change): PlantedHunk {
  const planted_lines = b.slice(change.plantedAt, change.plantedAt + change.added);
  const clean_lines = a.slice(change.cleanAt, change.cleanAt + change.removed);
  if (change.added === 0) {
    return { start_line: Math.max(1, change.plantedAt), end_line: Math.min(b.length, change.plantedAt + 1), planted_lines, clean_lines };
  }
  return { start_line: change.plantedAt + 1, end_line: change.plantedAt + change.added, planted_lines, clean_lines };
}

/**
 * The changed hunks between the clean and planted texts. Throws when they are identical. A hunk that
 * only deleted lines is located by the planted lines on both sides of the deletion.
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
  const changes = lineChanges(a, b, prefix, suffix);
  const hunks = changes.map((change) => hunkOf(a, b, change));
  const first = hunks[0];
  const last = hunks[hunks.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("the planted file differs from the clean file but no changed line was found");
  }
  return {
    start_line: first.start_line,
    end_line: last.end_line,
    planted_lines: b.slice(prefix, b.length - suffix),
    clean_lines: a.slice(prefix, a.length - suffix),
    hunks,
    mutation: unifiedDiff(a, b, changes),
  };
}

/** `path:start-end`, one range per hunk, separated by commas: `src/a.ts:12-12, 40-41`. */
export function siteLabel(path: string, site: PlantedSite): string {
  return `${path}:${site.hunks.map((hunk) => `${String(hunk.start_line)}-${String(hunk.end_line)}`).join(", ")}`;
}

function range(start: number, count: number): string {
  return `${String(count === 0 ? start - 1 : start)},${String(count)}`;
}

/** The changes as `git diff` would print them: changes closer than twice the context share one section. */
function unifiedDiff(a: string[], b: string[], changes: Change[]): string {
  const groups: Change[][] = [];
  for (const change of changes) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    if (group !== undefined && previous !== undefined && change.cleanAt - (previous.cleanAt + previous.removed) <= 2 * CONTEXT) {
      group.push(change);
    } else {
      groups.push([change]);
    }
  }
  const out: string[] = [];
  for (const group of groups) {
    const head = group[0];
    const tail = group[group.length - 1];
    if (head === undefined || tail === undefined) {
      continue;
    }
    const before = Math.min(CONTEXT, head.cleanAt);
    const cleanEnd = tail.cleanAt + tail.removed;
    const after = Math.min(CONTEXT, a.length - cleanEnd);
    const body: string[] = a.slice(head.cleanAt - before, head.cleanAt).map((line) => ` ${line}`);
    let removed = 0;
    let added = 0;
    group.forEach((change, index) => {
      body.push(...a.slice(change.cleanAt, change.cleanAt + change.removed).map((line) => `-${line}`));
      body.push(...b.slice(change.plantedAt, change.plantedAt + change.added).map((line) => `+${line}`));
      removed += change.removed;
      added += change.added;
      const next = group[index + 1];
      if (next !== undefined) {
        body.push(...a.slice(change.cleanAt + change.removed, next.cleanAt).map((line) => ` ${line}`));
      }
    });
    body.push(...a.slice(cleanEnd, cleanEnd + after).map((line) => ` ${line}`));
    const unchanged = body.length - removed - added;
    out.push(`@@ -${range(head.cleanAt - before + 1, unchanged + removed)} +${range(head.plantedAt - before + 1, unchanged + added)} @@`, ...body);
  }
  return `${out.join("\n")}\n`;
}
