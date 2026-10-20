// The host side of catalog version 2 (catalog/v2.json): every entry with its contract fields and
// its pinned files (planted patch, reference repair, clean reconstruction, incident), each read and
// checked against its SHA-256, and the entry's check set bound to the data file and the version 2
// protocol. Host side only; the copy reads the same file through v2/entry.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, isSha256, sha256Hex } from "../src/hash.ts";
import { CATALOG_V2_FORMAT } from "../v2/entry.ts";

export const CATALOG_V2_PATH = fileURLToPath(new URL("../catalog/v2.json", import.meta.url));

export class CatalogV2Error extends Error {
  override name = "CatalogV2Error";
}

export interface PinnedText {
  file: string;
  sha256: string;
  text: string;
}

export interface CatalogV2Entry {
  entry_id: string;
  source_id: string;
  bug_type_id: "concurrency" | "date_time";
  criteria: { criterion_id: string; version: string }[];
  check_set: { check_set_id: string; version: string; data_file: string; data_sha256: string; protocol_file: string; protocol_sha256: string };
  target_path: string;
  baseline_sha256: string;
  buggy_sha256: string;
  buggy_git_tree: string;
  planted: PinnedText;
  repair: PinnedText & { kind: "revert" | "independent"; result_sha256: string };
  clean_reconstruction: PinnedText;
  incident: PinnedText;
  presentation: { title: string; observed_failure: string; how_checked: string; repetition_summary: string };
  difficulty: "not_assessed";
}

export interface CatalogV2 {
  sha256: string;
  catalog_id: string;
  version: number;
  baseline_id: string;
  entries: CatalogV2Entry[];
}

function section(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CatalogV2Error(`${what} must be an object`);
  return value;
}

function str(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new CatalogV2Error(`${what}.${key} must be a non-empty string`);
  return value;
}

function sha(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (!isSha256(value)) throw new CatalogV2Error(`${what}.${key} must be a SHA-256`);
  return value;
}

function relative(path: string, what: string): string {
  if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new CatalogV2Error(`${what} must be a relative path`);
  return path;
}

function pinned(dir: string, value: unknown, what: string): PinnedText {
  const record = section(value, what);
  const file = relative(str(record, "file", what), `${what}.file`);
  const bytes = readFileSync(join(dir, file));
  const expected = sha(record, "sha256", what);
  if (sha256Hex(bytes) !== expected) throw new CatalogV2Error(`${what}: ${file} differs from its pinned SHA-256`);
  return { file, sha256: expected, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}

export function loadCatalogV2(path: string = CATALOG_V2_PATH): CatalogV2 {
  const bytes = readFileSync(path);
  const dir = dirname(path);
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CatalogV2Error("the catalog is not JSON");
  }
  const root = section(data, "catalog");
  if (root.format !== CATALOG_V2_FORMAT) throw new CatalogV2Error(`the catalog is not ${CATALOG_V2_FORMAT}`);
  if (typeof root.version !== "number" || !Number.isSafeInteger(root.version)) throw new CatalogV2Error("catalog.version must be an integer");
  if (!Array.isArray(root.entries) || root.entries.length === 0) throw new CatalogV2Error("the catalog has no entries");
  const entries = root.entries.map((value: unknown, index: number): CatalogV2Entry => {
    const what = `entries[${String(index)}]`;
    const entry = section(value, what);
    const bugType = entry.bug_type_id;
    if (bugType !== "concurrency" && bugType !== "date_time") throw new CatalogV2Error(`${what}.bug_type_id is not a bug type`);
    if (!Array.isArray(entry.criteria) || entry.criteria.length === 0) throw new CatalogV2Error(`${what}.criteria must list at least one criterion`);
    const criteria = entry.criteria.map((item: unknown, at: number) => {
      const criterion = section(item, `${what}.criteria[${String(at)}]`);
      return { criterion_id: str(criterion, "criterion_id", `${what}.criteria`), version: str(criterion, "version", `${what}.criteria`) };
    });
    const check = section(entry.check_set, `${what}.check_set`);
    const repairRecord = section(entry.reference_repair, `${what}.reference_repair`);
    const kind = repairRecord.kind;
    if (kind !== "revert" && kind !== "independent") throw new CatalogV2Error(`${what}.reference_repair.kind must be revert or independent`);
    const presentation = section(entry.presentation, `${what}.presentation`);
    if (entry.difficulty !== "not_assessed") throw new CatalogV2Error(`${what}.difficulty must be not_assessed`);
    return {
      entry_id: str(entry, "entry_id", what),
      source_id: str(entry, "source_id", what),
      bug_type_id: bugType,
      criteria,
      check_set: {
        check_set_id: str(check, "check_set_id", `${what}.check_set`),
        version: str(check, "version", `${what}.check_set`),
        data_file: relative(str(check, "data_file", `${what}.check_set`), `${what}.check_set.data_file`),
        data_sha256: sha(check, "data_sha256", `${what}.check_set`),
        protocol_file: relative(str(check, "protocol_file", `${what}.check_set`), `${what}.check_set.protocol_file`),
        protocol_sha256: sha(check, "protocol_sha256", `${what}.check_set`),
      },
      target_path: relative(str(entry, "target_path", what), `${what}.target_path`),
      baseline_sha256: sha(entry, "baseline_sha256", what),
      buggy_sha256: sha(entry, "buggy_sha256", what),
      buggy_git_tree: str(entry, "buggy_git_tree", what),
      planted: pinned(dir, entry.planted_patch, `${what}.planted_patch`),
      repair: { ...pinned(dir, repairRecord, `${what}.reference_repair`), kind, result_sha256: sha(repairRecord, "result_sha256", `${what}.reference_repair`) },
      clean_reconstruction: pinned(dir, entry.clean_reconstruction, `${what}.clean_reconstruction`),
      incident: pinned(dir, entry.incident, `${what}.incident`),
      presentation: {
        title: str(presentation, "title", `${what}.presentation`),
        observed_failure: str(presentation, "observed_failure", `${what}.presentation`),
        how_checked: str(presentation, "how_checked", `${what}.presentation`),
        repetition_summary: str(presentation, "repetition_summary", `${what}.presentation`),
      },
      difficulty: "not_assessed",
    };
  });
  if (new Set(entries.map((entry) => entry.entry_id)).size !== entries.length) throw new CatalogV2Error("the catalog repeats an entry ID");
  return { sha256: sha256Hex(bytes), catalog_id: str(root, "catalog_id", "catalog"), version: root.version, baseline_id: str(root, "baseline_id", "catalog"), entries };
}
