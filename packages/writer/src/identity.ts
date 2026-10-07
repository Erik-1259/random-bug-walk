// Identity of a writer call in the spend ledger: the run context and the hashes the reservation
// carries. The operation ID, the call name and the profile digest's encoding come from
// @rbw/schema; the payload hash is of the exact request body this package sends.
import { createHash } from "node:crypto";
import { callName, operationId as schemaOperationId, providerCallIdentity, validateRecord } from "@rbw/schema";
import type { JobRequest } from "@rbw/schema";
import { z } from "zod";
import { WRITER_MODEL_PROFILE } from "./config.ts";
import { profileSha256 } from "./profile.ts";
import type { ModelProfile } from "./profile.ts";

/** A string that the shared schema accepts as `type`. */
function schemaString(type: "Uuid" | "Sha256") {
  return z.string().refine((value) => validateRecord(type, value).length === 0, { message: `must be a ${type}` });
}

export const RunContextSchema = z.strictObject({
  project_id: schemaString("Uuid"),
  project_policy_sha256: schemaString("Sha256"),
  batch_id: schemaString("Uuid"),
  task_revision: schemaString("Sha256"),
  root_execution_id: schemaString("Uuid"),
  execution_id: schemaString("Uuid"),
  parent_execution_id: schemaString("Uuid").nullable(),
});

/** The run fields of a job request; every writer call is part of one, so `batch_id` is required. */
export type RunContext = Pick<
  JobRequest,
  "project_id" | "project_policy_sha256" | "batch_id" | "task_revision" | "root_execution_id" | "execution_id" | "parent_execution_id"
>;

/** Validates a caller-supplied run context; unknown fields are rejected. Throws on any problem. */
export function parseRunContext(value: unknown): RunContext {
  const parsed = RunContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid run context: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export type WriterKind = "writer.card" | "writer.issue";
export const WRITER_KINDS: readonly WriterKind[] = WRITER_MODEL_PROFILE.kinds;

/** A candidate name: lowercase letters, digits, `_` and `-`, so it is one segment of a call name. */
export const CANDIDATE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,45}$/;

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (typeof text !== "string") {
    throw new Error("value cannot be written as canonical JSON");
  }
  return text;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const PROFILE_SHA256 = profileSha256(WRITER_MODEL_PROFILE);

/** SHA-256 of the canonical JSON v1 bytes of the frozen writer profile. */
export function runtimeProfileSha256(): string {
  return PROFILE_SHA256;
}

/** SHA-256 of the exact request body bytes sent to the provider. */
export function payloadHash(body: string): string {
  return sha256Hex(body);
}

export interface MeteredCallIdentity {
  context: RunContext;
  kind: string;
  candidate: string;
  callOrdinal: number;
  /** 1 for the first operation at an ordinal; later attempts follow only an unsent one. */
  attemptOrdinal: number;
}

export interface WriterCallIdentity extends MeteredCallIdentity {
  kind: WriterKind;
}

/**
 * The schema's operation ID of the call's OperationIdentity, whose call name is
 * `<kind>:<candidate>:<ordinal>`. Deterministic, so a restarted process finds the ordinals
 * already used in the ledger.
 */
export function operationId(identity: WriterCallIdentity): string {
  return operationIdFor(PROFILE_SHA256, identity);
}

/** The operation ID of a call made under `profile`, as the metered call reserves it. */
export function meteredOperationId(profile: ModelProfile, identity: MeteredCallIdentity): string {
  return operationIdFor(profileSha256(profile), identity);
}

/** The operation ID of a call under the profile whose digest is `profileSha`. */
export function operationIdFor(profileSha: string, identity: MeteredCallIdentity): string {
  return schemaOperationId(
    providerCallIdentity({
      ...identity.context,
      kind: identity.kind,
      runtime_profile_sha256: profileSha,
      call_name: callName(identity.kind, identity.candidate, identity.callOrdinal),
      attempt_ordinal: identity.attemptOrdinal,
    }),
  ).sha256;
}
