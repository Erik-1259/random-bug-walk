// Builds the two parts of one case in memory: the bug case and the validator core bound to it. Pure (no
// file system or process access); the Node exporter and the synthetic pair builder both call packPair, so
// the separation and consistency checks cannot be skipped.
import type {
  BaselineIdentity,
  BugCaseRuntime,
  CatalogEntry,
  ExpectedMatrix,
  FileDigest,
  PackageFormat,
  PackageKind,
  PatchText,
  Protocol,
  ReferenceRepair,
} from "@rbw/factory-contract";
import { encodeCanonical, sha256Hex } from "@rbw/schema";
import { compareUtf8, isRelativePath, memberPathProblem, packArchive, type ArchiveMember } from "./archive.ts";
import {
  BUG_CASE_FORMAT,
  canonicalEqual,
  BUG_CASE_MANIFEST,
  CHECKS_DIRECTORY,
  CLEAN_RECONSTRUCTION_PATH,
  EXPORTER_TOOL,
  INCIDENT_DIRECTORY,
  QUALIFICATION_EXPECTED,
  REFERENCE_REPAIR_PATH,
  SOURCE_DIRECTORY,
  VALIDATOR_FORMAT,
  VALIDATOR_MANIFEST,
  type BugCaseManifest,
  type PackageProvenance,
  type ValidatorManifest,
} from "./format.ts";

export interface PairInput {
  case_id: string;
  defect_id: string;
  package_version: number;
  /** The host application's license (SPDX identifier), recorded as neutral provenance. */
  license: string;
  /** The catalog entry both parts come from: its plant, repair, protocol and environment are checked against the inputs. */
  entry: CatalogEntry;
  baseline: BaselineIdentity;
  bug_case: {
    /** The buggy application source with the unchanged original tests, paths relative to the source root. */
    source: ArchiveMember[];
    incident: ArchiveMember[];
    runtime: BugCaseRuntime;
  };
  validator: {
    /** Verification checks, fixtures and expected vectors, paths relative to the checks root. */
    checks: ArchiveMember[];
    expected: ExpectedMatrix;
    protocol: Protocol;
    clean_reconstruction: PatchText;
    reference_repair: ReferenceRepair;
  };
}

export interface PackedPart<M> {
  kind: PackageKind;
  format: PackageFormat;
  bytes: Uint8Array;
  sha256: string;
  size_bytes: number;
  manifest: M;
  /** Every member, manifest included, for the pre-write scan. */
  members: ArchiveMember[];
}

export interface PackedPair {
  bug_case: PackedPart<BugCaseManifest>;
  validator_core: PackedPart<ValidatorManifest>;
}

export type PackRefusalCode = "inconsistent_inputs" | "separation";

/** Raised when the inputs disagree with the entry or the bug case would carry evaluator material. */
export class PackRefused extends Error {
  readonly code: PackRefusalCode;
  readonly problems: readonly string[];

  constructor(code: PackRefusalCode, problems: readonly string[]) {
    super(`package refused (${code}): ${problems.join("; ")}`);
    this.name = "PackRefused";
    this.code = code;
    this.problems = problems;
  }
}

const encoder = new TextEncoder();
const HASH = /^[0-9a-f]{64}$/;
const VERSION_CONTROL = new Set([".git", ".hg", ".svn"]);
/** Top-level source directories that name evaluator locations; the bug case never has them. */
const EVALUATOR_ROOTS = new Set(["evaluator", "validator", ".rbw"]);

function digests(members: readonly ArchiveMember[]): FileDigest[] {
  return members.map((member) => ({ path: member.path, sha256: sha256Hex(member.bytes) })).sort((a, b) => compareUtf8(a.path, b.path));
}

function prefixed(prefix: string, members: readonly ArchiveMember[]): ArchiveMember[] {
  return members.map((member) => ({ path: `${prefix}${member.path}`, bytes: member.bytes }));
}

/** The whole patch and each of its hunks (header and body), the texts that must not appear in a bug case. */
function patchNeedles(patch: string): Uint8Array[] {
  if (patch === "") return [];
  const needles = [patch];
  const lines = patch.split("\n");
  let hunk: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (hunk !== null) needles.push(hunk.join("\n"));
      hunk = [line];
    } else if (line.startsWith("diff --git ")) {
      if (hunk !== null) needles.push(hunk.join("\n"));
      hunk = null;
    } else if (hunk !== null && line !== "") {
      hunk.push(line);
    }
  }
  if (hunk !== null) needles.push(hunk.join("\n"));
  return needles.map((needle) => encoder.encode(needle));
}

