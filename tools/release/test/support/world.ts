// The release tests' synthetic world: the local runner's simulated kit image behind a fake Docker
// that also lists a VCR repository digest, the runner's synthetic manifest, terms, probes and
// alternative fix, a public_demo policy, a registry that links the synthetic mutation, and job
// runs laid out as the controller writes them. Each copy runs the real driver code through the
// simulated kit, so the record sets, evidence and decisions are the ones the real code writes.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ControllerSummary, CopyRecord } from "@rbw/controller";
import { buildJob, containerName, importJob, mergeRecordSet, runCopyCommand, runTag, summaryBytes, trialSummaries, writeJobDir } from "@rbw/local-runner";
import type { BuiltJob, CopyResult, JobContext, JobLabel, RunIds } from "@rbw/local-runner";
import { buildJobRequest, buildPolicy, encodeCanonical, sha256Hex } from "@rbw/schema";
import type { FamilyRegistry, HeldOutIdentityList, RootRun } from "@rbw/schema";
import { FakeClock, FakeDocker, ok } from "../../../local-runner/test/support/fakes.ts";
import { KitImage } from "../../../local-runner/test/support/kit-image.ts";
import { tempDir as runnerTempDir, writeAlternativeDir, writeManifest, writeProbeDir, writeTerms } from "../../../local-runner/test/support/synthetic.ts";
import { jobContext } from "../../src/judge-job.ts";
import type { BuildSources } from "../../src/judge-job.ts";

export const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
export const RELEASE_ID = "00000000-0000-4000-8000-000000000601";
export const VCR_DIGEST = `sha256:${"cd".repeat(32)}`;
export const KIT_IMAGE = `vcr.example.invalid/synthetic-team/synthetic-project/rbw-umami-kit@${VCR_DIGEST}`;
export const CONTROLLER_IMAGE = `vcr.example.invalid/synthetic-team/synthetic-project/rbw-controller@sha256:${"ce".repeat(32)}`;
export const REPOSITORY_URL = "https://example.invalid/synthetic-owner/synthetic-results";
export const BASE_URI = "https://example.invalid/synthetic-store/";
export const UC3 = "umami-uc3-v1";
// Assembled at runtime so that no source line holds the synthetic pattern as a literal.
export const FORBIDDEN_TERM = ["synthetic", "release", "canary"].join("-");

const created: string[] = [];

/** Removes every directory tempDir made; the vitest setup file calls it after each test file. */
export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix = "rbw-release-test-"): string {
  const dir = runnerTempDir(prefix);
  created.push(dir);
  return dir;
}

export function write(path: string, bytes: string | Uint8Array): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

export function canonical(value: unknown): Uint8Array {
  return encodeCanonical(value);
}

/** Sequential synthetic UUIDs with a fixed group, so every run of a test makes the same IDs. */
export function uuids(group: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-${group}-${counter.toString(16).padStart(12, "0")}`;
  };
}

export interface World {
  dir: string;
  kit: KitImage;
  docker: FakeDocker;
  clock: FakeClock;
  sources: BuildSources;
  policy: { file: string; bytes: Uint8Array; sha256: string };
  patterns: string;
  gitleaks: string;
}

/** The simulated kit's Docker, whose local image also lists the VCR digest (none when `repoDigests` is empty). */
export function kitDocker(kit: KitImage, repoDigests: readonly string[] = [KIT_IMAGE]): FakeDocker {
  return new FakeDocker((args, options) => (args.includes("{{json .RepoDigests}}") ? ok(JSON.stringify(repoDigests)) : kit.docker.run(args, options)));
}

/** A gitleaks stand-in that reports the version the scanner pins and no findings. */
export function writeGitleaksStub(dir: string): string {
  const scanner = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "publication", "src", "cli.ts");
  const version = execFileSync(process.execPath, [scanner, "gitleaks-version"], { encoding: "utf8" }).trim();
  const script = write(
    join(dir, "gitleaks-stub.mjs"),
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "version") { process.stdout.write(${JSON.stringify(version)} + "\\n"); process.exit(0); }
writeFileSync(args[args.indexOf("--report-path") + 1], "[]");
process.exit(0);
`,
  );
  return `${process.execPath} ${script}`;
}

