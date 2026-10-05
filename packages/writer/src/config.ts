// The writer's fixed model, provider and limits. Nothing here is read from the environment:
// there is no fallback model and no override of the model or the base URL.

export const MODEL_ID = "nvidia/Nemotron-3_5-Lightning";
export const BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
/** The only URL a writer request goes to. */
export const CHAT_COMPLETIONS_URL = `${BASE_URL}chat/completions`;

/** Provider label for the spend ledger, and the service name of both envelope lines. */
export const PROVIDER = "token-factory";
export const SERVICE = "token-factory";

/** The one environment variable that holds the writer role's key. Only the `record` command reads it. */
export const API_KEY_VARIABLE = "TOKEN_FACTORY_WRITER_KEY";

export const MAX_INPUT_TOKENS = 32_768;
export const MAX_OUTPUT_TOKENS = 8_192;
/** Billed calls per candidate, shared by card writing, issue writing and every repair. */
export const MAX_CALLS_PER_CANDIDATE = 12;
export const MAX_RETRIES = 0;

/**
 * Framing allowances of the prompt bound (see prompt-bound.ts). Per message: the chat template's
 * role markers and separators. Per request: the template's preamble, the generation prompt and any
 * marker the template adds when thinking is off.
 */
export const PER_MESSAGE_FRAMING_TOKENS = 16;
export const PER_REQUEST_FRAMING_TOKENS = 256;

/** A request still open after this long is abandoned and recorded as a lost response. */
export const REQUEST_TIMEOUT_MS = 600_000;

/** Role label the writer acts under in the spend ledger. */
export const ACTOR_ROLE = "writer";

/** The frozen writer profile; its canonical JSON digest is the operation's runtime_profile_sha256. */
export const WRITER_PROFILE = Object.freeze({
  provider: PROVIDER,
  model: MODEL_ID,
  base_url: BASE_URL,
  max_input_tokens: MAX_INPUT_TOKENS,
  max_output_tokens: MAX_OUTPUT_TOKENS,
  max_calls_per_candidate: MAX_CALLS_PER_CANDIDATE,
  max_retries: MAX_RETRIES,
  enable_thinking: false,
  tools: "none",
  structured_output: "json_schema_strict",
  prompt_bound: Object.freeze({
    method: "utf8_bytes_plus_framing",
    per_message_framing_tokens: PER_MESSAGE_FRAMING_TOKENS,
    per_request_framing_tokens: PER_REQUEST_FRAMING_TOKENS,
  }),
  request_timeout_ms: REQUEST_TIMEOUT_MS,
});
