import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRateSheet } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import { RATE_SHEET_PATH, judgeReservation } from "@rbw/controller";
import { candidateIdentity, utcSeconds } from "@rbw/local-runner";
import { buildJobRequest, buildPolicy, canonicalDigest, encodeCanonical, parseCanonical, parseRecord, sha256Hex, taskRevision } from "@rbw/schema";
import type { ExpectedTrials, FamilyRegistry, HeldOutIdentityList, JobRequest, PublicationRecord } from "@rbw/schema";
import { buildRelease } from "../../src/build.ts";
import type { BuildDeps, BuildOptions } from "../../src/build.ts";
import { checkRelease } from "../../src/check.ts";
import { JUDGE_PLACEHOLDERS } from "../../src/judge-job.ts";
import { LocalPrivateStore } from "@rbw/publisher/private-store";
import type { PrivateStore } from "@rbw/publisher/private-store";
import { stage } from "../../src/stage.ts";
import { checkout, destination, publish } from "../support/publish.ts";
import { CONTROLLER_IMAGE, KIT_IMAGE, RELEASE_ID, canonical, factoryRun, generatedFiles, kitDocker, tempDir, world, write } from "../support/world.ts";
import type { FactoryRun, World } from "../support/world.ts";

const SOURCES = new URL("../../fixtures/sources/", import.meta.url).pathname;
const FAMILY = "synthetic-family-1";
const SOURCE_FIX = { upstream: "synthetic-upstream", commit: "a".repeat(40) };

interface Published {
  runDir: string;
  publication: string;
  record: PublicationRecord;
}

let w: World;
let factory: FactoryRun;
let rates: Rates;
let eligible: Published;
let inputs: { issue: string; issueCheck: string; recordings: string; approval: string; registry: string; heldOut: string; issueSha256: string };

function readExpected(path: string): ExpectedTrials {
  return parseCanonical(readFileSync(path)) as unknown as ExpectedTrials;
}

/** Stages the factory run, lets `change` edit the staging directory, and publishes it to a fresh destination. */
async function published(change: (staging: string, exec: string) => void = () => undefined, novelty: "clear" | "blocked" | "incomplete" = "clear", card = true): Promise<Published> {
  const dir = tempDir();
  const out = join(dir, "staging");
  const redactions = join(dir, "private", "redactions.txt");
  const generated = generatedFiles(dir, novelty);
  const outcome = stage({ run: factory.run, rootRun: factory.rootRunFile, out, redactionsOut: redactions, ...generated, card: card ? generated.card : undefined });
  if (!outcome.ok) throw new Error("synthetic: the stage was refused");
  change(out, factory.ids.executions.admission);
  const d = destination(w);
  const { result, record } = await publish(w, d, { rootRun: factory.rootRunFile, staging: out, redactions });
  if (result.code !== 0 || record === null) throw new Error(`synthetic: the publish exited ${String(result.code)}: ${result.stderr}`);
  return { runDir: checkout(d.remote, `runs/${factory.ids.root_execution_id}`), publication: write(join(dir, "publication.json"), canonical(record)), record };
}

function editJson(path: string, edit: (value: Record<string, unknown>) => unknown): void {
  writeFileSync(path, encodeCanonical(edit(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)));
}

function registry(mutationIds: string[]): string {
  const value: FamilyRegistry = { schema_version: 1, families: [{ family_id: FAMILY, exposure: "public", held_out_eligible: false, source_fixes: [SOURCE_FIX], mutation_ids: mutationIds }] };
  return write(join(tempDir(), "families.json"), canonical(value));
}

function heldOut(value: Partial<HeldOutIdentityList> = {}): string {
  return write(join(tempDir(), "held-out.json"), canonical({ schema_version: 1, family_ids: [], source_fixes: [], mutation_ids: [], ...value }));
}

function options(overrides: Partial<BuildOptions> = {}): BuildOptions {
  const dir = tempDir();
  return {
    releaseId: RELEASE_ID,
    run: eligible.runDir,
    publication: eligible.publication,
    policy: w.policy.file,
    rootRun: factory.rootRunFile,
    issue: inputs.issue,
    issueCheck: inputs.issueCheck,
    recordings: inputs.recordings,
    approval: inputs.approval,
    registry: inputs.registry,
    heldOut: inputs.heldOut,
    sources: w.sources,
    controllerImage: CONTROLLER_IMAGE,
    localStore: join(dir, "private-store"),
    out: join(dir, "release"),
    ...overrides,
  };
}

