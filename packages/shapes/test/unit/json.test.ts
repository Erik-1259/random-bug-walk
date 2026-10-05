import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/json.ts";

describe("canonicalJson", () => {
  it("sorts keys at every depth and writes no insignificant whitespace", () => {
    const value = { b: [{ z: 1, a: "x" }], a: { d: null, c: true } };
    expect(canonicalJson(value)).toBe('{"a":{"c":true,"d":null},"b":[{"a":"x","z":1}]}');
  });

  it("keeps array order and escapes strings as JSON does", () => {
    expect(canonicalJson(["b", "a", 'q"\n'])).toBe('["b","a","q\\"\\n"]');
  });

  it("rejects values JSON cannot represent exactly", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
  });
});
