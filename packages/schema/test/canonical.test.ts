import { describe, expect, it } from "vitest";
import { CanonicalError, canonicalDigest, encodeCanonical, parseCanonical, sha256Hex } from "../src/canonical.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const parse = (source: string): unknown => parseCanonical(new TextEncoder().encode(source));

describe("encodeCanonical", () => {
  it("sorts keys by code point, not by locale", () => {
    expect(text(encodeCanonical({ b: 1, B: 2, a: { z: 1, Z: 2 }, _: 3, "1": 4 }))).toBe('{"1":4,"B":2,"_":3,"a":{"Z":2,"z":1},"b":1}');
  });

  it("emits no whitespace and no trailing newline", () => {
    expect(text(encodeCanonical({ a: [1, { b: null }], c: "d e" }))).toBe('{"a":[1,{"b":null}],"c":"d e"}');
  });

  it("writes -0 as 0", () => {
    expect(text(encodeCanonical([-0]))).toBe("[0]");
  });

  it("escapes only the required characters", () => {
    expect(text(encodeCanonical(["\u0007\u001f\u007f /\"\\\b\t\n\f\r"]))).toBe('["\\u0007\\u001f\u007f /\\"\\\\\\b\\t\\n\\f\\r"]');
  });

  it.each([
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["2^53", 2 ** 53],
    ["-(2^53)", -(2 ** 53)],
    ["undefined", undefined],
    ["a bigint", 1n],
    ["a lone surrogate", "\ud800"],
    ["a non-ASCII key", { "é": 1 }],
    ["a nested undefined", { a: undefined }],
    ["a function", () => 1],
    ["a date", new Date(0)],
  ])("rejects %s", (_label, value) => {
    expect(() => encodeCanonical(value)).toThrow(CanonicalError);
  });

  it("hashes the canonical bytes", () => {
    const digest = canonicalDigest({ b: 1, a: 2 });
    expect(text(digest.bytes)).toBe('{"a":2,"b":1}');
    expect(digest.sha256).toBe(sha256Hex(new TextEncoder().encode('{"a":2,"b":1}')));
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseCanonical", () => {
  it("parses -0 as the integer 0", () => {
    expect(Object.is(parse("-0"), 0)).toBe(true);
  });

  it("keeps decomposed and precomposed text distinct", () => {
    expect(parse('["é","é"]')).toEqual(["é", "é"]);
  });

  it.each([
    ["a duplicate key after escapes", '{"a":1,"\\u0061":2}'],
    ["a deep duplicate key", '[[{"k":{"x":1,"x":2}}]]'],
    ["a fraction", "1.0"],
    ["an exponent", "1E2"],
    ["a plus sign", "+1"],
    ["a leading zero", "01"],
    ["single quotes", "'a'"],
    ["a trailing comma", "[1,]"],
    ["a comment", "[1]//"],
    ["an unterminated string", '"abc'],
    ["an invalid escape", '"\\x41"'],
    ["a raw line feed in a string", '"a\nb"'],
    ["a vertical tab between tokens", "[1,\u000b2]"],
    ["a no-break space between tokens", "[1, 2]"],
    ["a lone low surrogate escape", '"\\udc00x"'],
    ["a high surrogate followed by a non-surrogate escape", '"\\ud800\\u0041"'],
    ["nothing", "   "],
  ])("rejects %s", (_label, source) => {
    expect(() => parse(source)).toThrow(CanonicalError);
  });

  it("rejects a byte-order mark and invalid UTF-8", () => {
    expect(() => parseCanonical(Uint8Array.from([0xef, 0xbb, 0xbf, 0x31]))).toThrow(CanonicalError);
    expect(() => parseCanonical(Uint8Array.from([0x22, 0xc3, 0x22]))).toThrow(CanonicalError);
  });
});
