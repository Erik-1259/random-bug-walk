// A judge replay of a race release runs the release's own family: the controller reads the family
// and the race latency back from the frozen judge job (the race fixture's vectors and the copy
// profile hash), and applies them as a `run --family race --race-latency-ms` job does, with the
// race probe set and the latency in every copy. A time-zone replay is unchanged: no family record
// and no latency.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAMILIES, buildJob, deriveCodeStates, expectedVectors, profileSha256, runTag } from "@rbw/local-runner";
import type { JobContext } from "@rbw/local-runner";
import { LocalPrivateStore } from "@rbw/publisher/private-store";
import { buildJobRequest, canonicalDigest, parseRecord, sha256Hex } from "@rbw/schema";
import type { Release } from "@rbw/schema";
import { loadProbeSet } from "@rbw/shapes";
import { parseSuiteManifest } from "@rbw/umami-driver";
import { controllerEnvelope } from "../../src/envelope.ts";
import type { CopyEnvelope } from "../../src/envelope.ts";
import { controllerSandboxName, judgeDeadlineMs, judgeIds, judgeKeys, judgeOperation, judgeRelease, newProgress, progressBytes } from "../../src/judge.ts";
import { NO_DOCKER, runJudgeReplay } from "../../src/judge-run.ts";
import type { JudgeRunOutcome } from "../../src/judge-run.ts";
import { JUDGE } from "../../src/limits.ts";
import { FakeClock } from "../../../local-runner/test/support/fakes.ts";
import { CLEAN, tempDir, writeAlternativeDir, writeProbeDir, writeRaceProbeDir } from "../../../local-runner/test/support/synthetic.ts";
import { world } from "../support/harness.ts";
import type { World } from "../support/harness.ts";

const FIXTURE = fileURLToPath(new URL("../../../release/fixtures/release/", import.meta.url));
const RELEASE_ID = "00000000-0000-4000-8000-000000000601";
const REQUEST_ID = "00000000-0000-4000-8000-00000000b201";
const CREATED = Date.parse("2026-10-06T09:00:00Z");
const RACE_REASON = "Synthetic: a partial or stub fix of this race has no natural form.";
const JOB_DIR = join(FIXTURE, "private-store", "judge-jobs", RELEASE_ID);

function fixtureRelease(): Release {
  return parseRecord("Release", readFileSync(join(FIXTURE, "repository", "releases", RELEASE_ID, "release.json")));
}

/**
 * The fixture's judge job rebuilt for the race family at `latency`, as the release tool freezes one:
 * the same frozen source, suites and audit inputs, with the race fixture's vectors, the synthetic
 * race probes' code states, the reference fix as fixed-01 and the latency's copy profile (or
 * `profile`, a hash given as is).
 */
function raceJudgeJob(release: Release, probesDir: string, latency: number | null, profile = profileSha256(latency)): { request: Uint8Array; expected: Uint8Array } {
  const frozen = parseRecord("JobRequest", readFileSync(join(JOB_DIR, "request.json")));
  const frozenExpected = parseRecord("ExpectedTrials", readFileSync(join(JOB_DIR, "expected-trials.json")));
  const suiteBytes = readFileSync(join(JOB_DIR, "original-suite.json"));
  const probes = loadProbeSet(probesDir);
  const placeholder = frozen.root_execution_id;
  const ctx: JobContext = {
    ids: {
      run_tag: runTag(placeholder),
      project_id: release.project_id,
      batch_id: frozen.batch_id,
      root_execution_id: placeholder,
      executions: { "kit-check": frozen.execution_id, observe: frozen.execution_id, admission: frozen.execution_id, "alternative-fix": frozen.execution_id, "candidate-text": frozen.execution_id },
      release_id: release.release_id,
    },
    imageDigest: frozen.image_digest,
    kitSha256: "e".repeat(64),
    fixtureSha256: sha256Hex(readFileSync(FAMILIES.race.fixtureFile)),
    addedSuiteSha256: frozenExpected.trials[0]?.added_suite_sha256 ?? "",
    originalSuite: { sha256: sha256Hex(suiteBytes), testIds: parseSuiteManifest(suiteBytes).tests.map((test) => test.id) },
    states: deriveCodeStates(Buffer.from(CLEAN), probes, null),
    vectors: expectedVectors(FAMILIES.race.loadFixture(), probes),
    adm06: "not_applicable",
    judgeFixed: "fixed",
    profileSha256: profile,
    deadlineAt: frozen.deadline_at,
    projectPolicy: { sha256: release.project_policy_sha256, policy_id: frozen.policy_id },
    issue: { sha256: "ab".repeat(32), style: "user-report" },
  };
  const first = buildJob("alternative-fix", ctx);
  const request = buildJobRequest({ ...first.request, reservation_microusd: frozen.reservation_microusd });
  return { request: request.bytes, expected: first.expectedBytes };
}

interface Replay {
  w: World;
  release: Release;
  store: LocalPrivateStore;
}

