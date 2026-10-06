// Results directories for tests: copies of the committed fixtures, and synthetic case runs whose
// admission evidence and decision come from the real importer over the admission package's
// synthetic record sets.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, importRecordSet, type Evidence } from "@rbw/admission";
import { canonicalDigest, encodeCanonical, parseRecord, sha256Hex, type RunManifest, type RunManifestEntry } from "@rbw/schema";
import { cleanupRecordSets, recordSet, type RecordSetDraft } from "../../../../packages/admission/test/support/record-set.ts";

export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
export const DEVELOPMENT = join(FIXTURES, "development-2026-10-06");
export const NO_RELEASE = join(FIXTURES, "no-release");
export const DEVELOPMENT_ROOT = "00000000-0000-4000-8000-000000001006";
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

/**
 * A results directory with one published case run: the development fixture's symptom and an
 * admission job's evidence.json and decision.json, imported from a synthetic record set.
 */
export function syntheticCase(mutate: (draft: RecordSetDraft) => void = () => undefined): SyntheticCase {
  const evidence = importRecordSet(recordSet(mutate));
  const decision = decide(evidence);
  const root = evidence.request.root_execution_id;
  const execution = evidence.request.execution_id;
  const dir = tempDir();
  mkdirSync(join(dir, "repository", "runs"), { recursive: true });
  const symptom = readFileSync(join(runDir(DEVELOPMENT, DEVELOPMENT_ROOT), "generated", "symptom.json"));
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
