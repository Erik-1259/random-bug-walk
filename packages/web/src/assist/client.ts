// Browser client for the bug designer and the delivery brief (/api/assist/*). These calls are
// optional help on /factory: every failure comes back as a plain outcome, never an exception, so
// the request form keeps working exactly as before whatever the assist service does. Responses
// are checked field by field; anything unreadable counts as "unavailable", never as a result.
// Erasable syntax only (type imports, no enums), like src/factory/format.ts.

export type AssistHostId = "umami" | "task-report";
export const ASSIST_HOSTS: readonly AssistHostId[] = ["umami", "task-report"];
export const QUERY_MIN_CHARS = 3;
export const QUERY_MAX_CHARS = 300;

export interface ShapeSource { title: string; url: string }
export interface ShapeFit { host_id: AssistHostId; bug_type_id: string; phrase: string }
export interface BugShape { id: string; title: string; summary: string; sources: ShapeSource[]; fit: ShapeFit | null; fit_reason: string }
export interface ModelInfo { provider: "nebius-token-factory"; model_id: string; at: string }
export interface SearchInfo { provider: "tavily"; query: string; at: string; result_count: number }
export interface ShapesResult { shapes: BugShape[]; search: SearchInfo; model: ModelInfo }
export interface BugSpec { title: string; target_app: string; where: string; change: string; why_tests_miss: string; checks_to_add: string[]; fix: string }
export interface SpecResult { spec: BugSpec; model: ModelInfo }
export interface DeliveryBrief { what_it_is: string; how_to_run: string; how_to_validate: string }
export interface NoveltyCheck { provider: "tavily"; checked_at: string; phrases: string[]; public_matches: { phrase: string; url: string }[] }
export interface BriefResult { brief: DeliveryBrief; novelty: NoveltyCheck; caveat: string; model: ModelInfo }

export type AssistFailureCode = "signed_out" | "refused" | "rate_limited" | "unavailable" | "invalid_request";
export interface AssistFailure { code: AssistFailureCode; message: string | null; retryAfterS: number | null }
export type AssistOutcome<T> = { ok: true; value: T } | { ok: false; failure: AssistFailure };

