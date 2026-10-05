import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CanonicalError, canonicalDigest, parseCanonical, type JsonValue } from "./canonical.ts";
import type { JobRequest, MutationIdentity, OperationIdentity, ProjectPolicy, RootRun, TaskRevisionIdentity } from "./generated.ts";
import { jobOperationIdentity, jobPayloadHash, mutationId, operationId, taskRevision } from "./jobs.ts";
import { isDefName, validateRecord, type RecordContext } from "./validate.ts";

export interface Verdict {
  verdict: "valid" | "invalid";
  canonical: Uint8Array | null;
  sha256: string | null;
}

interface ManifestEntry {
  name: string;
  type?: string;
  context?: Record<string, string>;
  /** For an invalid fixture that a code rule rejects: the one error code it must produce. */
  error?: string;
}

interface FixtureManifest {
  canonical: ManifestEntry[];
  records: ManifestEntry[];
}

function readManifest(dir: string): FixtureManifest {
  const value = parseCanonical(readFileSync(join(dir, "manifest.json"))) as unknown as FixtureManifest;
  if (!Array.isArray(value.canonical) || !Array.isArray(value.records)) throw new Error("fixture manifest is malformed");
  return value;
}

function invalid(): Verdict {
  return { verdict: "invalid", canonical: null, sha256: null };
}

function valid(value: unknown): Verdict {
  const { bytes, sha256 } = canonicalDigest(value);
  return { verdict: "valid", canonical: bytes, sha256 };
}

function parseOrNull(bytes: Uint8Array): { value: JsonValue } | null {
  try {
    return { value: parseCanonical(bytes) };
  } catch (error) {
    if (error instanceof CanonicalError) return null;
    throw error;
  }
}

export function canonicalVerdict(dir: string, name: string): Verdict {
  const parsed = parseOrNull(readFileSync(join(dir, "canonical", `${name}.input`)));
  return parsed === null ? invalid() : valid(parsed.value);
}

function contextValue(dir: string, name: string): unknown {
  return parseCanonical(readFileSync(join(dir, "records", `${name}.json`)));
}

/** The error codes for a record fixture: ["canonical"] when strict parsing fails, else the validator's codes. */
export function recordErrors(dir: string, name: string, manifest: FixtureManifest = readManifest(dir)): { parsed: { value: JsonValue } | null; errors: string[] } {
  const entry = manifest.records.find((item) => item.name === name);
  if (entry?.type === undefined || !isDefName(entry.type)) throw new Error(`unknown record fixture ${name}`);
  const parsed = parseOrNull(readFileSync(join(dir, "records", `${name}.json`)));
  if (parsed === null) return { parsed, errors: ["canonical"] };
  const context: RecordContext = {};
  const names = entry.context ?? {};
  if (names.policy !== undefined) context.policy = contextValue(dir, names.policy) as ProjectPolicy;
  if (names.root !== undefined) context.root = contextValue(dir, names.root) as RootRun;
  if (names.previous !== undefined) context.previous = contextValue(dir, names.previous) as ProjectPolicy;
  if (names.request !== undefined) context.request = contextValue(dir, names.request) as JobRequest;
  return { parsed, errors: validateRecord(entry.type, parsed.value, context) };
}

export function recordVerdict(dir: string, name: string, manifest: FixtureManifest = readManifest(dir)): Verdict {
  const { parsed, errors } = recordErrors(dir, name, manifest);
  return parsed === null || errors.length > 0 ? invalid() : valid(parsed.value);
}

/** The IDs computed from a valid identity-bearing fixture, as `[name, value]` pairs. */
function computedIds(type: string | undefined, value: unknown): [string, string][] {
  switch (type) {
    case "JobRequest": {
      const request = value as JobRequest;
      return [
        ["operation_id", operationId(jobOperationIdentity(request)).sha256],
        ["payload_hash", jobPayloadHash(request).sha256],
      ];
    }
    case "OperationIdentity":
      return [["operation_id", operationId(value as OperationIdentity).sha256]];
    case "MutationIdentity": {
      const identity = value as MutationIdentity;
      return [["mutation_id", mutationId(identity, { allowedPaths: identity.changes.map((change) => change.path) }).sha256]];
    }
    case "TaskRevisionIdentity":
      return [["task_revision", taskRevision(value as TaskRevisionIdentity).sha256]];
    default:
      return [];
  }
}

/**
 * One line per fixture, `<name> <verdict> <sha256 or ->`, canonical cases first, in manifest
 * order; then `<name> <id> <value>` for each ID computed from a valid job request or identity record.
 */
export function fixtureReport(dir: string): string[] {
  const manifest = readManifest(dir);
  const line = (name: string, verdict: Verdict): string => `${name} ${verdict.verdict} ${verdict.sha256 ?? "-"}`;
  const ids: string[] = [];
  const records = manifest.records.map((entry) => {
    const verdict = recordVerdict(dir, entry.name, manifest);
    if (verdict.verdict === "valid") {
      for (const [id, value] of computedIds(entry.type, contextValue(dir, entry.name))) ids.push(`${entry.name} ${id} ${value}`);
    }
    return line(entry.name, verdict);
  });
  return [...manifest.canonical.map((entry) => line(entry.name, canonicalVerdict(dir, entry.name))), ...records, ...ids];
}
