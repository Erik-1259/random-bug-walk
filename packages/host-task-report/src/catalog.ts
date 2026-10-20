// The candidate catalog of the task-report host (catalog/v1.json) and the code states it derives:
// clean is the vendored baseline, buggy is the baseline with the entry's planted patch, and fixed is
// the buggy tree with the pinned reference repair, which must give back the baseline file's exact
// bytes. Patches are applied as data with the diff library, never by running anything, and every
// base, result and patch is checked against the catalog's hashes. Host side only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, parsePatch } from "diff";
import type { StructuredPatch } from "diff";
import type { Baseline } from "./baseline.ts";
import { isRecord, isSha256, sha256Hex } from "./hash.ts";

export const CATALOG_DIR = fileURLToPath(new URL("../catalog/", import.meta.url));
export const CATALOG_FILE = join(CATALOG_DIR, "v1.json");
export const CATALOG_FORMAT = "rbw.task-report.catalog.v1";

export class CatalogError extends Error {
  override name = "CatalogError";
}

export interface PinnedFile {
  file: string;
  sha256: string;
  text: string;
}

export interface CatalogEntry {
  entry_id: string;
  bug_type: string;
  criterion: { id: string; version: number };
  failure_code: string;
  check: { id: string; version: number; data_file: string; protocol_file: string };
  target_path: string;
  baseline_sha256: string;
  buggy_sha256: string;
  buggy_git_tree: string;
  planted: PinnedFile;
  repair: PinnedFile & { result_sha256: string; kind: string };
  incident: PinnedFile;
  difficulty: string;
  source_inferable: boolean;
}

export interface Catalog {
  sha256: string;
  catalog_id: string;
  version: number;
  baseline_id: string;
  entries: CatalogEntry[];
}

function str(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new CatalogError(`${what}.${key} must be a non-empty string`);
  return value;
}

function sha(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (!isSha256(value)) throw new CatalogError(`${what}.${key} must be a SHA-256`);
  return value;
}

function section(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CatalogError(`${what} must be an object`);
  return value;
}

/** Reads a file the catalog names beside it and checks its pinned hash. */
function pinned(dir: string, value: unknown, what: string): PinnedFile {
  const record = section(value, what);
  const file = str(record, "file", what);
  if (file.startsWith("/") || file.split("/").some((part) => part === ".." || part === "")) throw new CatalogError(`${what}.file must be a relative path inside the catalog`);
  const bytes = readFileSync(join(dir, file));
  const expected = sha(record, "sha256", what);
  if (sha256Hex(bytes) !== expected) throw new CatalogError(`${what}: ${file} differs from its pinned SHA-256`);
  return { file, sha256: expected, text: bytes.toString("utf8") };
}

export function loadCatalog(path: string = CATALOG_FILE): Catalog {
  const bytes = readFileSync(path);
  const dir = join(path, "..");
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CatalogError("the catalog is not JSON");
  }
  const root = section(data, "catalog");
  if (root.format !== CATALOG_FORMAT) throw new CatalogError(`the catalog is not ${CATALOG_FORMAT}`);
  if (!Array.isArray(root.entries) || root.entries.length === 0) throw new CatalogError("the catalog has no entries");
  const entries = root.entries.map((value: unknown, index: number): CatalogEntry => {
    const what = `entries[${String(index)}]`;
    const entry = section(value, what);
    const criterion = section(entry.criterion, `${what}.criterion`);
    const check = section(entry.check, `${what}.check`);
    const repairRecord = section(entry.reference_repair, `${what}.reference_repair`);
    if (typeof criterion.version !== "number" || typeof check.version !== "number") throw new CatalogError(`${what}: versions must be numbers`);
    if (typeof entry.source_inferable !== "boolean") throw new CatalogError(`${what}.source_inferable must be a boolean`);
    return {
      entry_id: str(entry, "entry_id", what),
      bug_type: str(entry, "bug_type", what),
      criterion: { id: str(criterion, "id", `${what}.criterion`), version: criterion.version },
      failure_code: str(entry, "failure_code", what),
      check: { id: str(check, "id", `${what}.check`), version: check.version, data_file: str(check, "data_file", `${what}.check`), protocol_file: str(check, "protocol_file", `${what}.check`) },
      target_path: str(entry, "target_path", what),
      baseline_sha256: sha(entry, "baseline_sha256", what),
      buggy_sha256: sha(entry, "buggy_sha256", what),
      buggy_git_tree: str(entry, "buggy_git_tree", what),
      planted: pinned(dir, entry.planted_patch, `${what}.planted_patch`),
      repair: { ...pinned(dir, repairRecord, `${what}.reference_repair`), result_sha256: sha(repairRecord, "result_sha256", `${what}.reference_repair`), kind: str(repairRecord, "kind", `${what}.reference_repair`) },
      incident: pinned(dir, entry.incident, `${what}.incident`),
      difficulty: str(entry, "difficulty", what),
      source_inferable: entry.source_inferable,
    };
  });
  if (new Set(entries.map((entry) => entry.entry_id)).size !== entries.length) throw new CatalogError("the catalog repeats an entry ID");
  return { sha256: sha256Hex(bytes), catalog_id: str(root, "catalog_id", "catalog"), version: typeof root.version === "number" ? root.version : 0, baseline_id: str(root, "baseline_id", "catalog"), entries };
}