export function world(): World {
  const dir = tempDir();
  const kit = new KitImage();
  const built = buildPolicy({ projectId: PROJECT_ID, outputRepository: REPOSITORY_URL, publicArtifactBaseUri: BASE_URI, policyVersion: 1 });
  const originalSuite = write(join(dir, "inputs", "original-suite.json"), kit.suite.encoded.bytes);
  return {
    dir,
    kit,
    docker: kitDocker(kit),
    clock: new FakeClock(),
    sources: {
      image: "rbw-umami-kit:synthetic",
      manifest: writeManifest(dir),
      terms: writeTerms(dir),
      auditPolicy: write(join(dir, "inputs", "audit-policy.json"), "{}"),
      kitStage: kit.kitStage,
      originalSuite,
      probesDir: writeProbeDir(),
      alternativeDir: writeAlternativeDir(),
    },
    policy: { file: write(join(dir, "private", "policy.json"), built.bytes), bytes: built.bytes, sha256: built.sha256 },
    patterns: write(join(dir, "private", "patterns.txt"), `# synthetic pattern list\n${FORBIDDEN_TERM}\n`),
    gitleaks: writeGitleaksStub(dir),
  };
}

/** IDs of one root: the run's root, batch and executions share one UUID group. */
export function rootIds(group: string): RunIds {
  const next = uuids(group);
  const root = next();
  return {
    run_tag: runTag(root),
    project_id: PROJECT_ID,
    batch_id: next(),
    root_execution_id: root,
    executions: { "kit-check": next(), observe: next(), admission: next(), "alternative-fix": next(), "candidate-text": next() },
    release_id: RELEASE_ID,
  };
}

export interface JobRun {
  built: BuiltJob;
  jobDir: string;
  summary: ControllerSummary;
}

/**
 * Runs one job's copies through the simulated kit and lays the job out as the controller does:
 * jobs/<name>/job, records/, evidence.json, decision.json and summary.json.
 */
export async function runJobCopies(w: World, run: string, name: string, label: JobLabel, ctx: JobContext): Promise<JobRun> {
  const first = buildJob(label, ctx);
  const request = buildJobRequest({ ...first.request, reservation_microusd: 147_682 * first.expected.trials.length });
  const built: BuiltJob = { ...first, request: request.request, requestBytes: request.bytes, requestSha256: request.sha256 };
  const base = join(run, "jobs", name);
  writeJobDir(join(base, "job"), built);
  const tag = runTag(ctx.ids.root_execution_id);
  const records: CopyRecord[] = [];
  const results: CopyResult[] = [];
  for (const trial of built.expected.trials) {
    const work = join(base, "copies", trial.trial_id);
    const outcome = await runCopyCommand(
      { job: join(base, "job"), trial: trial.trial_id, root: run, image: w.sources.image, manifest: w.sources.manifest, terms: w.sources.terms, policy: w.sources.auditPolicy, probesDir: w.sources.probesDir, alternativeDir: w.sources.alternativeDir, work, backend: "docker" },
      { docker: w.docker, clock: w.clock },
    );
    const copy = outcome.copy;
    if (copy === null) throw new Error(`synthetic: copy ${trial.trial_id} was refused (${outcome.refusal?.reason ?? "-"})`);
    results.push({ ...copy, job: name, work_dir: work, collected_dir: null, records_dir: outcome.recordsDir, phases: Object.entries(copy.phases_ms).map(([phase, ms]) => ({ name: phase, duration_ms: ms })) });
    records.push({
      trial_id: trial.trial_id,
      code_state: trial.code_state,
      operation_id: sha256Hex(Buffer.from(`synthetic-operation-${name}-${trial.trial_id}`)),
      call_name: `sandbox.copy:${name}:${trial.trial_id}`,
      status: copy.status,
      reason: copy.reason,
      launch: "confirmed",
      child_resource_id: containerName(tag, label, trial.trial_id),
      stop_confirmed: true,
      phases_ms: copy.phases_ms,
      live_ms: 1000,
      reserved_microusd: 147_682,
      settled_microusd: 1_000,
      ledger_state: "reconciled",
      ledger_detail: null,
      refusal: null,
      copy,
    });
  }
  mergeRecordSet(built, results, join(base, "records"));
  const imported = importJob(join(base, "records"), base);
  const summary: ControllerSummary = {
    schema_version: 1,
    label: "development_evidence",
    note: "Synthetic controller summary for the release tests. The planted bug is synthetic.",
    admission_claim: false,
    published: false,
    status: "complete",
    reason: null,
    detail: null,
    job: {
      name,
      kind: built.kind,
      execution_id: built.request.execution_id,
      root_execution_id: built.request.root_execution_id,
      task_revision: built.request.task_revision,
      request_sha256: built.requestSha256,
      expected_trials_sha256: built.expectedSha256,
      deadline_at: built.request.deadline_at,
      baseline: null,
      trials: built.expected.trials.map((trial) => trial.trial_id),
    },
    controller: {
      backend: "docker",
      sandbox_image: null,
      ledger: "in_memory",
      pool_key: "development",
      allocation_key: null,
      slot_key: "development",
      controller_ms: 9_000_000,
      ceiling_microusd: 8_000_000,
      max_copies: 13,
      copy_reserved_microusd: 147_682,
      started_at: "2026-10-06T09:00:00Z",
      ended_at: "2026-10-06T09:30:00Z",
    },
    image: { reference: w.sources.image, digest: built.request.image_digest, kit_sha256: ctx.kitSha256 },
    original_suite: { sha256: ctx.originalSuite.sha256, test_count: ctx.originalSuite.testIds.length, source: "file" },
    copies: records,
    import: { refusal: imported.refusal, evidence_sha256: imported.evidence_sha256, decision_sha256: imported.decision_sha256, trials: trialSummaries(imported.evidence) },
    spend: { reserved_microusd: 147_682 * records.length, settled_microusd: 1_000 * records.length, open_microusd: 0 },
    slot: { key: "development", acquired: true, released: true, blockers: null },
  };
  writeFileSync(join(base, "summary.json"), summaryBytes(summary));
  rmSync(join(base, "copies"), { recursive: true, force: true });
  return { built, jobDir: base, summary };
}

