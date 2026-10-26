import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DefName } from "@rbw/factory-contract";
import { parseContract } from "@rbw/factory-contract/validate";
import { FACTORY_CONTRACT_REVISION } from "../src/factory/client.ts";

const fixtures = new URL("./fixtures/factory-v1/", import.meta.url);
const upstream = new URL("../../../docs/product/fixtures/bug-request-v1/", import.meta.url);
function definition(name: string): DefName {
  if (name.startsWith("error-")) return "ErrorResponse";
  if (name.startsWith("status-")) return "RequestStatus";
  if (name.startsWith("interpretation-")) return "Interpretation";
  if (name.startsWith("validation-")) return "ValidationRun";
  if (name.startsWith("session")) return "SessionStatus";
  const definitions: Record<string, DefName> = { "capabilities.json": "Capabilities", "example.json": "ExampleResponse", "start-request.json": "StartRequest", "test-evidence.json": "TestEvidence" };
  const value = definitions[name];
  if (value === undefined) throw new Error(`Unmapped synthetic fixture ${name}`);
  return value;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A fixture without the fields contract revision 3 added to test-mode evidence: its revision-2 form. */
function withoutRevision3(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutRevision3);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["root_execution_id", "execution_id", "host_id"].includes(key)).map(([key, entry]) => [key, withoutRevision3(entry)]));
}

/** Revision 3 changed only test-mode evidence, which the UI does not read, so its pinned copy stays the revision-2 file. */
const REVISION_3_CHANGED = new Set(["test-evidence.json"]);

describe("pinned revision-2 UI fixtures, not backend acceptance", () => {
  const names = readdirSync(fixtures).filter(name => name.endsWith(".json")).sort();
  it("pins the shared Git package and copies the complete published fixture set", () => {
    expect(FACTORY_CONTRACT_REVISION).toBe("66651d67fcb09c402b25d9688ea492c0e69e1c2b");
    expect(names).toEqual(readdirSync(upstream).filter(name => name.endsWith(".json")).sort());
  });
  it.each(names.filter(name => !REVISION_3_CHANGED.has(name)))("validates exact published bytes of %s with the shared server/test parser", name => {
    const bytes = readFileSync(new URL(name, fixtures));
    expect(bytes).toEqual(readFileSync(new URL(name, upstream)));
    expect(() => parseContract(definition(name), bytes.toString("utf8"))).not.toThrow();
  });
  it.each([...REVISION_3_CHANGED])("keeps %s as the published file without its revision-3 test-control fields, and the published file validates", name => {
    const published = readFileSync(new URL(name, upstream), "utf8");
    expect(JSON.parse(readFileSync(new URL(name, fixtures), "utf8")) as Json).toEqual(withoutRevision3(JSON.parse(published) as Json));
    expect(() => parseContract(definition(name), published)).not.toThrow();
  });
});
