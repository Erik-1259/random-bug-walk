import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeCanonical, parseCanonical, sha256Hex } from "@rbw/schema";
import { loadProbeSet } from "@rbw/shapes";
import { addedSuiteSha256 } from "@rbw/umami-driver";
import { loadFixture } from "@rbw/umami-fixture";
import { deriveCodeStates, loadAlternativeFix } from "../../src/code-states.ts";
import { dryRun } from "../../src/dry-run.ts";
import { BASELINE_KEY, buildJob, expectedVectors, newRunIds, writeJobDir } from "../../src/jobs.ts";
import { RECORDED_SYNTHETIC_DIR } from "../../src/recorded.ts";
import { importJob } from "../../src/records.ts";
import type { Docker } from "../../src/docker.ts";
import { exportImage } from "../../src/projection.ts";
import { runCopyCommand } from "../../src/run-copy.ts";
import { runSequence } from "../../src/sequence.ts";
import type { SequenceOptions } from "../../src/sequence.ts";
import { summaryText } from "../../src/summary.ts";
import type { Summary } from "../../src/summary.ts";
import { FakeClock, FakeDocker, ok } from "../support/fakes.ts";
import { FakeSandboxSdk } from "../support/fake-sandbox.ts";
import { IMAGE_ID, KitImage } from "../support/kit-image.ts";
import type { KitImageOptions } from "../support/kit-image.ts";
import { CLEAN, PARTIAL, PLANTED, STUB, sha256, tempDir, writeAlternativeDir, writeManifest, writeProbeDir, writeRaceProbeDir, writeTerms } from "../support/synthetic.ts";

function uuids(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  };
}

function options(kit: KitImage, overrides: Partial<SequenceOptions> = {}): SequenceOptions {
  const dir = tempDir();
  return {
    image: "rbw-umami-kit:synthetic",
    kitStage: kit.kitStage,
    manifest: writeManifest(dir),
    terms: writeTerms(dir),
    policy: null,
    recorded: RECORDED_SYNTHETIC_DIR,
    work: join(dir, "work"),
    concurrency: 1,
    probesDir: writeProbeDir(),
    alternativeDir: writeAlternativeDir(),
    ...overrides,
  };
}

async function sequence(kitOptions: KitImageOptions = {}, overrides: Partial<SequenceOptions> = {}) {
  const clock = new FakeClock({ manual: true });
  const kit = new KitImage({
    ...kitOptions,
    onHang: () => {
      clock.release();
    },
  });
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };
  const result = await runSequence(options(kit, overrides), { docker: kit.docker, clock, uuid: uuids(), log });
  return { kit, result, summary: result.summary, lines };
}

function job(summary: Summary, label: string) {
  const found = summary.jobs.find((item) => item.label === label);
  if (found === undefined) throw new Error(`no job ${label}`);
  return found;
}

