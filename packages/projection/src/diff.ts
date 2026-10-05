import { InputError, isRepoPath } from "./input.ts";

export interface PatchLine {
  op: " " | "-" | "+";
  text: Buffer;
  /** False when the diff marks this line with "\ No newline at end of file". */
  newline: boolean;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export interface FilePatch {
  path: string;
  hunks: Hunk[];
}

const MUTATION = "malformed_mutation";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (100644|100755))?$/;

function fail(): never {
  throw new InputError(MUTATION);
}

function headerPath(line: string, prefix: string): string {
  if (!line.startsWith(prefix)) fail();
  const raw = line.slice(prefix.length);
  // git appends a tab to these lines when the name contains a space.
  const path = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (path.startsWith('"') || !isRepoPath(path)) fail();
  return path;
}

/**
 * Parses a git-style unified diff that only modifies files: one `diff --git` section per
 * file, an optional `index` line, `---`/`+++` with the same path, then hunks. Mode changes,
 * new, deleted, renamed, copied, binary and quoted-path sections are refused.
 */
export function parseDiff(diff: string): FilePatch[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) fail();
  const patches: FilePatch[] = [];
  let index = 0;
  const next = (): string => {
    const line = lines[index];
    if (line === undefined) fail();
    index += 1;
    return line;
  };
  while (index < lines.length) {
    const header = next();
    if (!header.startsWith("diff --git ")) fail();
    let line = next();
    if (INDEX_LINE.test(line)) line = next();
    const path = headerPath(line, "--- a/");
    if (headerPath(next(), "+++ b/") !== path || header !== `diff --git a/${path} b/${path}`) fail();
    if (patches.some((patch) => patch.path === path)) fail();
    const hunks: Hunk[] = [];
    while (index < lines.length && lines[index]?.startsWith("@@ ") === true) {
      const hunk = parseHunk(next(), next, () => lines[index]);
      const previous = hunks.at(-1);
      if (previous !== undefined && hunk.oldStart <= previous.oldStart + previous.oldCount - (previous.oldCount === 0 ? 0 : 1)) fail();
      hunks.push(hunk);
    }
    if (hunks.length === 0) fail();
    patches.push({ path, hunks });
  }
  return patches;
}

function parseHunk(header: string, next: () => string, peek: () => string | undefined): Hunk {
  const match = HUNK_HEADER.exec(header);
  if (match === null) fail();
  const hunk: Hunk = {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    lines: [],
  };
  let oldLeft = hunk.oldCount;
  let newLeft = hunk.newCount;
  while (oldLeft > 0 || newLeft > 0) {
    const line = next();
    const op = line[0];
    if (op !== " " && op !== "-" && op !== "+") fail();
    const last = hunk.lines.at(-1);
    // A line without a newline can only end its side of the hunk.
    if (last !== undefined && !last.newline && (op === last.op || op === " " || last.op === " ")) fail();
    if (op !== "+") oldLeft -= 1;
    if (op !== "-") newLeft -= 1;
    if (oldLeft < 0 || newLeft < 0) fail();
    hunk.lines.push({ op, text: Buffer.from(line.slice(1), "utf8"), newline: true });
    if (peek()?.startsWith("\\ ") === true) {
      next();
      const last = hunk.lines.at(-1);
      // An empty line without a newline is zero bytes, not a line; no file holds one.
      if (last === undefined || last.text.length === 0) fail();
      last.newline = false;
    }
  }
  return hunk;
}

interface Line {
  text: Buffer;
  newline: boolean;
}

function splitLines(bytes: Buffer): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0x0a, start);
    if (end < 0) {
      lines.push({ text: bytes.subarray(start), newline: false });
      break;
    }
    lines.push({ text: bytes.subarray(start, end), newline: true });
    start = end + 1;
  }
  return lines;
}

/** Joins lines, or returns null when a line other than the last lacks its newline, or an empty line lacks one. */
function joinLines(lines: readonly Line[]): Buffer | null {
  if (lines.some((line, index) => !line.newline && (index < lines.length - 1 || line.text.length === 0))) return null;
  return Buffer.concat(lines.flatMap((line) => (line.newline ? [line.text, Buffer.from("\n")] : [line.text])));
}

/**
 * ADM-01: applies a patch at exactly the positions its hunk headers state, with no fuzz and
 * no offset, so that forward and reverse application are inverses. Returns null when the
 * bytes do not match the patch.
 */
export function applyPatch(original: Buffer, patch: FilePatch, direction: "forward" | "reverse"): Buffer | null {
  const source = splitLines(original);
  const output: Line[] = [];
  let cursor = 0;
  const reverse = direction === "reverse";
  for (const hunk of patch.hunks) {
    const fromStart = reverse ? hunk.newStart : hunk.oldStart;
    const fromCount = reverse ? hunk.newCount : hunk.oldCount;
    const toStart = reverse ? hunk.oldStart : hunk.newStart;
    const toCount = reverse ? hunk.oldCount : hunk.newCount;
    let position = fromCount === 0 ? fromStart : fromStart - 1;
    if (position < cursor || position > source.length) return null;
    output.push(...source.slice(cursor, position));
    if (toStart !== (toCount === 0 ? output.length : output.length + 1)) return null;
    for (const line of hunk.lines) {
      const op = reverse && line.op !== " " ? (line.op === "-" ? "+" : "-") : line.op;
      if (op !== "+") {
        const current = source[position];
        if (current?.newline !== line.newline || !current.text.equals(line.text)) return null;
        position += 1;
      }
      if (op !== "-") output.push({ text: line.text, newline: line.newline });
    }
    cursor = position;
  }
  output.push(...source.slice(cursor));
  return joinLines(output);
}

/** Line numbers, in the patched file, of the lines the patch adds. */
export function addedLines(patch: FilePatch): number[] {
  const added: number[] = [];
  for (const hunk of patch.hunks) {
    let line = hunk.newStart;
    for (const entry of hunk.lines) {
      if (entry.op === "+") added.push(line);
      if (entry.op !== "-") line += 1;
    }
  }
  return added;
}
