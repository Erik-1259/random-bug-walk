// The typed data layer. It reads a results directory with the layout the publisher writes and
// refuses one that is malformed:
//   repository/runs/<root>/manifest.json   each published run's RunManifest
//   repository/runs/<root>/<entry path>    the run's published files below the large-file threshold
//   store/status/<root>.json               each run's PublicRunStatus
//   store/sha256/<hex>                     large published files (optional here; linked by public_uri)
// Inside a run it reads generated/symptom.json (an ObservedSymptom) and, for each job execution,
// results/<execution>/evidence.json and decision.json as @rbw/admission writes them.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Decision, Evidence } from "@rbw/admission";
import type { JsonValue, ObservedSymptom, PublicationStatus, PublicRunStatus, RootRunKind, RootRunOutcome, RootRunStatus, RunManifest, RunManifestEntry } from "@rbw/schema";
import { recordPackages, type RecordPackages } from "./records.ts";

export const MANIFEST_FILE = "manifest.json";
export const SYMPTOM_PATH = "generated/symptom.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOB_OUTPUT = /^results\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(evidence|decision)\.json$/;

export type ReleaseErrorCode =
  | "layout"
  | "manifest_invalid"
  | "run_directory_mismatch"
  | "file_missing"
  | "file_hash_mismatch"
  | "file_unlisted"
  | "status_invalid"
  | "status_mismatch"
  | "run_missing"
  | "symptom_invalid"
  | "admission_invalid"
  | "admission_mismatch";

export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;

  constructor(code: ReleaseErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReleaseError";
    this.code = code;
  }
}

export interface AdmissionRecords {
  executionId: string;
  evidence: Evidence;
  decision: Decision;
}

export interface Run {
  rootExecutionId: string;
  kind: RootRunKind;
  status: RootRunStatus;
  outcome: RootRunOutcome | null;
  publicationStatus: PublicationStatus | null;
  declaredStageCount: number;
  childExecutionCount: number;
  /** The published manifest; null for a run that only has a status object. */
  manifest: RunManifest | null;
  symptom: ObservedSymptom | null;
  /** The admission job's records; null when the run published none. */
  admission: AdmissionRecords | null;
}

export interface Results {
  /** Every run, published or status only, sorted by root execution ID. */
  runs: Run[];
  /** The run the case page shows (see chooseCase), if any published run holds an observed symptom. */
  caseRun: Run | null;
  /**
   * The validated release. Releases (ADM-09) are planned and have no record format yet, so no
   * published record can make a result eligible, and this is always null.
   */
  release: null;
}

export interface PublishedFile {
  bytes: Uint8Array;
  mediaType: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Every regular file below a run directory, as relative POSIX paths; anything else is refused. */
async function runFiles(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await entries(dir)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await runFiles(join(dir, entry.name), path)));
    else if (entry.isFile()) found.push(path);
    else throw new ReleaseError("layout", `${path} is not a regular file or directory`);
  }
  return found;
}

function isRepositoryFile(entry: RunManifestEntry): boolean {
  return (entry.outcome === "published" || entry.outcome === "truncated") && entry.public_uri === null;
}

class Reader {
  readonly dir: string;
  readonly packages: RecordPackages;

  constructor(dir: string, packages: RecordPackages) {
    this.dir = dir;
    this.packages = packages;
  }

  /** The publisher and the importer write canonical bytes; anything else was changed afterwards. */
  isCanonical(bytes: Uint8Array, value: unknown): boolean {
    return Buffer.from(bytes).equals(Buffer.from(this.packages.schema.encodeCanonical(value as JsonValue)));
  }

  runDir(root: string): string {
    return join(this.dir, "repository", "runs", root);
  }

  async readManifest(root: string): Promise<RunManifest> {
    const bytes = await readFile(join(this.runDir(root), MANIFEST_FILE)).catch((error: unknown) => {
      if (isMissing(error)) throw new ReleaseError("manifest_invalid", `runs/${root} has no ${MANIFEST_FILE}`);
      throw error;
    });
    let manifest: RunManifest;
    try {
      manifest = this.packages.schema.parseRecord("RunManifest", bytes);
    } catch (error) {
      if (error instanceof this.packages.schema.RecordError || error instanceof this.packages.schema.CanonicalError) {
        throw new ReleaseError("manifest_invalid", `runs/${root}/${MANIFEST_FILE}: ${error.message}`);
      }
      throw error;
    }
    if (!this.isCanonical(bytes, manifest)) throw new ReleaseError("manifest_invalid", `runs/${root}/${MANIFEST_FILE} is not canonical JSON`);
    if (manifest.root_execution_id !== root) throw new ReleaseError("run_directory_mismatch", `runs/${root} holds the manifest of ${manifest.root_execution_id}`);
    return manifest;
  }