describe("the full local sequence over the real driver code paths, without Docker", () => {
  it("runs the kit check, the observation, admission and the alternative fix, and decides admission from the imported records", async () => {
    const { summary, result, kit } = await sequence();
    expect(result.exitCode).toBe(0);

    const kitCheck = job(summary, "kit-check");
    expect(kitCheck.copies.map((copy) => [copy.trial_id, copy.status])).toEqual(["clean-01", "clean-02", "clean-03", "clean-04", "clean-05"].map((id) => [id, "complete"]));
    expect(kitCheck.import.trials.every((trial) => trial.status === "complete" && trial.added_verdict === "match" && trial.original_failed === 0)).toBe(true);
    expect(kitCheck.import.trials.map((trial) => trial.original_executed)).toEqual([5, 5, 5, 5, 5]);

    const observe = job(summary, "observe");
    expect(observe.baseline).toEqual({ key: BASELINE_KEY, sha256: kitCheck.import.evidence_sha256 });
    expect(observe.copies.map((copy) => [copy.trial_id, copy.status, copy.placed_sha256])).toEqual([["planted-01", "complete", sha256(PLANTED)]]);
    expect(observe.import.trials[0]).toMatchObject({ trial_id: "planted-01", status: "complete", added_verdict: "match", original_executed: 0 });

    const admission = job(summary, "admission");
    expect(admission.copies).toHaveLength(13);
    expect(admission.copies.every((copy) => copy.status === "complete")).toBe(true);
    expect(summary.admission).toMatchObject({
      decisions: { "ADM-02": "pass", "ADM-03": "pass", "ADM-04": "pass", "ADM-05": "pass", "ADM-06": "pass" },
      comparison: "blind_spot_demonstrated",
      outcome_verdict: "pass",
    });
    expect(summary.admission?.cells).toHaveLength(6);

    expect(summary.alternative_fix).toMatchObject({ trial_id: "fixed-01", status: "complete", passes_every_check: true });
    const alternative = job(summary, "alternative-fix");
    expect(alternative.copies.map((copy) => copy.trial_id)).toEqual(["fixed-01"]);

    const placed = Object.fromEntries([...kit.placedFiles.entries()].map(([name, hash]) => [name.replace(/^rbw-[0-9a-f]+-/, ""), hash]));
    expect(placed).toMatchObject({
      "observe-planted-01": sha256(PLANTED),
      "admission-fixed-01": sha256(CLEAN),
      "admission-planted-05": sha256(PLANTED),
      "admission-partial-01": sha256(PARTIAL),
      "admission-stub-01": sha256(STUB),
    });
    expect(Object.keys(placed).some((name) => name.includes("clean-"))).toBe(false);
  });

  it("labels the summary development evidence and records the run date, the known limit, the image and every input hash", async () => {
    const { summary } = await sequence();
    expect(summary).toMatchObject({ label: "development_evidence", admission_claim: false, published: false });
    expect(summary.run.run_date_utc).toBe("2026-10-06");
    expect(summary.run.revenue_tests_known_limit).toMatchObject({ applies: false });
    expect(summary.image.digest).toBe(IMAGE_ID);
    expect(Object.keys(summary.inputs).sort()).toEqual(
      [
        "added_suite_sha256",
        "alternative_fix_patch_sha256",
        "alternative_fix_record_sha256",
        "fixture_sha256",
        "kit_sha256",
        "manifest_sha256",
        "original_suite_sha256",
        "policy_sha256",
        "probe_patches_sha256",
        "probes_json_sha256",
        "recorded_files_sha256",
        "terms_sha256",
      ].sort(),
    );
    expect(summary.code_states.map((state) => state.state)).toEqual(["clean", "planted", "fixed", "partial", "stub", "alternative_fix"]);
  });

  it("measures each copy: phase timings, the tests phase against 240 s and the artifact bytes against 64 MiB", async () => {
    const { summary } = await sequence();
    const copy = job(summary, "admission").copies.find((item) => item.trial_id === "planted-01");
    expect(copy?.tests_phase).toMatchObject({ limit_ms: 240000, within_limit: true });
    expect(copy?.tests_phase?.duration_ms).toBeGreaterThan(0);
    expect(copy?.artifact_bytes).toMatchObject({ limit: 67108864, within_limit: true });
    expect(copy?.artifact_bytes?.total).toBeGreaterThan(0);
    expect(Object.keys(copy?.phases_ms ?? {})).toEqual(["audit", "create", "place", "run", "collect", "remove"]);
    expect(copy?.audit).toMatchObject({ verdict: "pass" });
    expect(job(summary, "kit-check").copies[0]?.audit).toMatchObject({ verdict: "not_applicable", reason: "no_declared_change" });
  });

  it("writes the summary as canonical JSON and a short text table", async () => {
    const { result } = await sequence();
    const bytes = readFileSync(result.summaryPath);
    expect(Buffer.from(encodeCanonical(parseCanonical(bytes))).equals(bytes)).toBe(true);
    expect(sha256Hex(bytes)).toBe(result.summarySha256);
    const text = readFileSync(result.textPath, "utf8");
    expect(text).toContain("development evidence");
    expect(text.split("\n").filter((line) => /^(kit-check|observe|admission|alternative-fix) /.test(line))).toHaveLength(20);
    expect(text).toContain("comparison blind_spot_demonstrated");
  });

  it("runs the card, the issue and the three phrase searches in recorded mode and puts them in the summary", async () => {
    const { summary } = await sequence();
    expect(summary.candidate_text).toMatchObject({ status: "complete", provenance: ["synthetic"], novelty: "clear" });
  });

  it("gives the same decisions with concurrency 3, with a distinct container for every copy", async () => {
    const { summary, kit } = await sequence({}, { concurrency: 3 });
    expect(summary.admission).toMatchObject({ comparison: "blind_spot_demonstrated", outcome_verdict: "pass" });
    expect(summary.run.concurrency).toBe(3);
    expect(new Set(kit.created).size).toBe(kit.created.length);
    expect(kit.created).toHaveLength(22);
  });

  it("imports the records of a copy whose driver ended with an internal error (exit 3)", async () => {
    const { summary } = await sequence({ stack: { "planted-03": { resetThrowsAt: 1 } } });
    const copy = job(summary, "admission").copies.find((item) => item.trial_id === "planted-03");
    expect(copy).toMatchObject({ status: "incomplete", reason: "driver_internal_error", driver_exit: 3 });
    const trial = job(summary, "admission").import.trials.find((item) => item.trial_id === "planted-03");
    expect(trial).toMatchObject({ status: "incomplete", stage: "driver", code: "import:driver_status", reason: "artifact_missing" });
    expect(summary.admission?.decisions["ADM-04"]).toBe("incomplete");
    expect(summary.admission?.comparison).toBe("incomplete");
  });

  it("records a copy stopped at the outer limit as incomplete, and imports nothing from it", async () => {
    const { summary, result } = await sequence({ hang: ["stub-01"] });
    const copy = job(summary, "admission").copies.find((item) => item.trial_id === "stub-01");
    expect(copy).toMatchObject({ status: "incomplete", reason: "timeout", timed_out: true });
    const trial = job(summary, "admission").import.trials.find((item) => item.trial_id === "stub-01");
    expect(trial).toMatchObject({ status: "incomplete", code: "import:result_missing" });
    expect(summary.admission?.decisions["ADM-06"]).toBe("incomplete");
    expect(result.exitCode).toBe(1);
  });
});

