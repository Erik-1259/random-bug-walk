import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";
import { RULE_FILE, DT1_SOURCE, DT1_TARGET, type SourceSpec, type TargetSpec } from "../../src/shape.ts";
import type { TargetInput } from "../../src/target.ts";
import type { SourceInput } from "../../src/source.ts";

export function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function gitBlob(text: string): string {
  const bytes = Buffer.from(text);
  return createHash("sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
}

export const RULE = readFileSync(RULE_FILE);
export const TARGET = fixture("target.ts.txt");
export const ROUTE = fixture("route.ts.txt");
export const BEFORE = fixture("source-before.tsx.txt");
export const AFTER = fixture("source-after.tsx.txt");

export const SYNTHETIC_PATH = "src/synthetic/getSyntheticStats.ts";
export const SYNTHETIC_COMMIT = "0000000000000000000000000000000000000001";

export const CLEAN_LINE = "      ${getDateSQL('website_event.created_at', unit, timezone)} x,";
export const PLANTED_LINE = "      ${getDateSQL('website_event.created_at', unit)} x,";

/** The real rule with the `inside` condition and the constraints removed from the fixed-form rule. */
export function broadRule(): Uint8Array {
  const docs = parseAllDocuments(RULE.toString("utf8"));
  const fixed = docs[0];
  if (fixed === undefined) {
    throw new Error("rule file has no documents");
  }
  fixed.deleteIn(["rule", "inside"]);
  fixed.delete("constraints");
  return Buffer.from(docs.map((doc) => doc.toString()).join(""));
}

/** The expected planted text, written by hand so the tests do not reuse the rule's own rewrite. */
export function plant(text: string): string {
  return text.replace(CLEAN_LINE, PLANTED_LINE);
}

/** A target spec that declares the synthetic files' hashes, so each test isolates one check. */
export function targetSpec(target: string, route = ROUTE, overrides: Partial<TargetSpec> = {}): TargetSpec {
  return {
    ...DT1_TARGET,
    hostCommit: SYNTHETIC_COMMIT,
    path: SYNTHETIC_PATH,
    sha256: sha256(target),
    resultSha256: sha256(plant(target)),
    routeSha256: sha256(route),
    ...overrides,
  };
}

export function targetInput(target: string, route = ROUTE, rule: Uint8Array = RULE): TargetInput {
  return {
    path: SYNTHETIC_PATH,
    mode: "100644",
    bytes: Buffer.from(target),
    routeBytes: Buffer.from(route),
    ruleBytes: rule,
  };
}

export const SOURCE_COMMIT = "a000000000000000000000000000000000000001";
export const SOURCE_PARENT = "b000000000000000000000000000000000000002";
export const SOURCE_PATH = "src/synthetic/RevenuePage.tsx";

export function sourceSpec(before = BEFORE, after = AFTER): SourceSpec {
  return {
    ...DT1_SOURCE,
    commit: SOURCE_COMMIT,
    parent: SOURCE_PARENT,
    path: SOURCE_PATH,
    before: { gitBlob: gitBlob(before), sha256: sha256(before) },
    after: { gitBlob: gitBlob(after), sha256: sha256(after) },
  };
}

export function sourceInput(before = BEFORE, after = AFTER, overrides: Partial<SourceInput> = {}): SourceInput {
  return {
    commit: SOURCE_COMMIT,
    parent: SOURCE_PARENT,
    parents: [SOURCE_PARENT],
    changes: [{ status: "M", path: SOURCE_PATH }],
    before: Buffer.from(before),
    after: Buffer.from(after),
    ruleBytes: readFileSync(new URL("../../rules/dt-1.tz-arg.source.yml", import.meta.url)),
    ...overrides,
  };
}
