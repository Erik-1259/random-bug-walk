// Synthetic model answers for the committed recordings, in call order: for each candidate, Super's
// answer then Kimi's. No answer here came from a model.
import type { FetchFunction } from "@rbw/writer";
import { KIMI_PROFILE } from "../../src/profiles.ts";
import type { ReviewOutput } from "../../src/prompt.ts";

/** A valid answer, a schema-invalid answer, an HTTP 500, or the reply text as given. */
export type Scripted = ReviewOutput | "invalid" | "http_500" | { readonly raw: string };

export const answer = (verdict: ReviewOutput["verdict"], zone: ReviewOutput["zone_is_selected"], same: ReviewOutput["same_call"]): ReviewOutput => ({
  verdict,
  zone_is_selected: zone,
  same_call: same,
  reason: `Synthetic answer: ${verdict}, zone ${zone}, same call ${same}.`,
});

export const YES = answer("fix", "yes", "yes");
export const NO = answer("not_fix", "no", "no");
export const UNSURE = answer("unsure", "unsure", "unsure");
/** A fix whose zone is not the selected one: an inconsistent answer, counted as unsure. */
const INCONSISTENT = answer("fix", "no", "yes");

/** For the harvest's synthetic run, in funnel order. */
export const REVIEW_SCRIPT: readonly (readonly [Scripted, Scripted])[] = [
  [YES, YES],
  [YES, NO],
  [YES, YES],
  [NO, NO],
  ["invalid", NO],
  ["http_500", NO],
  [INCONSISTENT, YES],
  [NO, NO],
  [YES, YES],
  [YES, UNSURE],
];

/** For the acceptance set, in its order. Kimi's yes on the runtime-zone case is a planted per-model failure. */
export const ACCEPTANCE_SCRIPT: readonly (readonly [Scripted, Scripted])[] = [
  [YES, YES],
  [YES, YES],
  [YES, YES],
  [NO, NO],
  [NO, NO],
  [NO, NO],
  [NO, UNSURE],
  [NO, NO],
  [NO, NO],
  [NO, YES],
];

export const SYNTHETIC_USAGE = { prompt_tokens: 900, completion_tokens: 60 };

/** Kimi thinks: its synthetic replies carry reasoning text and a reasoning count inside completion_tokens. */
export const SYNTHETIC_REASONING = "Synthetic reasoning: the shown call gains the selected zone as an argument.";
export const SYNTHETIC_REASONING_TOKENS = 40;

/** The response to one request, as an OpenAI-compatible chat completion. */
export function response(scripted: Scripted, model: string): { status: number; body: string } {
  if (scripted === "http_500") {
    return { status: 500, body: JSON.stringify({ error: { message: "synthetic server error" } }) };
  }
  const content =
    scripted === "invalid" ? JSON.stringify({ verdict: "maybe" }) : "raw" in scripted ? scripted.raw : JSON.stringify(scripted);
  const thinks = model === KIMI_PROFILE.hashed.model;
  return {
    status: 200,
    body: JSON.stringify({
      id: "synthetic-completion",
      object: "chat.completion",
      created: 1767225600,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content, ...(thinks ? { reasoning: SYNTHETIC_REASONING } : {}) }, finish_reason: "stop" },
      ],
      usage: {
        ...SYNTHETIC_USAGE,
        total_tokens: SYNTHETIC_USAGE.prompt_tokens + SYNTHETIC_USAGE.completion_tokens,
        ...(thinks ? { completion_tokens_details: { reasoning_tokens: SYNTHETIC_REASONING_TOKENS } } : {}),
      },
    }),
  };
}

/** A fetch that answers each request from `script` in call order: Super's answer, then Kimi's. */
export function scriptedFetch(script: readonly (readonly [Scripted, Scripted])[]): FetchFunction {
  const queue = script.flat();
  return (_input, init) => {
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("the script has no answer for this request"));
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { model?: string };
    const reply = response(next, body.model ?? "");
    return Promise.resolve(new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } }));
  };
}
