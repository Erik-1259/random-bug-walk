// The solver's frozen model profiles and attempt caps. Each hashed part is canonical JSON (safe
// integers and strings only), and its digest is the runtime_profile_sha256 of every solver call.
// The per-call limits and the sampling settings are predictions, not measurements: the harness
// pilot measures them, and the profile is frozen after it (a change changes the digest).
import type { ModelProfile } from "@rbw/writer";

/** The one operation kind of a solver model call; one per model turn. */
export const SOLVER_KIND = "solver.turn";
export type SolverKind = typeof SOLVER_KIND;

export const ACTOR_ROLE = "solver";
export const API_KEY_VARIABLE = "TOKEN_FACTORY_SOLVER_KEY";
export const PROVIDER = "token-factory";
export const BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
/** The only URL a solver request goes to. */
export const CHAT_COMPLETIONS_URL = `${BASE_URL}chat/completions`;

export interface AttemptCaps {
  /** Model calls launched. */
  readonly max_turns: number;
  /** Reported input tokens summed over the attempt's calls (the counted bound where none is reported). */
  readonly max_input_tokens: number;
  readonly max_wall_ms: number;
  readonly max_rebuilds: number;
}

/** The pre-registered caps of one attempt, shared by both arms. */
export const ATTEMPT_CAPS: AttemptCaps = Object.freeze({
  max_turns: 50,
  max_input_tokens: 1_500_000,
  max_wall_ms: 40 * 60 * 1000,
  max_rebuilds: 8,
});

/**
 * The caps an attempt can stop on. `context_window`: one request stays over the per-call limit
 * after the history policy has elided every tool result it may.
 */
export const CAP_NAMES = ["turns", "input_tokens", "wall", "context_window"] as const;
export type CapName = (typeof CAP_NAMES)[number];

/** Byte caps on what one tool result shows the model. */
export const TOOL_OUTPUT_CAPS = Object.freeze({
  bash_output_bytes: 16_384,
  bash_timeout_ms: 120_000,
  read_file_bytes: 65_536,
  /** Each of the build's stdout log, its stderr log and rbw-build-app's own messages. */
  build_log_bytes: 8_192,
  server_logs_bytes: 16_384,
});

/**
 * How the prompt bound is counted: the UTF-8 byte length of the whole request body plus framing.
 * The body holds every message, tool call, tool result and tool definition the model reads, so
 * with a byte-level tokenizer the body's byte count bounds the text tokens.
 */
export const PROMPT_BOUND = Object.freeze({
  method: "utf8_body_bytes_plus_framing",
  per_message_framing_tokens: 16,
  per_request_framing_tokens: 256,
});

/**
 * How the history is kept within the per-call limit, the same in both arms: while a request's
 * counted bound is over `max_input_tokens`, the oldest tool result outside the newest tool message
 * is replaced by a short stub, one at a time. Only when nothing more may be elided does the
 * attempt stop on the `context_window` cap.
 */
export const HISTORY_POLICY = Object.freeze({
  method: "elide_oldest_tool_result_while_over_per_call_limit",
  keeps: "newest_tool_message",
});

/** What the hashed part holds beyond the writer's HashedProfile fields. */
interface SolverHashedExtras {
  readonly kind: SolverKind;
  readonly history_policy: typeof HISTORY_POLICY;
  /** Decimal strings: canonical JSON v1 carries safe integers only. */
  readonly sampling: { readonly temperature: string; readonly seed: "attempt_index" };
  readonly attempt_caps: AttemptCaps;
  readonly tool_output_caps: typeof TOOL_OUTPUT_CAPS;
  readonly request_extras: Readonly<Record<string, unknown>>;
}

export type SolverProfile = ModelProfile<SolverKind> & {
  readonly hashed: ModelProfile["hashed"] & SolverHashedExtras;
  /** The sampling temperature sent on every request, equal to `hashed.sampling.temperature`. */
  readonly temperature: number;
};

interface ModelSettings {
  readonly model: string;
  readonly service: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly request_timeout_ms: number;
  readonly temperature: number;
  readonly request_extras: Readonly<Record<string, unknown>>;
}

function profile(settings: ModelSettings): SolverProfile {
  const hashed = Object.freeze({
    provider: PROVIDER,
    model: settings.model,
    base_url: BASE_URL,
    kind: SOLVER_KIND,
    max_input_tokens: settings.max_input_tokens,
    max_output_tokens: settings.max_output_tokens,
    max_retries: 0,
    request_timeout_ms: settings.request_timeout_ms,
    prompt_bound: PROMPT_BOUND,
    history_policy: HISTORY_POLICY,
    sampling: Object.freeze({ temperature: String(settings.temperature), seed: "attempt_index" as const }),
    attempt_caps: ATTEMPT_CAPS,
    tool_output_caps: TOOL_OUTPUT_CAPS,
    request_extras: settings.request_extras,
  });
  return Object.freeze({
    hashed,
    request_extras: settings.request_extras,
    service: settings.service,
    actor_role: ACTOR_ROLE,
    kinds: Object.freeze<SolverKind[]>([SOLVER_KIND]),
    api_key_variable: API_KEY_VARIABLE,
    temperature: settings.temperature,
  });
}

/**
 * The solver model: Nemotron 3.5 Super VL, the successor of the pre-registered Nemotron 3 Super,
 * which the provider retires in November 2026. Thinking is off as harvest-review sends it.
 */
export const SUPER_SOLVER_PROFILE = profile({
  model: "nvidia/Nemotron-3.5-Super-VL",
  service: "token-factory.nemotron-3.5-super-vl",
  max_input_tokens: 131_072,
  max_output_tokens: 8_192,
  request_timeout_ms: 300_000,
  temperature: 0.6,
  request_extras: Object.freeze({ chat_template_kwargs: Object.freeze({ enable_thinking: false }) }),
});

/**
 * The single fallback, used only if the pilot shows Super's tool calling broken: Kimi-K3, the
 * successor of the pre-registered Kimi-K2.7-Code. It is treated as always thinking, as K2.7-Code
 * was, so no thinking field is sent, and its reasoning counts against its output limit.
 */
export const KIMI_SOLVER_PROFILE = profile({
  model: "moonshotai/Kimi-K3",
  service: "token-factory.kimi-k3",
  max_input_tokens: 131_072,
  max_output_tokens: 16_384,
  request_timeout_ms: 600_000,
  temperature: 0.6,
  request_extras: Object.freeze({}),
});

export const SOLVER_PROFILES = Object.freeze({ super: SUPER_SOLVER_PROFILE, kimi: KIMI_SOLVER_PROFILE });
export type SolverModelName = keyof typeof SOLVER_PROFILES;
