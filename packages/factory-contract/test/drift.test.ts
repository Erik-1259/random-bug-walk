import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { EVENT_TYPE_VALUES } from "../src/index.ts";
import { GENERATED_PATH, SCHEMA_SOURCE, enumValues, readSchemaSource, renderTypescript, repositoryRoot } from "../scripts/render.ts";
import { CONTRACT_DOCUMENT } from "./support.ts";

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const schema = JSON.parse(readSchemaSource()) as { $defs: Record<string, Node> };
const defs = Object.entries(schema.$defs);

/** Every value of `key` anywhere under `node`, except the named definitions' own top level. */
function collect(node: unknown, key: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const item of node) collect(item, key, found);
  else if (isNode(node)) {
    for (const [name, value] of Object.entries(node)) {
      if (name === key) found.push(value);
      collect(value, key, found);
    }
  }
  return found;
}

describe("drift check", () => {
  it("src/generated.ts matches the schema; run `pnpm --filter @rbw/factory-contract run generate` after editing it", () => {
    expect(readFileSync(join(repositoryRoot, GENERATED_PATH), "utf8")).toBe(renderTypescript(readSchemaSource()));
  });

  it("writes no attribution line and no timestamp", () => {
    const content = renderTypescript(readSchemaSource());
    expect(content).not.toMatch(/generated (with|by)/i);
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/);
  });

  it("is named by the contract document as its machine-readable definition", () => {
    expect(readFileSync(CONTRACT_DOCUMENT, "utf8")).toContain(SCHEMA_SOURCE);
  });
});

describe("schema conventions", () => {
  it("is strict JSON without duplicate keys", () => {
    expect(() => parseCanonical(new TextEncoder().encode(readSchemaSource()))).not.toThrow();
  });

  it("anchors every pattern and avoids classes that differ between languages", () => {
    const patterns = collect(schema, "pattern");
    expect(patterns.length).toBeGreaterThan(5);
    for (const pattern of patterns) {
      expect(typeof pattern).toBe("string");
      expect(String(pattern)).toMatch(/^\^.*\$$/);
      expect(String(pattern)).not.toMatch(/\\[dDwWsSbB]/);
    }
  });

  it("forbids unknown fields and requires every field in every object definition", () => {
    for (const [name, node] of defs) {
      if (node.type !== "object" || node.oneOf !== undefined) continue;
      expect(node.additionalProperties, name).toBe(false);
      expect([...(node.required as string[])].sort(), name).toEqual(Object.keys(node.properties as Node).sort());
    }
  });

  it("lists each enumeration once and uses only subsets of it elsewhere", () => {
    const named = defs.flatMap(([name, node]) => {
      const values = enumValues(node);
      return values === null ? [] : [[name, values] as const];
    });
    const sets = named.map(([, values]) => [...values].sort().join(","));
    expect(new Set(sets).size).toBe(sets.length);
    const inline = collect(defs.filter(([, node]) => enumValues(node) === null).map(([, node]) => node), "enum");
    expect(inline.length).toBeGreaterThan(0);
    for (const values of inline) {
      expect(Array.isArray(values)).toBe(true);
      const subsetOf = named.filter(([, list]) => (values as string[]).every((value) => list.includes(value)));
      expect(subsetOf.length, JSON.stringify(values)).toBeGreaterThan(0);
    }
  });

  it("keeps the normalized input identical to the input except for its descriptions", () => {
    // Drops description annotations (strings), not the `description` property of an item.
    const strip = (node: unknown): unknown =>
      JSON.parse(JSON.stringify(node, (key, value: unknown) => (key === "description" && typeof value === "string" ? undefined : value)));
    const input = structuredClone(schema.$defs.RequestInput) as { properties: { items: { items: unknown } } };
    input.properties.items.items = { $ref: "#/$defs/NormalizedRequestItemInput" };
    expect(strip(schema.$defs.NormalizedRequestInput)).toEqual(strip(input));
    const item = structuredClone(schema.$defs.RequestItemInput) as { properties: { description: unknown } };
    item.properties.description = { anyOf: [{ $ref: "#/$defs/Description" }, { type: "null" }] };
    expect(strip(schema.$defs.NormalizedRequestItemInput)).toEqual(strip(item));
  });

  it("gives every event type exactly one Event variant", () => {
    const event = schema.$defs.Event;
    const variants = (event?.oneOf as { $ref: string }[]).map((item) => item.$ref.replace("#/$defs/", ""));
    const types = variants.flatMap((variant) => {
      const property = (schema.$defs[variant]?.properties as Record<string, { const?: string; enum?: string[] }>).type;
      return property?.enum ?? (property?.const === undefined ? [] : [property.const]);
    });
    expect([...types].sort()).toEqual([...EVENT_TYPE_VALUES].sort());
  });
});

describe("client safety", () => {
  const read = (file: string) => readFileSync(join(repositoryRoot, "packages", "factory-contract", "src", file), "utf8");

  it("generated.ts imports nothing", () => {
    expect(read("generated.ts")).not.toMatch(/^import\b|^export .* from |\bimport\(|\brequire\(/m);
  });

  it("index.ts and adapter.ts load nothing at run time but generated.ts", () => {
    for (const file of ["index.ts", "adapter.ts"]) {
      const text = read(file);
      const specifiers = [...text.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const specifier of specifiers) expect(["./generated.ts", "./adapter.ts"], file).toContain(specifier);
      expect(text, file).not.toMatch(/^import (?!type )/m);
      expect(text, file).not.toMatch(/^export \{/m);
      expect(text, file).not.toMatch(/\brequire\(/);
    }
  });
});
