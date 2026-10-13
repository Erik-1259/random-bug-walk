// The judge job is built for the release's own bug family: the time-zone family's job is pinned
// byte for byte, and a second (synthetic) family's fixture package, probes and alternative fix
// build a job of their own. A family whose probes or alternative fix differ from the ones a judge
// replay derives code states from is refused, because its replays could never run.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@rbw/schema";
import { InputsError, runCopyCommand, writeJobDir } from "@rbw/local-runner";
import { FIXTURE_FILE, loadFixture } from "@rbw/umami-fixture";
import type { Fixture } from "@rbw/umami-fixture";
import { ALTERNATIVE, CLEAN, PARTIAL, TARGET, sha256, writeAlternativeDir, writeProbeDir } from "../../../local-runner/test/support/synthetic.ts";
import { familyFrom } from "../../src/family.ts";
import type { ReplayInputs } from "../../src/family.ts";
import { TIME_ZONE_FAMILY, buildJudgeJob, jobContext } from "../../src/judge-job.ts";
import type { BuildSources, JudgeJob, JudgeJobFamily } from "../../src/judge-job.ts";
import { PROJECT_ID, RELEASE_ID, UC3, rootIds, tempDir, world, write } from "../support/world.ts";
import type { World } from "../support/world.ts";

// The time-zone family's judge job from the synthetic world, as the release tool built it before
// the family became an input. A change to any of these bytes changes what a released judge replays.
const TIME_ZONE_PIN = {
  index_sha256: "3a4a333dc587f61fd3681d0b5f4bb66fd2211db9f76b81415cd664727d396cc7",
  task_revision: "bf57ee5aa716e638b24f974807c4270a058d66cd70a6cea17093756f2b2bfa96",
  files: {
    "audit-policy.json": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    "expected-trials.json": "afc9d4e326d90a15889434a3fc59a64e2d7a1dc2fd26b87d4febafbaed7fc728",
    "original-suite.json": "68c27725b2fb3344a56bff8d55c3b2ec31b710c9f8aada08d458939ea83ba732",
    "projection-manifest.json": "8a3a47e7a839b1eb6ca2e5c3e82c351df28faae4cf1219df00d2fad0940ba752",
    "request.json": "b9709b28dfa5cd1601566c716a22e801b1b95b544e0f7cfcc14eacdc64fdeefe",
    "source.tar": "b94a40df299e3bf043f31ab640902508b4a3af8ddfc697a19d049f2ab5defcad",
    "strict-terms.txt": "a5f1ea57b2056207631cf7e0df024cc5a619caa4f1de22e2fdea6617e128b804",
  },
};

const SYNTHETIC_FIXTURE_ID = "synthetic-second-family-001";

async function judgeJob(w: World, sources: BuildSources): Promise<JudgeJob> {
  return buildJudgeJob(w.docker, sources, {
    releaseId: RELEASE_ID,
    projectId: PROJECT_ID,
    policy: { sha256: w.policy.sha256, policy_id: UC3 },
    issueSha256: "ab".repeat(32),
    reservationMicrousd: 600_000,
    exportDir: join(tempDir(), "source"),
  });
}

function fileHashes(job: JudgeJob): Record<string, string> {
  return Object.fromEntries(job.files.map((file) => [file.path, sha256Hex(file.bytes)]));
}

function fixtureShaOf(job: JudgeJob): string {
  return job.identity.fixture_sha256;
}

// The synthetic family's own fixed vector: the time-zone family's fixed vector with one check
// failing, so a job that took the time-zone family's vectors would show it. The probes record no
// fixed vector, so this one agrees with the synthetic probes.
const SYNTHETIC_FIXED_MARKER = { check_id: "tzarg.kolkata-day-counts", failure_code: "local_day_counts_mismatch", observed: "assertion_fail" };

/**
 * A synthetic fixture package laid out as @rbw/umami-fixture is: data/ holds the time-zone data
 * file under another fixture ID and with its own fixed vector (so its bytes, hash and expected
 * vectors are its own), and src/index.ts exports FIXTURE_FILE and loadFixture.
 */
