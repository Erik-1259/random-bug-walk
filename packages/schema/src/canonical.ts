import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Raised for any input or value outside canonical JSON v1. The message never quotes the input. */
export class CanonicalError extends Error {
  constructor(reason: string) {
    super(`canonical JSON: ${reason}`);
    this.name = "CanonicalError";
  }
}

const MAX_DEPTH = 256;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const SHORT_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) > 0x7f) return false;
  return true;
}

function defineKey(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  // defineProperty keeps a "__proto__" key as data instead of changing the prototype.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

class Parser {
  private position = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): JsonValue {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.position !== this.text.length) throw new CanonicalError("trailing content");
    return value;
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length && WHITESPACE.has(this.text.charCodeAt(this.position))) this.position += 1;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > MAX_DEPTH) throw new CanonicalError("nesting too deep");
    this.skipWhitespace();
    const char = this.text[this.position];
    if (char === "{") return this.parseObject(depth);
    if (char === "[") return this.parseArray(depth);
    if (char === '"') return this.parseString();
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.parseNumber();
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.text.startsWith(word, this.position)) {
        this.position += word.length;
        return value;
      }
    }
    throw new CanonicalError("unexpected token");
  }

  private parseObject(depth: number): JsonValue {
    this.position += 1;
    const result: Record<string, JsonValue> = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.position] === "}") {
      this.position += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.position] !== '"') throw new CanonicalError("expected a key");
      const key = this.parseString();
      if (!isAscii(key)) throw new CanonicalError("non-ASCII key");
      if (seen.has(key)) throw new CanonicalError("duplicate key");
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.position] !== ":") throw new CanonicalError("expected a colon");
      this.position += 1;
      defineKey(result, key, this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.position];
      this.position += 1;
      if (next === "}") return result;
      if (next !== ",") throw new CanonicalError("expected a comma");
    }
  }

  private parseArray(depth: number): JsonValue {
    this.position += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.position] === "]") {
      this.position += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.position];
      this.position += 1;
      if (next === "]") return result;
      if (next !== ",") throw new CanonicalError("expected a comma");
    }
  }

  private parseString(): string {
    this.position += 1;
    let result = "";
    for (;;) {
      const char = this.text[this.position];
      if (char === undefined) throw new CanonicalError("unterminated string");
      this.position += 1;
      if (char === '"') break;
      if (char.charCodeAt(0) < 0x20) throw new CanonicalError("control character in string");
      if (char !== "\\") {
        result += char;
        continue;
      }
      const escape = this.text[this.position];
      this.position += 1;
      if (escape === "u") {
        const hex = this.text.slice(this.position, this.position + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new CanonicalError("invalid unicode escape");
        result += String.fromCharCode(Number.parseInt(hex, 16));
        this.position += 4;
      } else {
        const short = escape === undefined ? undefined : SHORT_ESCAPES[escape];
        if (short === undefined) throw new CanonicalError("invalid escape");
        result += short;
      }
    }
    if (!result.isWellFormed()) throw new CanonicalError("lone surrogate");
    return result;
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(this.text.slice(this.position, this.position + 32));
    if (match === null) throw new CanonicalError("invalid number");
    this.position += match[0].length;
    const next = this.text[this.position];
    if (next === "." || next === "e" || next === "E") throw new CanonicalError("only integers are allowed");
    if (next !== undefined && next >= "0" && next <= "9") throw new CanonicalError("integer out of range");
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) throw new CanonicalError("integer out of range");
    return value === 0 ? 0 : value;
  }
}

/** Parses bytes strictly: UTF-8 without BOM, no duplicate or non-ASCII keys, integers only, nothing trailing. */
export function parseCanonical(bytes: Uint8Array): JsonValue {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new CanonicalError("byte-order mark");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CanonicalError("invalid UTF-8");
  }
  return new Parser(text).parseDocument();
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalError("nesting too deep");
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new CanonicalError("only safe integers are allowed");
    return value === 0 ? "0" : String(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new CanonicalError("lone surrogate");
    // For well-formed strings JSON.stringify escapes exactly ", \, \b, \t, \n, \f, \r and other
    // code points below U+0020 (as lowercase \u00xx); everything else stays literal.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new CanonicalError("sparse array");
      items.push(serialize(value[index], depth + 1));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const key of keys) if (!isAscii(key)) throw new CanonicalError("non-ASCII key");
    // Keys are ASCII, so UTF-16 code unit order equals code point and byte order.
    keys.sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], depth + 1)}`).join(",")}}`;
  }
  throw new CanonicalError("unsupported value");
}

/** Canonical JSON v1 bytes of a value. Throws CanonicalError for anything outside v1. */
export function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(serialize(value, 0));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface CanonicalDigest {
  bytes: Uint8Array;
  sha256: string;
}

/** Canonical bytes and their SHA-256; store both wherever the hash is stored. */
export function canonicalDigest(value: unknown): CanonicalDigest {
  const bytes = encodeCanonical(value);
  return { bytes, sha256: sha256Hex(bytes) };
}
