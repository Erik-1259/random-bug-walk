// The run's inputs, read and hashed before anything runs. A missing or inconsistent input stops
// the run here, before any container exists.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InputError, canonicalJson, parseManifest } from "@rbw/projection";
import type { Manifest } from "@rbw/projection";
import { sha256Hex } from "@rbw/schema";
import { loadProbeSet } from "@rbw/shapes";
import type { ProbeSet } from "@rbw/shapes";
import { UMAMI_COMMIT, addedSuiteSha256 } from "@rbw/umami-driver";
import { loadAlternativeFix } from "./code-states.ts";
import type { AlternativeFix } from "./code-states.ts";
import { DEFAULT_FAMILY, FamilyError, checkFamilyProbes, checkKitStage, familyFor, raceLatency } from "./family.ts";
import type { Family, FamilyFixture, FamilyId } from "./family.ts";
import { DEFAULT_POLICY } from "./projection.ts";
import { loadRecordedDir } from "./recorded.ts";
import type { RecordedDir } from "./recorded.ts";

export class InputsError extends Error {
  override name = "InputsError";
}

export interface CopyInputOptions {
  manifest: string;
  terms: string;
  policy: string | null;
  /** The bug family; the time-zone family when absent. */
  family?: FamilyId;
  /** Race family only: the database latency each copy's Toxiproxy applies, 0 to 10000 ms; absent keeps the image default. */
  raceLatencyMs?: number | null;
  /** The family's probe directory unless a test gives another. */
  probesDir?: string;
  /** The family's alternative fix unless a test gives another. */
  alternativeDir?: string;
}

export interface CopyInputs {
  manifestPath: string;
  manifest: Manifest;
  manifestSha256: string;
  termsPath: string;
  termsSha256: string;
  policyPath: string | null;
  policySha256: string;
  family: Family;
  /** The latency every copy sets with `rbw-proxy set-latency`, or null for the image's own setting. */
  raceLatencyMs: number | null;
  probes: ProbeSet;
  probesJsonSha256: string;
  probePatchesSha256: Record<string, string>;
  /** Null for a family without an alternative fix. */
  alternative: AlternativeFix | null;
}

export interface RunInputOptions extends CopyInputOptions {
  kitStage: string;
  recorded: string;
}

export interface RunInputs extends CopyInputs {
  fixture: FamilyFixture;
  fixtureSha256: string;
  addedSuiteSha256: string;
  recorded: RecordedDir;
}

function read(path: string | URL, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error) throw new InputsError(`the ${what} cannot be read`);
    throw error;
  }
}

/** The inputs one copy needs: the manifest, the term list, the policy, the probes and the alternative fix. */
export function loadCopyInputs(options: CopyInputOptions): CopyInputs {
  let family: Family;
  let latency: number | null;
  try {
    family = familyFor(options.family);
    latency = raceLatency(family, options.raceLatencyMs);
  } catch (error) {
    if (error instanceof FamilyError) throw new InputsError(error.message);
    throw error;
  }
  const manifestBytes = read(options.manifest, "manifest");
  let manifest: Manifest;
  try {
    manifest = parseManifest(manifestBytes.toString("utf8"));
  } catch (error) {
    if (error instanceof InputError) throw new InputsError("the manifest is not a projection manifest");
    throw error;
  }
  const probesDir = options.probesDir ?? family.probesDir;
  const probes = loadProbeSet(probesDir);
  if (manifest.host_commit !== UMAMI_COMMIT || probes.data.host_commit !== UMAMI_COMMIT) {
    throw new InputsError(`the manifest and the probes must be at the pinned commit ${UMAMI_COMMIT}`);
  }
  const target = manifest.files.find((file) => file.path === probes.data.target_path);
  if (target?.sha256 !== probes.data.clean_sha256 || target.mode !== "100644") {
    throw new InputsError(`the manifest's ${probes.data.target_path} is not the probes' clean file`);
  }
  const termsSha256 = sha256Hex(read(options.terms, "term list"));
  const policyBytes = options.policy === null ? Buffer.from(DEFAULT_POLICY) : read(options.policy, "policy");
  return {
    manifestPath: options.manifest,
    manifest,
    manifestSha256: sha256Hex(manifestBytes),
    termsPath: options.terms,
    termsSha256,
    policyPath: options.policy,
    policySha256: sha256Hex(policyBytes),
    family,
    raceLatencyMs: latency,
    probes,
    probesJsonSha256: sha256Hex(read(join(probesDir, "probes.json"), "probes.json")),
    probePatchesSha256: Object.fromEntries([...probes.patches.entries()].map(([id, text]) => [id, sha256Hex(Buffer.from(text))])),
    alternative: alternativeFor(options.alternativeDir ?? family.alternativeDir),
  };
}

/** The family's alternative fix, or null when it has none. */
function alternativeFor(dir: string | null): AlternativeFix | null {
  return dir === null ? null : loadAlternativeFix(dir);
}

/** Every input of the full sequence. */
export async function loadRunInputs(options: RunInputOptions): Promise<RunInputs> {
  const copy = loadCopyInputs(options);
  const fixtureDir = join(options.kitStage, "umami-fixture");
  if (!existsSync(fixtureDir)) throw new InputsError("the kit stage has no umami-fixture directory (run the driver's stage-kit.ts)");
  try {
    checkKitStage(copy.family, options.kitStage);
    checkFamilyProbes(copy.family, copy.probes);
  } catch (error) {
    if (error instanceof FamilyError) throw new InputsError(error.message);
    throw error;
  }
  return {
    ...copy,
    fixture: copy.family.loadFixture(),
    fixtureSha256: sha256Hex(read(copy.family.fixtureFile, "fixture data file")),
    addedSuiteSha256: await addedSuiteSha256(fixtureDir),
    recorded: loadRecordedDir(options.recorded),
  };
}

/** Every input hash, as the summary and the dry run report them. */
export function inputHashes(inputs: RunInputs, fromImage: { kitSha256: string | null; originalSuiteSha256: string | null }): Record<string, string | Record<string, string> | null> {
  return {
    manifest_sha256: inputs.manifestSha256,
    terms_sha256: inputs.termsSha256,
    policy_sha256: inputs.policySha256,
    probes_json_sha256: inputs.probesJsonSha256,
    probe_patches_sha256: inputs.probePatchesSha256,
    alternative_fix_record_sha256: inputs.alternative?.record_sha256 ?? null,
    alternative_fix_patch_sha256: inputs.alternative?.patch_sha256 ?? null,
    fixture_sha256: inputs.fixtureSha256,
    added_suite_sha256: inputs.addedSuiteSha256,
    recorded_files_sha256: inputs.recorded.files,
    kit_sha256: fromImage.kitSha256,
    original_suite_sha256: fromImage.originalSuiteSha256,
    // Recorded only off the default, so a time-zone run's inputs are what they always were.
    ...(inputs.family.id === DEFAULT_FAMILY ? {} : { family: inputs.family.id, race_latency_ms: inputs.raceLatencyMs === null ? "image_default" : String(inputs.raceLatencyMs) }),
  };
}

/** One `input <name>=<value>` line per hash; a map is written as canonical JSON. */
export function inputLines(hashes: Record<string, string | Record<string, string> | null>): string[] {
  return Object.entries(hashes)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `input ${name}=${typeof value === "string" ? value : canonicalJson(value)}`);
}
