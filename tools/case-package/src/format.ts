// The package format rbw-bug-case/1 and rbw-validator/1 (docs/product/bug-package-v1.md): member
// layout, manifest shapes, the pair binding and the prepared-directory index. Pure, with no file system
// or process access, so the web routes and the worker can import it.
import type {
  BaselineIdentity,
  BugCaseRuntime,
  CatalogEntry,
  ExpectedMatrix,
  FileDigest,
  HostId,
  PackageFormat,
  PackageKind,
  Protocol,
  RepairKind,
} from "@rbw/factory-contract";
import { HOST_ID_VALUES } from "@rbw/factory-contract";
import { canonicalDigest, encodeCanonical } from "@rbw/schema";

export const BUG_CASE_FORMAT = "rbw-bug-case/1";
export const VALIDATOR_FORMAT = "rbw-validator/1";

/** Member paths. Source and incident files sit under their directories with the adapter's relative paths. */
export const BUG_CASE_MANIFEST = "bug-case.json";
export const SOURCE_DIRECTORY = "source/";
export const INCIDENT_DIRECTORY = "incident/";
export const VALIDATOR_MANIFEST = "validator.json";
export const CHECKS_DIRECTORY = "checks/";
export const CLEAN_RECONSTRUCTION_PATH = "reconstruction/clean.patch";
export const REFERENCE_REPAIR_PATH = "repair/reference.patch";
/** The per-run evidence member: present only in a final validator archive, never in the core. */
export const EVIDENCE_PATH = "evidence/qualification.json";

/** The exporter's name and version, recorded in both manifests' provenance. */
export const EXPORTER_TOOL = { name: "rbw-case-package", version: "1" } as const;

/** The expected outcome of every cell, as the contract's qualification table fixes them. */
export const QUALIFICATION_EXPECTED: ExpectedMatrix = {
  original_suite: { clean: "pass", buggy: "pass", fixed: "pass" },
  verification: { clean: "pass", buggy: "fail", fixed: "pass" },
};

/** Neutral provenance: the host application's license and the tools that wrote the archive. */
export interface PackageProvenance {
  license: string;
  tools: { name: string; version: string }[];
}

export interface BugCaseManifest {
  format: typeof BUG_CASE_FORMAT;
  package_version: number;
  case_id: string;
  defect_id: string;
  host_id: HostId;
  baseline: BaselineIdentity;
  runtime: BugCaseRuntime;
  provenance: PackageProvenance;
  /** Every member except bug-case.json, by UTF-8 path order. */
  files: FileDigest[];
}

export interface PatchMember {
  path: string;
  patch_sha256: string;
  /** The SHA-256 of every path the patch changes, after it is applied to the exported buggy source. */
  result_sha256: FileDigest[];
}

export interface ValidatorManifest {
  format: typeof VALIDATOR_FORMAT;
  package_version: number;
  case_id: string;
  defect_id: string;
  host_id: HostId;
  entry_id: string;
  baseline: BaselineIdentity;
  /** The SHA-256 of the one bug-case archive this validator belongs to. */
  bug_case_sha256: string;
  expected: ExpectedMatrix;
  protocol: Protocol;
  clean_reconstruction: PatchMember & { path: typeof CLEAN_RECONSTRUCTION_PATH };
  reference_repair: PatchMember & { path: typeof REFERENCE_REPAIR_PATH; kind: RepairKind };
  provenance: PackageProvenance;
  /** Every core member except validator.json, by UTF-8 path order; never the evidence member. */
  files: FileDigest[];
}

/**
 * The factory's identity functions (contract section 10.4), injected by the caller: the exporter writes the
 * IDs they return and never computes them itself. The criteria catalog version is bound by the caller.
 */
export interface CaseIdentity {
  defectId(baseline: BaselineIdentity, entry: CatalogEntry): string;
  caseId(defectId: string, entry: CatalogEntry): string;
}

export interface PairBindingInput {
  bug_case_sha256: string;
  validator_sha256: string;
  case_id: string;
}

/**
 * `pair_sha256` of contract section 10.3: the canonical JSON v1 hash of exactly
 * `{ bug_case_sha256, case_id, validator_sha256 }`, where `validator_sha256` is the downloadable
 * (final) validator archive. It is computed outside both archives, since neither can hold its own hash.
 */
