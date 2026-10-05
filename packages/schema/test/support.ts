import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const fixturesDir = join(packageDir, "fixtures");

export interface CanonicalCase {
  name: string;
  expect: "valid" | "invalid";
}

export interface RecordCase {
  name: string;
  type: string;
  expect: "valid" | "invalid";
  rule: string;
  context?: Record<string, string>;
  error?: string;
}

export interface FixtureManifest {
  canonical: CanonicalCase[];
  records: RecordCase[];
}

export function readManifest(): FixtureManifest {
  return JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8")) as FixtureManifest;
}

export function fixtureBytes(...parts: string[]): Buffer {
  return readFileSync(join(fixturesDir, ...parts));
}

export function fixtureText(...parts: string[]): string {
  return fixtureBytes(...parts).toString("utf8");
}
