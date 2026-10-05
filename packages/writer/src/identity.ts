// Identity of a writer call in the spend ledger: the run context, canonical JSON, and the hashes
// the reservation carries. The shared schema package will supply the run context, the operation-ID
// and the payload-hash definitions later; until then they live here, in this one module.
import { createHash } from "node:crypto";
import { z } from "zod";
import { WRITER_PROFILE } from "./config.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const RunContextSchema = z
  .object({
    project_id: z.string().regex(UUID),
    project_policy_sha256: z.string().regex(SHA256),
    batch_id: z.string().regex(UUID).nullable(),
    task_revision: z.string().regex(SHA256),
    root_execution_id: z.string().regex(UUID),
    execution_id: z.string().regex(UUID),
    parent_execution_id: z.string().regex(UUID).nullable(),
  })
  .strict();
export type RunContext = z.infer<typeof RunContextSchema>;

/** Validates a caller-supplied run context; unknown fields are rejected. Throws on any problem. */
export function parseRunContext(value: unknown): RunContext {
  const parsed = RunContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid run context: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export type WriterKind = "writer.card" | "writer.issue";
export const WRITER_KINDS: readonly WriterKind[] = ["writer.card", "writer.issue"];

/** A candidate name: lowercase letters, digits, `_` and `-`, so the call name stays a spend label. */
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

export function runtimeProfileSha256(): string {
  return sha256Hex(canonicalJson(WRITER_PROFILE));
}

/** SHA-256 of the exact request body bytes sent to the provider. */
export function payloadHash(body: string): string {
  return sha256Hex(body);
}

export interface OperationIdentity {
  context: RunContext;
  kind: WriterKind;
  candidate: string;
  callOrdinal: number;
  /** 1 for the first operation at an ordinal; later attempts follow only an unsent one. */
  attemptOrdinal: number;
}

/** Deterministic, so a restarted process finds the ordinals already used in the ledger. */
export function operationId(identity: OperationIdentity): string {
  const { context } = identity;
  return sha256Hex(
    canonicalJson({
      project_id: context.project_id,
      project_policy_sha256: context.project_policy_sha256,
      root_execution_id: context.root_execution_id,
      batch_id: context.batch_id,
      task_revision: context.task_revision,
      kind: identity.kind,
      runtime_profile_sha256: runtimeProfileSha256(),
      candidate: identity.candidate,
      call_ordinal: identity.callOrdinal,
      attempt_ordinal: identity.attemptOrdinal,
    }),
  );
}

/**
 * `<kind>.<candidate>.<ordinal>`. The spend ledger accepts call names of lowercase letters, digits,
 * `.`, `_` and `-` only, so the parts are joined with `.` rather than `:`.
 */
export function callName(kind: WriterKind, candidate: string, callOrdinal: number): string {
  return `${kind}.${candidate}.${String(callOrdinal)}`;
}
