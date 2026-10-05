import { InputError } from "./input.ts";

export interface Term {
  text: string;
  /** Case-insensitive, Unicode-aware matcher for UTF-8 text. */
  unicode: RegExp;
  /** ASCII-case-folding matcher for bytes read as Latin-1, used when content is not UTF-8. */
  bytes: RegExp;
}

export interface TermList {
  strict: Term[];
  generic: Term[];
}

/** A match's first and last line, 1-based. */
export interface Span {
  start: number;
  end: number;
}

const TERMS = "terms_unavailable";
const SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

function escapeByte(byte: number): string {
  const char = String.fromCharCode(byte);
  if (/[A-Za-z]/.test(char)) return `[${char.toLowerCase()}${char.toUpperCase()}]`;
  if (/[\\^$.*+?()[\]{}|/-]/.test(char)) return `\\${char}`;
  if (byte >= 0x20 && byte < 0x7f) return char;
  return `\\x${byte.toString(16).padStart(2, "0")}`;
}

/** ADM-07: literal, case-insensitive matching where a run of whitespace matches any run of whitespace. */
export function compileTerm(text: string): Term {
  const words = text.split(/\s+/u);
  const unicode = new RegExp(words.map((word) => word.replace(SYNTAX, "\\$&")).join("\\s+"), "giu");
  const bytes = new RegExp(
    words.map((word) => [...Buffer.from(word, "utf8")].map(escapeByte).join("")).join("[\\t\\n\\v\\f\\r ]+"),
    "g",
  );
  return { text, unicode, bytes };
}

/**
 * Parses a term list: `strict:<term>` or `generic:<term>` per line, terms trimmed, blank
 * lines and `#` comments ignored. Anything else, or bytes that are not UTF-8, is malformed.
 */
export function parseTerms(content: Buffer): TermList {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new InputError(TERMS);
  }
  const list: TermList = { strict: [], generic: [] };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(strict|generic):(.*)$/su.exec(line);
    const tier = match?.[1];
    const term = match?.[2]?.trim() ?? "";
    if ((tier !== "strict" && tier !== "generic") || term === "") throw new InputError(TERMS);
    list[tier].push(compileTerm(term));
  }
  return list;
}

function decodeUtf8(content: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    return null;
  }
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Every match of any term in `content`, as line spans. UTF-8 content is matched as text;
 * anything else as bytes with ASCII case folding.
 */
export function matchSpans(content: Buffer, terms: readonly Term[]): Span[] {
  if (terms.length === 0) return [];
  const utf8 = decodeUtf8(content);
  const text = utf8 ?? content.toString("latin1");
  let starts: number[] | null = null;
  const spans = new Map<string, Span>();
  for (const term of terms) {
    const pattern = utf8 === null ? term.bytes : term.unicode;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      starts ??= [0, ...[...text.matchAll(/\n/g)].map((newline) => newline.index + 1)];
      const span = { start: lineAt(starts, match.index), end: lineAt(starts, match.index + match[0].length - 1) };
      spans.set(`${String(span.start)}:${String(span.end)}`, span);
    }
  }
  return [...spans.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Whether a name or other short text contains any of the terms. */
export function textHasTerm(text: string, terms: readonly Term[]): boolean {
  return terms.some((term) => {
    term.unicode.lastIndex = 0;
    return term.unicode.test(text);
  });
}
