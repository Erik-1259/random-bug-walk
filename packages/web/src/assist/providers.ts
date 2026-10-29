// The bug designer's two providers over plain fetch: Nebius Token Factory's OpenAI-compatible chat
// completions (strict JSON schema output, thinking off, no tools, no retries), and Tavily search (basic
// depth, no answer, no raw content, no automatic parameters), as the writer and the search package
// call them. A key is sent only as the bearer header and never logged; a failure is an
// AssistUnavailable whose reason names no provider text.
import { AssistUnavailable } from "./http.ts";
import { EXCERPT_MAX_CHARS, PROVIDER_TIMEOUT_MS } from "./limits.ts";
import { validateModelOutput, type ModelSchemaName, type ModelOutputs, wireSchema } from "./schemas.ts";

export type Fetch = typeof fetch;

export const TOKEN_FACTORY_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
export const CHAT_COMPLETIONS_URL = `${TOKEN_FACTORY_BASE_URL}chat/completions`;
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const MODEL_PROVIDER = "nebius-token-factory";
export const SEARCH_PROVIDER = "tavily";

export interface ModelInfo {
  provider: typeof MODEL_PROVIDER;
  model_id: string;
  at: string;
}

export interface ChatCall<K extends ModelSchemaName> {
  apiKey: string;
  model: string;
  schema: K;
  system: string;
  user: string;
  maxTokens: number;
}

/** The designer transport with a caller-owned strict schema and conversation. No automatic retry. */
export interface StructuredChatCall {
  apiKey: string;
  model: string;
  schemaName: string;
  schema: unknown;
  messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens: number;
}

async function post(fetchFn: Fetch, url: string, apiKey: string, body: unknown, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new AssistUnavailable(`${what}: ${timedOut ? "timed out" : "request failed"}`);
  }
  if (!response.ok) throw new AssistUnavailable(`${what}: HTTP ${String(response.status)}`);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new AssistUnavailable(`${what}: the response is not JSON`);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The message content as JSON: plain, or inside one fenced block. */
function parseContent(content: string): unknown {
  const text = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return JSON.parse(fenced?.[1] ?? text) as unknown;
}

/** One structured completion; callers validate the content and decide whether a repair is allowed. */
export async function structuredChat(fetchFn: Fetch, call: StructuredChatCall): Promise<{ content: string; truncated: boolean }> {
  const body = {
    model: call.model,
    messages: call.messages,
    max_tokens: call.maxTokens,
    temperature: 0.2,
    stream: false,
    response_format: { type: "json_schema", json_schema: { name: call.schemaName, strict: true, schema: call.schema } },
    chat_template_kwargs: { enable_thinking: false },
  };
  const answer = record(await post(fetchFn, CHAT_COMPLETIONS_URL, call.apiKey, body, "token factory"));
  const choices = answer?.choices;
  const choice = Array.isArray(choices) ? record(choices[0]) : null;
  const message = record(choice?.message);
  const content = message?.content;
  if (typeof content !== "string") throw new AssistUnavailable("token factory: the answer has no message content");
  return { content, truncated: choice?.finish_reason === "length" };
}

/** One chat completion whose answer must match the named schema; anything else is unavailable. */
export async function chat<K extends ModelSchemaName>(fetchFn: Fetch, call: ChatCall<K>, now: () => Date): Promise<{ output: ModelOutputs[K]; model: ModelInfo }> {
  const { content, truncated } = await structuredChat(fetchFn, { apiKey: call.apiKey, model: call.model,
    schemaName: call.schema, schema: wireSchema(call.schema), maxTokens: call.maxTokens,
    messages: [{ role: "system", content: call.system }, { role: "user", content: call.user }] });
  if (truncated) throw new AssistUnavailable("token factory: the answer reached max_tokens");
  let parsed: unknown;
  try {
    parsed = parseContent(content);
  } catch {
    throw new AssistUnavailable("token factory: the answer is not JSON");
  }
  const errors = validateModelOutput(call.schema, parsed);
  if (errors.length > 0) throw new AssistUnavailable(`token factory: the answer does not match ${call.schema} (${errors.slice(0, 3).join(", ")})`);
  return { output: parsed as ModelOutputs[K], model: { provider: MODEL_PROVIDER, model_id: call.model, at: now().toISOString() } };
}

export interface SearchResult {
  title: string;
  url: string;
  excerpt: string;
}

export interface SearchCall {
  apiKey: string;
  query: string;
  maxResults: number;
  /** Only results that contain the query's quoted phrase. */
  exactMatch?: boolean;
  includeDomains?: readonly string[];
}

function httpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** One Tavily search; results without an http(s) URL are dropped, and excerpts are cut short. */
export async function search(fetchFn: Fetch, call: SearchCall): Promise<SearchResult[]> {
  const body: Record<string, unknown> = {
    query: call.query,
    search_depth: "basic",
    max_results: call.maxResults,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    auto_parameters: false,
  };
  if (call.exactMatch === true) body.exact_match = true;
  if (call.includeDomains !== undefined) body.include_domains = [...call.includeDomains];
  const answer = record(await post(fetchFn, TAVILY_SEARCH_URL, call.apiKey, body, "tavily"));
  const results = answer?.results;
  if (!Array.isArray(results)) throw new AssistUnavailable("tavily: the response has no results list");
  const found: SearchResult[] = [];
  for (const raw of results.slice(0, call.maxResults)) {
    const item = record(raw);
    const url = item?.url;
    if (typeof url !== "string" || !httpUrl(url) || found.some((result) => result.url === url)) continue;
    const title = typeof item?.title === "string" && item.title.trim() !== "" ? item.title.trim() : url;
    const excerpt = typeof item?.content === "string" ? item.content.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_CHARS) : "";
    found.push({ title: title.slice(0, 300), url, excerpt });
  }
  return found;
}