describe("the dry run", () => {
  it("prints every docker command and every input hash for the full sequence, without Docker", async () => {
    const lines = await dryRun(options(new KitImage()), { uuid: uuids() });
    const creates = lines.filter((line) => line.startsWith("docker create "));
    expect(creates).toHaveLength(22);
    expect(creates.filter((line) => line.includes("--network none --cpus 4 --memory 8g --security-opt no-new-privileges"))).toHaveLength(21);
    expect(lines.filter((line) => line.startsWith("docker kill "))).toHaveLength(0);
    for (const name of ["manifest_sha256", "terms_sha256", "policy_sha256", "probes_json_sha256", "alternative_fix_patch_sha256", "fixture_sha256", "added_suite_sha256", "recorded_files_sha256"]) {
      expect(lines.some((line) => line.startsWith(`input ${name}=`))).toBe(true);
    }
    expect(lines.some((line) => line.includes("rbw-copy trial planted-01"))).toBe(true);
  });
});

describe("run-copy", () => {
  async function observeJob(kit: KitImage, baselineSha: (actual: string) => string) {
    const root = tempDir();
    const probes = loadProbeSet(writeProbeDir());
    let counter = 100;
    const ids = newRunIds(() => {
      counter += 1;
      return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
    });
    const ctx = {
      ids,
      imageDigest: IMAGE_ID,
      kitSha256: "d".repeat(64),
      fixtureSha256: "e".repeat(64),
      addedSuiteSha256: await addedSuiteSha256(join(kit.kitStage, "umami-fixture")),
      originalSuite: { sha256: kit.suite.encoded.sha256, testIds: kit.suite.manifest.tests.map((test) => test.id) },
      states: deriveCodeStates(Buffer.from(CLEAN), probes, loadAlternativeFix(writeAlternativeDir())),
      vectors: expectedVectors(loadFixture(), probes),
      profileSha256: "b".repeat(64),
      deadlineAt: "2026-10-06T21:00:00Z",
    };
    const records = join(root, "jobs", "kit-check", "records");
    writeJobDir(records, buildJob("kit-check", ctx));
    const imported = importJob(records, join(root, "jobs", "kit-check"));
    const observe = buildJob("observe", ctx, { key: BASELINE_KEY, sha256: baselineSha(imported.evidence_sha256 ?? "") });
    writeJobDir(join(root, "jobs", "observe", "job"), observe);
    return { root, jobDir: join(root, "jobs", "observe", "job") };
  }

  it("refuses to start an observation whose baseline does not match the kit-check records, before any docker command", async () => {
    const kit = new KitImage();
    const { root, jobDir } = await observeJob(kit, () => "0".repeat(64));
    const dir = tempDir();
    const outcome = await runCopyCommand(
      { job: jobDir, trial: "planted-01", root, image: "rbw-umami-kit:synthetic", manifest: writeManifest(dir), terms: writeTerms(dir), policy: null, work: join(dir, "work"), probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() },
      { docker: kit.docker, clock: new FakeClock({ manual: true }) },
    );
    expect(kit.docker.calls).toEqual([]);
    expect(outcome).toMatchObject({ exitCode: 1, refusal: { reason: "baseline_mismatch" } });
  });

  it("runs exactly one copy from a job directory and a trial ID when the baseline matches", async () => {
    const kit = new KitImage();
    const { root, jobDir } = await observeJob(kit, (actual) => actual);
    const dir = tempDir();
    const outcome = await runCopyCommand(
      { job: jobDir, trial: "planted-01", root, image: "rbw-umami-kit:synthetic", manifest: writeManifest(dir), terms: writeTerms(dir), policy: null, work: join(dir, "work"), probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() },
      { docker: kit.docker, clock: new FakeClock({ manual: true }) },
    );
    expect(outcome.refusal).toBeNull();
    expect(outcome.copy).toMatchObject({ trial_id: "planted-01", status: "complete", placed_sha256: sha256(PLANTED) });
    expect(kit.created.filter((name) => name.endsWith("-observe-planted-01"))).toHaveLength(1);
    expect(outcome.exitCode).toBe(0);
  });

  const VCR_DIGEST = `sha256:${"cd".repeat(32)}`;
  const VCR_IMAGE = `synthetic-team/synthetic-project/rbw-umami-kit@${VCR_DIGEST}`;

  /** The kit's Docker, whose local image lists the given repository digests. */
  function pushedDocker(kit: KitImage, repoDigests: string[]): FakeDocker {
    return new FakeDocker((args, runOptions) => (args.includes("{{json .RepoDigests}}") ? ok(JSON.stringify(repoDigests)) : kit.docker.run(args, runOptions)));
  }

  it("runs the copy on Vercel Sandbox with --backend sandbox, and reports its stop and call counts", async () => {
    const kit = new KitImage();
    const { root, jobDir } = await observeJob(kit, (actual) => actual);
    const dir = tempDir();
    const docker = pushedDocker(kit, [`vcr.example.invalid/synthetic-team/synthetic-project/rbw-umami-kit@${VCR_DIGEST}`]);
    const sdk = new FakeSandboxSdk({ collected: { runExit: 0 } });
    const outcome = await runCopyCommand(
      { job: jobDir, trial: "planted-01", root, image: "rbw-umami-kit:synthetic", manifest: writeManifest(dir), terms: writeTerms(dir), policy: null, work: join(dir, "work"), probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir(), backend: "sandbox", sandboxImage: VCR_IMAGE },
      { docker, clock: new FakeClock(), sandbox: sdk },
    );
    expect(outcome.refusal).toBeNull();
    expect(outcome.copy).toMatchObject({ trial_id: "planted-01", status: "complete", placed_sha256: sha256(PLANTED), sandbox: { stop_confirmed: true, calls: { mutating: 3, artifact_reads: 2, stops: 1 } } });
    expect(kit.created.filter((name) => !name.endsWith("-export"))).toEqual([]);
    expect(sdk.ops()).toEqual(["create", "writeFiles", "runCommand", "readFile", "readFile", "stop", "get"]);
    const written = parseCanonical(readFileSync(join(dir, "work", "copy-summary.json"))) as { sandbox?: { name: string } };
    expect(written.sandbox?.name).toMatch(/-observe-planted-01$/);
    expect(outcome.exitCode).toBe(0);
  });

  it("runs a copy from a prebuilt source with no Docker call: no inspect, no repository digests and no export", async () => {
    const kit = new KitImage();
    const { root, jobDir } = await observeJob(kit, (actual) => actual);
    const dir = tempDir();
    const source = await exportImage(kit.docker, { image: IMAGE_ID, container: "rbw-synthetic-prebuilt-export", dest: join(dir, "source") });
    const noDocker: Docker = { run: () => Promise.reject(new Error("synthetic: prebuilt mode must make no Docker call")) };
    const sdk = new FakeSandboxSdk({ collected: { runExit: 0 } });
    const outcome = await runCopyCommand(
      {
        job: jobDir,
        trial: "planted-01",
        root,
        image: IMAGE_ID,
        manifest: writeManifest(dir),
        terms: writeTerms(dir),
        policy: null,
        work: join(dir, "work"),
        probesDir: writeProbeDir(),
        alternativeDir: writeAlternativeDir(),
        backend: "sandbox",
        sandboxImage: VCR_IMAGE,
        prebuiltSource: source.source_dir,
      },
      { docker: noDocker, clock: new FakeClock(), sandbox: sdk },
    );
    expect(outcome.refusal).toBeNull();
    expect(outcome.copy).toMatchObject({ trial_id: "planted-01", status: "complete", placed_sha256: sha256(PLANTED), audit: { verdict: "pass" } });
    expect(sdk.ops().filter((op) => op === "create")).toHaveLength(1);
  });

  it("refuses a race-family copy on a time-zone kit image after the export, before any copy container", async () => {
    const kit = new KitImage();
    const { root, jobDir } = await observeJob(kit, (actual) => actual);
    const dir = tempDir();
    const outcome = await runCopyCommand(
      { job: jobDir, trial: "planted-01", root, image: "rbw-umami-kit:synthetic", manifest: writeManifest(dir), terms: writeTerms(dir), policy: null, work: join(dir, "work"), family: "race", raceLatencyMs: 50, probesDir: writeRaceProbeDir() },
      { docker: kit.docker, clock: new FakeClock({ manual: true }) },
    );
    expect(outcome).toMatchObject({ exitCode: 1, copy: null, refusal: { reason: "image_family_mismatch" } });
    expect(outcome.refusal?.detail).toContain("rbw-umami-race-kit-image-manifest/1");
    expect(kit.created.filter((name) => !name.endsWith("-export"))).toEqual([]);
  });

  it("refuses a VCR image that is not one of the local image's repository digests, before the export and any SDK call", async () => {
    const kit = new KitImage();
    const { root, jobDir } = await observeJob(kit, (actual) => actual);
    const dir = tempDir();
    const sdk = new FakeSandboxSdk();
    const outcome = await runCopyCommand(
      { job: jobDir, trial: "planted-01", root, image: "rbw-umami-kit:synthetic", manifest: writeManifest(dir), terms: writeTerms(dir), policy: null, work: join(dir, "work"), probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir(), backend: "sandbox", sandboxImage: VCR_IMAGE },
      { docker: pushedDocker(kit, [`vcr.example.invalid/synthetic-team/synthetic-project/rbw-umami-kit@sha256:${"ef".repeat(32)}`]), clock: new FakeClock(), sandbox: sdk },
    );
    expect(outcome).toMatchObject({ exitCode: 1, refusal: { reason: "sandbox_image_mismatch" } });
    expect(kit.created).toEqual([]);
    expect(sdk.calls).toEqual([]);
  });
});

