// The exporter: reads one catalog entry's inputs from its host adapter, checks them against the entry,
// dry-runs the clean reconstruction and the reference repair on the exported buggy source, packs the
// bug case and the validator core, and passes every member of both parts through the pre-write scan hook.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogEntry, FileSet, HostAdapter, PackageKind } from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";
import { sha256Hex } from "@rbw/schema";
import { ArchiveError, isRelativePath, type ArchiveMember } from "./archive.ts";
import { canonicalEqual, type BugCaseManifest, type CaseIdentity, type ValidatorManifest } from "./format.ts";
import { packPair, PackRefused, type PackedPart } from "./pack.ts";
import { applyPatchText, PatchError, sameDigests } from "./patch.ts";

export interface ScanInput {
  part: PackageKind;
  /** Every member of the part, manifest included, as it will be written. */
  members: readonly ArchiveMember[];
}

/** The shape of the repository's publication scanner result, so a hook can return that result as it is. */
export type ScanVerdict = { outcome: "clean" } | { outcome: "blocked"; locations: string[] } | { outcome: "unavailable" };

/** Runs before anything is written; anything but `clean` refuses the export. */
export type ScanHook = (input: ScanInput) => Promise<ScanVerdict>;

export type ExportRefusalCode = "inconsistent_inputs" | "separation" | "unreadable_input" | "repair_mismatch" | "scan_blocked" | "scan_unavailable";

export class ExportRefused extends Error {
  readonly code: ExportRefusalCode;
  readonly problems: readonly string[];

  constructor(code: ExportRefusalCode, problems: readonly string[]) {
    super(`export refused (${code}): ${problems.join("; ")}`);
    this.name = "ExportRefused";
    this.code = code;
    this.problems = problems;
  }
}

export interface ExportOptions {
  adapter: HostAdapter;
  entry: CatalogEntry;
  identity: CaseIdentity;
  /** The host application's license (SPDX identifier), recorded as neutral provenance. */
  license: string;
  /** Defaults to 1. */
  package_version?: number;
  /** The pre-write scan; null exports without one and records `scanned: false`. */
  scan: ScanHook | null;
}

export interface PreparedCase {
  host_id: CatalogEntry["host_id"];
  entry_id: string;
  catalog_version: string;
  package_version: number;
  case_id: string;
  defect_id: string;
  bug_case: PackedPart<BugCaseManifest>;
  validator_core: PackedPart<ValidatorManifest>;
  scanned: boolean;
}

/** Reads a file set's listed files, refusing links, other non-regular files and bytes that differ from the list. */
export async function readFileSet(set: FileSet, name: string): Promise<ArchiveMember[]> {
  const members: ArchiveMember[] = [];
  const seen = new Set<string>();
  for (const file of set.files) {
    if (!isRelativePath(file.path) || seen.has(file.path)) throw new ExportRefused("unreadable_input", [`${name} lists an invalid or repeated path`]);
    seen.add(file.path);
    const path = join(set.root, file.path);
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      throw new ExportRefused("unreadable_input", [`${name} file ${file.path} cannot be read`]);
    }
    if (!stats.isFile()) throw new ExportRefused("unreadable_input", [`${name} file ${file.path} is not a regular file`]);
    const bytes = new Uint8Array(await readFile(path));
    if (sha256Hex(bytes) !== file.sha256) throw new ExportRefused("unreadable_input", [`${name} file ${file.path} differs from its listed hash`]);
    members.push({ path: file.path, bytes });
  }
  return members;
}

/** Fails closed: only a verdict that is exactly `{ outcome: "clean" }` lets the export continue. */
async function scanned(scan: ScanHook, part: PackageKind, members: readonly ArchiveMember[]): Promise<void> {
  const verdict: unknown = await scan({ part, members });
  const outcome = typeof verdict === "object" && verdict !== null ? (verdict as { outcome?: unknown }).outcome : undefined;
  if (outcome === "clean") return;
  if (outcome === "blocked") {
    const locations = (verdict as { locations?: unknown }).locations;
    const listed = Array.isArray(locations) ? locations.map((location) => `${part}: ${String(location)}`) : [`${part}: blocked`];
    throw new ExportRefused("scan_blocked", listed);
  }
  throw new ExportRefused("scan_unavailable", [`${part}: the scan did not answer clean`]);
}

