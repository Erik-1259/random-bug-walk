// A race-family release's judge job carries the family and its race latency: the race fixture and
// probe set, the three-trial judge profile with no partial or stub state, and the copy profile hash
// with the latency in it, so a replay reads both back from the frozen bytes. The family and latency
// come from the admitted run's own records. The time-zone judge job stays what it was.
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAMILIES, frozenJobFamily, profileSha256 } from "@rbw/local-runner";
import { parseRecord, sha256Hex } from "@rbw/schema";
import { KitImage } from "../../../local-runner/test/support/kit-image.ts";
import type { KitImageOptions } from "../../../local-runner/test/support/kit-image.ts";
import { writeManifest, writeProbeDir, writeRaceProbeDir, writeTerms } from "../../../local-runner/test/support/synthetic.ts";
import { admissionExecution } from "../../src/check.ts";
import { recordedFamily, sourcesForFamily } from "../../src/family.ts";
import { TIME_ZONE_FAMILY, buildJudgeJob, judgeJobFamily } from "../../src/judge-job.ts";
import type { BuildSources, JudgeJob } from "../../src/judge-job.ts";
import { PROJECT_ID, RELEASE_ID, UC3, kitDocker, tempDir, world, write } from "../support/world.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/release/", import.meta.url));
const RACE_REASON = "Synthetic: a partial or stub fix of this race has no natural form.";

/** A synthetic race release's build inputs: the simulated race kit, its staged race fixture, and the synthetic race probes. */
function raceWorld(raceLatencyMs: number | null, kit: KitImageOptions = { family: "race" }) {
  const image = new KitImage(kit);
  const dir = tempDir();
  const sources: BuildSources = {
    image: "rbw-umami-race-kit:synthetic",
    manifest: writeManifest(dir),
    terms: writeTerms(dir),
    auditPolicy: write(join(dir, "inputs", "audit-policy.json"), "{}"),
    kitStage: image.kitStage,
    originalSuite: write(join(dir, "inputs", "original-suite.json"), image.suite.encoded.bytes),
    family: { ...judgeJobFamily("race"), probesDir: writeRaceProbeDir() },
    raceLatencyMs,
  };
  return { docker: kitDocker(image), sources };
}

function judgeJob(docker: ReturnType<typeof kitDocker>, sources: BuildSources): Promise<JudgeJob> {
  const w = world();
  return buildJudgeJob(docker, sources, {
    releaseId: RELEASE_ID,
    projectId: PROJECT_ID,
    policy: { sha256: w.policy.sha256, policy_id: UC3 },
    issueSha256: "ab".repeat(32),
    reservationMicrousd: 600_000,
    exportDir: join(tempDir(), "source"),
  });
}

