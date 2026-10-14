import { describe, expect, it } from "vitest";
import { redactor } from "../../src/redact.ts";

describe("redactor", () => {
  it("accepts an encoded percent sign in a query value and redacts both its encoded and decoded forms", () => {
    const redact = redactor("postgresql://synthetic-user:synthetic-pass@synthetic-host:5432/synthetic-db?application_name=100%25synthetic");
    const out = redact("app 100%synthetic and raw 100%25synthetic on synthetic-host as synthetic-user");
    expect(out).not.toContain("100%synthetic");
    expect(out).not.toContain("100%25synthetic");
    expect(out).not.toContain("synthetic-host");
    expect(out).not.toContain("synthetic-user");
  });
});