export interface SeparationInput {
  /** Bug case members with their archive paths (source/..., incident/...). */
  bug_case: readonly ArchiveMember[];
  /** Validator files whose copies must not appear in the bug case. */
  validator_files: readonly ArchiveMember[];
  /** Patch texts (plant, clean reconstruction, reference repair) that must not appear verbatim. */
  patches: readonly string[];
  /** Hashes of original or repaired file contents (plant targets' before, repair and reconstruction results). */
  pristine_sha256: readonly string[];
}

/**
 * Lists every reason a bug case would carry evaluator material: version-control history, an evaluator
 * location, a byte copy of a validator file, a pristine or repaired copy of a changed file, or verbatim patch
 * text (a whole patch or one of its hunks). Empty files are never treated as copies.
 */
export function separationProblems(input: SeparationInput): string[] {
  const problems: string[] = [];
  const validatorHashes = new Set(input.validator_files.filter((file) => file.bytes.length > 0).map((file) => sha256Hex(file.bytes)));
  const pristine = new Set(input.pristine_sha256);
  const needles = input.patches.flatMap(patchNeedles);
  for (const member of input.bug_case) {
    const segments = member.path.split("/");
    if (segments.some((segment) => VERSION_CONTROL.has(segment))) problems.push(`version_control_history: ${member.path}`);
    if (member.path.startsWith(SOURCE_DIRECTORY) && EVALUATOR_ROOTS.has(segments[1] ?? "")) problems.push(`evaluator_location: ${member.path}`);
    if (member.bytes.length === 0) continue;
    const hash = sha256Hex(member.bytes);
    if (validatorHashes.has(hash)) problems.push(`validator_file_copy: ${member.path}`);
    if (pristine.has(hash)) problems.push(`pristine_copy: ${member.path}`);
    const bytes = Buffer.from(member.bytes.buffer, member.bytes.byteOffset, member.bytes.byteLength);
    if (needles.some((needle) => bytes.indexOf(needle) >= 0)) problems.push(`patch_text: ${member.path}`);
  }
  return problems;
}

function consistencyProblems(input: PairInput): string[] {
  const problems: string[] = [];
  const { entry, baseline, bug_case: bugCase, validator } = input;
  const check = (ok: boolean, problem: string): void => {
    if (!ok) problems.push(problem);
  };
  check(HASH.test(input.case_id) && HASH.test(input.defect_id), "case_id and defect_id must be 64 lowercase hex characters");
  check(Number.isSafeInteger(input.package_version) && input.package_version >= 1, "package_version must be a positive integer");
  check(input.license.trim() !== "", "the license must be named");
  check(baseline.host_id === entry.host_id, "the baseline belongs to another host");
  check(bugCase.runtime.kit_image === entry.environment.kit_image && bugCase.runtime.kit_image_digest === entry.environment.kit_image_digest, "the runtime image differs from the entry's environment");
  check(canonicalEqual(validator.expected, QUALIFICATION_EXPECTED), "the expected outcomes differ from the qualification table");
  check(sha256Hex(encoder.encode(entry.plant.patch)) === entry.plant.patch_sha256, "the planted change's patch hash does not match its text");
  check(sha256Hex(encoder.encode(validator.reference_repair.patch)) === validator.reference_repair.patch_sha256, "the reference repair's patch hash does not match its text");
  check(sha256Hex(encoder.encode(validator.clean_reconstruction.patch)) === validator.clean_reconstruction.patch_sha256, "the clean reconstruction's patch hash does not match its text");
  check(canonicalEqual(validator.reference_repair, entry.reference_repair), "the reference repair differs from the entry's");
  check(validator.protocol.protocol_id === entry.verification.protocol_id && validator.protocol.sha256 === entry.verification.protocol_sha256, "the protocol differs from the entry's verification identity");
  for (const [name, members] of [["source", bugCase.source], ["incident", bugCase.incident], ["checks", validator.checks]] as const) {
    // Relative, unique, no two differing only in case, no file that is also a directory: every tree must unpack anywhere.
    const problem = memberPathProblem(members.map((member) => member.path));
    if (problem !== null) problems.push(`${name}: ${problem}`);
  }
  check(entry.plant.targets.length > 0, "the planted change has no targets");
  const source = new Map(bugCase.source.map((member) => [member.path, member.bytes]));
  for (const target of entry.plant.targets) {
    const bytes = source.get(target.path);
    check(bytes !== undefined && sha256Hex(bytes) === target.after_sha256, `the exported source does not hold the planted change at ${target.path}`);
  }
  const results = [...entry.reference_repair.result_sha256.map((item) => item.path), ...entry.plant.targets.map((item) => item.path)];
  check(results.every((path) => isRelativePath(path)), "a changed path is not a relative path");
  check(new Set(entry.reference_repair.result_sha256.map((item) => item.path)).size === entry.reference_repair.result_sha256.length, "the repair lists a path twice");
  check(new Set(entry.plant.targets.map((item) => item.path)).size === entry.plant.targets.length, "the planted change lists a path twice");
  return problems;
}