describe("the race family: 11 admission copies, ADM-06 not applicable, a database latency per copy", () => {
  const raceOverrides = (extra: Partial<SequenceOptions> = {}): Partial<SequenceOptions> => ({ family: "race", probesDir: writeRaceProbeDir(), alternativeDir: undefined, raceLatencyMs: 50, ...extra });

  it("runs the kit check, the observation and an 11-copy admission without partial, stub or alternative-fix copies, and records the family", async () => {
    const { summary, result, kit } = await sequence({ family: "race" }, raceOverrides());
    expect(result.exitCode).toBe(0);
    expect(summary.family).toEqual({ id: "race", adm06: { status: "not_applicable", reason: "Synthetic: a partial or stub fix of this race has no natural form." }, admission_copies: 11 });
    expect(summary.code_states.map((state) => state.state)).toEqual(["clean", "planted", "fixed"]);
    expect(summary.jobs.map((item) => item.label)).toEqual(["kit-check", "observe", "admission"]);
    const admission = job(summary, "admission");
    expect(admission.copies.map((copy) => copy.trial_id)).toEqual([
      "clean-01",
      "fixed-01",
      "fixed-02",
      "fixed-03",
      "fixed-04",
      "fixed-05",
      "planted-01",
      "planted-02",
      "planted-03",
      "planted-04",
      "planted-05",
    ]);
    expect(admission.copies.every((copy) => copy.status === "complete")).toBe(true);
    expect(admission.copies.every((copy) => copy.proxy?.exit === 0 && copy.proxy.latency_ms === 50 && copy.proxy.source === "override")).toBe(true);
    expect(summary.admission).toMatchObject({
      decisions: { "ADM-02": "pass", "ADM-03": "pass", "ADM-04": "pass", "ADM-05": "pass", "ADM-06": "not_applicable" },
      comparison: "blind_spot_demonstrated",
      outcome_verdict: "pass",
    });
    expect(summary.alternative_fix).toBeNull();
    expect(summary.inputs).toMatchObject({ family: "race", race_latency_ms: "50", alternative_fix_record_sha256: null });
    expect(kit.created.some((name) => name.includes("alternative-fix") || name.includes("partial") || name.includes("stub"))).toBe(false);
    const latencies = [...kit.containers.values()].map((container) => container.latency);
    expect(latencies.length).toBe(1 + 5 + 1 + 11);
    expect(latencies.every((latency) => latency === "50")).toBe(true);
    expect(summaryText(summary)).toContain("family race admission_copies 11 adm06 not_applicable");
  });

  it("runs no candidate text: the recorded inputs describe the time-zone bug, so no card, issue or search reaches the race task revision", async () => {
    const { summary, result } = await sequence({ family: "race" }, raceOverrides());
    expect(result.exitCode).toBe(0);
    expect(summary.candidate_text).toMatchObject({ status: "not_run", code: "symptom_unavailable" });
    expect(existsSync(join(result.summaryPath, "..", "candidate-text"))).toBe(false);
    expect(summaryText(summary)).toContain("candidate text not_run symptom_unavailable");
  });

  it("passes no latency argument when the run keeps the race image's default", async () => {
    const { result, kit, summary } = await sequence({ family: "race" }, raceOverrides({ raceLatencyMs: null }));
    expect(result.exitCode).toBe(0);
    expect(summary.jobs.flatMap((item) => item.copies).every((copy) => copy.proxy === undefined)).toBe(true);
    expect([...kit.containers.values()].every((container) => container.latency === null)).toBe(true);
  });

  it("stops at the export when the race family is given a time-zone kit image", async () => {
    const { summary, result } = await sequence({ family: "race", imageFamily: "time-zone" }, raceOverrides());
    expect(result.exitCode).toBe(1);
    expect(summary.failure).toMatchObject({ step: "export" });
    expect(summary.failure?.detail).toContain("rbw-umami-race-kit-image-manifest/1");
    expect(summary.jobs).toEqual([]);
  });

  it("stops at the export when the default family is given a race kit image", async () => {
    const { summary, result } = await sequence({ imageFamily: "race" });
    expect(result.exitCode).toBe(1);
    expect(summary.failure).toMatchObject({ step: "export" });
    expect(summary.failure?.detail).toContain("is a race kit image (rbw-umami-race-kit-image-manifest/1)");
  });

  it("refuses a kit stage that holds the time-zone fixture for a race run, before any docker command", async () => {
    const kit = new KitImage();
    await expect(runSequence(options(kit, raceOverrides()), { docker: kit.docker, clock: new FakeClock({ manual: true }), uuid: uuids(), log: () => undefined })).rejects.toThrow(/kit stage holds no rc-1-backup-code-001\.v1\.json/);
    expect(kit.docker.calls).toEqual([]);
  });

  it("refuses the time-zone probe set (with partial and stub probes) for the race fixture, which declares no partial or stub vector", async () => {
    const kit = new KitImage({ family: "race" });
    await expect(runSequence(options(kit, raceOverrides({ probesDir: writeProbeDir() })), { docker: kit.docker, clock: new FakeClock({ manual: true }), uuid: uuids(), log: () => undefined })).rejects.toThrow(
      /declares the code states clean,fixed,planted, but its probe set needs clean,fixed,partial,planted,stub/,
    );
  });

  it("refuses a latency for the time-zone family, and one above 10000 ms", async () => {
    const kit = new KitImage();
    await expect(runSequence(options(kit, { raceLatencyMs: 50 }), { docker: kit.docker, clock: new FakeClock({ manual: true }), uuid: uuids(), log: () => undefined })).rejects.toThrow(/has no database proxy/);
    const race = new KitImage({ family: "race" });
    await expect(runSequence(options(race, raceOverrides({ raceLatencyMs: 10001 })), { docker: race.docker, clock: new FakeClock({ manual: true }), uuid: uuids(), log: () => undefined })).rejects.toThrow(/from 0 to 10000/);
  });

  it("prints the 11 admission copies with the latency argument in the dry run", async () => {
    const lines = await dryRun(options(new KitImage({ family: "race" }), raceOverrides()), { uuid: uuids() });
    const creates = lines.filter((line) => line.startsWith("docker create ") && line.includes(" rbw-copy "));
    expect(creates).toHaveLength(1 + 5 + 1 + 11);
    expect(creates.every((line) => / rbw-copy (freeze freeze|trial [a-z]+-\d\d) 50$/.test(line))).toBe(true);
    expect(lines).toContain("family race: 11 admission copies, ADM-06 not applicable, latency 50 ms");
  });
});
