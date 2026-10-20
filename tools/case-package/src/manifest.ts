// Strict readers for the two manifests: canonical JSON v1 bytes, exactly the documented fields, and the
// shared shapes checked against the contract schema. Node only (the schema validator reads its file).
import type { DefName, DefTypes, FileDigest } from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";
import { CanonicalError, encodeCanonical, parseCanonical } from "@rbw/schema";
import { compareUtf8 } from "./archive.ts";
import {
  BUG_CASE_FORMAT,
  CHECKS_DIRECTORY,
  CLEAN_RECONSTRUCTION_PATH,
  INCIDENT_DIRECTORY,
  REFERENCE_REPAIR_PATH,
  SOURCE_DIRECTORY,
  VALIDATOR_FORMAT,
  type BugCaseManifest,
  type PackageProvenance,
  type ValidatorManifest,
} from "./format.ts";

/** Raised for a manifest outside its format. The message names the field, never its value. */
export class ManifestError extends Error {
  constructor(reason: string) {
    super(`manifest: ${reason}`);
    this.name = "ManifestError";
  }
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, keys: readonly string[], field: string): Fields {
  if (!isRecord(value)) throw new ManifestError(`${field} is not an object`);
  const present = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (present.length !== expected.length || present.some((key, index) => key !== expected[index])) {
    throw new ManifestError(`${field} does not have exactly the documented fields`);
  }
  return value;
}

function shaped<K extends DefName>(name: K, value: unknown, field: string): DefTypes[K] {
  if (validateContract(name, value).length > 0) throw new ManifestError(`${field} is not a valid ${name}`);
  return value as DefTypes[K];
}

function digests(value: unknown, field: string): FileDigest[] {
  if (!Array.isArray(value)) throw new ManifestError(`${field} is not a list`);
  const list = value.map((item) => shaped("FileDigest", item, field));
  list.forEach((item, index) => {
    const previous = list[index - 1];
    if (previous !== undefined && compareUtf8(previous.path, item.path) >= 0) throw new ManifestError(`${field} is not unique and in path order`);
  });
  return list;
}

function provenance(value: unknown): PackageProvenance {
  const fields = object(value, ["license", "tools"], "provenance");
  if (typeof fields.license !== "string" || fields.license === "") throw new ManifestError("provenance.license is not a name");
  if (!Array.isArray(fields.tools)) throw new ManifestError("provenance.tools is not a list");
  const tools = fields.tools.map((tool) => {
    const item = object(tool, ["name", "version"], "provenance.tools");
    if (typeof item.name !== "string" || item.name === "" || typeof item.version !== "string" || item.version === "") {
      throw new ManifestError("provenance.tools has an unnamed tool");
    }
    return { name: item.name, version: item.version };
  });
  return { license: fields.license, tools };
}

function canonical(bytes: Uint8Array): unknown {
  let value: unknown;
  try {
    value = parseCanonical(bytes);
  } catch (error) {
    if (error instanceof CanonicalError) throw new ManifestError("not canonical JSON");
    throw error;
  }
  if (!Buffer.from(encodeCanonical(value)).equals(Buffer.from(bytes))) throw new ManifestError("not in canonical form");
  return value;
}

const BUG_CASE_KEYS = ["format", "package_version", "case_id", "defect_id", "host_id", "baseline", "runtime", "provenance", "files"] as const;

export function parseBugCaseManifest(bytes: Uint8Array): BugCaseManifest {
  const fields = object(canonical(bytes), BUG_CASE_KEYS, "bug-case.json");
  if (fields.format !== BUG_CASE_FORMAT) throw new ManifestError("format is not rbw-bug-case/1");
  const manifest: BugCaseManifest = {
    format: BUG_CASE_FORMAT,
    package_version: shaped("PositiveInteger", fields.package_version, "package_version"),
    case_id: shaped("Sha256", fields.case_id, "case_id"),
    defect_id: shaped("Sha256", fields.defect_id, "defect_id"),
    host_id: shaped("HostId", fields.host_id, "host_id"),
    baseline: shaped("BaselineIdentity", fields.baseline, "baseline"),
    runtime: shaped("BugCaseRuntime", fields.runtime, "runtime"),
    provenance: provenance(fields.provenance),
    files: digests(fields.files, "files"),
  };
  if (manifest.baseline.host_id !== manifest.host_id) throw new ManifestError("baseline belongs to another host");
  if (!manifest.files.every((file) => file.path.startsWith(SOURCE_DIRECTORY) || file.path.startsWith(INCIDENT_DIRECTORY))) {
    throw new ManifestError("files lists a path outside source/ and incident/");
  }
  return manifest;
}

