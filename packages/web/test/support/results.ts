// Results directories for tests: copies of the committed fixtures, and synthetic case runs whose
// admission evidence and decision come from the real importer over the admission package's
// synthetic record sets.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, importRecordSet, type Evidence } from "@rbw/admission";
import { canonicalDigest, encodeCanonical, parseRecord, sha256Hex, type RunManifest, type RunManifestEntry } from "@rbw/schema";
import { cleanupRecordSets, RACE_FAMILY, recordSet, type RecordSetDraft } from "../../../../packages/admission/test/support/record-set.ts";

export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
export const DEVELOPMENT = join(FIXTURES, "development-2026-10-06");
export const NO_RELEASE = join(FIXTURES, "no-release");
export const DEVELOPMENT_ROOT = "00000000-0000-4000-8000-000000001006";
/** The release package's synthetic results directory, read in place: one released factory run. */
export const RELEASE = fileURLToPath(new URL("../../../../tools/release/fixtures/release/", import.meta.url));
export const RELEASE_ID = "00000000-0000-4000-8000-000000000601";
export const RELEASE_ROOT = "00000000-0000-4000-8100-000000000001";
export const SYMPTOM_SOURCE = fileURLToPath(new URL("../../../../tools/local-runner/candidates/umami-tz-arg-001/writer-input.json", import.meta.url));

const created: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rbw-web-"));
  created.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanupRecordSets();
}