/** Parses a patch and requires it to change only the target file. */
export function targetPatch(text: string, target: string): StructuredPatch {
  const patches = parsePatch(text);
  const [patch] = patches;
  if (patches.length !== 1 || patch?.oldFileName !== `a/${target}` || patch.newFileName !== `b/${target}` || patch.hunks.length === 0) {
    throw new CatalogError(`the patch must change only ${target}`);
  }
  return patch;
}

/** Applies a patch to its base, checking the base hash, the scope and the result hash. */
export function applyChecked(base: Uint8Array, patchText: string, target: string, baseSha256: string, resultSha256: string): Buffer {
  if (sha256Hex(base) !== baseSha256) throw new CatalogError("the base differs from its pinned SHA-256");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(base);
  const result = applyPatch(text, targetPatch(patchText, target));
  if (result === false) throw new CatalogError("the patch does not apply to its base");
  const bytes = Buffer.from(result, "utf8");
  if (sha256Hex(bytes) !== resultSha256) throw new CatalogError("the patched file differs from its pinned SHA-256");
  return bytes;
}

export type StateName = "clean" | "buggy" | "fixed";

export interface StateTree {
  state: StateName;
  /** Every file of the app tree by repository-relative path. */
  files: Map<string, Buffer>;
  target_sha256: string;
}

/** Reads the vendored baseline tree and checks every file against the baseline manifest. */
export function readBaselineTree(appDir: string, baseline: Baseline): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const [path, hash] of Object.entries(baseline.source.files)) {
    const bytes = readFileSync(join(appDir, path));
    if (sha256Hex(bytes) !== hash) throw new CatalogError(`vendored file ${path} differs from the baseline manifest`);
    files.set(path, bytes);
  }
  return files;
}

/** The app tree of one code state of an entry, derived from the vendored baseline. */
export function deriveState(entry: CatalogEntry, baselineFiles: ReadonlyMap<string, Buffer>, state: StateName): StateTree {
  const base = baselineFiles.get(entry.target_path);
  if (base === undefined) throw new CatalogError(`the baseline has no ${entry.target_path}`);
  const files = new Map(baselineFiles);
  if (state === "clean") return { state, files, target_sha256: sha256Hex(base) };
  const buggy = applyChecked(base, entry.planted.text, entry.target_path, entry.baseline_sha256, entry.buggy_sha256);
  if (state === "buggy") {
    files.set(entry.target_path, buggy);
    return { state, files, target_sha256: entry.buggy_sha256 };
  }
  const fixed = applyChecked(buggy, entry.repair.text, entry.target_path, entry.buggy_sha256, entry.repair.result_sha256);
  if (!fixed.equals(base)) throw new CatalogError("the reference repair does not give back the baseline bytes");
  files.set(entry.target_path, fixed);
  return { state, files, target_sha256: entry.repair.result_sha256 };
}