const VALIDATOR_KEYS = [
  "format", "package_version", "case_id", "defect_id", "host_id", "entry_id", "baseline", "bug_case_sha256",
  "expected", "protocol", "clean_reconstruction", "reference_repair", "provenance", "files",
] as const;

export function parseValidatorManifest(bytes: Uint8Array): ValidatorManifest {
  const fields = object(canonical(bytes), VALIDATOR_KEYS, "validator.json");
  if (fields.format !== VALIDATOR_FORMAT) throw new ManifestError("format is not rbw-validator/1");
  const reconstruction = object(fields.clean_reconstruction, ["path", "patch_sha256", "result_sha256"], "clean_reconstruction");
  const repair = object(fields.reference_repair, ["path", "patch_sha256", "result_sha256", "kind"], "reference_repair");
  if (reconstruction.path !== CLEAN_RECONSTRUCTION_PATH) throw new ManifestError("clean_reconstruction.path is not the documented member");
  if (repair.path !== REFERENCE_REPAIR_PATH) throw new ManifestError("reference_repair.path is not the documented member");
  const manifest: ValidatorManifest = {
    format: VALIDATOR_FORMAT,
    package_version: shaped("PositiveInteger", fields.package_version, "package_version"),
    case_id: shaped("Sha256", fields.case_id, "case_id"),
    defect_id: shaped("Sha256", fields.defect_id, "defect_id"),
    host_id: shaped("HostId", fields.host_id, "host_id"),
    entry_id: shaped("Identifier", fields.entry_id, "entry_id"),
    baseline: shaped("BaselineIdentity", fields.baseline, "baseline"),
    bug_case_sha256: shaped("Sha256", fields.bug_case_sha256, "bug_case_sha256"),
    expected: shaped("ExpectedMatrix", fields.expected, "expected"),
    protocol: shaped("Protocol", fields.protocol, "protocol"),
    clean_reconstruction: {
      path: CLEAN_RECONSTRUCTION_PATH,
      patch_sha256: shaped("Sha256", reconstruction.patch_sha256, "clean_reconstruction.patch_sha256"),
      result_sha256: digests(reconstruction.result_sha256, "clean_reconstruction.result_sha256"),
    },
    reference_repair: {
      path: REFERENCE_REPAIR_PATH,
      patch_sha256: shaped("Sha256", repair.patch_sha256, "reference_repair.patch_sha256"),
      result_sha256: digests(repair.result_sha256, "reference_repair.result_sha256"),
      kind: shaped("RepairKind", repair.kind, "reference_repair.kind"),
    },
    provenance: provenance(fields.provenance),
    files: digests(fields.files, "files"),
  };
  if (manifest.baseline.host_id !== manifest.host_id) throw new ManifestError("baseline belongs to another host");
  const patches = new Map([[CLEAN_RECONSTRUCTION_PATH, manifest.clean_reconstruction.patch_sha256], [REFERENCE_REPAIR_PATH, manifest.reference_repair.patch_sha256]]);
  for (const file of manifest.files) {
    const patch = patches.get(file.path);
    if (patch === undefined && !file.path.startsWith(CHECKS_DIRECTORY)) throw new ManifestError("files lists a path outside checks/ and the patch members");
    if (patch !== undefined && patch !== file.sha256) throw new ManifestError("a patch member's hash differs from its patch hash");
    patches.delete(file.path);
  }
  if (patches.size > 0) throw new ManifestError("files does not list both patch members");
  return manifest;
}
