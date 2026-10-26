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

describe("pinned revision-3 UI fixtures, not backend acceptance", () => {
  const names = readdirSync(fixtures).filter(name => name.endsWith(".json")).sort();
  it("pins the shared Git package and copies the complete published fixture set", () => {
    expect(FACTORY_CONTRACT_REVISION).toBe("4be0c93f94a8582b998383c70d10837ba49c8014");
    expect(names).toEqual(readdirSync(upstream).filter(name => name.endsWith(".json")).sort());
  });
  it.each(names)("validates exact published bytes of %s with the shared server/test parser", name => {
    const bytes = readFileSync(new URL(name, fixtures));
    expect(bytes).toEqual(readFileSync(new URL(name, upstream)));
    expect(() => parseContract(definition(name), bytes.toString("utf8"))).not.toThrow();
  });
});