function writeSyntheticFixturePackage(): string {
  const dir = tempDir("rbw-release-fixture-package-");
  const data = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as { outcome_vectors: Record<string, { check_id: string }[]> } & Record<string, unknown>;
  const fixed = data.outcome_vectors.fixed?.map((row) => (row.check_id === SYNTHETIC_FIXED_MARKER.check_id ? SYNTHETIC_FIXED_MARKER : row));
  const outcomeVectors = { ...data.outcome_vectors, fixed };
  write(join(dir, "data", "synthetic.v1.json"), `${JSON.stringify({ ...data, fixture_id: SYNTHETIC_FIXTURE_ID, outcome_vectors: outcomeVectors }, null, 2)}\n`);
  const parser = pathToFileURL(new URL("../../../../packages/umami-fixture/src/index.ts", import.meta.url).pathname).href;
  write(
    join(dir, "src", "index.ts"),
    `import { readFileSync } from "node:fs";
import { parseFixture } from ${JSON.stringify(parser)};
export const FIXTURE_FILE = new URL("../data/synthetic.v1.json", import.meta.url);
export function loadFixture() { return parseFixture(readFileSync(FIXTURE_FILE, "utf8")); }
`,
  );
  return dir;
}

/** A copy of the world's kit stage whose staged fixture package holds these data files, as stage-kit.ts copies a package's data/. */
function stageWith(w: World, data: Record<string, string | URL>): string {
  const stage = join(tempDir("rbw-release-stage-"), "kit-stage");
  cpSync(w.sources.kitStage, stage, { recursive: true });
  for (const [name, from] of Object.entries(data)) write(join(stage, "umami-fixture", "data", name), readFileSync(from));
  return stage;
}

/** The synthetic package's data file, as the family names it. */
function syntheticDataFile(pkg: string): string {
  return join(pkg, "data", "synthetic.v1.json");
}

// Another family over the same synthetic target: its mutation plants a different file, so its
// planted, fixed, partial and stub patches all differ from the synthetic time-zone probes'.
const OTHER_PLANTED = CLEAN.replace("  return range(unit, zone);", "  return range(unit, 'UTC');");
const HEADER = `diff --git a/${TARGET} b/${TARGET}\n--- a/${TARGET}\n+++ b/${TARGET}\n`;
const OTHER_PATCHES = {
  "mutation.patch": `${HEADER}@@ -1,5 +1,5 @@\n // synthetic target for local-runner tests\n export function synthetic(zone: string) {\n   const unit = 'day';\n-  return range(unit, zone);\n+  return range(unit, 'UTC');\n }\n`,
  "partial.patch": `${HEADER}@@ -1,5 +1,5 @@\n // synthetic target for local-runner tests\n export function synthetic(zone: string) {\n   const unit = 'day';\n-  return range(unit, 'UTC');\n+  return range(unit, zone === 'Pacific/Auckland' ? zone : 'UTC');\n }\n`,
  "stub.patch": `${HEADER}@@ -1,5 +1,6 @@\n // synthetic target for local-runner tests\n export function synthetic(zone: string) {\n   const unit = 'day';\n+  if (zone !== 'UTC') return [];\n   return range(unit, 'UTC');\n }\n`,
};
const OTHER_STUB = OTHER_PLANTED.replace("  const unit = 'day';\n", "  const unit = 'day';\n  if (zone !== 'UTC') return [];\n");

