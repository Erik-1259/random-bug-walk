import { createHash } from "node:crypto";

/** An input that cannot be used; the command exits 2 with `code` and never with the input's text. */
export class InputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export type JsonObject = Record<string, unknown>;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with keys sorted at every level and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as JsonObject)[key]);
    return sorted;
  }
  return value;
}

/** Orders strings by their UTF-8 bytes, the order git and the manifest use. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError(code);
  }
}

/** Returns `value` as an object holding every required key, only known keys, and nothing else. */
export function strictObject(value: unknown, required: readonly string[], optional: readonly string[], code: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InputError(code);
  const object = value as JsonObject;
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) throw new InputError(code);
  }
  for (const key of required) {
    if (!(key in object)) throw new InputError(code);
  }
  return object;
}

export function stringField(object: JsonObject, key: string, code: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new InputError(code);
  return value;
}

export function arrayField(object: JsonObject, key: string, code: string): unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new InputError(code);
  return value;
}

export const HEX40 = /^[0-9a-f]{40}$/;
export const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A repository-relative POSIX path: not absolute, no empty, `.` or `..` segment, no
 * backslash and no NUL.
 */
export function isRepoPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function repoPath(value: unknown, code: string): string {
  if (typeof value !== "string" || !isRepoPath(value)) throw new InputError(code);
  return value;
}
