// The run's inputs, read and hashed before anything runs. A missing or inconsistent input stops
// the run here, before any container exists.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InputError, canonicalJson, parseManifest } from "@rbw/projection";
import type { Manifest } from "@rbw/projection";
import { sha256Hex } from "@rbw/schema";
import { PROBE_DIR, loadProbeSet } from "@rbw/shapes";
import type { ProbeSet } from "@rbw/shapes";
import { UMAMI_COMMIT, addedSuiteSha256 } from "@rbw/umami-driver";
import { FIXTURE_FILE, loadFixture } from "@rbw/umami-fixture";
import type { Fixture } from "@rbw/umami-fixture";
import { ALTERNATIVE_FIX_DIR, loadAlternativeFix } from "./code-states.ts";
import type { AlternativeFix } from "./code-states.ts";
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
  /** The shapes package's probe directory unless a test gives another. */
  probesDir?: string;
  /** This package's alternative fix unless a test gives another. */
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
  probes: ProbeSet;
  probesJsonSha256: string;
  probePatchesSha256: Record<string, string>;
  alternative: AlternativeFix;
}

export interface RunInputOptions extends CopyInputOptions {
  kitStage: string;
  recorded: string;
}

export interface RunInputs extends CopyInputs {
  fixture: Fixture;
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
  const manifestBytes = read(options.manifest, "manifest");
  let manifest: Manifest;
  try {
    manifest = parseManifest(manifestBytes.toString("utf8"));
  } catch (error) {
    if (error instanceof InputError) throw new InputsError("the manifest is not a projection manifest");
    throw error;
  }
  const probesDir = options.probesDir ?? PROBE_DIR;
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
    probes,
    probesJsonSha256: sha256Hex(read(join(probesDir, "probes.json"), "probes.json")),
    probePatchesSha256: Object.fromEntries([...probes.patches.entries()].map(([id, text]) => [id, sha256Hex(Buffer.from(text))])),
    alternative: loadAlternativeFix(options.alternativeDir ?? ALTERNATIVE_FIX_DIR),
  };
}

/** Every input of the full sequence. */
export async function loadRunInputs(options: RunInputOptions): Promise<RunInputs> {
  const copy = loadCopyInputs(options);
  const fixtureDir = join(options.kitStage, "umami-fixture");
  if (!existsSync(fixtureDir)) throw new InputsError("the kit stage has no umami-fixture directory (run the driver's stage-kit.ts)");
  return {
    ...copy,
    fixture: loadFixture(),
    fixtureSha256: sha256Hex(read(FIXTURE_FILE, "fixture data file")),
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
    alternative_fix_record_sha256: inputs.alternative.record_sha256,
    alternative_fix_patch_sha256: inputs.alternative.patch_sha256,
    fixture_sha256: inputs.fixtureSha256,
    added_suite_sha256: inputs.addedSuiteSha256,
    recorded_files_sha256: inputs.recorded.files,
    kit_sha256: fromImage.kitSha256,
    original_suite_sha256: fromImage.originalSuiteSha256,
  };
}

/** One `input <name>=<value>` line per hash; a map is written as canonical JSON. */
export function inputLines(hashes: Record<string, string | Record<string, string> | null>): string[] {
  return Object.entries(hashes)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `input ${name}=${typeof value === "string" ? value : canonicalJson(value)}`);
}