function deps(overrides: Partial<BuildDeps> = {}): BuildDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    docker: w.docker,
    clock: w.clock,
    rates,
    env: {},
    privateStoreFromEnv: () => {
      throw new Error("synthetic: local mode must not ask for the real store");
    },
    log: (line) => {
      logs.push(line);
    },
    logs,
    ...overrides,
  };
}

async function refused(opts: BuildOptions, code: string, extra: Partial<BuildDeps> = {}): Promise<void> {
  const outcome = await buildRelease(opts, deps(extra));
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.codes).toContain(code);
  expect(existsSync(opts.out)).toBe(false);
  expect(existsSync(opts.localStore ?? "")).toBe(false);
}

beforeAll(async () => {
  w = world();
  rates = await loadRateSheet(RATE_SHEET_PATH);
  factory = await factoryRun(w);
  eligible = await published();
  const dir = tempDir();
  const issueSha256 = canonicalDigest(JSON.parse(readFileSync(join(SOURCES, "issue.json"), "utf8")) as never).sha256;
  inputs = {
    issue: join(SOURCES, "issue.json"),
    issueCheck: join(SOURCES, "issue-check.json"),
    recordings: join(SOURCES, "recordings"),
    approval: write(join(dir, "approval.json"), JSON.stringify({ decision: "approved", issue_sha256: issueSha256, reviewed_at: "2026-10-14T10:00:00Z" })),
    registry: registry([candidateIdentity(factory.ctx).mutation_id ?? ""]),
    heldOut: heldOut(),
    issueSha256,
  };
});

describe("build: the eligible release", () => {
  it("ADM-09 checks, stores the judge job, then writes release.json, the issue, its check report and the recordings", async () => {
    const opts = options();
    const now = utcSeconds(w.clock.now());
    const outcome = await buildRelease(opts, deps());
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    const release = parseRecord("Release", readFileSync(join(opts.out, "release.json")));
    expect(Buffer.from(encodeCanonical(release))).toEqual(readFileSync(join(opts.out, "release.json")));
    expect(outcome.releaseSha256).toBe(sha256Hex(readFileSync(join(opts.out, "release.json"))));
    expect(release.release_id).toBe(RELEASE_ID);
    expect(release.policy_id).toBe("umami-uc3-v1");
    expect(release.project_policy_sha256).toBe(w.policy.sha256);
    expect(release.calibration).toBe("not_requested");
    expect(release.images).toEqual({ kit_image: KIT_IMAGE, controller_image: CONTROLLER_IMAGE });
    expect(release.family).toEqual({ family_id: FAMILY, source_fix: SOURCE_FIX, mutation_id: release.revisions[0]?.identity.mutation_id, split: "public_demo" });
    expect(release.run).toEqual({
      root_execution_id: factory.ids.root_execution_id,
      publication_id: eligible.record.publication_id,
      manifest_sha256: eligible.record.manifest_sha256,
      repository_commit: eligible.record.repository_commit,
    });
    expect(release.admission).toEqual({ execution_id: factory.ids.executions.admission, outcome_verdict: "pass", classification: "blind_spot_demonstrated" });
    expect(release.approval).toEqual({ decision: "approved", issue_sha256: inputs.issueSha256, reviewed_at: "2026-10-14T10:00:00Z" });
    expect(release.created_at).toBe(now);
    expect(readdirSync(opts.out, { recursive: true, encoding: "utf8" }).sort()).toEqual([
      "issue-check.json",
      "issue.json",
      "recordings",
      "recordings/card-1.recording.json",
      "recordings/issue-1.recording.json",
      "release.json",
    ]);
    expect(release.files).toEqual(
      ["issue-check.json", "issue.json", "recordings/card-1.recording.json", "recordings/issue-1.recording.json"].map((path) => ({ path, sha256: sha256Hex(readFileSync(join(opts.out, path))) })),
    );
    expect(sha256Hex(readFileSync(join(opts.out, "issue.json")))).toBe(inputs.issueSha256);
    expect(checkRelease(release, { dir: eligible.runDir, policyBytes: w.policy.bytes, publication: eligible.record, rootRun: factory.rootRun }, opts.out)).toEqual([]);
  });

  it("publishes only the *.recording.json files of a writer record --out directory, never its summaries", async () => {
    const recordings = join(tempDir(), "record-out");
    cpSync(inputs.recordings, recordings, { recursive: true });
    write(join(recordings, "card-1.summary.json"), canonical({ operation_id: "synthetic-operation", settled_microusd: 1 }));
    const opts = options({ recordings });
    const outcome = await buildRelease(opts, deps());
    if (!outcome.ok) throw new Error(outcome.codes.join(","));
    expect(readdirSync(join(opts.out, "recordings")).sort()).toEqual(["card-1.recording.json", "issue-1.recording.json"]);
  });

  it("ADM-07 makes the complete revision the admission's provisional one plus the frozen issue, from the judge job's own identity", async () => {
    const opts = options();
    const outcome = await buildRelease(opts, deps());
    if (!outcome.ok) throw new Error(outcome.codes.join(","));
    const store = new LocalPrivateStore(opts.localStore ?? "");
    const request = parseRecord("JobRequest", (await store.get(`judge-jobs/${RELEASE_ID}/request.json`, 1 << 20)) ?? new Uint8Array());
    const [revision] = outcome.release.revisions;
    expect(outcome.release.revisions).toHaveLength(1);
    expect(revision?.sha256).toBe(request.task_revision);
    expect(revision === undefined ? null : taskRevision(revision.identity).sha256).toBe(request.task_revision);
    expect(revision?.identity).toMatchObject({ revision_kind: "complete", issue_sha256: inputs.issueSha256, issue_style: "user-report", grading_policy_id: "umami-uc3-v1" });
    if (revision === undefined) throw new Error("synthetic: no revision");
    const provisional = { ...revision.identity, revision_kind: "provisional" as const, issue_sha256: null, issue_style: null };
    expect(taskRevision(provisional).sha256).toBe(factory.admission.built.request.task_revision);
  });
});