  /** Checks that the run directory holds exactly the manifest's repository files, with their bytes. */
  async checkFiles(manifest: RunManifest): Promise<void> {
    const root = manifest.root_execution_id;
    const listed = new Map(manifest.entries.filter(isRepositoryFile).map((entry) => [entry.path, entry]));
    const present = new Set(await runFiles(this.runDir(root)));
    for (const path of present) {
      if (path !== MANIFEST_FILE && !listed.has(path)) throw new ReleaseError("file_unlisted", `runs/${root}/${path} is not a published repository file of the manifest`);
    }
    for (const entry of listed.values()) {
      if (!present.has(entry.path)) throw new ReleaseError("file_missing", `runs/${root}/${entry.path} is listed but absent`);
      const bytes = await readFile(join(this.runDir(root), entry.path));
      if (bytes.length !== entry.size_bytes || sha256(bytes) !== entry.sha256) throw new ReleaseError("file_hash_mismatch", `runs/${root}/${entry.path} differs from its manifest entry`);
    }
  }

  /** The bytes of a published entry: from the repository, or from the store for a large file. */
  async entryBytes(root: string, entry: RunManifestEntry): Promise<Uint8Array> {
    if (entry.public_uri === null) return readFile(join(this.runDir(root), entry.path));
    const hash = entry.sha256 ?? "";
    const bytes = await readFile(join(this.dir, "store", "sha256", hash)).catch((error: unknown) => {
      if (isMissing(error)) throw new ReleaseError("file_missing", `runs/${root}/${entry.path} is a large file whose store object is absent`);
      throw error;
    });
    if (sha256(bytes) !== hash) throw new ReleaseError("file_hash_mismatch", `the store object of runs/${root}/${entry.path} differs from its manifest entry`);
    return bytes;
  }

  async readSymptom(manifest: RunManifest): Promise<ObservedSymptom | null> {
    const entry = manifest.entries.find((item) => item.path === SYMPTOM_PATH && item.outcome === "published");
    if (entry === undefined) return null;
    const bytes = await this.entryBytes(manifest.root_execution_id, entry);
    try {
      return this.packages.schema.parseRecord("ObservedSymptom", bytes);
    } catch (error) {
      if (error instanceof this.packages.schema.RecordError || error instanceof this.packages.schema.CanonicalError) {
        throw new ReleaseError("symptom_invalid", `runs/${manifest.root_execution_id}/${SYMPTOM_PATH}: ${error.message}`);
      }
      throw error;
    }
  }