/** The private store and ledger as the judge route leaves them, holding the fixture's judge job or, with `race`, a race one. */
async function prepare(race?: { probesDir: string; latency: number | null; profile?: string }): Promise<Replay> {
  const clock = new FakeClock({ start: CREATED });
  const w = await world({ clock, sandbox: { collected: { runExit: 0 } } });
  const storeDir = tempDir("rbw-judge-family-store-");
  cpSync(join(FIXTURE, "private-store"), storeDir, { recursive: true });
  let release = fixtureRelease();
  if (race !== undefined) {
    const job = raceJudgeJob(release, race.probesDir, race.latency, race.profile);
    const dir = join(storeDir, "judge-jobs", RELEASE_ID);
    writeFileSync(join(dir, "request.json"), job.request);
    writeFileSync(join(dir, "expected-trials.json"), job.expected);
    const index = JSON.parse(readFileSync(join(dir, "judge-job.json"), "utf8")) as { release_id: string; files: { path: string; sha256: string }[] };
    const files = index.files.map((file) => ({ path: file.path, sha256: sha256Hex(readFileSync(join(dir, file.path))) }));
    const digest = canonicalDigest({ release_id: index.release_id, files });
    writeFileSync(join(dir, "judge-job.json"), digest.bytes);
    release = { ...release, judge_job: { ...release.judge_job, index_sha256: digest.sha256 } };
  }
  const store = new LocalPrivateStore(storeDir);
  const ids = judgeIds(REQUEST_ID);
  const op = judgeOperation(REQUEST_ID, judgeRelease(release), controllerEnvelope(w.deps.rates) as CopyEnvelope);
  const must = (result: { ok: boolean }) => {
    if (!result.ok) throw new Error("synthetic: the route's ledger setup was refused");
  };
  must(await w.spend.acquireSlot({ slot_key: JUDGE.slot_key, root_execution_id: ids.root, actor_role: "judge-route" }));
  must(await w.spend.reserve(op.request));
  must(await w.spend.transition({ operation_id: op.operation_id, from_state: "prepared", to_state: "launching", actor_role: "judge-route", slot_key: JUDGE.slot_key }));
  must(await w.spend.transition({ operation_id: op.operation_id, from_state: "launching", to_state: "running", actor_role: "judge-route", provider_resource_id: op.sandbox_name }));
  await store.putNew(judgeKeys(ids.root).progress, progressBytes(newProgress(ids.root, CREATED, judgeDeadlineMs(CREATED))), "application/json");
  w.sdk.seed(controllerSandboxName(ids.root), "running");
  clock.current = CREATED + 30_000;
  w.deps.docker = NO_DOCKER;
  return { w, release, store };
}

function replay(r: Replay, probes: { probesDir: string; alternativeDir?: string }): Promise<JudgeRunOutcome> {
  return runJudgeReplay({ requestId: REQUEST_ID, release: r.release, store: r.store, deadlineAtMs: judgeDeadlineMs(CREATED), work: tempDir("rbw-judge-family-work-"), ...probes }, r.w.deps);
}

/** The copy script's arguments of each copy command the replay ran: rbw-copy, the mode, the trial and any latency. */
function copyArgs(w: World): string[][] {
  return w.sdk.calls.flatMap((call) => (call.op === "runCommand" ? [call.params.args.slice(call.params.args.indexOf("rbw-copy"))] : []));
}

describe("a judge replay of a race release", () => {
  it("sets the frozen job's race latency in every copy and records the race family", async () => {
    const probesDir = writeRaceProbeDir();
    const r = await prepare({ probesDir, latency: 75 });
    const outcome = await replay(r, { probesDir });
    expect(outcome.summary.reason).toBeNull();
    expect(copyArgs(r.w)).toEqual([
      ["rbw-copy", "trial", "clean-01", "75"],
      ["rbw-copy", "trial", "planted-01", "75"],
      ["rbw-copy", "trial", "fixed-01", "75"],
    ]);
    expect(outcome.summary.family).toEqual({ id: "race", adm06: { status: "not_applicable", reason: RACE_REASON }, admission_copies: 11, race_latency_ms: 75 });
  });

  it("keeps the image's default latency for a race job frozen with none", async () => {
    const probesDir = writeRaceProbeDir();
    const r = await prepare({ probesDir, latency: null });
    const outcome = await replay(r, { probesDir });
    expect(outcome.summary.reason).toBeNull();
    expect(copyArgs(r.w).map((args) => args.length)).toEqual([3, 3, 3]);
    expect(outcome.summary.family).toMatchObject({ id: "race", race_latency_ms: null });
  });

  it("refuses, before any copy, a race job whose runtime profile is the copy profile at no latency (family_unreadable)", async () => {
    const probesDir = writeRaceProbeDir();
    const r = await prepare({ probesDir, latency: null, profile: "c".repeat(64) });
    const outcome = await replay(r, { probesDir });
    expect(outcome.summary.reason).toBe("cannot_build");
    expect(outcome.summary.detail).toContain("family_unreadable");
    expect(copyArgs(r.w)).toEqual([]);
  });
});

describe("a judge replay of the time-zone release", () => {
  it("runs the frozen job with no latency and no family record, as before", async () => {
    const r = await prepare();
    const outcome = await replay(r, { probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() });
    expect(outcome.summary.status).toBe("complete");
    expect(copyArgs(r.w)).toEqual([
      ["rbw-copy", "trial", "clean-01"],
      ["rbw-copy", "trial", "planted-01"],
      ["rbw-copy", "trial", "fixed-01"],
    ]);
    expect("family" in outcome.summary).toBe(false);
  });
});
