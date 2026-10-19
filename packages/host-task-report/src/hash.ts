// Hashing shared by the host side and the copy image: SHA-256, canonical JSON and the tree hash.
// The tree hash is the one the custom host harness at baseline 2 uses for its frozen suite (the
// same canonical form as RBW's addedSuiteSha256): every regular file's SHA-256 keyed by its POSIX
// path, sorted, as canonical JSON, hashed again. Imports only node: built-ins, so it loads in the
// copy image without any package.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class HashError extends Error {
  override name = "HashError";
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON for objects, arrays, strings, safe integers, booleans and null: keys sorted by
 * UTF-16 code unit, no whitespace, no trailing newline.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new HashError("canonical JSON allows safe integers only");
    return String(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new HashError("canonical JSON rejects lone surrogates");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new HashError("canonical JSON: unsupported value");
}

export interface TreeHash {
  tree_sha256: string;
  /** SHA-256 of every file, keyed by its POSIX path relative to the root, in sorted order. */
  files: Record<string, string>;
}

/** The tree hash of a file map. */
export function treeSha256(files: Readonly<Record<string, string>>): string {
  return sha256Hex(canonicalJson(sortedRecord(files)));
}

export function sortedRecord(files: Readonly<Record<string, string>>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) {
    const value = files[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

/**
 * Hashes every regular file under root. Directories named node_modules, a top-level
 * test-results and files named .DS_Store are skipped, as in the harness; a symlink or any other
 * non-regular file is an error.
 */
export function hashTree(root: string): TreeHash {
  const files: Record<string, string> = {};
  const add = (rel: string): void => {
    const abs = join(root, rel);
    const stat = lstatSync(abs);
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (stat.isSymbolicLink()) throw new HashError(`symlink in tree: ${rel}`);
    if (stat.isDirectory()) {
      if (name === "node_modules" || rel === "test-results") return;
      for (const entry of readdirSync(abs).sort()) add(`${rel}/${entry}`);
      return;
    }
    if (!stat.isFile()) throw new HashError(`not a regular file: ${rel}`);
    if (name === ".DS_Store") return;
    files[rel] = sha256Hex(readFileSync(abs));
  };
  for (const top of readdirSync(root).sort()) add(top);
  const sorted = sortedRecord(files);
  return { tree_sha256: treeSha256(sorted), files: sorted };
}

/** Differences between hashed files and pinned per-file hashes, as sorted path lists. */
export function diffFiles(actual: Readonly<Record<string, string>>, pinned: Readonly<Record<string, string>>): { changed: string[]; missing: string[]; extra: string[] } {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [path, hash] of Object.entries(pinned)) {
    if (!(path in actual)) missing.push(path);
    else if (actual[path] !== hash) changed.push(path);
  }
  const extra = Object.keys(actual).filter((path) => !(path in pinned));
  return { changed: changed.sort(), missing: missing.sort(), extra: extra.sort() };
}

/** Reads a JSON file next to a `.sha256` pin and refuses it when the bytes differ from the pin. */
export function readPinnedJson(path: string): { value: unknown; sha256: string } {
  const bytes = readFileSync(path);
  const sha256 = sha256Hex(bytes);
  const pinned = readFileSync(`${path}.sha256`, "utf8").trim().split(/\s+/)[0] ?? "";
  if (pinned !== sha256) throw new HashError(`${path} differs from its .sha256 pin`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HashError(`${path} is not JSON`);
  }
  return { value, sha256 };
}