  parseCanonical(bytes: Uint8Array, location: string): unknown {
    try {
      const value = this.packages.schema.parseCanonical(bytes);
      if (!this.isCanonical(bytes, value)) throw new ReleaseError("admission_invalid", `${location} is not canonical JSON`);
      return value;
    } catch (error) {
      if (error instanceof this.packages.schema.CanonicalError) throw new ReleaseError("admission_invalid", `${location}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Reads every job's evidence and decision pair and returns the admission job's, if any. A job
   * whose pair was not both published (the importer writes the decision only after the evidence,
   * and a failed stage can leave either one not produced) has no records to show.
   */
  async readAdmission(manifest: RunManifest): Promise<AdmissionRecords | null> {
    const root = manifest.root_execution_id;
    const outputs = new Map<string, { evidence?: RunManifestEntry; decision?: RunManifestEntry }>();
    for (const entry of manifest.entries) {
      const match = JOB_OUTPUT.exec(entry.path);
      if (match === null) continue;
      const [, execution = "", name] = match;
      if (entry.outcome !== "published") continue;
      const pair = outputs.get(execution) ?? {};
      if (name === "evidence") pair.evidence = entry;
      else pair.decision = entry;
      outputs.set(execution, pair);
    }
    const found: AdmissionRecords[] = [];
    for (const [execution, pair] of [...outputs].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const location = `runs/${root}/results/${execution}`;
      if (pair.evidence === undefined || pair.decision === undefined) continue;
      const evidenceBytes = await this.entryBytes(root, pair.evidence);
      const evidence = this.parseCanonical(evidenceBytes, `${location}/evidence.json`);
      const decision = this.parseCanonical(await this.entryBytes(root, pair.decision), `${location}/decision.json`);
      const evidenceErrors = this.packages.admission.evidenceErrors(evidence);
      const decisionErrors = this.packages.admission.decisionErrors(decision);
      if (evidenceErrors.length > 0) throw new ReleaseError("admission_invalid", `${location}/evidence.json: ${evidenceErrors.join(", ")}`);
      if (decisionErrors.length > 0) throw new ReleaseError("admission_invalid", `${location}/decision.json: ${decisionErrors.join(", ")}`);
      const records = { executionId: execution, evidence: evidence as Evidence, decision: decision as Decision };
      if (records.decision.evidence_sha256 !== sha256(evidenceBytes)) throw new ReleaseError("admission_mismatch", `${location}/decision.json names other evidence`);
      if (records.evidence.request.root_execution_id !== root) throw new ReleaseError("admission_mismatch", `${location}/evidence.json belongs to another root`);
      if (records.evidence.request.execution_id !== execution || records.decision.execution_id !== execution) {
        throw new ReleaseError("admission_mismatch", `${location} holds the records of another execution`);
      }
      if (records.decision.kind !== records.evidence.request.kind) throw new ReleaseError("admission_mismatch", `${location}: the decision's kind differs from the evidence's`);
      if (records.decision.kind === "admission") found.push(records);
    }
    if (found.length > 1) throw new ReleaseError("admission_invalid", `runs/${root} holds more than one admission job's records`);
    return found[0] ?? null;
  }

  async readStatuses(): Promise<Map<string, PublicRunStatus>> {
    const statuses = new Map<string, PublicRunStatus>();
    for (const entry of await entries(join(this.dir, "store", "status"))) {
      const root = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : "";
      if (!entry.isFile() || !UUID.test(root)) throw new ReleaseError("status_invalid", `status/${entry.name} is not a status object`);
      const bytes = await readFile(join(this.dir, "store", "status", entry.name));
      let status: PublicRunStatus;
      try {
        status = this.packages.schema.parseRecord("PublicRunStatus", bytes);
      } catch (error) {
        if (error instanceof this.packages.schema.RecordError || error instanceof this.packages.schema.CanonicalError) {
          throw new ReleaseError("status_invalid", `status/${entry.name}: ${error.message}`);
        }
        throw error;
      }
      if (!this.isCanonical(bytes, status)) throw new ReleaseError("status_invalid", `status/${entry.name} is not canonical JSON`);
      if (status.root_execution_id !== root) throw new ReleaseError("status_invalid", `status/${entry.name} holds the status of ${status.root_execution_id}`);
      statuses.set(root, status);
    }
    return statuses;
  }
}

function checkStatus(manifest: RunManifest, status: PublicRunStatus | undefined): void {
  if (status === undefined) return;
  const agrees =
    status.kind === manifest.kind &&
    status.status === "terminal" &&
    status.outcome === manifest.outcome &&
    status.publication_status === "published" &&
    status.project_policy_sha256 === manifest.project_policy_sha256 &&
    status.declared_stage_count === manifest.declared_stages.length &&
    status.child_execution_count === manifest.executions.length - 1;
  if (!agrees) throw new ReleaseError("status_mismatch", `status/${manifest.root_execution_id}.json disagrees with the published manifest`);
}

/** How far a run with a symptom got: a demonstrated blind spot, then any admission decision, then a symptom alone. */
function caseRank(run: Run): number {
  if (run.admission?.decision.comparison?.classification === "blind_spot_demonstrated") return 2;
  return run.admission === null ? 0 : 1;
}

/**
 * The run the case page shows: of the runs that hold an observed symptom, the one that got
 * furthest, and of those the first by root execution ID. Every run stays in the catalog.
 */
function chooseCase(runs: Run[]): Run | null {
  let chosen: Run | null = null;
  for (const run of runs) {
    if (run.symptom !== null && (chosen === null || caseRank(run) > caseRank(chosen))) chosen = run;
  }
  return chosen;
}

/** Reads and checks a results directory. Throws ReleaseError for a malformed one. Pages use loadResults. */
export async function readResults(dir: string): Promise<Results> {
  if (!(await isDirectory(join(dir, "repository")))) throw new ReleaseError("layout", "the results directory has no repository/ directory");
  const reader = new Reader(dir, await recordPackages());
  const statuses = await reader.readStatuses();
  const runs: Run[] = [];
  for (const entry of await entries(join(dir, "repository", "runs"))) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) throw new ReleaseError("layout", `runs/${entry.name} is not a run directory`);
    const manifest = await reader.readManifest(entry.name);
    await reader.checkFiles(manifest);
    const status = statuses.get(entry.name);
    checkStatus(manifest, status);
    statuses.delete(entry.name);
    runs.push({
      rootExecutionId: manifest.root_execution_id,
      kind: manifest.kind,
      status: "terminal",
      outcome: manifest.outcome,
      publicationStatus: "published",
      declaredStageCount: manifest.declared_stages.length,
      childExecutionCount: manifest.executions.length - 1,
      manifest,
      symptom: await reader.readSymptom(manifest),
      admission: await reader.readAdmission(manifest),
    });
  }
  for (const [root, status] of statuses) {
    if (status.publication_status === "published") throw new ReleaseError("run_missing", `status/${root}.json says published, but the repository holds no runs/${root}`);
    runs.push({
      rootExecutionId: root,
      kind: status.kind,
      status: status.status,
      outcome: status.outcome,
      publicationStatus: status.publication_status,
      declaredStageCount: status.declared_stage_count,
      childExecutionCount: status.child_execution_count,
      manifest: null,
      symptom: null,
      admission: null,
    });
  }
  runs.sort((a, b) => (a.rootExecutionId < b.rootExecutionId ? -1 : 1));
  return { runs, caseRun: chooseCase(runs), release: null };
}

