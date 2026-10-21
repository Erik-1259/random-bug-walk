// The factory's identities: the only implementation of the defect, case and candidate IDs, the two
// UUIDv5 namespaces, the request and validation roots and the request's budget key. The web routes,
// the hosted worker and the package tools import these; none derives its own.
import { createHash } from "node:crypto";
import { canonicalDigest } from "@rbw/schema";
import type { BaselineIdentity, CatalogEntry, CopyState, HostId } from "@rbw/factory-contract";

/** UUIDv5 of the RFC 4122 URL namespace and `urn:rbw:factory:request:v1`. */
export const FACTORY_REQUEST_NAMESPACE = "6c1e4166-2010-5951-8f97-6da94e644aea";
/** UUIDv5 of the RFC 4122 URL namespace and `urn:rbw:factory:validation:v1`. */
export const FACTORY_VALIDATION_NAMESPACE = "aebfd055-c278-51d1-8228-f09eddcc5632";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** RFC 4122 version 5 (SHA-1) UUID of a name in a namespace, lowercase. */
export function uuidV5(namespace: string, name: string): string {
  if (!isUuid(namespace)) throw new Error("the namespace is not a lowercase UUID");
  const hash = createHash("sha1").update(Buffer.from(namespace.replaceAll("-", ""), "hex")).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Every ledger operation of a request uses this root. */
export function requestRoot(requestId: string): string {
  if (!isUuid(requestId)) throw new Error("the request ID is not a lowercase UUID");
  return uuidV5(FACTORY_REQUEST_NAMESPACE, requestId);
}

/**
 * The spend ledger's budget key of a request: the SHA-256 of the canonical JSON of
 * `{ schema_version: 1, kind: "factory.request_budget", request_id }`, as 64 lowercase hex digits.
 */
export function budgetKey(requestId: string): string {
  if (!isUuid(requestId)) throw new Error("the request ID is not a lowercase UUID");
  return canonicalDigest({ schema_version: 1, kind: "factory.request_budget", request_id: requestId }).sha256;
}

/** A validation run holds the factory slot and runs its operations under this root. */
export function validationRoot(validationId: string): string {
  if (!isUuid(validationId)) throw new Error("the validation ID is not a lowercase UUID");
  return uuidV5(FACTORY_VALIDATION_NAMESPACE, validationId);
}

/** The ledger project ID of a factory project name. */
export function factoryProjectId(project: string): string {
  return uuidV5(FACTORY_REQUEST_NAMESPACE, project);
}

/**
 * A copy's execution ID: UUIDv5 of `<root>:<subject>:<state>-<n>` under the root's own namespace, where
 * the subject is the candidate ID (request) or the case ID (validation) and `n` counts from 1.
 */
export function copyExecutionId(input: { kind: "request" | "validation"; root: string; subject_id: string; state: CopyState; n: number }): string {
  if (!isUuid(input.root)) throw new Error("the root is not a lowercase UUID");
  if (!Number.isSafeInteger(input.n) || input.n < 1) throw new Error("the copy number must be a positive integer");
  const namespace = input.kind === "request" ? FACTORY_REQUEST_NAMESPACE : FACTORY_VALIDATION_NAMESPACE;
  return uuidV5(namespace, `${input.root}:${input.subject_id}:${input.state}-${String(input.n)}`);
}

/** The planted change: its targets (path and before and after file hashes) sorted by path. */
export function mutationSha256(entry: Pick<CatalogEntry, "plant">): string {
  const targets = [...entry.plant.targets]
    .map((target) => ({ path: target.path, before_sha256: target.before_sha256, after_sha256: target.after_sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return canonicalDigest(targets).sha256;
}

/** The planted change on a host baseline. No run ID, package byte or wording enters it. */
export function defectId(baseline: BaselineIdentity, entry: Pick<CatalogEntry, "host_id" | "plant">): string {
  if (baseline.host_id !== entry.host_id) throw new Error("the entry's host differs from the baseline's");
  return canonicalDigest({
    schema_version: 1,
    host_id: entry.host_id,
    baseline: { baseline_id: baseline.baseline_id, app_commit: baseline.app_commit, original_suite_sha256: baseline.original_suite.sha256 },
    mutation_sha256: mutationSha256(entry),
  }).sha256;
}

/** The runtime environment of a kit image. */
export function environmentSha256(hostId: HostId, kitImageDigest: string): string {
  return canonicalDigest({ host_id: hostId, kit_image_digest: kitImageDigest }).sha256;
}

/** The case: the defect plus the bug type, criteria catalog version, checks, expectations, repair and runtime. */
export function caseId(input: { defect_id: string; entry: Pick<CatalogEntry, "bug_type_id" | "verification" | "reference_repair" | "environment">; criteria_catalog_version: string }): string {
  const { entry } = input;
  return canonicalDigest({
    schema_version: 1,
    defect_id: input.defect_id,
    bug_type_id: entry.bug_type_id,
    criteria_catalog_version: input.criteria_catalog_version,
    check_set_sha256: entry.verification.check_set_sha256,
    expected_vectors_sha256: entry.verification.expected_vectors_sha256,
    reference_repair_sha256: entry.reference_repair.patch_sha256,
    environment_sha256: entry.environment.environment_sha256,
  }).sha256;
}

/** A catalog entry tried within a request: the hash of its source, catalog version and entry ID. */
export function candidateId(entry: Pick<CatalogEntry, "source_id" | "catalog_version" | "entry_id">): string {
  return canonicalDigest({ schema_version: 1, source_id: entry.source_id, catalog_version: entry.catalog_version, entry_id: entry.entry_id }).sha256;
}
