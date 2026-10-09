// The two frozen model profiles of the harvest review. Each hashed part holds the model, the
// limits, the writer's prompt-bound method and framing, and the request extras that set thinking,
// so a change to any of them changes runtime_profile_sha256. The output limit and the timeout are
// per model: Kimi always thinks, and its reasoning counts against its output tokens.
import type { ModelProfile } from "@rbw/writer";

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

/** Thinking off as the writer sends it to Nemotron Lightning: the chat template's enable_thinking flag. */
export const SUPER_PROFILE = profile(
  "nvidia/nemotron-3-super-120b-a12b",
  "token-factory.nemotron-3-super",
  { max_output_tokens: 4_096, request_timeout_ms: 120_000 },
  Object.freeze({ chat_template_kwargs: Object.freeze({ enable_thinking: false }) }),
);

/**
 * No extras: Kimi-K2.7-Code has no documented way to turn thinking off. Moonshot's guide says
 * "thinking is always on" for it and that passing `thinking: { type: "disabled" }` errors
 * (https://platform.kimi.ai/docs/guide/use-thinking-models), and the vLLM recipe says it "runs in
 * thinking mode only" (https://recipes.vllm.ai/moonshotai/Kimi-K2.7-Code). Its reasoning counts
 * against its 32,768 output tokens, and the 1,200,000 ms timeout leaves room for it. All the
 * limits are provisional while they are tuned.
 */
export const KIMI_PROFILE = profile(
  "moonshotai/Kimi-K2.7-Code",
  "token-factory.kimi-k2.7-code",
  { max_output_tokens: 32_768, request_timeout_ms: 1_200_000 },
  Object.freeze({}),
);

export type ModelName = "super" | "kimi";

/** The models in call order, each at its fixed call ordinal. */
export const REVIEW_MODELS: readonly { readonly name: ModelName; readonly ordinal: number; readonly profile: ModelProfile<ReviewKind> }[] = Object.freeze([
  { name: "super", ordinal: 1, profile: SUPER_PROFILE },
  { name: "kimi", ordinal: 2, profile: KIMI_PROFILE },
]);