describe("a race release's judge job", () => {
  it("records the race family and its latency, and hashes the latency into the copy profile", async () => {
    const race = raceWorld(75);
    const job = await judgeJob(race.docker, race.sources);
    expect(job.family).toBe("race");
    expect(job.raceLatencyMs).toBe(75);
    expect(job.built.request.runtime_profile_sha256).toBe(profileSha256(75));
    expect(job.identity.environment_sha256).toBe(profileSha256(75));
    expect(job.identity.fixture_sha256).toBe(sha256Hex(readFileSync(FAMILIES.race.fixtureFile)));

    const w = world();
    const timeZone = await judgeJob(w.docker, w.sources);
    expect(timeZone.family).toBe("time-zone");
    expect(timeZone.raceLatencyMs).toBeNull();
    expect(timeZone.built.request.runtime_profile_sha256).toBe(profileSha256());
    expect(job.built.request.runtime_profile_sha256).not.toBe(timeZone.built.request.runtime_profile_sha256);
    expect(job.built.request.task_revision).not.toBe(timeZone.built.request.task_revision);
    expect(job.indexSha256).not.toBe(timeZone.indexSha256);
  });

  it("expects the race fixture's vectors in three trials with no partial or stub state, grading the reference fix", async () => {
    const race = raceWorld(75);
    const job = await judgeJob(race.docker, race.sources);
    expect(job.built.expected.trials.map((trial) => [trial.trial_id, trial.code_state])).toEqual([
      ["clean-01", "clean"],
      ["planted-01", "planted"],
      ["fixed-01", "fixed"],
    ]);
    const vectors = FAMILIES.race.loadFixture().outcome_vectors;
    for (const trial of job.built.expected.trials) {
      expect(trial.expected_checks).toEqual((vectors[trial.code_state] ?? []).map((row) => ({ check_id: row.check_id, expected: row.observed, failure_code: row.failure_code })));
    }
  });

  it("is read back from its frozen bytes as the race family at its latency, which every replay copy then sets", async () => {
    const at75 = raceWorld(75);
    expect(frozenJobFamily((await judgeJob(at75.docker, at75.sources)).built)).toEqual({ ok: true, family: "race", raceLatencyMs: 75 });
    const imageDefault = raceWorld(null);
    const job = await judgeJob(imageDefault.docker, imageDefault.sources);
    expect(job.built.request.runtime_profile_sha256).toBe(profileSha256());
    expect(frozenJobFamily(job.built)).toEqual({ ok: true, family: "race", raceLatencyMs: null });
    const w = world();
    expect(frozenJobFamily((await judgeJob(w.docker, w.sources)).built)).toEqual({ ok: true, family: "time-zone", raceLatencyMs: null });
  });

  it("refuses the race family on a time-zone kit image (kit_image_family_mismatch)", async () => {
    const race = raceWorld(75, { family: "race", imageFamily: "time-zone" });
    await expect(judgeJob(race.docker, race.sources)).rejects.toMatchObject({ code: "kit_image_family_mismatch" });
  });

  it("refuses a latency for the time-zone family, as the controller's run does", async () => {
    const w = world();
    await expect(judgeJob(w.docker, { ...w.sources, raceLatencyMs: 75 })).rejects.toThrow(/has no database proxy, so it takes no latency/);
  });

  it("refuses the race family with the time-zone probe set", async () => {
    const race = raceWorld(75);
    await expect(judgeJob(race.docker, { ...race.sources, family: { ...judgeJobFamily("race"), probesDir: writeProbeDir() } })).rejects.toMatchObject({ code: "fixture_vectors_incomplete" });
  });
});

/** A published run directory whose admission summary holds `family` (absent: no family record) and whose request names `profile`. */
function runWith(family: unknown, profile: string) {
  const runDir = join(tempDir("rbw-release-family-run-"), "run");
  const executionId = "00000000-0000-4000-8000-0000000000a1";
  write(join(runDir, "results", executionId, "summary.json"), JSON.stringify(family === undefined ? { status: "complete" } : { status: "complete", family }));
  return { runDir, admission: { executionId, request: { runtime_profile_sha256: profile } } };
}

describe("recordedFamily: the family the admitted run's records name", () => {
  it("reads the race family and its latency from the admission summary's family record", () => {
    const { runDir, admission } = runWith({ id: "race", adm06: { status: "not_applicable", reason: RACE_REASON }, admission_copies: 11, race_latency_ms: 75 }, profileSha256(75));
    expect(recordedFamily(runDir, admission)).toEqual({ id: "race", raceLatencyMs: 75 });
    const imageDefault = runWith({ id: "race", adm06: { status: "not_applicable", reason: RACE_REASON }, admission_copies: 11, race_latency_ms: null }, profileSha256());
    expect(recordedFamily(imageDefault.runDir, imageDefault.admission)).toEqual({ id: "race", raceLatencyMs: null });
  });

  it("is the time-zone family when the summary has no family record, or there is no summary", () => {
    const { runDir, admission } = runWith(undefined, profileSha256());
    expect(recordedFamily(runDir, admission)).toEqual({ id: "time-zone", raceLatencyMs: null });
    expect(recordedFamily(tempDir(), admission)).toEqual({ id: "time-zone", raceLatencyMs: null });
  });

  it("refuses a recorded latency that is not the one the admission's profile hash holds (run_family_mismatch)", () => {
    const { runDir, admission } = runWith({ id: "race", race_latency_ms: 75 }, profileSha256(50));
    expect(() => recordedFamily(runDir, admission)).toThrow(expect.objectContaining({ code: "run_family_mismatch" }) as Error);
  });

  it("refuses an unknown family, a latency on the time-zone family or a malformed record (run_family_invalid)", () => {
    for (const family of [{ id: "other", race_latency_ms: null }, { id: "time-zone", race_latency_ms: 75 }, { id: "race", race_latency_ms: 10_001 }, { id: 7 }, { id: "race", race_latency_ms: "75" }]) {
      const { runDir, admission } = runWith(family, profileSha256(75));
      expect(() => recordedFamily(runDir, admission)).toThrow(expect.objectContaining({ code: "run_family_invalid" }) as Error);
    }
  });
});