/** A checked results directory, with where each file readPublishedFile serves lives on disk. */
export interface ResultsIndex {
  results: Results;
  /** Keyed by `<root>/<path>`. */
  files: ReadonlyMap<string, { location: string; mediaType: string }>;
}

async function indexResults(dir: string): Promise<ResultsIndex> {
  const results = await readResults(dir);
  const files = new Map<string, { location: string; mediaType: string }>();
  for (const run of results.runs) {
    if (run.manifest === null) continue;
    const root = run.rootExecutionId;
    const location = join(dir, "repository", "runs", root);
    files.set(`${root}/${MANIFEST_FILE}`, { location: join(location, MANIFEST_FILE), mediaType: "application/json" });
    for (const entry of run.manifest.entries) {
      if (isRepositoryFile(entry) && entry.media_type != null) files.set(`${root}/${entry.path}`, { location: join(location, entry.path), mediaType: entry.media_type });
    }
  }
  return { results, files };
}

const indexes = new Map<string, Promise<ResultsIndex>>();

/**
 * The checked index of a results directory, read and checked once per directory per process.
 * Every page and file of a build shares it, so a build reads each published file a fixed number
 * of times however many routes it prerenders.
 */
export function loadResults(dir: string): Promise<ResultsIndex> {
  const key = resolve(dir);
  let index = indexes.get(key);
  if (index === undefined) {
    index = indexResults(key);
    indexes.set(key, index);
  }
  return index;
}

/**
 * A published repository file of a run, or its manifest, for download. Only paths the manifest
 * lists are served; anything else, including a large file kept in the store, gives null.
 */
export async function readPublishedFile(dir: string, root: string, path: string): Promise<PublishedFile | null> {
  const file = (await loadResults(dir)).files.get(`${root}/${path}`);
  if (file === undefined) return null;
  return { bytes: await readFile(file.location), mediaType: file.mediaType };
}

/** Every file readPublishedFile serves, for prerendering. */
export function publishedFiles(results: Results): { root: string; path: string }[] {
  return results.runs.flatMap((run) =>
    run.manifest === null
      ? []
      : [{ root: run.rootExecutionId, path: MANIFEST_FILE }, ...run.manifest.entries.filter(isRepositoryFile).map((entry) => ({ root: run.rootExecutionId, path: entry.path }))],
  );
}