function writeOtherFamilyInputs(): ReplayInputs {
  const probesDir = writeProbeDir();
  const data = JSON.parse(readFileSync(join(probesDir, "probes.json"), "utf8")) as {
    planted_sha256: string;
    fixed_reference: { base_sha256: string };
    probes: { id: string; base_sha256: string; result_sha256: string }[];
  };
  const planted = sha256(OTHER_PLANTED);
  data.planted_sha256 = planted;
  data.fixed_reference.base_sha256 = planted;
  for (const probe of data.probes) {
    if (probe.id === "mutation") probe.result_sha256 = planted;
    else probe.base_sha256 = planted;
    if (probe.id === "partial") probe.result_sha256 = sha256(PARTIAL);
    if (probe.id === "stub") probe.result_sha256 = sha256(OTHER_STUB);
  }
  writeFileSync(join(probesDir, "probes.json"), `${JSON.stringify(data, null, 2)}\n`);
  for (const [name, text] of Object.entries(OTHER_PATCHES)) writeFileSync(join(probesDir, name), text);
  const alternativeDir = writeAlternativeDir();
  const record = { base_sha256: planted, description: "Synthetic alternative fix of another family.", patch: "alternative-fix.patch", result_sha256: sha256(ALTERNATIVE), target_path: TARGET };
  writeFileSync(join(alternativeDir, "alternative-fix.json"), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(
    join(alternativeDir, "alternative-fix.patch"),
    `${HEADER}@@ -1,5 +1,5 @@\n // synthetic target for local-runner tests\n export function synthetic(zone: string) {\n   const unit = 'day';\n-  return range(unit, 'UTC');\n+  return range(unit, zone || 'UTC');\n }\n`,
  );
  return { probesDir, alternativeDir };
}

/** The world's probes and fix: what the synthetic world's replay derives code states from. */
function worldReplay(w: World): ReplayInputs {
  return { probesDir: w.sources.family.probesDir, alternativeDir: w.sources.family.alternativeDir };
}

describe("the judge job's family", () => {
  it("builds the time-zone family's judge job byte for byte as before", async () => {
    const w = world();
    // The world's family is the time-zone one with the synthetic kit's probes and fix swapped in.
    expect({ ...w.sources.family, probesDir: TIME_ZONE_FAMILY.probesDir, alternativeDir: TIME_ZONE_FAMILY.alternativeDir }).toEqual(TIME_ZONE_FAMILY);
    const job = await judgeJob(w, w.sources);
    expect(job.indexSha256).toBe(TIME_ZONE_PIN.index_sha256);
    expect(job.built.request.task_revision).toBe(TIME_ZONE_PIN.task_revision);
    expect(fileHashes(job)).toEqual(TIME_ZONE_PIN.files);
    expect(fixtureShaOf(job)).toBe(sha256Hex(readFileSync(FIXTURE_FILE)));
  });

  it("reads the time-zone family's real probes when the family is left out, which the synthetic kit's manifest does not match", async () => {
    const w = world();
    const withoutFamily: BuildSources = { ...w.sources };
    delete withoutFamily.family;
    const built = jobContext(w.docker, withoutFamily, { ids: rootIds("8700"), deadlineAt: "2026-10-06T12:00:00Z", exportDir: join(tempDir(), "source") });
    await expect(built).rejects.toThrow(InputsError);
    await expect(built).rejects.toThrow(/is not the probes' clean file/);
  });

  it("names the shapes package's probes, the local runner's alternative fix and @rbw/umami-fixture as the default family", () => {
    expect(TIME_ZONE_FAMILY.fixtureFile).toBe(FIXTURE_FILE);
    expect(TIME_ZONE_FAMILY.loadFixture).toBe(loadFixture);
    expect(TIME_ZONE_FAMILY.probesDir).toMatch(/packages\/shapes\/probes\//);
    expect(TIME_ZONE_FAMILY.alternativeDir).toMatch(/tools\/local-runner\/probes\/$/);
  });

  it("builds a second family's own judge job from its fixture package, probes and alternative fix", async () => {
    const w = world();
    const pkg = writeSyntheticFixturePackage();
    const family = await familyFrom({ fixturePackage: pkg, probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() }, worldReplay(w));
    expect(family.loadFixture().fixture_id).toBe(SYNTHETIC_FIXTURE_ID);
    const job = await judgeJob(w, { ...w.sources, kitStage: stageWith(w, { "synthetic.v1.json": syntheticDataFile(pkg) }), family });
    const syntheticSha = sha256Hex(readFileSync(syntheticDataFile(pkg)));
    expect(syntheticSha).not.toBe(sha256Hex(readFileSync(FIXTURE_FILE)));
    expect(fixtureShaOf(job)).toBe(syntheticSha);
    expect(job.indexSha256).not.toBe(TIME_ZONE_PIN.index_sha256);
    expect(job.built.request.task_revision).not.toBe(TIME_ZONE_PIN.task_revision);
    // The same source; the fixture and the staged package differ from the time-zone job.
    const hashes = fileHashes(job);
    expect(hashes["source.tar"]).toBe(TIME_ZONE_PIN.files["source.tar"]);
    expect(hashes["request.json"]).not.toBe(TIME_ZONE_PIN.files["request.json"]);
    expect(hashes["expected-trials.json"]).not.toBe(TIME_ZONE_PIN.files["expected-trials.json"]);
    // The expected vectors are the synthetic family's own, not the time-zone family's.
    const expectedFixed = family.loadFixture().outcome_vectors.fixed.map((row) => ({ check_id: row.check_id, expected: row.observed, failure_code: row.failure_code }));
    const fixedTrial = job.built.expected.trials.find((trial) => trial.code_state === "fixed");
    expect(fixedTrial?.expected_checks).toEqual(expectedFixed);
    expect(fixedTrial?.expected_checks).toContainEqual({ check_id: SYNTHETIC_FIXED_MARKER.check_id, expected: "assertion_fail", failure_code: SYNTHETIC_FIXED_MARKER.failure_code });
    const expectedTrials = new TextDecoder().decode(job.files.find((file) => file.path === "expected-trials.json")?.bytes);
    expect(expectedTrials).toContain(SYNTHETIC_FIXED_MARKER.failure_code);
  });

  it("refuses a family whose fixture is not the one staged into the kit stage (fixture_stage_mismatch)", async () => {
    const w = world();
    const pkg = writeSyntheticFixturePackage();
    const family = await familyFrom({ fixturePackage: pkg, probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() }, worldReplay(w));
    // The synthetic family with the time-zone family's staged package.
    const timeZoneStage = stageWith(w, { "umami-tz-arg-001.v1.json": FIXTURE_FILE });
    await expect(judgeJob(w, { ...w.sources, kitStage: timeZoneStage, family })).rejects.toMatchObject({ code: "fixture_stage_mismatch" });
    // The time-zone family with the synthetic family's staged package.
    const syntheticStage = stageWith(w, { "synthetic.v1.json": syntheticDataFile(pkg) });
    await expect(judgeJob(w, { ...w.sources, kitStage: syntheticStage })).rejects.toMatchObject({ code: "fixture_stage_mismatch" });
    // A staged file of the same name with other bytes.
    const edited = tempDir();
    write(join(edited, "umami-tz-arg-001.v1.json"), `${readFileSync(FIXTURE_FILE, "utf8")} `);
    const editedStage = stageWith(w, { "umami-tz-arg-001.v1.json": join(edited, "umami-tz-arg-001.v1.json") });
    await expect(judgeJob(w, { ...w.sources, kitStage: editedStage })).rejects.toMatchObject({ code: "fixture_stage_mismatch" });
    // The time-zone family with its own staged data file builds.
    const job = await judgeJob(w, { ...w.sources, kitStage: timeZoneStage });
    expect(fixtureShaOf(job)).toBe(sha256Hex(readFileSync(FIXTURE_FILE)));
  });

  it("shows why another family's probes are refused: the replay's copies cannot run its judge job (cannot_run)", async () => {
    const w = world();
    const other = writeOtherFamilyInputs();
    const job = await judgeJob(w, { ...w.sources, family: { ...w.sources.family, ...other } });
    const jobDir = join(tempDir(), "job");
    writeJobDir(jobDir, job.built);
    const fixed = job.built.expected.trials.find((trial) => trial.code_state === "fixed");
    expect(fixed).toBeDefined();
    // A replay's copy derives code states from the replay's own probes and fix, not the family's.
    const outcome = await runCopyCommand(
      { job: jobDir, trial: fixed?.trial_id ?? "", root: null, image: w.sources.image, manifest: w.sources.manifest, terms: w.sources.terms, policy: w.sources.auditPolicy, ...worldReplay(w), work: join(tempDir(), "copy"), backend: "docker" },
      { docker: w.docker, clock: w.clock },
    );
    expect(outcome.copy).toBeNull();
    expect(outcome.refusal).toMatchObject({ reason: "cannot_run" });
    expect(outcome.refusal?.detail).toMatch(/names a fixed patch this runner did not derive/);
  });

  it("refuses a family whose fixture has no vector for some code state (fixture_vectors_incomplete)", async () => {
    const w = world();
    const threeStates = (): Fixture => {
      const fixture = structuredClone(loadFixture());
      const vectors = fixture.outcome_vectors as Partial<Fixture["outcome_vectors"]>;
      delete vectors.partial;
      delete vectors.stub;
      return fixture;
    };
    const family: JudgeJobFamily = { ...w.sources.family, loadFixture: threeStates };
    await expect(judgeJob(w, { ...w.sources, family })).rejects.toMatchObject({ code: "fixture_vectors_incomplete", message: "fixture_vectors_incomplete: partial,stub" });
  });
});

describe("familyFrom: the build command's family flags", () => {
  it("is the time-zone family when no family flag is given", async () => {
    expect(await familyFrom({})).toBe(TIME_ZONE_FAMILY);
  });

  it("refuses a fixture package without its own probes and alternative fix, or probes without a package (family_incomplete)", async () => {
    const pkg = writeSyntheticFixturePackage();
    await expect(familyFrom({ fixturePackage: pkg })).rejects.toMatchObject({ code: "family_incomplete" });
    await expect(familyFrom({ fixturePackage: pkg, probesDir: writeProbeDir() })).rejects.toMatchObject({ code: "family_incomplete" });
    await expect(familyFrom({ probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() })).rejects.toMatchObject({ code: "family_incomplete" });
  });

  it("refuses a family whose probes or alternative fix are not the ones a judge replay derives code states from (family_not_replayable)", async () => {
    const pkg = writeSyntheticFixturePackage();
    const replay: ReplayInputs = { probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() };
    const other = writeOtherFamilyInputs();
    await expect(familyFrom({ fixturePackage: pkg, ...other }, replay)).rejects.toMatchObject({ code: "family_not_replayable" });
    await expect(familyFrom({ fixturePackage: pkg, probesDir: other.probesDir, alternativeDir: writeAlternativeDir() }, replay)).rejects.toMatchObject({ code: "family_not_replayable" });
    await expect(familyFrom({ fixturePackage: pkg, probesDir: writeProbeDir(), alternativeDir: other.alternativeDir }, replay)).rejects.toMatchObject({ code: "family_not_replayable" });
    // By default the replay's inputs are the released controller's: the time-zone family's real probes and fix.
    await expect(familyFrom({ fixturePackage: pkg, probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() })).rejects.toMatchObject({ code: "family_not_replayable" });
    // The same bytes in other directories are the replay's inputs.
    const family = await familyFrom({ fixturePackage: pkg, probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() }, replay);
    expect(family.loadFixture().fixture_id).toBe(SYNTHETIC_FIXTURE_ID);
  });

  it("refuses a directory that is not a fixture package (fixture_package_invalid)", async () => {
    const extra = { probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() };
    await expect(familyFrom({ fixturePackage: tempDir(), ...extra })).rejects.toMatchObject({ code: "fixture_package_invalid" });
    const noLoader = tempDir();
    write(join(noLoader, "src", "index.ts"), 'export const FIXTURE_FILE = "synthetic.json";\n');
    await expect(familyFrom({ fixturePackage: noLoader, ...extra })).rejects.toMatchObject({ code: "fixture_package_invalid" });
  });
});
