// The bug family a release's judge job is built for. A known family (time-zone or race) comes from
// the admitted run's own records: the admission summary's family record and its race latency, which
// must give the admission's runtime profile hash. The build command's flags name any other family.
// With no family flag the job is the recorded family's. A fixture package names its own probes and
// alternative fix: all three flags or none, so another family can never fall back to the time-zone
// family's probes or fix.
//
// A judge replay reads a known family back from the frozen job and uses that family's own probes
// and fix. A family given by flags is not one it can recognize: its copies derive their code states
// from the time-zone family's probes and fix, so a family whose probes or fix differ would freeze a
// judge job whose every replay ends cannot_run, and it is refused (family_not_replayable).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ALTERNATIVE_FIX_DIR, DEFAULT_FAMILY, FamilyError, familyFor, loadAlternativeFix, profileSha256, raceLatency } from "@rbw/local-runner";
import type { FamilyFixture, FamilyId } from "@rbw/local-runner";
import { PROBE_DIR, loadProbeSet } from "@rbw/shapes";
import type { Fixture } from "@rbw/umami-fixture";
import { ReleaseInputError } from "./errors.ts";
import { TIME_ZONE_FAMILY, judgeJobFamily } from "./judge-job.ts";
import type { BuildSources, JudgeJobFamily } from "./judge-job.ts";

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

/** The family an admitted run was graded under, and its race latency (null: the image's default, or no proxy). */
export interface RecordedFamily {
  id: FamilyId;
  raceLatencyMs: number | null;
}

/**
 * The family the admission job's published summary records (results/<execution>/summary.json, the
 * controller's family record), checked with the controller's own family and latency rules. A
 * summary with no family record is the time-zone family's, as every summary was before families.
 * A recorded family other than the default must give the admission's runtime profile hash with its
 * latency, so the judge job is graded under the very profile the admission was.
 */
export function recordedFamily(runDir: string, admission: { executionId: string; request: { runtime_profile_sha256: string } }): RecordedFamily {
  const path = join(runDir, "results", admission.executionId, "summary.json");
  if (!existsSync(path)) return { id: DEFAULT_FAMILY, raceLatencyMs: null };
  let record: unknown;
  try {
    record = (JSON.parse(readFileSync(path, "utf8")) as { family?: unknown }).family;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ReleaseInputError("run_family_invalid", "the admission summary is not JSON");
    throw error;
  }
  if (record === undefined || record === null) return { id: DEFAULT_FAMILY, raceLatencyMs: null };
  const { id, race_latency_ms: latency } = record as { id?: unknown; race_latency_ms?: unknown };
  if (typeof id !== "string" || !(latency === null || latency === undefined || typeof latency === "number")) throw new ReleaseInputError("run_family_invalid", "the admission summary's family record is malformed");
  let recorded: RecordedFamily;
  try {
    const family = familyFor(id);
    recorded = { id: family.id, raceLatencyMs: raceLatency(family, latency) };
  } catch (error) {
    if (error instanceof FamilyError) throw new ReleaseInputError("run_family_invalid", error.message);
    throw error;
  }
  if (recorded.id !== DEFAULT_FAMILY && profileSha256(recorded.raceLatencyMs) !== admission.request.runtime_profile_sha256) {
    throw new ReleaseInputError("run_family_mismatch", "the admission's runtime profile is not the recorded family's latency profile");
  }
  return recorded;
}

/**
 * The build sources for the recorded family. A time-zone run keeps the sources as given (the
 * flags' family, or the time-zone family). A run of another known family builds that family's job
 * with its latency; the sources may name that same family (`id`), or no family at all (no family
 * flag), but never a different one.
 */
export function sourcesForFamily(sources: BuildSources, recorded: RecordedFamily): BuildSources {
  const given: Readonly<JudgeJobFamily<FamilyFixture>> | undefined = sources.family;
  if (recorded.id === DEFAULT_FAMILY) {
    if (given?.id !== undefined && given.id !== DEFAULT_FAMILY) throw new ReleaseInputError("family_conflict", `the run is the ${DEFAULT_FAMILY} family's, not the ${given.id} family's`);
    return sources;
  }
  const flagless = given === undefined || given === TIME_ZONE_FAMILY;
  if (!flagless && given.id !== recorded.id) throw new ReleaseInputError("family_conflict", `the run is the ${recorded.id} family's; the family flags name another`);
  return { ...sources, family: flagless ? judgeJobFamily(recorded.id) : given, raceLatencyMs: recorded.raceLatencyMs };
}
