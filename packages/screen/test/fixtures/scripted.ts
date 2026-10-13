// The fake model: synthetic chat completions answered from a script in call order. No answer here
// came from a model.
import type { FetchFunction } from "@rbw/writer";
import type { ScreenAnswer } from "../../src/prompt.ts";

/** A valid answer, a schema-invalid answer, an HTTP 500, or a response lost after the request was sent. */
export type Scripted = ScreenAnswer | "invalid" | "http_500" | "lost";

export const SYNTHETIC_USAGE = { prompt_tokens: 1_200, completion_tokens: 80 };

/** Locates the planted line and restores the clean form. */
export const LOCATED_AND_FIXED: ScreenAnswer = {
  file: "src/report.ts",
  start_line: 12,
  end_line: 12,
  fixed_code: "  return formatTotal(total, rounding, currency);",
  reason: "Synthetic answer: the total drops the currency argument.",
};

/** Points at the planted line with a fix that is not the clean form. */
export const LOCATED_ONLY: ScreenAnswer = {
  file: "src/report.ts",
  start_line: 11,
  end_line: 12,
  fixed_code: "  const total = rows.reduce((sum, row) => sum + row, 0);\n  return formatTotal(total, rounding, \"eur\");",
  reason: "Synthetic answer: hard-codes the currency.",
};

/** A valid answer about another file; its reason must never reach the record. */
export const MISS_REASON = "Synthetic miss reason that names a place far from the planted site.";
export const MISS: ScreenAnswer = {
  file: "src/format.ts",
  start_line: 5,
  end_line: 5,
  fixed_code: '  const symbol = SYMBOLS[currency.toLowerCase()] ?? "";',
  reason: MISS_REASON,
};

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export function completion(content: string, model: string, usage: Usage = SYNTHETIC_USAGE): string {
  return JSON.stringify({
    id: "synthetic-completion",
    object: "chat.completion",
    created: 1767225600,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  });
}

export interface ScriptedFetch {
  fetch: FetchFunction;
  bodies: Record<string, unknown>[];
}

/** A fetch that answers each request from `script` in call order and keeps every request body. */
export function scriptedFetch(script: readonly Scripted[], usage: Usage = SYNTHETIC_USAGE): ScriptedFetch {
  const queue = [...script];
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    fetch: (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      bodies.push(body);
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(new Error("the script has no answer for this request"));
      }
      if (next === "lost") {
        return Promise.reject(new Error("synthetic connection reset after the request was sent"));
      }
      if (next === "http_500") {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "synthetic server error" } }), { status: 500 }));
      }
      const content = next === "invalid" ? JSON.stringify({ file: "src/report.ts" }) : JSON.stringify(next);
      const model = typeof body.model === "string" ? body.model : "";
      return Promise.resolve(new Response(completion(content, model, usage), { status: 200, headers: { "content-type": "application/json" } }));
    },
  };
}