export function copyFixture(fixture: string): string {
  const dir = tempDir();
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

export function writeFile(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export function releaseDir(results: string, releaseId: string = RELEASE_ID): string {
  return join(results, "repository", "releases", releaseId);
}

/** A copy of the release fixture's published directories: inputs/ and private-store/ are not published. */
export function copyRelease(): string {
  const dir = tempDir();
  for (const part of ["repository", "store"]) cpSync(join(RELEASE, part), join(dir, part), { recursive: true });
  return dir;
}

export function runDir(results: string, root: string): string {
  return join(results, "repository", "runs", root);
}

export function readManifest(results: string, root: string): RunManifest {
  return parseRecord("RunManifest", readFileSync(join(runDir(results, root), "manifest.json")));
}

/** Writes a manifest as canonical bytes after checking it against the schema, as the publisher does. */
export function writeManifest(results: string, manifest: RunManifest): void {
  const sorted = { ...manifest, entries: [...manifest.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  const bytes = encodeCanonical(sorted);
  parseRecord("RunManifest", bytes);
  writeFile(join(runDir(results, manifest.root_execution_id), "manifest.json"), bytes);
}

export function publishedEntry(path: string, executionId: string, bytes: Uint8Array, mediaType = "application/json"): RunManifestEntry {
  return {
    path,
    execution_id: executionId,
    trial_id: null,
    media_type: mediaType,
    outcome: "published",
    sha256: sha256Hex(bytes),
    size_bytes: bytes.length,
    public_uri: null,
    reason: null,
    redactions: [],
  };
}

/** Adds a file to a run: its bytes in the repository and its entry in the manifest. */
export function addRunFile(results: string, root: string, path: string, executionId: string, bytes: Uint8Array): void {
  writeFile(join(runDir(results, root), path), bytes);
  const manifest = readManifest(results, root);
  writeManifest(results, { ...manifest, entries: [...manifest.entries.filter((entry) => entry.path !== path), publishedEntry(path, executionId, bytes)] });
}

export interface SyntheticCase {
  dir: string;
  root: string;
  execution: string;
  evidence: Evidence;
}

/** @rbw/schema's synthetic RaceSymptom fixture: two concurrent uses of one code, both accepted. */
export const RACE_SYMPTOM_SOURCE = fileURLToPath(new URL("../../../../packages/schema/fixtures/records/race-symptom-valid.json", import.meta.url));

export interface SyntheticCaseOptions {
  /** The run's generated/symptom.json bytes; the development fixture's time-zone symptom unless set. */
  symptom?: Uint8Array;
  /**
   * Imports the admission package's race-family record set instead of the time-zone one: the 11-copy
   * admission profile, with no partial-fix or stub-fix copy, for a family that records ADM-06 as not applicable.
   */
  raceFamily?: boolean;
}

/** The race symptom fixture in canonical bytes, as a release stages it. */
export function raceSymptomBytes(): Uint8Array {
  return canonicalDigest(JSON.parse(readFileSync(RACE_SYMPTOM_SOURCE, "utf8")) as never).bytes;
}

/**
 * A results directory with one published case run: the development fixture's symptom and an
 * admission job's evidence.json and decision.json, imported from a synthetic record set.
 */
export function syntheticCase(mutate: (draft: RecordSetDraft) => void = () => undefined, options: SyntheticCaseOptions = {}): SyntheticCase {
  const evidence: Evidence = importRecordSet(recordSet(mutate, undefined, "admission", options.raceFamily === true ? RACE_FAMILY : {}));
  const decision = decide(evidence);
  const root = evidence.request.root_execution_id;
  const execution = evidence.request.execution_id;
  const dir = tempDir();
  mkdirSync(join(dir, "repository", "runs"), { recursive: true });
  const symptom = options.symptom ?? readFileSync(join(runDir(DEVELOPMENT, DEVELOPMENT_ROOT), "generated", "symptom.json"));
  const evidenceBytes = canonicalDigest(evidence).bytes;
  const decisionBytes = canonicalDigest(decision).bytes;
  const files: [string, string, Uint8Array][] = [
    ["generated/symptom.json", root, symptom],
    [`results/${execution}/decision.json`, execution, decisionBytes],
    [`results/${execution}/evidence.json`, execution, evidenceBytes],
  ];
  for (const [path, , bytes] of files) writeFile(join(runDir(dir, root), path), bytes);
  writeManifest(dir, {
    schema_version: 1,
    project_id: "00000000-0000-4000-8000-000000000001",
    project_policy_sha256: evidence.request.project_policy_sha256,
    root_execution_id: root,
    kind: "factory",
    declared_stages: ["admission"],
    outcome: "completed",
    executions: [
      { execution_id: root, parent_execution_id: null },
      { execution_id: execution, parent_execution_id: root },
    ],
    entries: files.map(([path, owner, bytes]) => publishedEntry(path, owner, bytes)),
  });
  return { dir, root, execution, evidence };
}

export interface JudgeReplayOptions {
  /** The replay root's recorded outcome; null for one that has not finished. */
  outcome: "completed" | "failed" | "incomplete" | "cancelled" | null;
  /** Whether the run's files are published, or it has only a status object. */
  published: boolean;
  /** The root's kind: a judge replay unless set. */
  kind?: "judge_replay" | "paired_comparison";
}

/**
 * Adds a judge replay root (RootRun kind judge_replay) to a results directory, shaped like the ones
 * `tools/release publish-replays` publishes: one judge_verify child, a report.md and a status object.
 * With kind paired_comparison it adds a paired comparison root of the same shape instead.
 * Its policy hash is the first published run's, so it passes the status check.
 */
export function addJudgeReplay(results: string, root: string, { outcome, published, kind = "judge_replay" }: JudgeReplayOptions): void {
  const [first] = readdirSync(join(results, "repository", "runs")).sort();
  if (first === undefined) throw new Error("synthetic: the results directory holds no published run to take a policy from");
  const policy = readManifest(results, first).project_policy_sha256;
  const child = `${root.slice(0, -4)}f001`;
  if (published) {
    if (outcome === null) throw new Error("synthetic: a published run has an outcome");
    const report = new TextEncoder().encode(`# Run ${root}\n\nKind: ${kind}. Outcome: ${outcome}. The planted bug is synthetic.\n`);
    writeFile(join(runDir(results, root), "report.md"), report);
    writeManifest(results, {
      schema_version: 1,
      project_id: "00000000-0000-4000-8000-000000000001",
      project_policy_sha256: policy,
      root_execution_id: root,
      kind,
      declared_stages: [kind === "judge_replay" ? "judge_verify" : "solver_sessions"],
      outcome,
      executions: [
        { execution_id: root, parent_execution_id: null },
        { execution_id: child, parent_execution_id: root },
      ],
      entries: [publishedEntry("report.md", root, report, "text/markdown")],
    });
  }
  const status = encodeCanonical({
    schema_version: 1,
    root_execution_id: root,
    kind,
    status: outcome === null ? "running" : "terminal",
    outcome,
    publication_status: published ? "published" : null,
    project_policy_sha256: policy,
    declared_stage_count: 1,
    child_execution_count: 1,
  });
  parseRecord("PublicRunStatus", status);
  writeFile(join(results, "store", "status", `${root}.json`), status);
}

/** The release fixture with three judge replays: two published and completed, one still running with only a status object. */
export const REPLAY_ROOTS = ["00000000-0000-4000-8200-000000000001", "00000000-0000-4000-8200-000000000002", "00000000-0000-4000-8200-000000000003"] as const;

export function releaseWithReplays(): string {
  const dir = copyRelease();
  addJudgeReplay(dir, REPLAY_ROOTS[0], { outcome: "completed", published: true });
  addJudgeReplay(dir, REPLAY_ROOTS[1], { outcome: "completed", published: true });
  addJudgeReplay(dir, REPLAY_ROOTS[2], { outcome: null, published: false });
  return dir;
}

/** Two paired comparison roots: one published and completed, one still running with only a status object. */
export const PAIRED_ROOTS = ["00000000-0000-4000-8300-000000000001", "00000000-0000-4000-8300-000000000002"] as const;

/** The release fixture with the three judge replays and the two paired comparison roots. */
export function releaseWithPairedComparisons(): string {
  const dir = releaseWithReplays();
  addJudgeReplay(dir, PAIRED_ROOTS[0], { outcome: "completed", published: true, kind: "paired_comparison" });
  addJudgeReplay(dir, PAIRED_ROOTS[1], { outcome: null, published: false, kind: "paired_comparison" });
  return dir;
}
