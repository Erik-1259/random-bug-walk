import { describe, expect, it } from "vitest";
import { errorSummary } from "../src/index.ts";

describe("errorSummary", () => {
  it("keeps only the first line, dropping a call log that could list request headers", () => {
    const error = new Error("apiRequestContext.fetch: socket hang up\nCall log:\n  - → GET /api/synthetic\n  -   authorization: Bearer synthetic-token");
    expect(errorSummary(error, [])).toBe("apiRequestContext.fetch: socket hang up");
  });

  it("redacts every secret on the kept line", () => {
    expect(errorSummary(new Error("bad synthetic-token and synthetic-token"), ["synthetic-token", ""])).toBe("bad [redacted] and [redacted]");
  });

  it("summarizes a thrown non-Error value", () => {
    expect(errorSummary("synthetic failure", [])).toBe("synthetic failure");
  });
});
