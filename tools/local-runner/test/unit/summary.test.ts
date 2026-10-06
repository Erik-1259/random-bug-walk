import { describe, expect, it } from "vitest";
import { parseCanonical } from "@rbw/schema";
import { revenueKnownLimit, summaryBytes } from "../../src/summary.ts";

describe("the summary", () => {
  it("flags a run on the 2nd to the 5th of a month (UTC), the driver's known limit, and refuses nothing", () => {
    const applies = (iso: string) => revenueKnownLimit(Date.parse(iso)).applies;
    expect(applies("2026-10-01T23:59:59Z")).toBe(false);
    expect(applies("2026-10-02T00:00:00Z")).toBe(true);
    expect(applies("2026-11-05T23:59:59Z")).toBe(true);
    expect(applies("2026-11-06T00:00:00Z")).toBe(false);
    expect(revenueKnownLimit(Date.parse("2026-10-03T12:00:00Z"))).toEqual({
      applies: true,
      days: "2nd to 5th of a month, UTC",
      note: "two upstream revenue tests fail on a clean copy on these days (packages/umami-driver README, Known limits); recorded, not refused",
    });
  });

  it("encodes as canonical JSON: sorted keys, no whitespace, integers only", () => {
    const bytes = summaryBytes({ b: 1, a: [true, null, "x"] });
    expect(Buffer.from(bytes).toString()).toBe('{"a":[true,null,"x"],"b":1}');
    expect(parseCanonical(bytes)).toEqual({ a: [true, null, "x"], b: 1 });
    expect(() => summaryBytes({ duration: 1.5 })).toThrow();
  });
});
