// The final validator archive: the validator core plus one per-run evidence member. Pure and in memory
// (no file system or process access), so the worker that records the archive's SHA-256 and the download
// route that re-assembles and hash-checks it produce the same bytes from the same core and evidence value.
// inspectValidator reads the core and evidence hashes back from a stored archive.
import { CanonicalError, encodeCanonical, parseCanonical, sha256Hex } from "@rbw/schema";
import { ArchiveError, packArchive, unpackArchive } from "./archive.ts";
import { EVIDENCE_PATH, VALIDATOR_FORMAT, VALIDATOR_MANIFEST } from "./format.ts";

/** Raised when the core is not a validator core or the evidence is outside canonical JSON v1. */
export class AssemblyError extends Error {
  constructor(reason: string) {
    super(`validator assembly: ${reason}`);
    this.name = "AssemblyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assembles the final validator archive from a validator core and the evidence value. The evidence member
 * holds the value's canonical JSON v1 bytes, so a value read back from storage with its keys reordered gives
 * the same archive. The core's manifest and listed files are checked first; a core that already holds
 * evidence is refused.
 */
export function assembleFinalValidator(core: Uint8Array, evidence: unknown): Uint8Array {
  let evidenceBytes: Uint8Array;
  try {
    evidenceBytes = encodeCanonical(evidence);
  } catch (error) {
    if (error instanceof CanonicalError) throw new AssemblyError("the evidence is not canonical JSON");
    throw error;
  }
  let members;
  try {
    members = unpackArchive(core);
  } catch (error) {
    if (error instanceof ArchiveError) throw new AssemblyError("the core is not a readable archive");
    throw error;
  }
  const byPath = new Map(members.map((member) => [member.path, member.bytes]));
  const manifestBytes = byPath.get(VALIDATOR_MANIFEST);
  if (manifestBytes === undefined) throw new AssemblyError("the archive is not a validator core");
  if (byPath.has(EVIDENCE_PATH)) throw new AssemblyError("the core already holds evidence");
  let manifest: unknown;
  try {
    manifest = parseCanonical(manifestBytes);
  } catch (error) {
    if (error instanceof CanonicalError) throw new AssemblyError("the validator manifest is not canonical JSON");
    throw error;
  }
  if (!isRecord(manifest) || manifest.format !== VALIDATOR_FORMAT || !Array.isArray(manifest.files)) {
    throw new AssemblyError("the archive is not a validator core");
  }
  const listed = manifest.files as unknown[];
  const seen = new Set<string>([VALIDATOR_MANIFEST]);
  for (const file of listed) {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.sha256 !== "string") throw new AssemblyError("the validator manifest lists a malformed file");
    const bytes = byPath.get(file.path);
    if (seen.has(file.path) || bytes === undefined || sha256Hex(bytes) !== file.sha256) throw new AssemblyError("the core's members differ from its manifest");
    seen.add(file.path);
  }
  if (seen.size !== members.length) throw new AssemblyError("the core's members differ from its manifest");
  return packArchive([...members, { path: EVIDENCE_PATH, bytes: evidenceBytes }]);
}

/** What a stored validator archive holds, read back from its bytes (hashes and layout only). */
export interface ValidatorContents {
  /**
   * SHA-256 of the validator core the archive holds: its members without the evidence member, packed as
   * the exporter packs a core. Null when the archive is unreadable or holds no rbw-validator/1 manifest.
   */
  core_sha256: string | null;
  /** SHA-256 of the evidence member's bytes; null when the archive is unreadable or has none. */
  evidence_sha256: string | null;
}

function isValidatorManifest(bytes: Uint8Array | undefined): boolean {
  if (bytes === undefined) return false;
  let manifest: unknown;
  try {
    manifest = parseCanonical(bytes);
  } catch (error) {
    if (error instanceof CanonicalError) return false;
    throw error;
  }
  return isRecord(manifest) && manifest.format === VALIDATOR_FORMAT;
}

/**
 * The inverse of assembleFinalValidator for checking: `inspectValidator(assembleFinalValidator(core, evidence))`
 * gives the core's SHA-256 and the SHA-256 of the evidence's canonical JSON, and a core gives its own SHA-256
 * and no evidence. It answers nulls instead of throwing for bytes that are not a validator, so a caller that
 * compares the hashes with the expected ones refuses such an archive.
 */
export function inspectValidator(bytes: Uint8Array): ValidatorContents {
  let members;
  try {
    members = unpackArchive(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) return { core_sha256: null, evidence_sha256: null };
    throw error;
  }
  const evidence = members.find((member) => member.path === EVIDENCE_PATH);
  const core = members.filter((member) => member.path !== EVIDENCE_PATH);
  const manifest = core.find((member) => member.path === VALIDATOR_MANIFEST);
  return {
    core_sha256: isValidatorManifest(manifest?.bytes) ? sha256Hex(packArchive(core)) : null,
    evidence_sha256: evidence === undefined ? null : sha256Hex(evidence.bytes),
  };
}
