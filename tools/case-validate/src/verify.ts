// Export verification, first step: both archives are read strictly, each member is checked against its
// manifest, and the validator must name this exact bug case, case, defect, host, baseline and package
// version. Refusals carry a client-safe message and an evaluator-only diagnostic.
import {
  ArchiveError,
  BUG_CASE_MANIFEST,
  canonicalEqual,
  EVIDENCE_PATH,
  ManifestError,
  pairSha256,
  parseBugCaseManifest,
  parseValidatorManifest,
  QUALIFICATION_EXPECTED,
  unpackArchive,
  VALIDATOR_MANIFEST,
  type BugCaseManifest,
  type ValidatorManifest,
} from "@rbw/case-package";
import type { FileDigest } from "@rbw/factory-contract";
import { CanonicalError, encodeCanonical, parseCanonical, sha256Hex } from "@rbw/schema";

/**
 * The pair is not one case's two exported parts. `message` is safe to show a client; `diagnostic` may name
 * validator members and is evaluator material.
 */
export class PairRefused extends Error {
  readonly code = "export_mismatch";
  readonly diagnostic: string;

  constructor(message: string, diagnostic: string = message) {
    super(message);
    this.name = "PairRefused";
    this.diagnostic = diagnostic;
  }
}

export interface VerifiedPart<M> {
  sha256: string;
  manifest: M;
  /** Members by path, manifest included. */
  members: Map<string, Uint8Array>;
}

export interface VerifiedPair {
  bug_case: VerifiedPart<BugCaseManifest>;
  validator: VerifiedPart<ValidatorManifest> & { evidence: boolean };
  pair_sha256: string;
}

function read(bytes: Uint8Array, label: string): Map<string, Uint8Array> {
  try {
    return new Map(unpackArchive(bytes).map((member) => [member.path, member.bytes]));
  } catch (error) {
    if (error instanceof ArchiveError) throw new PairRefused(`the ${label} is not a readable package archive`, error.message);
    throw error;
  }
}

function manifest<M>(parse: (bytes: Uint8Array) => M, bytes: Uint8Array, label: string): M {
  try {
    return parse(bytes);
  } catch (error) {
    if (error instanceof ManifestError) throw new PairRefused(`the ${label} manifest is not valid`, error.message);
    throw error;
  }
}

/** Every listed file is present with its hash, and nothing else is, apart from the allowed extra paths. */
function checkMembers(members: Map<string, Uint8Array>, manifestPath: string, files: readonly FileDigest[], extra: readonly string[], label: string): void {
  for (const file of files) {
    const bytes = members.get(file.path);
    if (bytes === undefined) throw new PairRefused(`the ${label} is missing a listed file`, `missing ${file.path}`);
    if (sha256Hex(bytes) !== file.sha256) throw new PairRefused(`a file in the ${label} differs from its listed hash`, `hash mismatch at ${file.path}`);
  }
  const listed = new Set([manifestPath, ...files.map((file) => file.path), ...extra]);
  for (const path of members.keys()) {
    if (!listed.has(path)) throw new PairRefused(`the ${label} holds a file its manifest does not list`, `unlisted ${path}`);
  }
}

/**
 * Verifies a bug case and a validator package as one case's pair. The validator may be a core or a final
 * archive (core plus the evidence member). Throws PairRefused for anything else, including a swapped pair.
 */
export function verifyPair(bugCase: Uint8Array, validator: Uint8Array): VerifiedPair {
  const bugMembers = read(bugCase, "bug case");
  const validatorMembers = read(validator, "validator package");
  if (bugMembers.has(VALIDATOR_MANIFEST) && validatorMembers.has(BUG_CASE_MANIFEST)) {
    throw new PairRefused("the parts are swapped: the bug case argument is a validator package and the validator argument is a bug case");
  }
  const bugManifestBytes = bugMembers.get(BUG_CASE_MANIFEST);
  if (bugManifestBytes === undefined) throw new PairRefused("the bug case part is not an rbw-bug-case/1 archive");
  const validatorManifestBytes = validatorMembers.get(VALIDATOR_MANIFEST);
  if (validatorManifestBytes === undefined) throw new PairRefused("the validator part is not an rbw-validator/1 archive");
  const bugManifest = manifest(parseBugCaseManifest, bugManifestBytes, "bug case");
  const validatorManifest = manifest(parseValidatorManifest, validatorManifestBytes, "validator package");

  checkMembers(bugMembers, BUG_CASE_MANIFEST, bugManifest.files, [], "bug case");
  checkMembers(validatorMembers, VALIDATOR_MANIFEST, validatorManifest.files, [EVIDENCE_PATH], "validator package");
  const evidence = validatorMembers.get(EVIDENCE_PATH);
  if (evidence !== undefined) {
    let canonical = false;
    try {
      canonical = Buffer.from(encodeCanonical(parseCanonical(evidence))).equals(Buffer.from(evidence));
    } catch (error) {
      if (!(error instanceof CanonicalError)) throw error;
    }
    if (!canonical) throw new PairRefused("the validator package's evidence is not canonical JSON");
  }

  const bugCaseSha256 = sha256Hex(bugCase);
  if (validatorManifest.bug_case_sha256 !== bugCaseSha256) throw new PairRefused("the validator package belongs to another bug case");
  const bindings: [string, boolean][] = [
    ["case_id", validatorManifest.case_id === bugManifest.case_id],
    ["defect_id", validatorManifest.defect_id === bugManifest.defect_id],
    ["package_version", validatorManifest.package_version === bugManifest.package_version],
    ["host_id", validatorManifest.host_id === bugManifest.host_id],
    ["baseline", canonicalEqual(validatorManifest.baseline, bugManifest.baseline)],
  ];
  const differing = bindings.filter(([, ok]) => !ok).map(([name]) => name);
  if (differing.length > 0) throw new PairRefused("the validator package belongs to another case or package version", `differs: ${differing.join(", ")}`);
  if (!canonicalEqual(validatorManifest.expected, QUALIFICATION_EXPECTED)) throw new PairRefused("the validator package's expected outcomes differ from the qualification table");

  const validatorSha256 = sha256Hex(validator);
  return {
    bug_case: { sha256: bugCaseSha256, manifest: bugManifest, members: bugMembers },
    validator: { sha256: validatorSha256, manifest: validatorManifest, members: validatorMembers, evidence: evidence !== undefined },
    pair_sha256: pairSha256({ bug_case_sha256: bugCaseSha256, validator_sha256: validatorSha256, case_id: bugManifest.case_id }),
  };
}
