import { REDACTION_CATEGORY_VALUES, type RedactionCategory } from "@rbw/schema";
import { InvalidInput } from "./errors.ts";

export interface RedactionValue {
  category: RedactionCategory;
  value: Uint8Array;
}

export type RedactionCounts = Partial<Record<RedactionCategory, number>>;

export interface Sanitized {
  bytes: Uint8Array;
  counts: RedactionCounts;
}

function isRedactionCategory(value: string): value is RedactionCategory {
  return (REDACTION_CATEGORY_VALUES as readonly string[]).includes(value);
}

/**
 * Parses the private redaction-values file: UTF-8, blank and `#` lines ignored, otherwise
 * `<category>\t<value>` with a final CR dropped. Errors name the line number only.
 */
export function parseRedactionValues(bytes: Uint8Array): RedactionValue[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvalidInput("redaction_values_malformed");
  }
  const byValue = new Map<string, RedactionCategory>();
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    const category = tab === -1 ? "" : line.slice(0, tab);
    const value = tab === -1 ? "" : line.slice(tab + 1);
    if (!isRedactionCategory(category) || value === "") throw new InvalidInput(`redaction_values_malformed_line_${String(index + 1)}`);
    const existing = byValue.get(value);
    if (existing !== undefined && existing !== category) throw new InvalidInput(`redaction_values_malformed_line_${String(index + 1)}`);
    byValue.set(value, category);
  }
  return [...byValue].map(([value, category]) => ({ category, value: new TextEncoder().encode(value) }));
}

const HEADER = /^[ \t<>]*(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*:/i;
const AUTH_MARKER = Buffer.from(" [redacted:auth_header]");

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function add(counts: RedactionCounts, category: RedactionCategory, amount = 1): void {
  counts[category] = (counts[category] ?? 0) + amount;
}

/** A run of output bytes; inserted markers are never matched again by the values rule. */
interface Segment {
  bytes: Buffer;
  inserted: boolean;
}

/**
 * Header rule: keeps everything up to the colon and the line ending, replaces a non-blank rest.
 * Kept bytes are collected as pieces and joined once per segment, so the cost stays linear.
 */
function redactHeaders(input: Buffer, counts: RedactionCounts): Segment[] {
  const segments: Segment[] = [];
  let pieces: Buffer[] = [];
  const flush = (): void => {
    if (pieces.length > 0) segments.push({ bytes: Buffer.concat(pieces), inserted: false });
    pieces = [];
  };
  const keep = (bytes: Buffer): void => {
    pieces.push(bytes);
  };
  let start = 0;
  while (start < input.length) {
    const newline = input.indexOf(0x0a, start);
    const end = newline === -1 ? input.length : newline + 1;
    let contentEnd = newline === -1 ? input.length : newline;
    if (newline !== -1 && contentEnd > start && input[contentEnd - 1] === 0x0d) contentEnd -= 1;
    const content = input.subarray(start, contentEnd);
    // latin1 maps bytes one to one, so the match length is a byte offset; the pattern is ASCII-only.
    const match = HEADER.exec(content.toString("latin1"));
    const rest = match === null ? Buffer.alloc(0) : content.subarray(match[0].length);
    if (match !== null && rest.some((byte) => byte !== 0x20 && byte !== 0x09)) {
      keep(content.subarray(0, match[0].length));
      flush();
      segments.push({ bytes: AUTH_MARKER, inserted: true });
      keep(input.subarray(contentEnd, end));
      add(counts, "auth_header");
    } else {
      keep(input.subarray(start, end));
    }
    start = end;
  }
  flush();
  return segments;
}

/** Values rule: exact bytes, left to right, longest value first at each position, no rematching. */
function redactValues(input: Buffer, values: readonly RedactionValue[], counts: RedactionCounts): Buffer {
  if (values.length === 0) return input;
  const byFirstByte = new Map<number, { value: Buffer; marker: Buffer; category: RedactionCategory }[]>();
  for (const item of [...values].sort((a, b) => b.value.length - a.value.length)) {
    const first = item.value[0];
    if (first === undefined) continue;
    const list = byFirstByte.get(first) ?? [];
    list.push({ value: Buffer.from(item.value), marker: Buffer.from(`[redacted:${item.category}]`), category: item.category });
    byFirstByte.set(first, list);
  }
  const parts: Buffer[] = [];
  let copied = 0;
  let position = 0;
  while (position < input.length) {
    const candidates = byFirstByte.get(input[position] ?? -1);
    const hit = candidates?.find((item) => input.subarray(position, position + item.value.length).equals(item.value));
    if (hit === undefined) {
      position += 1;
      continue;
    }
    parts.push(input.subarray(copied, position), hit.marker);
    add(counts, hit.category);
    position += hit.value.length;
    copied = position;
  }
  parts.push(input.subarray(copied));
  return Buffer.concat(parts);
}

/**
 * The one sanitizer: the header rule for valid UTF-8, then the values rule for every file. The
 * values rule never matches inside a marker the header rule inserted.
 */
export function sanitize(input: Uint8Array, values: readonly RedactionValue[]): Sanitized {
  const counts: RedactionCounts = {};
  const bytes = Buffer.from(input);
  const segments = isUtf8(bytes) ? redactHeaders(bytes, counts) : [{ bytes, inserted: false }];
  const output = segments.map((segment) => (segment.inserted ? segment.bytes : redactValues(segment.bytes, values, counts)));
  return { bytes: Buffer.concat(output), counts };
}
