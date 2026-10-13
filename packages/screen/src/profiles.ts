// The screen's frozen model profiles. Each hashed part holds the model, the per-call limits, how the
// structured output is obtained, the writer's prompt-bound method and framing, the request extras
// and the sampling note, so a change to any of them changes runtime_profile_sha256. The limits are
// predictions sized from the inputs a screen sends (a few source files and one symptom), not
// measurements; a live run measures them.
import type { ModelProfile, StructuredOutputMode } from "@rbw/writer";

/** The one operation kind of a screen call; one per attempt. */
export const SCREEN_KIND = "screen.static";
export type ScreenKind = typeof SCREEN_KIND;

export const ACTOR_ROLE = "screen";
export const API_KEY_VARIABLE = "TOKEN_FACTORY_SCREEN_KEY";
export const PROVIDER = "token-factory";
export const BASE_URL = "https://api.tokenfactory.nebius.com/v1/";

/** Attempts per screen run: at most this many model calls. */
export const MAX_ATTEMPTS = 8;

const PROMPT_BOUND = Object.freeze({ method: "utf8_bytes_plus_framing", per_message_framing_tokens: 16, per_request_framing_tokens: 256 });

interface ModelSettings {
  readonly model: string;
  readonly service: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly request_timeout_ms: number;
  readonly structured_output: StructuredOutputMode;
  readonly request_extras: Readonly<Record<string, unknown>>;
}

function profile(settings: ModelSettings): ModelProfile<ScreenKind> {
  const hashed = Object.freeze({
    provider: PROVIDER,
    model: settings.model,
    base_url: BASE_URL,
    kind: SCREEN_KIND,
    max_input_tokens: settings.max_input_tokens,
    max_output_tokens: settings.max_output_tokens,
    max_retries: 0,
    request_timeout_ms: settings.request_timeout_ms,
    structured_output: settings.structured_output,
    prompt_bound: PROMPT_BOUND,
    // No temperature or seed is sent, so every attempt samples at the provider's default.
    sampling: "provider_default",
    request_extras: settings.request_extras,
  });
  return Object.freeze({
    hashed,
    request_extras: settings.request_extras,
    service: settings.service,
    actor_role: ACTOR_ROLE,
    kinds: Object.freeze<ScreenKind[]>([SCREEN_KIND]),
    api_key_variable: API_KEY_VARIABLE,
  });
}

/** The default screen model: the solver's pre-registered model, thinking off, strict JSON schema. */
export const SUPER_SCREEN_PROFILE = profile({
  model: "nvidia/nemotron-3-super-120b-a12b",
  service: "token-factory.nemotron-3-super",
  max_input_tokens: 65_536,
  max_output_tokens: 2_048,
  request_timeout_ms: 300_000,
  structured_output: "json_schema_strict",
  request_extras: Object.freeze({ chat_template_kwargs: Object.freeze({ enable_thinking: false }) }),
});

/**
 * The solver's fallback model. It always thinks, so no thinking field and no `response_format` are
 * sent; the reply text is validated with the same schema after the call, and its reasoning counts
 * against its output limit.
 */
export const KIMI_SCREEN_PROFILE = profile({
  model: "moonshotai/Kimi-K2.7-Code",
  service: "token-factory.kimi-k2.7-code",
  max_input_tokens: 65_536,
  max_output_tokens: 8_192,
  request_timeout_ms: 600_000,
  structured_output: "validated_after",
  request_extras: Object.freeze({}),
});

export const SCREEN_PROFILES = Object.freeze({ super: SUPER_SCREEN_PROFILE, kimi: KIMI_SCREEN_PROFILE });
export type ScreenModelName = keyof typeof SCREEN_PROFILES;

export function isScreenModelName(value: string): value is ScreenModelName {
  return value === "super" || value === "kimi";
}
