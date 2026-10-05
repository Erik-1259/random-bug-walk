import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCanonical } from "../src/canonical.ts";
import { readSchemaSource, renderGenerated, repositoryRoot } from "../scripts/render.ts";

function collectPatterns(node: unknown, found: string[]): string[] {
  if (Array.isArray(node)) for (const item of node) collectPatterns(item, found);
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "pattern" && typeof value === "string") found.push(value);
      else collectPatterns(value, found);
    }
  }
  return found;
}

describe("schema source", () => {
  it("is strict JSON", () => {
    expect(() => parseCanonical(new TextEncoder().encode(readSchemaSource()))).not.toThrow();
  });

  it("anchors every pattern and avoids classes that differ between the languages", () => {
    const patterns = collectPatterns(JSON.parse(readSchemaSource()), []);
    expect(patterns.length).toBeGreaterThan(10);
    for (const pattern of patterns) {
      expect(pattern.startsWith("^")).toBe(true);
      expect(pattern.endsWith("$")).toBe(true);
      expect(pattern).not.toMatch(/\\[dDwWsSbB]/);
    }
  });
});

describe("drift check", () => {
  it.each(renderGenerated(readSchemaSource()).map((file) => [file.path, file.content]))(
    "%s matches the schema source; run `pnpm --filter @rbw/schema run generate` after editing it",
    (path, content) => {
      expect(readFileSync(join(repositoryRoot, path), "utf8")).toBe(content);
    },
  );

  it("writes no attribution line and no timestamp", () => {
    for (const file of renderGenerated(readSchemaSource())) {
      expect(file.content).not.toMatch(/generated (with|by)/i);
      expect(file.content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/);
    }
  });
});
