// The identity fields of a spend reservation, kept in one module. The shared schema package will
// supply the run context, the profile digest and the operation ID later; until then they live here.
import { z } from "zod";
import type { EnvelopeLine, Price, ReserveRequest } from "@rbw/spend";
import { sha256OfCanonical } from "./canonical.ts";
import { SearchError } from "./errors.ts";
import { PLAN_PROFILE } from "./plan.ts";
import type { SearchSettings } from "./plan.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const runContextSchema = z.strictObject({
  project_id: uuid,
  project_policy_sha256: hex64,
  batch_id: uuid.nullable(),
  task_revision: hex64,
  root_execution_id: uuid,
  execution_id: uuid,
  parent_execution_id: uuid.nullable(),
});

export type RunContext = z.infer<typeof runContextSchema>;

export function parseRunContext(value: unknown): RunContext {
  const parsed = runContextSchema.safeParse(value);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    throw new SearchError("invalid_context", paths.join(", "));
  }
  return parsed.data;
}

export interface SearchProfile {
  /** SHA-256 of the canonical, sorted-key JSON of the frozen search profile. */
  sha256: string;
}

/** The frozen search profile: call options, limits and domain lists. */
export function buildProfile(settings: SearchSettings): SearchProfile {
  return { sha256: sha256OfCanonical({ plan: PLAN_PROFILE, settings }) };
}

export type SpendKind = "search.source" | "search.docs" | "search.phrase";

export interface IdentityInput {
  context: RunContext;
  profile: SearchProfile;
  candidate: string;
  /** The plan name, such as `source-1`. */
  name: string;
  kind: SpendKind;
  /** The request options and query; hashed into `payload_hash`. */
  options: unknown;
}

export interface Identity {
  operation_id: string;
  payload_hash: string;
  call_name: string;
  kind: SpendKind;
  runtime_profile_sha256: string;
}

export const ATTEMPT_ORDINAL = 1;

export function buildIdentity(input: IdentityInput): Identity {
  const { context } = input;
  return {
    operation_id: sha256OfCanonical({
      project_id: context.project_id,
      project_policy_sha256: context.project_policy_sha256,
      root_execution_id: context.root_execution_id,
      batch_id: context.batch_id,
      task_revision: context.task_revision,
      kind: input.kind,
      runtime_profile_sha256: input.profile.sha256,
      candidate: input.candidate,
      call_name: input.name,
      attempt_ordinal: ATTEMPT_ORDINAL,
    }),
    payload_hash: sha256OfCanonical(input.options),
    // The spend call-name label allows letters, digits ".", "_" and "-", so the parts join with ".".
    call_name: `${input.kind}.${input.candidate}.${input.name}`,
    kind: input.kind,
    runtime_profile_sha256: input.profile.sha256,
  };
}

/** One credit line, capped at `limit` credits, priced per credit. */
export function creditEnvelope(limit: number, price: Price): EnvelopeLine {
  return { service: "tavily", unit: "credit", limit, enforced_by: "request_parameter", price };
}

export interface ReservationInput {
  context: RunContext;
  identity: Identity;
  poolKey: string;
  allocationKey: string | null;
  rateSheetSha256: string;
  envelope: EnvelopeLine[];
}

export function buildReserveRequest(input: ReservationInput): ReserveRequest {
  const { context, identity } = input;
  return {
    operation_id: identity.operation_id,
    payload_hash: identity.payload_hash,
    attempt_ordinal: ATTEMPT_ORDINAL,
    previous_operation_id: null,
    project_id: context.project_id,
    project_policy_sha256: context.project_policy_sha256,
    batch_id: context.batch_id,
    task_revision: context.task_revision,
    root_execution_id: context.root_execution_id,
    execution_id: context.execution_id,
    parent_execution_id: context.parent_execution_id,
    kind: identity.kind,
    call_name: identity.call_name,
    provider: "tavily",
    provider_replay_key: null,
    pool_key: input.poolKey,
    allocation_key: input.allocationKey,
    runtime_profile_sha256: identity.runtime_profile_sha256,
    rate_sheet_sha256: input.rateSheetSha256,
    envelope: input.envelope,
  };
}
