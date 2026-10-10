// The two frozen model profiles of the harvest review. Each hashed part holds the model, the
// limits, how the structured output is obtained, the writer's prompt-bound method and framing, and
// the request extras that set thinking, so a change to any of them changes runtime_profile_sha256.
// The limits are per model and were set from measured calls (see the README); they are provisional.
import type { ModelProfile, StructuredOutputMode } from "@rbw/writer";

export const REVIEW_KIND = "harvest.review";
export type ReviewKind = typeof REVIEW_KIND;

export const ACTOR_ROLE = "harvest-review";
export const API_KEY_VARIABLE = "TOKEN_FACTORY_REVIEW_KEY";

const BASE = {
  provider: "token-factory",
  base_url: "https://api.tokenfactory.nebius.com/v1/",
  max_input_tokens: 65_536,
  max_retries: 0,
  prompt_bound: Object.freeze({ method: "utf8_bytes_plus_framing", per_message_framing_tokens: 16, per_request_framing_tokens: 256 }),
} as const;

interface ModelLimits {
  readonly max_output_tokens: number;
  readonly request_timeout_ms: number;
  readonly structured_output: StructuredOutputMode;
}

function profile(model: string, service: string, limits: ModelLimits, extras: Readonly<Record<string, unknown>>): ModelProfile<ReviewKind> {
  const hashed = Object.freeze({ ...BASE, ...limits, model, request_extras: extras });
  return Object.freeze({
    hashed,
    request_extras: extras,
    service,
    actor_role: ACTOR_ROLE,
    kinds: Object.freeze<ReviewKind[]>([REVIEW_KIND]),
    api_key_variable: API_KEY_VARIABLE,
  });
}

/** Thinking off as the writer sends it to Nemotron Lightning, and the strict JSON schema. */
export const SUPER_PROFILE = profile(
  "nvidia/nemotron-3-super-120b-a12b",
  "token-factory.nemotron-3-super",
  { max_output_tokens: 1_024, request_timeout_ms: 60_000, structured_output: "json_schema_strict" },
  Object.freeze({ chat_template_kwargs: Object.freeze({ enable_thinking: false }) }),
);

/**
 * Thinking on, with no request extras and no `response_format`: with the strict JSON schema the
 * provider returned no reasoning, so the reply text is validated with the same schema after the
 * call. Its reasoning counts against its 8,192 output tokens.
 */
export const KIMI_PROFILE = profile(
  "moonshotai/Kimi-K2.7-Code",
  "token-factory.kimi-k2.7-code",
  { max_output_tokens: 8_192, request_timeout_ms: 600_000, structured_output: "validated_after" },
  Object.freeze({}),
);

export type ModelName = "super" | "kimi";

/** The models in call order, each at its fixed call ordinal. */
export const REVIEW_MODELS: readonly { readonly name: ModelName; readonly ordinal: number; readonly profile: ModelProfile<ReviewKind> }[] = Object.freeze([
  { name: "super", ordinal: 1, profile: SUPER_PROFILE },
  { name: "kimi", ordinal: 2, profile: KIMI_PROFILE },
]);
