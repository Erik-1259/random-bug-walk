import { createHash } from "node:crypto";
import {
  assertRecord,
  canonicalDigest,
  sha256Hex,
  type Omission,
  type OmissionReason,
  type ProjectPolicy,
  type PublishedArtifact,
  type Redaction,
  type RedactionCategory,
  type RootRun,
  type RunManifest,
  type RunManifestEntry,
} from "@rbw/schema";
import { sanitize, type RedactionCounts, type RedactionValue } from "./sanitize.ts";
import { REPORT_FILE, type StagedRun } from "./staging.ts";

export const MANIFEST_FILE = "manifest.json";

const MEDIA_TYPES: Record<string, string> = {
  csv: "text/csv",
  diff: "text/x-diff",
  gz: "application/gzip",
  html: "text/html",
  json: "application/json",
  jsonl: "application/x-ndjson",
  log: "text/plain",
  md: "text/markdown",
  patch: "text/x-diff",
  png: "image/png",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

export function mediaTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] : undefined) ?? "application/octet-stream";
}

/** A frozen, sanitized file of the candidate. */
export interface FrozenFile {
  path: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  /** Stored in the public store instead of the repository. */
  large: boolean;
}

export interface Candidate {
  publicationId: string;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  files: FrozenFile[];
  artifacts: PublishedArtifact[];
  omissions: Omission[];
}

export interface FrozenCandidate {
  candidate: Candidate;
  /** Sanitized bytes keyed by SHA-256. */
  blobs: Map<string, Uint8Array>;
}

/** UUID derived from the root ID and the manifest hash (version 8 layout, SHA-256 based). */
export function publicationIdFor(rootExecutionId: string, manifestSha256: string): string {
  const digest = createHash("sha256").update(`rbw-publication-id-v1\n${rootExecutionId}\n${manifestSha256}`).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function mergeRedactions(declared: readonly { category: RedactionCategory; count: number }[], counts: RedactionCounts): Redaction[] {
  const totals = new Map<RedactionCategory, number>();
  for (const item of declared) totals.set(item.category, (totals.get(item.category) ?? 0) + item.count);
  for (const [category, count] of Object.entries(counts) as [RedactionCategory, number][]) totals.set(category, (totals.get(category) ?? 0) + count);
  return [...totals]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([category, count]) => ({ category, count }));
}

export interface FreezeInput {
  policy: ProjectPolicy;
  policySha256: string;
  root: RootRun;
  staged: StagedRun;
  values: readonly RedactionValue[];
  baseUri: string;
  largeObjectThreshold: number;
}

/**
 * Sanitizes the staged bytes and builds the RunManifest. Uses no clock and no randomness, so
 * the same staged bytes and redaction values always give the same candidate.
 */
export function freeze(input: FreezeInput): FrozenCandidate {
  const { root, staged } = input;
  const declarations = new Map(staged.omissions.entries.flatMap((entry) => ("path" in entry ? [[entry.path, entry] as const] : [])));
  const blobs = new Map<string, Uint8Array>();
  const files: FrozenFile[] = [];
  const entries: RunManifestEntry[] = [];

  for (const file of staged.files) {
    const { bytes, counts } = sanitize(file.bytes, input.values);
    const sha256 = sha256Hex(bytes);
    blobs.set(sha256, bytes);
    const large = bytes.length > input.largeObjectThreshold;
    const mediaType = mediaTypeFor(file.path);
    files.push({ path: file.path, sha256, size_bytes: bytes.length, media_type: mediaType, large });
    const declaration = declarations.get(file.path);
    const truncated = declaration?.outcome === "truncated";
    entries.push({
      path: file.path,
      execution_id: file.executionId,
      trial_id: file.trialId,
      media_type: mediaType,
      outcome: truncated ? "truncated" : "published",
      sha256,
      size_bytes: bytes.length,
      public_uri: large ? `${input.baseUri}sha256/${sha256}` : null,
      reason: truncated ? declaration.reason : null,
      redactions: mergeRedactions(staged.omissions.redactions.filter((item) => item.path === file.path), counts),
    });
  }

  const absent = (path: string, executionId: string, trialId: string | null, outcome: "not_produced" | "withheld_private", reason: OmissionReason): RunManifestEntry => ({
    path,
    execution_id: executionId,
    trial_id: trialId,
    media_type: null,
    outcome,
    sha256: null,
    size_bytes: null,
    public_uri: null,
    reason,
    redactions: [],
  });
  let withheld = 0;
  for (const entry of staged.omissions.entries) {
    if (entry.outcome === "not_produced") entries.push(absent(entry.path, entry.execution_id, entry.trial_id, "not_produced", entry.reason));
    if (entry.outcome === "withheld_private") {
      withheld += 1;
      entries.push(absent(`withheld/${String(withheld)}`, entry.execution_id, entry.trial_id, "withheld_private", entry.reason));
    }
  }
  if (!entries.some((entry) => entry.path === REPORT_FILE)) {
    entries.push(absent(REPORT_FILE, root.root_execution_id, null, "not_produced", "report_missing"));
  }
  entries.sort(byPath);

  const manifest = assertRecord(
    "RunManifest",
    {
      schema_version: 1,
      project_id: input.policy.project_id,
      project_policy_sha256: input.policySha256,
      root_execution_id: root.root_execution_id,
      kind: root.kind,
      declared_stages: root.declared_stages,
      outcome: root.outcome,
      executions: [
        { execution_id: root.root_execution_id, parent_execution_id: null },
        ...root.child_execution_ids.map((id) => ({ execution_id: id, parent_execution_id: root.root_execution_id })),
      ],
      entries,
    },
    { root, policy: input.policy },
  );
  const { bytes: manifestBytes, sha256: manifestSha256 } = canonicalDigest(manifest);
  files.sort(byPath);
  return { candidate: describeCandidate(root.root_execution_id, manifest, manifestBytes, manifestSha256, files), blobs };
}

/** True when the frozen file list matches the manifest's published and truncated entries exactly. */
export function filesMatchManifest(manifest: RunManifest, files: readonly FrozenFile[]): boolean {
  const withBytes = manifest.entries.filter((entry) => entry.outcome === "published" || entry.outcome === "truncated");
  if (withBytes.length !== files.length) return false;
  return withBytes.every((entry, index) => {
    const file = files[index];
    return (
      file?.path === entry.path &&
      file.sha256 === entry.sha256 &&
      file.size_bytes === entry.size_bytes &&
      file.media_type === entry.media_type &&
      file.large === (entry.public_uri !== null)
    );
  });
}

/** Derives the publication ID, artifacts and omissions of a candidate from its manifest. */
export function describeCandidate(rootExecutionId: string, manifest: RunManifest, manifestBytes: Uint8Array, manifestSha256: string, files: FrozenFile[]): Candidate {
  const byFile = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const artifacts: PublishedArtifact[] = [
    ...files.map((file) => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes, public_uri: byFile.get(file.path)?.public_uri ?? null })),
    { path: MANIFEST_FILE, sha256: manifestSha256, size_bytes: manifestBytes.length, public_uri: null },
  ].sort(byPath);
  const omissions: Omission[] = manifest.entries.flatMap((entry) =>
    entry.outcome === "published" || entry.reason === null ? [] : [{ category: entry.outcome, reason: entry.reason }],
  );
  return { publicationId: publicationIdFor(rootExecutionId, manifestSha256), manifestBytes, manifestSha256, files, artifacts, omissions };
}
