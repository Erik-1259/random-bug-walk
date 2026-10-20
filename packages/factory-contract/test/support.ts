import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../scripts/render.ts";

export const CONTRACT_DOCUMENT = join(repositoryRoot, "docs", "product", "bug-request-v1.md");
export const CONTRACT_FIXTURES = join(repositoryRoot, "docs", "product", "fixtures", "bug-request-v1");
export const INTERNAL_FIXTURES = join(repositoryRoot, "packages", "factory-contract", "test", "fixtures");

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, Json>;

export function jsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
}

export function readJson(dir: string, name: string): JsonObject {
  const value = JSON.parse(readFileSync(join(dir, name), "utf8")) as Json;
  return asObject(value, name);
}

export function contractFixture(name: string): JsonObject {
  return readJson(CONTRACT_FIXTURES, name);
}

export function internalFixture(name: string): JsonObject {
  return readJson(INTERNAL_FIXTURES, name);
}

export function asObject(value: Json | undefined, where: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} is not an object`);
  return value;
}

export function asArray(value: Json | undefined, where: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not an array`);
  return value;
}

/** The object at a path of keys and indexes, such as ["events", 3, "data"]. */
export function at(root: JsonObject, path: readonly (string | number)[]): JsonObject {
  let node: Json = root;
  for (const step of path) {
    node = typeof step === "number" ? (asArray(node, String(step))[step] ?? null) : (asObject(node, step)[step] ?? null);
  }
  return asObject(node, path.join("/"));
}

/** A deep copy of a fixture changed by `edit`. */
export function variant(base: JsonObject, edit: (copy: JsonObject) => void): JsonObject {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
}