describe("sourcesForFamily: the build sources for the recorded family", () => {
  it("keeps a time-zone run's sources exactly as given", () => {
    const w = world();
    expect(sourcesForFamily(w.sources, { id: "time-zone", raceLatencyMs: null })).toBe(w.sources);
  });

  it("builds a race run's job from the race family and its latency when no family flag was given", () => {
    const w = world();
    const sources = sourcesForFamily({ ...w.sources, family: TIME_ZONE_FAMILY }, { id: "race", raceLatencyMs: 75 });
    expect(sources.family).toEqual(judgeJobFamily("race"));
    expect(sources.family?.alternativeDir).toBeNull();
    expect(sources.raceLatencyMs).toBe(75);
    const noFamily: BuildSources = { ...w.sources };
    delete noFamily.family;
    expect(sourcesForFamily(noFamily, { id: "race", raceLatencyMs: null })).toMatchObject({ family: judgeJobFamily("race"), raceLatencyMs: null });
  });

  it("keeps a given race family (its own probes) for a race run", () => {
    const race = raceWorld(null);
    expect(sourcesForFamily(race.sources, { id: "race", raceLatencyMs: 75 })).toMatchObject({ family: race.sources.family, raceLatencyMs: 75 });
  });

  it("refuses family flags that name another family than the run's (family_conflict)", () => {
    const w = world();
    expect(() => sourcesForFamily(w.sources, { id: "race", raceLatencyMs: 75 })).toThrow(expect.objectContaining({ code: "family_conflict" }) as Error);
    expect(() => sourcesForFamily(raceWorld(75).sources, { id: "time-zone", raceLatencyMs: null })).toThrow(expect.objectContaining({ code: "family_conflict" }) as Error);
  });
});

describe("the released time-zone judge job (the synthetic release fixture)", () => {
  const releaseId = readFileSync(join(FIXTURE, "inputs", "release-id.txt"), "utf8").trim();
  const jobDir = join(FIXTURE, "private-store", "judge-jobs", releaseId);

  it("has the plain copy profile and is read back as the time-zone family with no latency", () => {
    const request = parseRecord("JobRequest", readFileSync(join(jobDir, "request.json")));
    const expected = parseRecord("ExpectedTrials", readFileSync(join(jobDir, "expected-trials.json")));
    expect(request.runtime_profile_sha256).toBe(profileSha256());
    expect(frozenJobFamily({ request, expected })).toEqual({ ok: true, family: "time-zone", raceLatencyMs: null });
  });

  it("comes from a run whose records name the time-zone family", () => {
    const rootRun = parseRecord("RootRun", readFileSync(join(FIXTURE, "inputs", "root-run.json")));
    const runDir = join(tempDir(), "run");
    cpSync(join(FIXTURE, "repository", "runs", rootRun.root_execution_id), runDir, { recursive: true });
    const admission = admissionExecution(runDir);
    expect(admission).not.toBeNull();
    if (admission === null) return;
    expect(recordedFamily(runDir, admission)).toEqual({ id: "time-zone", raceLatencyMs: null });
  });
});