function provenance(license: string): PackageProvenance {
  return { license, tools: [{ name: EXPORTER_TOOL.name, version: EXPORTER_TOOL.version }] };
}

function part<M>(kind: PackageKind, format: PackageFormat, manifestPath: string, manifest: M, members: ArchiveMember[]): PackedPart<M> {
  const all = [{ path: manifestPath, bytes: encodeCanonical(manifest) }, ...members].sort((a, b) => compareUtf8(a.path, b.path));
  const bytes = packArchive(all);
  return { kind, format, bytes, sha256: sha256Hex(bytes), size_bytes: bytes.length, manifest, members: all };
}

/**
 * Packs a case's bug case and validator core. Refuses inputs that disagree with the catalog entry and a
 * bug case that would carry evaluator material. The validator core records the bug case's SHA-256, so a
 * validator from another bug case is refused by the harness.
 */
export function packPair(input: PairInput): PackedPair {
  const problems = consistencyProblems(input);
  if (problems.length > 0) throw new PackRefused("inconsistent_inputs", problems);

  const { entry, bug_case: bugCase, validator } = input;
  const bugCaseMembers = [...prefixed(SOURCE_DIRECTORY, bugCase.source), ...prefixed(INCIDENT_DIRECTORY, bugCase.incident)];
  const cleanResult = entry.plant.targets
    .map((target) => ({ path: target.path, sha256: target.before_sha256 }))
    .sort((a, b) => compareUtf8(a.path, b.path));
  const repairResult = [...validator.reference_repair.result_sha256].sort((a, b) => compareUtf8(a.path, b.path));
  const patchMembers = [
    { path: CLEAN_RECONSTRUCTION_PATH, bytes: encoder.encode(validator.clean_reconstruction.patch) },
    { path: REFERENCE_REPAIR_PATH, bytes: encoder.encode(validator.reference_repair.patch) },
  ];
  const separation = separationProblems({
    bug_case: bugCaseMembers,
    validator_files: [...validator.checks, ...patchMembers],
    patches: [entry.plant.patch, validator.clean_reconstruction.patch, validator.reference_repair.patch],
    pristine_sha256: [...cleanResult, ...repairResult].map((item) => item.sha256),
  });
  if (separation.length > 0) throw new PackRefused("separation", separation);

  const bugCaseManifest: BugCaseManifest = {
    format: BUG_CASE_FORMAT,
    package_version: input.package_version,
    case_id: input.case_id,
    defect_id: input.defect_id,
    host_id: entry.host_id,
    baseline: input.baseline,
    runtime: bugCase.runtime,
    provenance: provenance(input.license),
    files: digests(bugCaseMembers),
  };
  const bugCasePart = part("bug_case", BUG_CASE_FORMAT, BUG_CASE_MANIFEST, bugCaseManifest, bugCaseMembers);

  const validatorMembers = [...prefixed(CHECKS_DIRECTORY, validator.checks), ...patchMembers];
  const validatorManifest: ValidatorManifest = {
    format: VALIDATOR_FORMAT,
    package_version: input.package_version,
    case_id: input.case_id,
    defect_id: input.defect_id,
    host_id: entry.host_id,
    entry_id: entry.entry_id,
    baseline: input.baseline,
    bug_case_sha256: bugCasePart.sha256,
    expected: validator.expected,
    protocol: validator.protocol,
    clean_reconstruction: { path: CLEAN_RECONSTRUCTION_PATH, patch_sha256: validator.clean_reconstruction.patch_sha256, result_sha256: cleanResult },
    reference_repair: { path: REFERENCE_REPAIR_PATH, patch_sha256: validator.reference_repair.patch_sha256, result_sha256: repairResult, kind: validator.reference_repair.kind },
    provenance: provenance(input.license),
    files: digests(validatorMembers),
  };
  const validatorPart = part("validator", VALIDATOR_FORMAT, VALIDATOR_MANIFEST, validatorManifest, validatorMembers);
  return { bug_case: bugCasePart, validator_core: validatorPart };
}
