// A conservative upper bound on a request's input tokens that needs no tokenizer download.
//
// Bound = the UTF-8 byte length of every message's content
//       + the byte length of the serialized structured-output schema the request carries
//       + the profile's per-message framing allowance per message
//       + its per-request framing allowance once.
//
// Assumption: the model's tokenizer is byte-level, so every ordinary token covers at least one byte
// of text, and a text of n bytes is at most n tokens. The framing allowances cover the special
// tokens the chat template adds around messages and at the start of the generation.
import { WRITER_MODEL_PROFILE } from "./config.ts";
import type { ModelProfile } from "./profile.ts";

const encoder = new TextEncoder();

function bytes(text: string): number {
  return encoder.encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBytes(content: unknown): number {
  if (typeof content === "string") {
    return bytes(content);
  }
  if (Array.isArray(content)) {
    return content.reduce<number>((sum, part) => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        return sum + bytes(part.text);
      }
      throw new Error("the prompt bound counts text content only");
    }, 0);
  }
  throw new Error("a message has content the prompt bound cannot count");
}

/** Counts the bound over the exact request body that will be sent. Throws on a body it cannot count. */
export function countPromptBound(body: string, profile: ModelProfile = WRITER_MODEL_PROFILE): number {
  const framing = profile.hashed.prompt_bound;
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    throw new Error("the request body has no messages");
  }
  let total = framing.per_request_framing_tokens;
  for (const message of parsed.messages) {
    if (!isRecord(message)) {
      throw new Error("a message is not an object");
    }
    total += framing.per_message_framing_tokens + contentBytes(message.content);
  }
  if (parsed.response_format !== undefined) {
    total += bytes(JSON.stringify(parsed.response_format));
  }
  return total;
}
