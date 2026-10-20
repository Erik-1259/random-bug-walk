// The catalog file of evaluator v2 (catalog/v2.json) as the copy driver and the evaluation read it:
// the catalog's SHA-256 and, per entry, the hashes that fix each state's source tree and the check
// files it runs under. Patch files are not read here (the host-side catalog loader in
// adapter/catalog.ts checks them); this module imports only node: built-ins so it runs in the copy.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord, isSha256, sha256Hex } from "../src/hash.ts";

export const CATALOG_V2_FILE = fileURLToPath(new URL("../catalog/v2.json", import.meta.url));
export const CATALOG_V2_FORMAT = "rbw.task-report.catalog.v2";

export class CatalogPinError extends Error {
  override name = "CatalogPinError";
}

export interface EntryPins {
  entry_id: string;
  target_path: string;
  /** The target file in the baseline (clean) tree. */
  baseline_sha256: string;
  /** The target file after the planted change (buggy tree). */
  buggy_sha256: string;
  /** The target file after the reference repair is applied to the buggy file (fixed tree). */
  repair_result_sha256: string;
  data_sha256: string;
  protocol_sha256: string;
}

export interface CatalogPins {
  sha256: string;
  catalog_id: string;
  baseline_id: string;
  entries: EntryPins[];
}

function sha(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (!isSha256(value)) throw new CatalogPinError(`${what}.${key} must be a SHA-256`);
  return value;
}

function str(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new CatalogPinError(`${what}.${key} must be a non-empty string`);
  return value;
}

function section(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CatalogPinError(`${what} must be an object`);
  return value;
}

export function parseCatalogPins(bytes: Uint8Array): CatalogPins {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CatalogPinError("the catalog is not JSON");
  }
  const root = section(data, "catalog");
  if (root.format !== CATALOG_V2_FORMAT) throw new CatalogPinError(`the catalog is not ${CATALOG_V2_FORMAT}`);
  if (!Array.isArray(root.entries) || root.entries.length === 0) throw new CatalogPinError("the catalog has no entries");
  const entries = root.entries.map((value: unknown, index: number): EntryPins => {
    const what = `entries[${String(index)}]`;
    const entry = section(value, what);
    const check = section(entry.check_set, `${what}.check_set`);
    const repair = section(entry.reference_repair, `${what}.reference_repair`);
    const target = str(entry, "target_path", what);
    if (target.startsWith("/") || target.split("/").some((part) => part === "" || part === "." || part === "..")) throw new CatalogPinError(`${what}.target_path must be a relative path`);
    return {
      entry_id: str(entry, "entry_id", what),
      target_path: target,
      baseline_sha256: sha(entry, "baseline_sha256", what),
      buggy_sha256: sha(entry, "buggy_sha256", what),
      repair_result_sha256: sha(repair, "result_sha256", `${what}.reference_repair`),
      data_sha256: sha(check, "data_sha256", `${what}.check_set`),
      protocol_sha256: sha(check, "protocol_sha256", `${what}.check_set`),
    };
  });
  if (new Set(entries.map((entry) => entry.entry_id)).size !== entries.length) throw new CatalogPinError("the catalog repeats an entry ID");
  return { sha256: sha256Hex(bytes), catalog_id: str(root, "catalog_id", "catalog"), baseline_id: str(root, "baseline_id", "catalog"), entries };
}

export function loadCatalogPins(path: string = CATALOG_V2_FILE): CatalogPins {
  return parseCatalogPins(readFileSync(path));
}

export function entryPins(catalog: CatalogPins, entryId: string): EntryPins {
  const found = catalog.entries.find((entry) => entry.entry_id === entryId);
  if (found === undefined) throw new CatalogPinError(`the catalog has no entry ${entryId}`);
  return found;
}
