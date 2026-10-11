// A model profile: what a metered call needs to know about one model. The hashed part is the object
// whose canonical digest is the operation's runtime_profile_sha256; the rest is config beside it.
import { canonicalDigest } from "@rbw/schema";

export type StructuredOutputMode = "json_schema_strict" | "validated_after";

/** The fields of the hashed part that the metered call reads. A profile may hash more fields. */
export interface HashedProfile {
  readonly provider: string;
  readonly model: string;
  readonly base_url: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_retries: number;
  readonly request_timeout_ms: number;
  /**
   * How the structured output is obtained. `json_schema_strict` (also when absent) sends the schema
   * as a strict `response_format`; `validated_after` sends no `response_format` and parses and
   * validates the reply text with the same schema after the call.
   */
  readonly structured_output?: StructuredOutputMode;
  /** Framing allowances of the prompt bound (see prompt-bound.ts). */
  readonly prompt_bound: {
    readonly method: string;
    readonly per_message_framing_tokens: number;
    readonly per_request_framing_tokens: number;
  };
}

export interface ModelProfile<K extends string = string> {
  /** Hashed into runtime_profile_sha256 as canonical JSON, every field included. */
  readonly hashed: HashedProfile;
  /** Top-level fields added to every request body; the hashed part describes what they set. */
  readonly request_extras: Readonly<Record<string, unknown>>;
  /** The service label of both envelope lines, and the rate entries they are priced from. */
  readonly service: string;
  /** The role label the caller acts under in the spend ledger. */
  readonly actor_role: string;
  /** The operation kinds the caller reserves under this profile. */
  readonly kinds: readonly K[];
  /** The environment variable that holds this role's key. */
  readonly api_key_variable: string;
}

/** SHA-256 of the canonical JSON v1 bytes of the profile's hashed part. */
export function profileSha256(profile: ModelProfile): string {
  return canonicalDigest(profile.hashed).sha256;
}