/** Exports one catalog entry to its bug case and validator core. Writes nothing; see writePrepared. */
export async function exportCase(options: ExportOptions): Promise<PreparedCase> {
  const { adapter, entry } = options;
  if (entry.host_id !== adapter.host_id) throw new ExportRefused("inconsistent_inputs", ["the entry belongs to another host"]);
  const bugCase = await adapter.bugCaseInputs(entry);
  const validator = await adapter.validatorInputs(entry);
  const problems = [
    ...validateContract("BugCaseInputs", bugCase).map((error) => `bug case inputs: ${error}`),
    ...validateContract("ValidatorInputs", validator).map((error) => `validator inputs: ${error}`),
  ];
  if (problems.length > 0) throw new ExportRefused("inconsistent_inputs", problems);
  const baseline = adapter.baseline();
  const checks: [boolean, string][] = [
    [bugCase.host_id === entry.host_id && validator.host_id === entry.host_id, "the inputs belong to another host"],
    [bugCase.entry_id === entry.entry_id && validator.entry_id === entry.entry_id, "the inputs belong to another entry"],
    [canonicalEqual(bugCase.baseline, baseline), "the bug case baseline differs from the adapter's"],
    [canonicalEqual(validator.protocol, adapter.protocol(entry)), "the validator protocol differs from the adapter's protocol for the entry"],
    [bugCase.incident.files.some((file) => file.path === entry.incident.path && file.sha256 === entry.incident.sha256), "the incident files do not hold the entry's incident description"],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, problem]) => problem);
  if (failed.length > 0) throw new ExportRefused("inconsistent_inputs", failed);

  const source = await readFileSet(bugCase.source, "source");
  const incident = await readFileSet(bugCase.incident, "incident");
  const checkFiles = await readFileSet(validator.checks, "checks");

  // Dry run: both patches must apply to the exported buggy source and give exactly their recorded results.
  const tree = new Map(source.map((member) => [member.path, member.bytes]));
  const expectedClean = entry.plant.targets.map((target) => ({ path: target.path, sha256: target.before_sha256 }));
  for (const [name, patch, expected] of [
    ["clean reconstruction", validator.clean_reconstruction.patch, expectedClean],
    ["reference repair", validator.reference_repair.patch, validator.reference_repair.result_sha256],
  ] as const) {
    let changed;
    try {
      changed = applyPatchText(tree, patch).changed;
    } catch (error) {
      if (error instanceof PatchError) throw new ExportRefused("repair_mismatch", [`the ${name} ${error.message}`]);
      throw error;
    }
    if (!sameDigests(changed, expected)) throw new ExportRefused("repair_mismatch", [`the ${name} does not give its recorded result on the exported buggy source`]);
  }

  const defectId = options.identity.defectId(baseline, entry);
  const caseId = options.identity.caseId(defectId, entry);
  let packed;
  try {
    packed = packPair({
      case_id: caseId,
      defect_id: defectId,
      package_version: options.package_version ?? 1,
      license: options.license,
      entry,
      baseline,
      bug_case: { source, incident, runtime: bugCase.runtime },
      validator: {
        checks: checkFiles,
        expected: validator.expected,
        protocol: validator.protocol,
        clean_reconstruction: validator.clean_reconstruction,
        reference_repair: validator.reference_repair,
      },
    });
  } catch (error) {
    if (error instanceof PackRefused) throw new ExportRefused(error.code, error.problems);
    // For example two source paths that differ only in case, which no case-insensitive file system can hold.
    if (error instanceof ArchiveError) throw new ExportRefused("inconsistent_inputs", [error.message]);
    throw error;
  }
  if (options.scan !== null) {
    await scanned(options.scan, "bug_case", packed.bug_case.members);
    await scanned(options.scan, "validator", packed.validator_core.members);
  }
  return {
    host_id: entry.host_id,
    entry_id: entry.entry_id,
    catalog_version: entry.catalog_version,
    package_version: options.package_version ?? 1,
    case_id: caseId,
    defect_id: defectId,
    bug_case: packed.bug_case,
    validator_core: packed.validator_core,
    scanned: options.scan !== null,
  };
}