export interface FactoryRun {
  run: string;
  ids: RunIds;
  ctx: JobContext;
  admission: JobRun;
  rootRun: RootRun;
  rootRunFile: string;
}

/** A completed factory root whose admission job ran under the public_demo policy and umami-uc3-v1. */
export async function factoryRun(w: World, group = "8000"): Promise<FactoryRun> {
  const ids = rootIds(group);
  const run = join(tempDir("rbw-release-run-"), "run");
  const { ctx } = await jobContext(w.docker, w.sources, { ids, deadlineAt: "2026-10-06T12:00:00Z", projectPolicy: { sha256: w.policy.sha256, policy_id: UC3 }, exportDir: join(run, "jobs", "admission", "source") });
  const admission = await runJobCopies(w, run, "admission", "admission", ctx);
  rmSync(join(run, "jobs", "admission", "source"), { recursive: true, force: true });
  const rootRun: RootRun = {
    schema_version: 1,
    project_id: PROJECT_ID,
    root_execution_id: ids.root_execution_id,
    project_policy_sha256: w.policy.sha256,
    kind: "factory",
    declared_stages: ["admission"],
    child_execution_ids: [ids.executions.admission],
    status: "terminal",
    outcome: "completed",
  };
  const rootRunFile = write(join(dirname(run), "root-run.json"), canonical(rootRun));
  return { run, ids, ctx, admission, rootRun, rootRunFile };
}

/** Synthetic generated files a factory stage passes on: the symptom, the card and the novelty summary. */
export function generatedFiles(dir: string, novelty: "clear" | "blocked" | "incomplete" = "clear"): { symptom: string; card: string; novelty: string } {
  return {
    symptom: write(join(dir, "generated", "symptom.json"), readFileSync(join(dirname(new URL(import.meta.url).pathname), "..", "..", "fixtures", "sources", "symptom.json"))),
    card: write(join(dir, "generated", "card.json"), readFileSync(join(dirname(new URL(import.meta.url).pathname), "..", "..", "fixtures", "sources", "card.json"))),
    novelty: write(
      join(dir, "generated", "novelty.json"),
      canonical({ status: novelty, matching_urls: novelty === "blocked" ? ["https://forum.example.invalid/synthetic-thread"] : [], incomplete_calls: novelty === "incomplete" ? ["phrase-2"] : [] }),
    ),
  };
}

export type { FamilyRegistry, HeldOutIdentityList };