describe("build: the judge job", () => {
  let opts: BuildOptions;
  let store: PrivateStore;
  let index: { release_id: string; files: { path: string; sha256: string }[] };
  let indexBytes: Uint8Array;
  let request: JobRequest;

  beforeAll(async () => {
    opts = options();
    const outcome = await buildRelease(opts, deps());
    if (!outcome.ok) throw new Error(outcome.codes.join(","));
    store = new LocalPrivateStore(opts.localStore ?? "");
    indexBytes = (await store.get(`judge-jobs/${RELEASE_ID}/judge-job.json`, 1 << 20)) ?? new Uint8Array();
    index = parseCanonical(indexBytes) as unknown as typeof index;
    request = parseRecord("JobRequest", (await store.get(`judge-jobs/${RELEASE_ID}/request.json`, 1 << 20)) ?? new Uint8Array());
    expect(outcome.release.judge_job).toEqual({ index_key: `judge-jobs/${RELEASE_ID}/judge-job.json`, index_sha256: sha256Hex(indexBytes) });
  });

  it("indexes only the release ID and every file with its SHA-256", async () => {
    expect(Object.keys(index).sort()).toEqual(["files", "release_id"]);
    expect(index.release_id).toBe(RELEASE_ID);
    const names = ["audit-policy.json", "expected-trials.json", "original-suite.json", "projection-manifest.json", "request.json", "source.tar", "strict-terms.txt"];
    expect(index.files.map((file) => file.path)).toEqual(names);
    for (const file of index.files) expect(sha256Hex((await store.get(`judge-jobs/${RELEASE_ID}/${file.path}`, 1 << 26)) ?? new Uint8Array())).toBe(file.sha256);
    expect((await store.list(`judge-jobs/${RELEASE_ID}/`)).sort()).toEqual([...names, "judge-job.json"].map((name) => `judge-jobs/${RELEASE_ID}/${name}`).sort());
    expect(JSON.stringify(index)).not.toMatch(/kit-stage|image-manifest|image_digest|provisional/);
    expect(readFileSync(w.sources.terms)).toEqual(Buffer.from((await store.get(`judge-jobs/${RELEASE_ID}/strict-terms.txt`, 1 << 20)) ?? new Uint8Array()));
  });

  it("freezes the complete judge_verify request: real project, policy, release ID and reservation, placeholders only where the overlay writes", () => {
    expect(request.kind).toBe("judge_verify");
    expect(request.project_id).toBe(factory.rootRun.project_id);
    expect(request.project_policy_sha256).toBe(w.policy.sha256);
    expect(request.policy_id).toBe("umami-uc3-v1");
    expect(request.release_id).toBe(RELEASE_ID);
    const reservation = judgeReservation(rates);
    if (!reservation.ok) throw new Error("synthetic: no reservation");
    expect(request.reservation_microusd).toBe(Number(reservation.reserved_microusd));
    expect(request.reservation_microusd).toBe(647_527);
    expect({ root: request.root_execution_id, batch: request.batch_id, execution: request.execution_id, parent: request.parent_execution_id, deadline: request.deadline_at }).toEqual({
      root: JUDGE_PLACEHOLDERS.root_execution_id,
      batch: JUDGE_PLACEHOLDERS.batch_id,
      execution: JUDGE_PLACEHOLDERS.execution_id,
      parent: JUDGE_PLACEHOLDERS.root_execution_id,
      deadline: JUDGE_PLACEHOLDERS.deadline_at,
    });
    expect(buildJobRequest({ ...request }).request).toEqual(request);
  });

  it("grades the source fix's fixed state: fixed-01's patch hash is the admission's fixed trials' hash", async () => {
    const expected = parseRecord("ExpectedTrials", (await store.get(`judge-jobs/${RELEASE_ID}/expected-trials.json`, 1 << 20)) ?? new Uint8Array(), { request });
    const admission = readExpected(join(eligible.runDir, "results", factory.ids.executions.admission, "expected-trials.json"));
    const fixed = new Set(admission.trials.filter((trial) => trial.code_state === "fixed").map((trial) => trial.patch_sha256));
    expect(fixed.size).toBe(1);
    expect(expected.trials.find((trial) => trial.trial_id === "fixed-01")?.patch_sha256).toBe([...fixed][0]);
    expect(expected.trials.find((trial) => trial.trial_id === "planted-01")?.patch_sha256).toBe(admission.trials.find((trial) => trial.trial_id === "planted-01")?.patch_sha256);
  });

  it("gives the same index bytes when built again, and storing the same bytes again succeeds", async () => {
    const again = await buildRelease({ ...options(), localStore: opts.localStore }, deps());
    expect(again.ok).toBe(true);
    expect(Buffer.from((await store.get(`judge-jobs/${RELEASE_ID}/judge-job.json`, 1 << 20)) ?? new Uint8Array())).toEqual(Buffer.from(indexBytes));
    const elsewhere = options();
    expect((await buildRelease(elsewhere, deps())).ok).toBe(true);
    expect(Buffer.from((await new LocalPrivateStore(elsewhere.localStore ?? "").get(`judge-jobs/${RELEASE_ID}/judge-job.json`, 1 << 20)) ?? new Uint8Array())).toEqual(Buffer.from(indexBytes));
  });

  it("refuses to overwrite a stored object with other bytes, and writes no release", async () => {
    const terms = write(join(tempDir(), "terms.txt"), `${readFileSync(w.sources.terms, "utf8")}strict:synthetic-other-term\n`);
    const other = { ...options({ sources: { ...w.sources, terms } }), localStore: opts.localStore };
    const outcome = await buildRelease(other, deps());
    expect(outcome).toMatchObject({ ok: false, codes: ["store_mismatch"] });
    expect(existsSync(other.out)).toBe(false);
    expect(readFileSync(w.sources.terms)).toEqual(Buffer.from((await store.get(`judge-jobs/${RELEASE_ID}/strict-terms.txt`, 1 << 20)) ?? new Uint8Array()));
  });

  it("in real mode gets its store only from privateStoreFromEnv, and no credential reaches a child process or a log", async () => {
    const credential = ["synthetic", "oidc", "credential"].join("-");
    const env: Record<string, string | undefined> = { VERCEL_OIDC_TOKEN: credential, BLOB_PRIVATE_STORE_ID: "synthetic-store-id", PATH: process.env.PATH };
    const dir = tempDir();
    const seen: Record<string, string | undefined>[] = [];
    const asked: Record<string, string | undefined>[] = [];
    const docker = kitDocker(w.kit);
    const watched = { run: (args: readonly string[], runOptions?: object) => {
      seen.push({ ...env });
      return docker.run(args, runOptions);
    } };
    const d = deps({
      env,
      docker: watched,
      privateStoreFromEnv: (given) => {
        asked.push({ ...given });
        return new LocalPrivateStore(join(dir, "store"));
      },
    });
    const outcome = await buildRelease(options({ localStore: null }), d);
    expect(outcome.ok).toBe(true);
    expect(asked).toEqual([{ VERCEL_OIDC_TOKEN: credential, BLOB_PRIVATE_STORE_ID: "synthetic-store-id", PATH: process.env.PATH }]);
    expect(seen.length).toBeGreaterThan(0);
    for (const snapshot of seen) expect(Object.values(snapshot)).not.toContain(credential);
    expect(d.logs.join("\n")).not.toContain(credential);
    expect(readdirSync(join(dir, "store", "judge-jobs", RELEASE_ID)).length).toBe(8);
  });
});