export interface AssistClient {
  bugShapes(query: string): Promise<AssistOutcome<ShapesResult>>;
  bugSpec(shape: Pick<BugShape, "title" | "summary" | "sources">, hostId: AssistHostId): Promise<AssistOutcome<SpecResult>>;
  deliveryBrief(requestId: string, caseId: string): Promise<AssistOutcome<BriefResult>>;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isHost = (value: unknown): value is AssistHostId => typeof value === "string" && (ASSIST_HOSTS as readonly string[]).includes(value);

/** Only plain web links are shown; a model or search result can never put another scheme on the page. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

function parseModel(value: unknown): ModelInfo | null {
  if (!isRecord(value) || value.provider !== "nebius-token-factory" || !isText(value.model_id) || !isTime(value.at)) return null;
  return { provider: "nebius-token-factory", model_id: value.model_id, at: value.at };
}

function parseSources(value: unknown): ShapeSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((source) => {
    if (!isRecord(source)) return [];
    const url = safeUrl(source.url);
    return url === null ? [] : [{ title: isText(source.title) ? source.title : url, url }];
  });
}

function parseFit(value: unknown): ShapeFit | null {
  if (!isRecord(value) || !isHost(value.host_id) || !isText(value.bug_type_id) || !isText(value.phrase)) return null;
  return { host_id: value.host_id, bug_type_id: value.bug_type_id, phrase: value.phrase };
}

export function parseShapes(data: unknown): ShapesResult | null {
  if (!isRecord(data) || !Array.isArray(data.shapes) || !isRecord(data.search)) return null;
  const model = parseModel(data.model);
  const search = data.search;
  if (model === null || search.provider !== "tavily" || typeof search.query !== "string" || !isTime(search.at) || typeof search.result_count !== "number") return null;
  const shapes = data.shapes.flatMap((shape: unknown, index): BugShape[] => {
    if (!isRecord(shape) || !isText(shape.title) || !isText(shape.summary)) return [];
    return [{ id: isText(shape.id) ? shape.id : `shape-${String(index + 1)}`, title: shape.title, summary: shape.summary, sources: parseSources(shape.sources),
      fit: parseFit(shape.fit), fit_reason: typeof shape.fit_reason === "string" ? shape.fit_reason : "" }];
  });
  if (shapes.length === 0) return null;
  return { shapes, search: { provider: "tavily", query: search.query, at: search.at, result_count: search.result_count }, model };
}

export function parseSpec(data: unknown): SpecResult | null {
  if (!isRecord(data) || !isRecord(data.spec)) return null;
  const model = parseModel(data.model);
  const spec = data.spec;
  const fields = [spec.title, spec.target_app, spec.where, spec.change, spec.why_tests_miss, spec.fix];
  if (model === null || !fields.every(isText) || !Array.isArray(spec.checks_to_add)) return null;
  return { spec: { title: spec.title as string, target_app: spec.target_app as string, where: spec.where as string, change: spec.change as string,
    why_tests_miss: spec.why_tests_miss as string, checks_to_add: spec.checks_to_add.filter(isText), fix: spec.fix as string }, model };
}

export function parseBrief(data: unknown): BriefResult | null {
  if (!isRecord(data) || !isRecord(data.brief) || !isRecord(data.novelty) || !isText(data.caveat)) return null;
  const model = parseModel(data.model);
  const { brief, novelty } = data;
  if (model === null || !isText(brief.what_it_is) || !isText(brief.how_to_run) || !isText(brief.how_to_validate)) return null;
  if (novelty.provider !== "tavily" || !isTime(novelty.checked_at) || !Array.isArray(novelty.phrases) || !Array.isArray(novelty.public_matches)) return null;
  const matches = novelty.public_matches.flatMap((match: unknown) => {
    if (!isRecord(match) || typeof match.phrase !== "string") return [];
    const url = safeUrl(match.url);
    return url === null ? [] : [{ phrase: match.phrase, url }];
  });
  return { brief: { what_it_is: brief.what_it_is, how_to_run: brief.how_to_run, how_to_validate: brief.how_to_validate },
    novelty: { provider: "tavily", checked_at: novelty.checked_at, phrases: novelty.phrases.filter(isText), public_matches: matches }, caveat: data.caveat, model };
}

const KNOWN_CODES: readonly AssistFailureCode[] = ["signed_out", "refused", "rate_limited", "unavailable", "invalid_request"];

/** The service's error envelope as a failure; an unknown code or shape reads as unavailable. */
export function parseFailure(status: number, data: unknown): AssistFailure {
  const error = isRecord(data) && isRecord(data.error) ? data.error : null;
  const raw = error !== null && typeof error.code === "string" ? error.code : null;
  const code: AssistFailureCode = raw === "assist_unavailable" ? "unavailable"
    : raw !== null && (KNOWN_CODES as readonly string[]).includes(raw) ? raw as AssistFailureCode
    : status === 401 ? "signed_out" : status === 429 ? "rate_limited" : status === 422 ? "refused" : "unavailable";
  const message = error !== null && isText(error.message) ? error.message : null;
  const retry = error !== null && typeof error.retry_after_s === "number" && Number.isFinite(error.retry_after_s) && error.retry_after_s >= 0 ? Math.ceil(error.retry_after_s) : null;
  return { code, message, retryAfterS: code === "rate_limited" ? retry : null };
}

const UNAVAILABLE: AssistFailure = { code: "unavailable", message: null, retryAfterS: null };

/** Model calls take a while; past this the browser gives up and shows the "unavailable" note. */
export const ASSIST_TIMEOUT_MS = 75_000;

export function createAssistClient(fetcher: typeof fetch = fetch, timeoutMs = ASSIST_TIMEOUT_MS): AssistClient {
  async function call<T>(path: string, body: unknown, parse: (data: unknown) => T | null): Promise<AssistOutcome<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const response = await fetcher(`/api/assist/${path}`, { method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let data: unknown = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) return { ok: false, failure: parseFailure(response.status, data) };
      const value = parse(data);
      return value === null ? { ok: false, failure: UNAVAILABLE } : { ok: true, value };
    } catch {
      return { ok: false, failure: UNAVAILABLE };
    } finally { clearTimeout(timeout); }
  }
  return {
    bugShapes: (query) => call("bug-shapes", { query }, parseShapes),
    bugSpec: (shape, hostId) => call("bug-spec", { shape: { title: shape.title, summary: shape.summary, sources: shape.sources }, host_id: hostId }, parseSpec),
    deliveryBrief: (requestId, caseId) => call("delivery-brief", { request_id: requestId, case_id: caseId }, parseBrief),
  };
}

export const assistClient = createAssistClient();

/** A query the service accepts: 3 to 300 characters after trimming. */
export function queryProblem(query: string): string | null {
  const length = Array.from(query.trim()).length;
  if (length < QUERY_MIN_CHARS) return `Type at least ${String(QUERY_MIN_CHARS)} characters.`;
  if (length > QUERY_MAX_CHARS) return `Keep it to ${String(QUERY_MAX_CHARS)} characters or fewer.`;
  return null;
}
