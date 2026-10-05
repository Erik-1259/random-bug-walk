import { isAbsolute, resolve } from "node:path";
import { InputError, arrayField, canonicalJson, compareUtf8, isRepoPath, parseJson, repoPath, strictObject, stringField } from "./input.ts";
import type { Manifest } from "./manifest.ts";

export const EXCLUSION_CATEGORIES = ["original_test", "answer_metadata", "revealing_comment"] as const;
export type ExclusionCategory = (typeof EXCLUSION_CATEGORIES)[number];

export interface Exclusion {
  /** A file path, or a directory path ending in `/` that covers every manifest file under it. */
  path: string;
  category: ExclusionCategory;
}

export interface DependencyLink {
  path: string;
  root: string;
}

export interface NeutralCommit {
  name: string;
  email: string;
  date: string;
  message: string;
}

export interface Policy {
  exclusions: Exclusion[];
  dependency_links: DependencyLink[];
  neutral_commit: NeutralCommit;
}

export const DEFAULT_NEUTRAL_COMMIT: NeutralCommit = {
  name: "workspace",
  email: "workspace@example.invalid",
  date: "2000-01-01T00:00:00Z",
  message: "Initial commit",
};

const POLICY = "malformed_policy";
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Seconds since the epoch for an RFC 3339 UTC date ending in `Z`, or null when it is not one. */
export function epochSeconds(date: string): number | null {
  if (!RFC3339_UTC.test(date)) return null;
  const millis = Date.parse(date);
  if (!Number.isFinite(millis) || millis < 0 || new Date(millis).toISOString() !== date.replace("Z", ".000Z")) return null;
  return millis / 1000;
}

function identityPart(value: string): boolean {
  return value !== "" && !/[<>\n\r\0]/.test(value);
}

function parseNeutralCommit(value: unknown): NeutralCommit {
  if (value === undefined) return { ...DEFAULT_NEUTRAL_COMMIT };
  const object = strictObject(value, [], ["name", "email", "date", "message"], POLICY);
  const commit = { ...DEFAULT_NEUTRAL_COMMIT };
  for (const key of ["name", "email", "date", "message"] as const) {
    if (key in object) commit[key] = stringField(object, key, POLICY);
  }
  if (!identityPart(commit.name) || !identityPart(commit.email)) throw new InputError(POLICY);
  if (epochSeconds(commit.date) === null) throw new InputError(POLICY);
  if (commit.message === "" || commit.message.includes("\0")) throw new InputError(POLICY);
  return commit;
}

export function parsePolicy(text: string): Policy {
  const top = strictObject(parseJson(text, POLICY), [], ["exclusions", "dependency_links", "neutral_commit"], POLICY);
  const exclusions: Exclusion[] = [];
  for (const item of "exclusions" in top ? arrayField(top, "exclusions", POLICY) : []) {
    const entry = strictObject(item, ["path", "category"], [], POLICY);
    const path = stringField(entry, "path", POLICY);
    const category = stringField(entry, "category", POLICY);
    if (!isRepoPath(path.endsWith("/") ? path.slice(0, -1) : path)) throw new InputError(POLICY);
    if (!(EXCLUSION_CATEGORIES as readonly string[]).includes(category)) throw new InputError(POLICY);
    exclusions.push({ path, category: category as ExclusionCategory });
  }
  const links: DependencyLink[] = [];
  for (const item of "dependency_links" in top ? arrayField(top, "dependency_links", POLICY) : []) {
    const entry = strictObject(item, ["path", "root"], [], POLICY);
    const path = repoPath(entry.path, POLICY);
    const root = stringField(entry, "root", POLICY);
    if (!isAbsolute(root) || resolve(root) !== root || root.includes("\0")) throw new InputError(POLICY);
    for (const other of links) {
      if (other.path === path || other.path.startsWith(`${path}/`) || path.startsWith(`${other.path}/`)) throw new InputError(POLICY);
    }
    links.push({ path, root });
  }
  return { exclusions, dependency_links: links, neutral_commit: parseNeutralCommit(top.neutral_commit) };
}

/** Canonical bytes of the policy with defaults filled in; its SHA-256 goes in the report. */
export function policyBytes(policy: Policy): Buffer {
  return Buffer.from(canonicalJson(policy), "utf8");
}

/**
 * ADM-01: exclusions remove whole manifest files only. Every entry must match at least one
 * manifest file, and a file matched twice must get one category.
 */
export function expandExclusions(policy: Policy, manifest: Manifest): Map<string, ExclusionCategory> {
  const expanded = new Map<string, ExclusionCategory>();
  for (const exclusion of policy.exclusions) {
    const matches = manifest.files.filter((file) =>
      exclusion.path.endsWith("/") ? file.path.startsWith(exclusion.path) : file.path === exclusion.path,
    );
    if (matches.length === 0) throw new InputError(POLICY);
    for (const file of matches) {
      const existing = expanded.get(file.path);
      if (existing !== undefined && existing !== exclusion.category) throw new InputError(POLICY);
      expanded.set(file.path, exclusion.category);
    }
  }
  return new Map([...expanded].sort(([a], [b]) => compareUtf8(a, b)));
}
