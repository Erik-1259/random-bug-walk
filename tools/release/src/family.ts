// The bug family a release's judge job is built for, from the build command's flags. With no family
// flag the job is the released time-zone family's. A fixture package names its own probes and
// alternative fix: all three flags or none, so another family can never fall back to the time-zone
// family's probes or fix.
//
// A judge replay cannot yet take a family's probes or alternative fix: the frozen judge job holds
// neither, and the released controller's copies derive their code states from the time-zone
// family's probes and fix. A family whose probes or fix differ would freeze a judge job whose every
// replay ends cannot_run, so it is refused (family_not_replayable) until the replay path carries them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ALTERNATIVE_FIX_DIR, loadAlternativeFix } from "@rbw/local-runner";
import { PROBE_DIR, loadProbeSet } from "@rbw/shapes";
import type { Fixture } from "@rbw/umami-fixture";
import { ReleaseInputError } from "./errors.ts";
import { TIME_ZONE_FAMILY } from "./judge-job.ts";
import type { JudgeJobFamily } from "./judge-job.ts";

export interface FamilyOptions {
  /** A fixture package directory whose src/index.ts exports FIXTURE_FILE and loadFixture, as @rbw/umami-fixture does. */
  fixturePackage?: string;
  /** The family's probe directory. */
  probesDir?: string;
  /** The family's alternative fix directory. */
  alternativeDir?: string;
}

/** The probes and alternative fix a judge replay's copies derive their code states from. */
export interface ReplayInputs {
  probesDir: string;
  alternativeDir: string;
}

/** What the released controller's judge replay reads: the shapes package's probes and the local runner's alternative fix. */
export const REPLAY_INPUTS: Readonly<ReplayInputs> = Object.freeze({ probesDir: PROBE_DIR, alternativeDir: ALTERNATIVE_FIX_DIR });

/** The bytes the copies derive code states from: probes.json, each probe patch, and the alternative fix's record and patch. */
function derivationBytes(inputs: ReplayInputs): string {
  try {
    const probes = loadProbeSet(inputs.probesDir);
    const alternative = loadAlternativeFix(inputs.alternativeDir);
    return JSON.stringify({
      probes_json: readFileSync(join(inputs.probesDir, "probes.json"), "utf8"),
      patches: [...probes.patches.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      alternative_record_sha256: alternative.record_sha256,
      alternative_patch_sha256: alternative.patch_sha256,
    });
  } catch (error) {
    if (error instanceof Error) throw new ReleaseInputError("family_inputs_invalid", error.message);
    throw error;
  }
}

/**
 * The family the flags name: the time-zone family when none is given, else all three are required,
 * and the family's probes and alternative fix must be byte for byte the ones a judge replay derives
 * code states from (`replay`, the released controller's by default).
 */
export async function familyFrom(options: FamilyOptions, replay: Readonly<ReplayInputs> = REPLAY_INPUTS): Promise<Readonly<JudgeJobFamily>> {
  const { fixturePackage, probesDir, alternativeDir } = options;
  if (fixturePackage === undefined && probesDir === undefined && alternativeDir === undefined) return TIME_ZONE_FAMILY;
  if (fixturePackage === undefined || probesDir === undefined || alternativeDir === undefined) {
    throw new ReleaseInputError("family_incomplete", "--fixture-package, --probes and --alternative-fix go together");
  }
  let module: { FIXTURE_FILE?: unknown; loadFixture?: unknown };
  try {
    module = (await import(pathToFileURL(join(fixturePackage, "src", "index.ts")).href)) as typeof module;
  } catch {
    throw new ReleaseInputError("fixture_package_invalid", "its src/index.ts cannot be loaded");
  }
  const { FIXTURE_FILE: fixtureFile, loadFixture } = module;
  if (!(typeof fixtureFile === "string" || fixtureFile instanceof URL) || typeof loadFixture !== "function") {
    throw new ReleaseInputError("fixture_package_invalid", "it must export FIXTURE_FILE and loadFixture");
  }
  if (derivationBytes({ probesDir, alternativeDir }) !== derivationBytes(replay)) {
    throw new ReleaseInputError("family_not_replayable", "a judge replay derives code states from the time-zone family's probes and alternative fix, not this family's");
  }
  return { fixtureFile, loadFixture: loadFixture as () => Fixture, probesDir, alternativeDir };
}