export function pairSha256(input: PairBindingInput): string {
  return canonicalDigest({ bug_case_sha256: input.bug_case_sha256, case_id: input.case_id, validator_sha256: input.validator_sha256 }).sha256;
}

/** True when two values have the same canonical JSON v1 bytes. */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b)));
}

export function formatOf(kind: PackageKind): PackageFormat {
  return kind === "bug_case" ? BUG_CASE_FORMAT : VALIDATOR_FORMAT;
}

/** The download file name of a part: `rbw-bug-case-<case_id>.tar.gz` or `rbw-validator-<case_id>.tar.gz`. */
export function packageFilename(kind: PackageKind, caseId: string): string {
  return `${kind === "bug_case" ? "rbw-bug-case" : "rbw-validator"}-${caseId}.tar.gz`;
}

export const PREPARED_INDEX = "index.json";
export const PREPARED_INDEX_FORMAT = "rbw-prepared-packages/1";

/** One prepared catalog entry: its IDs and the content addresses of its bug case and validator core. */
export interface PreparedEntry {
  host_id: HostId;
  entry_id: string;
  catalog_version: string;
  package_version: number;
  case_id: string;
  defect_id: string;
  bug_case_sha256: string;
  bug_case_size_bytes: number;
  validator_core_sha256: string;
  validator_core_size_bytes: number;
  /** Whether the pre-write scan hook passed both parts; false when the export ran without a hook. */
  scanned: boolean;
}

export interface PreparedIndex {
  format: typeof PREPARED_INDEX_FORMAT;
  /** Ordered by host_id, then entry_id. */
  entries: PreparedEntry[];
}

/** The object name of an archive in a prepared directory. */
export function preparedObjectName(sha256: string): string {
  return `${sha256}.tar.gz`;
}

const SHA256 = /^[0-9a-f]{64}$/;
const HOSTS: readonly string[] = HOST_ID_VALUES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value).sort();
  return present.length === keys.length && [...keys].sort().every((key, index) => present[index] === key);
}

const ENTRY_KEYS = [
  "host_id", "entry_id", "catalog_version", "package_version", "case_id", "defect_id",
  "bug_case_sha256", "bug_case_size_bytes", "validator_core_sha256", "validator_core_size_bytes", "scanned",
] as const;

function isPreparedEntry(value: unknown): value is PreparedEntry {
  if (!isRecord(value) || !exactKeys(value, ENTRY_KEYS)) return false;
  const { host_id, entry_id, catalog_version, package_version, case_id, defect_id } = value;
  return typeof host_id === "string" && HOSTS.includes(host_id)
    && typeof entry_id === "string" && entry_id !== ""
    && typeof catalog_version === "string" && catalog_version !== ""
    && Number.isSafeInteger(package_version) && (package_version as number) >= 1
    && [case_id, defect_id, value.bug_case_sha256, value.validator_core_sha256].every((hash) => typeof hash === "string" && SHA256.test(hash))
    && [value.bug_case_size_bytes, value.validator_core_size_bytes].every((size) => Number.isSafeInteger(size) && (size as number) >= 0)
    && typeof value.scanned === "boolean";
}

/** Parses a prepared index; throws on anything outside the shape, duplicate entries or unordered entries. */
export function parsePreparedIndex(value: unknown): PreparedIndex {
  if (!isRecord(value) || !exactKeys(value, ["format", "entries"]) || value.format !== PREPARED_INDEX_FORMAT || !Array.isArray(value.entries)) {
    throw new Error("prepared index: not an rbw-prepared-packages/1 index");
  }
  const entries: PreparedEntry[] = [];
  for (const entry of value.entries as unknown[]) {
    if (!isPreparedEntry(entry)) throw new Error("prepared index: malformed entry");
    const previous = entries.at(-1);
    if (previous !== undefined && comparePrepared(previous, entry) >= 0) throw new Error("prepared index: entries are not unique and ordered");
    entries.push(entry);
  }
  return { format: PREPARED_INDEX_FORMAT, entries };
}

export function comparePrepared(a: Pick<PreparedEntry, "host_id" | "entry_id">, b: Pick<PreparedEntry, "host_id" | "entry_id">): number {
  if (a.host_id !== b.host_id) return a.host_id < b.host_id ? -1 : 1;
  if (a.entry_id === b.entry_id) return 0;
  return a.entry_id < b.entry_id ? -1 : 1;
}