describe("build: a failing check stores and writes nothing", () => {
  it("ADM-07 refuses a release without an approval of this issue hash (approval_issue_mismatch)", async () => {
    const approval = write(join(tempDir(), "approval.json"), JSON.stringify({ decision: "approved", issue_sha256: "e".repeat(64), reviewed_at: "2026-10-14T10:00:00Z" }));
    await refused(options({ approval }), "approval_issue_mismatch");
  });

  it("ADM-07 refuses an issue whose check report is not ready_for_review (issue_not_ready)", async () => {
    const issueCheck = write(join(tempDir(), "issue-check.json"), JSON.stringify({ ...JSON.parse(readFileSync(inputs.issueCheck, "utf8")), status: "rejected", codes: ["numeric_mismatch"] }));
    await refused(options({ issueCheck }), "issue_not_ready");
  });

  it("ADM-07 refuses a release whose novelty is blocked (novelty_blocked)", async () => {
    const run = await published(undefined, "blocked");
    await refused(options({ run: run.runDir, publication: run.publication }), "novelty_blocked");
  });

  it("ADM-07 refuses a release whose run has no pattern card (card_invalid)", async () => {
    const run = await published(undefined, "clear", false);
    await refused(options({ run: run.runDir, publication: run.publication }), "card_invalid");
  });

  it("ADM-07 refuses a release whose pattern card is not schema-valid (card_invalid)", async () => {
    const run = await published((staging) => {
      editJson(join(staging, "generated", "card.json"), (card) => ({ ...card, bug_class: "not-a-bug-class" }));
    });
    await refused(options({ run: run.runDir, publication: run.publication }), "card_invalid");
  });

  it("ADM-07 refuses a release whose novelty is incomplete (novelty_incomplete)", async () => {
    const run = await published(undefined, "incomplete");
    await refused(options({ run: run.runDir, publication: run.publication }), "novelty_incomplete");
  });

  it("ADM-09 refuses an admission whose verdict is reject (outcome_verdict_not_pass)", async () => {
    const run = await published((staging, exec) => {
      editJson(join(staging, "results", exec, "decision.json"), (decision) => ({ ...decision, outcome_verdict: "reject" }));
    });
    await refused(options({ run: run.runDir, publication: run.publication }), "outcome_verdict_not_pass");
  });

  it("ADM-09 refuses an admission caught by the original suite (classification_not_blind_spot)", async () => {
    const run = await published((staging, exec) => {
      editJson(join(staging, "results", exec, "decision.json"), (decision) => ({ ...decision, comparison: { ...(decision.comparison as object), classification: "caught_by_original_suite" } }));
    });
    await refused(options({ run: run.runDir, publication: run.publication }), "classification_not_blind_spot");
  });

  it("ADM-09 refuses a planted copy whose audit is not pass, and accepts clean and fixed copies that are not_applicable (audit_not_pass)", async () => {
    const audits = factory.admission.summary.copies.map((copy) => `${copy.code_state}:${copy.copy?.audit.verdict ?? "-"}`);
    expect(new Set(audits.filter((item) => item.startsWith("clean") || item.startsWith("fixed")))).toEqual(new Set(["clean:not_applicable", "fixed:not_applicable"]));
    expect(audits.filter((item) => !item.startsWith("clean") && !item.startsWith("fixed")).every((item) => item.endsWith(":pass"))).toBe(true);
    const run = await published((staging, exec) => {
      editJson(join(staging, "results", exec, "summary.json"), (summary) => ({
        ...summary,
        copies: (summary.copies as { trial_id: string; copy: { audit: object } }[]).map((copy) => (copy.trial_id === "planted-03" ? { ...copy, copy: { ...copy.copy, audit: { ...copy.copy.audit, verdict: "fail" } } } : copy)),
      }));
    });
    await refused(options({ run: run.runDir, publication: run.publication }), "audit_not_pass");
  });

  it("ADM-09 refuses a run that is not the one the publication record names (run_manifest_mismatch)", async () => {
    const publication = write(join(tempDir(), "publication.json"), canonical({ ...eligible.record, manifest_sha256: "0".repeat(64) }));
    await refused(options({ publication }), "run_manifest_mismatch");
  });

  it("ADM-09 refuses a complete revision that does not reduce to the admission request's revision (revision_mismatch)", async () => {
    const run = await published((staging, exec) => {
      const path = join(staging, "results", exec, "request.json");
      const request = parseRecord("JobRequest", readFileSync(path));
      writeFileSync(path, buildJobRequest({ ...request, task_revision: "a".repeat(64) }).bytes);
    });
    await refused(options({ run: run.runDir, publication: run.publication }), "revision_mismatch");
  });

  it("ADM-09 refuses a policy that is not public_demo (policy_not_public_demo)", async () => {
    const evaluation = buildPolicy({ projectId: factory.rootRun.project_id, outputRepository: null, publicArtifactBaseUri: null, policyVersion: 1 });
    await refused(options({ policy: write(join(tempDir(), "policy.json"), evaluation.bytes) }), "policy_not_public_demo");
  });

  it("ADM-09 refuses an admission whose policy_id is not umami-uc3-v1 (policy_id_not_uc3)", async () => {
    const run = await published((staging, exec) => {
      const path = join(staging, "results", exec, "request.json");
      const request = parseRecord("JobRequest", readFileSync(path));
      writeFileSync(path, buildJobRequest({ ...request, policy_id: "local-development" }).bytes);
    });
    await refused(options({ run: run.runDir, publication: run.publication }), "policy_id_not_uc3");
  });

  it("ADM-09 refuses a kit image with no repository digest (kit_image_missing)", async () => {
    await refused(options(), "kit_image_missing", { docker: kitDocker(w.kit, []) });
  });

  it("ADM-09 refuses a root that is not a factory root (root_not_factory)", async () => {
    const rootRun = write(join(tempDir(), "root-run.json"), canonical({ ...factory.rootRun, kind: "kit_check" }));
    await refused(options({ rootRun }), "root_not_factory");
  });

  it("ADM-09 refuses a mutation the registry does not link (unregistered)", async () => {
    await refused(options({ registry: registry([]) }), "unregistered");
  });

  it("ADM-09 refuses a family that is held out (held_out_conflict)", async () => {
    await refused(options({ heldOut: heldOut({ family_ids: [FAMILY] }) }), "held_out_conflict");
  });

  it("names every failing code at once", async () => {
    const approval = write(join(tempDir(), "approval.json"), JSON.stringify({ decision: "approved", issue_sha256: "e".repeat(64), reviewed_at: "2026-10-14T10:00:00Z" }));
    const outcome = await buildRelease(options({ approval, registry: registry([]) }), deps({ docker: kitDocker(w.kit, []) }));
    expect(outcome).toMatchObject({ ok: false, codes: ["approval_issue_mismatch", "kit_image_missing", "unregistered"] });
  });
});

