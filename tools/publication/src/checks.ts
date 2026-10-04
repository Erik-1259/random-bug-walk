import { readFile } from "node:fs/promises";

/** One unit of scanned content: a file blob, a commit message, a text blob or a path list. */
export interface ScanUnit {
  kind: "file" | "message" | "text" | "paths";
  location: string;
  content: Uint8Array;
  /** For files: true when the file is named exactly LICENSE. */
  isLicense: boolean;
  /** For files: the path list that names this file, and its 1-based position there. */
  listed?: { list: string; position: number };
}

export interface CheckContext {
  terms: readonly RegExp[];
  /** The trusted copyright line, without a trailing CR. */
  trustedCopyright: Uint8Array | null;
  /** The `<owner>/<repo>` whose own URLs are exempt from the pattern check. */
  repository: string | null;
}

const lossyDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Decodes content as UTF-16 when it starts with a UTF-16 byte-order mark, otherwise as UTF-8. */
function decodeContent(content: Uint8Array): { text: string; utf8: boolean } {
  if (content[0] === 0xff && content[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(content), utf8: false };
  if (content[0] === 0xfe && content[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(content), utf8: false };
  return { text: lossyDecoder.decode(content), utf8: true };
}

function escapeLiteral(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function normalizeText(text: string): string {
  return text.normalize("NFC").toLowerCase().normalize("NFC");
}

/**
 * Reads the private pattern list. It returns null for a missing or unreadable file,
 * invalid UTF-8 or a list without terms; an empty list is never treated as clean.
 */
export async function loadTerms(path: string): Promise<RegExp[] | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const terms: RegExp[] = [];
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const words = normalizeText(line).split(/\s+/u).filter((word) => word.length > 0);
    terms.push(new RegExp(words.map(escapeLiteral).join("\\s+"), "gu"));
  }
  return terms.length > 0 ? terms : null;
}

/** Splits bytes on LF and drops one trailing CR from each line. */
function byteLines(content: Uint8Array): Buffer[] {
  const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  const lines: Buffer[] = [];
  let start = 0;
  for (;;) {
    const end = buffer.indexOf(0x0a, start);
    const line = buffer.subarray(start, end === -1 ? buffer.length : end);
    lines.push(line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line);
    if (end === -1) return lines;
    start = end + 1;
  }
}

/** The first line of a LICENSE that starts with "Copyright", or null. */
export function copyrightLine(license: Uint8Array): Uint8Array | null {
  const marker = Buffer.from("Copyright");
  return byteLines(license).find((line) => line.subarray(0, marker.length).equals(marker)) ?? null;
}

interface Normalized {
  text: string;
  lineStarts: number[];
}

function normalizeLines(lines: readonly string[]): Normalized {
  const normalized = lines.map(normalizeText);
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of normalized) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  return { text: normalized.join("\n"), lineStarts };
}

function lineOf(lineStarts: readonly number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function repositoryUrlPattern(repository: string): RegExp {
  const [owner = "", repo = ""] = normalizeText(repository).split("/");
  const path = `${escapeLiteral(owner)}/${escapeLiteral(repo)}`;
  // The name must end where a repository name cannot continue; a sentence-final dot is fine.
  const end = "(?![a-z0-9_-])(?!\\.[a-z0-9_-])";
  const forms = [
    `https://github\\.com/${path}(?:\\.git)?${end}`,
    `git@github\\.com:${path}\\.git${end}`,
    `(?<![a-z0-9_.-])github\\.com/${path}${end}`,
  ];
  return new RegExp(forms.join("|"), "gu");
}

/** Line numbers that violate the private pattern list after both exceptions. */
function patternViolations(unit: ScanUnit, text: string, utf8: boolean, context: CheckContext): Set<number> {
  const lines = text.split("\n");
  const normalized = normalizeLines(lines);
  const exempt: [number, number][] = [];
  if (unit.kind === "file" && unit.isLicense && utf8 && context.trustedCopyright !== null) {
    const trusted = Buffer.from(context.trustedCopyright);
    byteLines(unit.content).forEach((line, index) => {
      if (line.equals(trusted)) {
        const start = normalized.lineStarts[index] ?? 0;
        exempt.push([start, start + normalizeText(lines[index] ?? "").length]);
      }
    });
  }
  if (context.repository !== null) {
    for (const match of normalized.text.matchAll(repositoryUrlPattern(context.repository))) {
      exempt.push([match.index, match.index + match[0].length]);
    }
  }
  const found = new Set<number>();
  for (const term of context.terms) {
    term.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = term.exec(normalized.text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (!exempt.some(([from, to]) => from <= start && end <= to)) found.add(lineOf(normalized.lineStarts, start));
      term.lastIndex = start + 1;
    }
  }
  return found;
}

// The line-prefix skip: multi-character comment markers, then single whitespace, marker,
// emoji and other symbol characters. It runs as a linear loop, because a regular
// expression with overlapping alternatives backtracks exponentially on long runs.
const PREFIX_TOKENS = ["<!--", "//", "/*"];
const PREFIX_CHARACTER = /^(?:[\s#*+>\-\p{S}\p{Extended_Pictographic}]|\u200d|\ufe0e|\ufe0f)$/u;

function skipPrefix(line: string): string {
  let index = 0;
  for (;;) {
    const token = PREFIX_TOKENS.find((candidate) => line.startsWith(candidate, index));
    if (token !== undefined) {
      index += token.length;
      continue;
    }
    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (!PREFIX_CHARACTER.test(character)) break;
    index += character.length;
  }
  return line.slice(index);
}

// Attribution forms are written as expressions so that no forbidden form appears literally.
// Each is matched at the start of a line after the prefix skip.
const TRAILER = /^(?:co-authored|signed-off|reviewed|acked|helped|suggested)-by\s*:/iu;
const GENERATED_LINE = /^generated\s+(?:with|by)/iu;
const AUTHOR_TAG = /^[@]author/iu;
const ROBOT_FACE = "\u{1F916}";
const NOTE = /(?<![\p{L}\p{N}_])(?:(?:edited|reviewed|requested|approved)\s+by|on\s+behalf\s+of)(?![\p{L}\p{N}_])/giu;

function attributionViolations(text: string): Set<number> {
  const found = new Set<number>();
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const rest = skipPrefix(line);
    if (TRAILER.test(rest) || GENERATED_LINE.test(rest) || AUTHOR_TAG.test(rest) || line.includes(ROBOT_FACE)) {
      found.add(index + 1);
    }
  });
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  for (const match of text.matchAll(NOTE)) found.add(lineOf(lineStarts, match.index));
  return found;
}

/** Runs the private pattern check and, except for path lists, the attribution check. */
export function contentViolations(unit: ScanUnit, context: CheckContext): Set<number> {
  const { text, utf8 } = decodeContent(unit.content);
  const found = patternViolations(unit, text, utf8, context);
  if (unit.kind !== "paths") for (const line of attributionViolations(text)) found.add(line);
  return found;
}
