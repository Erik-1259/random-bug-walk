// The bug designer's endpoints: POST /api/factory/assist/bug-shapes, /bug-spec and /delivery-brief. Each checks
// the factory session first (the factory routes' own check), then the body, the designer's scope, its
// configuration and its rate limits, and only then calls a provider. Every failure past the body answers
// a plain error, so the page shows "unavailable right now" and the request form works as before. A model
// answer refused for its scope is asked for once more, counted against the same limits, before the route
// answers refused; a provider failure is not retried. Only error names, codes and refusal reason codes
// are logged; no key, prompt or provider text is.
import { createHash } from "node:crypto";
import type { Capabilities, Case } from "@rbw/factory-contract";
import type { AssistConfig } from "../config.ts";
import { readBody } from "../factory-server/http.ts";
import type { FactoryServer } from "../factory-server/ports.ts";
import { FACTORY_SESSION_COOKIE, hasFactorySession } from "../factory-server/session.ts";
import { readBugCase } from "./bug-case.ts";
import { catalogPairs, checkedFit } from "./catalog.ts";
import { assistError, AssistUnavailable, rateLimited, sendJson } from "./http.ts";
import { MAX_TOKENS, NOVELTY_MAX_RESULTS, QUERY_MAX_CHARS, QUERY_MIN_CHARS, RateLimiter, SEARCH_MAX_RESULTS, type AssistRoute } from "./limits.ts";
import { distinctivePhrases, NOVELTY_CAVEAT } from "./novelty.ts";
import { APP_CONTEXT, briefPrompt, shapesPrompt, specPrompt, type BriefFacts, type CatalogPair } from "./prompts.ts";
import { chat, search, SEARCH_PROVIDER, type Fetch, type SearchResult } from "./providers.ts";
import { designSecurityTopic, holdsCode, securityTopic } from "./safety.ts";
import { validateBody, type BodySchemaName, type Bodies } from "./schemas.ts";

/** Public bug reports are searched on these hosts, as the search package's source searches are. */
export const REPORT_DOMAINS = ["github.com", "stackoverflow.com"] as const;
/** `after` past every event: a status read for its cases only. */
const NO_EVENTS = Number.MAX_SAFE_INTEGER;

export interface AssistDeps {
  config: AssistConfig;
  fetch: Fetch;
  limiter: RateLimiter;
  now: () => Date;
}

/**
 * Why a route answered refused, logged as a code only: the visitor's text named a security term, the
 * model marked the request out of scope, or the model's answer named one in this field.
 */
type RefusalReason = "input_security_term" | "model_out_of_scope" | `output_security_term:${string}`;

function refused(server: FactoryServer, route: AssistRoute, reason: RefusalReason, note = ""): Response {
  server.log(`assist ${route}: ${reason}${note}; answered refused`);
  return assistError("refused");
}

/** One model attempt: a usable answer, or the reason the whole answer is refused. */
type Attempt<T> = { ok: true; value: T } | { ok: false; reason: RefusalReason };

/**
 * Runs a model attempt, and once more when its answer is refused, taking the second call from the
 * route's limits; a second refusal, or no room in the limits, answers refused. A provider failure
 * throws out of the attempt and is not retried.
 */
async function retryRefused<T>(server: FactoryServer, deps: AssistDeps, route: AssistRoute, request: Request, attempt: () => Promise<Attempt<T>>): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const first = await attempt();
  if (first.ok) return first;
  if (limit(deps, route, request) !== null) return { ok: false, response: refused(server, route, first.reason, " (no retry: rate limited)") };
  server.log(`assist ${route}: ${first.reason}; retrying the model call once`);
  const second = await attempt();
  return second.ok ? second : { ok: false, response: refused(server, route, second.reason) };
}

/** The session's limiter key: a digest of its cookie, so the limiter never holds the cookie itself. */
function sessionKey(request: Request): string {
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${FACTORY_SESSION_COOKIE}=`));
  return createHash("sha256").update(cookie ?? "").digest("hex");
}

type Prepared<K extends BodySchemaName> = { ok: true; body: Bodies[K] } | { ok: false; response: Response };

/** The session and body checks every route runs first. */
async function prepare<K extends BodySchemaName>(request: Request, server: FactoryServer, name: K): Promise<Prepared<K>> {
  if (!hasFactorySession(request, server.ports.passcode)) return { ok: false, response: assistError("signed_out") };
  const body = await readBody(request);
  if (!body.ok) return { ok: false, response: assistError("invalid_request", body.message) };
  const errors = validateBody(name, body.value);
  if (errors.length > 0) return { ok: false, response: assistError("invalid_request", `The body does not match ${name}: ${errors.slice(0, 3).join(", ")}.`) };
  return { ok: true, body: body.value as Bodies[K] };
}

/** Takes one call from the limits, or answers rate_limited. */
function limit(deps: AssistDeps, route: AssistRoute, request: Request): Response | null {
  const taken = deps.limiter.take(route, sessionKey(request), deps.now().getTime());
  return taken.ok ? null : rateLimited(taken.retry_after_s);
}

/** Runs a route past its checks; a provider failure or an unexpected error answers assist_unavailable. */
async function guard(server: FactoryServer, route: AssistRoute, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    server.log(`assist ${route}: ${error instanceof AssistUnavailable ? error.message : `a dependency failed (${error.name})`}; answered assist_unavailable`);
    return assistError("assist_unavailable", error instanceof AssistUnavailable ? error.visible : undefined);
  }
}

function capabilitiesOf(server: FactoryServer, now: Date): Capabilities | null {
  try {
    return server.ports.capabilities(now);
  } catch {
    return null;
  }
}

const NO_FIT_REASON = "No proven catalog pair fits this shape.";

/** POST /api/factory/assist/bug-shapes { query }: public bug reports of the class, generalized into 3 to 5 shapes. */
export function postBugShapes(request: Request, server: FactoryServer, deps: AssistDeps): Promise<Response> {
  return guard(server, "bug-shapes", async () => {
    const prepared = await prepare(request, server, "bug-shapes");
    if (!prepared.ok) return prepared.response;
    const query = prepared.body.query.replace(/\s+/g, " ").trim();
    if (query.length < QUERY_MIN_CHARS || query.length > QUERY_MAX_CHARS) return assistError("invalid_request", `Describe the bug class in ${String(QUERY_MIN_CHARS)} to ${String(QUERY_MAX_CHARS)} characters.`);
    if (securityTopic(query)) return refused(server, "bug-shapes", "input_security_term");
    const { tokenFactoryKey, tavilyKey, model } = deps.config;
    if (tokenFactoryKey === null || tavilyKey === null) return assistError("assist_unavailable");
    const limited = limit(deps, "bug-shapes", request);
    if (limited !== null) return limited;

    const searchQuery = `${query} bug report`;
    const results = await search(deps.fetch, { apiKey: tavilyKey, query: searchQuery, maxResults: SEARCH_MAX_RESULTS, includeDomains: REPORT_DOMAINS });
    const searchedAt = deps.now().toISOString();
    if (results.length === 0) throw new AssistUnavailable("tavily: no results", "The web search found no public bug reports for this description. Try a broader description.");
    const capabilities = capabilitiesOf(server, deps.now());
    const pairs: CatalogPair[] = capabilities === null ? [] : catalogPairs(capabilities);
    const prompt = shapesPrompt(query, results, pairs);
    // One shape naming a security term is dropped; only an answer left with no shape for that reason is refused, and retried.
    const answered = await retryRefused(server, deps, "bug-shapes", request, async () => {
      const { output, model: info } = await chat(deps.fetch, { apiKey: tokenFactoryKey, model, schema: "bug_shapes", ...prompt, maxTokens: MAX_TOKENS["bug-shapes"] }, deps.now);
      if (!output.in_scope) return { ok: false, reason: "model_out_of_scope" };
      const shapes = output.shapes
        .filter((shape) => shapeSecurityField(shape) === null && !holdsCode(shape.summary))
        .map((shape) => ({ shape, sources: sourcesOf(results, shape.source_numbers) }))
        .filter((item) => item.sources.length > 0)
        .map(({ shape, sources }, index) => {
          const fit = shape.fit_host_id === "none" || shape.fit_bug_type_id === "none" ? null : checkedFit(pairs, shape.fit_host_id, shape.fit_bug_type_id, shape.fit_phrase);
          const reason = shape.fit_reason.trim();
          return { id: `shape-${String(index + 1)}`, title: shape.title.trim(), summary: shape.summary.trim(), sources, fit, fit_reason: fit === null ? NO_FIT_REASON : reason === "" ? "This shape matches a proven catalog pair." : reason };
        });
      if (shapes.length === 0) {
        const field = output.shapes.map(shapeSecurityField).find((name) => name !== null);
        if (field !== undefined) return { ok: false, reason: `output_security_term:${field}` };
        throw new AssistUnavailable("token factory: no usable shape", "The bug designer could not generalize these reports into bug shapes. Try another description.");
      }
      return { ok: true, value: { shapes, info } };
    });
    if (!answered.ok) return answered.response;
    const { shapes, info } = answered.value;
    return sendJson({ shapes, search: { provider: SEARCH_PROVIDER, query: searchQuery, at: searchedAt, result_count: results.length }, model: info });
  });
}

/**
 * The first field of a model's shape that names a security term, or null. Shapes take the input check,
 * since a shown shape is sent back as bug-spec input.
 */
function shapeSecurityField(shape: { title: string; summary: string; fit_reason: string }): "title" | "summary" | "fit_reason" | null {
  return (["title", "summary", "fit_reason"] as const).find((field) => securityTopic(shape[field])) ?? null;
}

/** The search results a shape names by number, each once, in the order named. */
function sourcesOf(results: readonly SearchResult[], numbers: readonly number[]): { title: string; url: string }[] {
  const seen = new Set<number>();
  const sources: { title: string; url: string }[] = [];
  for (const number of numbers) {
    const result = results[number - 1];
    if (result === undefined || seen.has(number)) continue;
    seen.add(number);
    sources.push({ title: result.title, url: result.url });
  }
  return sources;
}

/** POST /api/factory/assist/bug-spec { shape, host_id }: a component-level design of the shape in one target app. */
export function postBugSpec(request: Request, server: FactoryServer, deps: AssistDeps): Promise<Response> {
  return guard(server, "bug-spec", async () => {
    const prepared = await prepare(request, server, "bug-spec");
    if (!prepared.ok) return prepared.response;
    const { shape, host_id: host } = prepared.body;
    const clean = { title: shape.title.trim(), summary: shape.summary.trim(), sources: shape.sources.map((item) => ({ title: item.title, url: item.url })) };
    if (securityTopic(`${clean.title} ${clean.summary}`)) return refused(server, "bug-spec", "input_security_term");
    const { tokenFactoryKey, model } = deps.config;
    if (tokenFactoryKey === null) return assistError("assist_unavailable");
    const limited = limit(deps, "bug-spec", request);
    if (limited !== null) return limited;

    const baseline = capabilitiesOf(server, deps.now())?.hosts.find((item) => item.host_id === host)?.baseline_id ?? null;
    const prompt = specPrompt(clean, host, baseline);
    const answered = await retryRefused(server, deps, "bug-spec", request, async () => {
      const answer = await chat(deps.fetch, { apiKey: tokenFactoryKey, model, schema: "bug_spec", ...prompt, maxTokens: MAX_TOKENS["bug-spec"] }, deps.now);
      if (!answer.output.in_scope) return { ok: false, reason: "model_out_of_scope" };
      const field = specSecurityField(answer.output);
      return field === null ? { ok: true, value: answer } : { ok: false, reason: `output_security_term:${field}` };
    });
    if (!answered.ok) return answered.response;
    const { output, model: info } = answered.value;
    const fields = [output.title, output.where, output.change, output.why_tests_miss, output.fix, ...output.checks_to_add];
    if (fields.some(holdsCode)) throw new AssistUnavailable("token factory: the design holds code", "The bug designer did not write a component-level design this time. Try again.");
    const spec = {
      title: output.title.trim(),
      target_app: APP_CONTEXT[host].name,
      where: output.where.trim(),
      change: output.change.trim(),
      why_tests_miss: output.why_tests_miss.trim(),
      checks_to_add: output.checks_to_add.map((item) => item.trim()),
      fix: output.fix.trim(),
    };
    return sendJson({ spec, model: info });
  });
}

const SPEC_FIELDS = ["title", "where", "change", "why_tests_miss", "fix", "checks_to_add"] as const;

/** The first field of a model's design that names a security term under the output check, or null. */
function specSecurityField(output: Record<(typeof SPEC_FIELDS)[number], string | string[]>): (typeof SPEC_FIELDS)[number] | null {
  return SPEC_FIELDS.find((field) => [output[field]].flat().some(designSecurityTopic)) ?? null;
}

function briefFacts(delivered: Case, material: Awaited<ReturnType<typeof readBugCase>>, bugType: string): BriefFacts {
  return {
    title: delivered.title,
    app: delivered.host_label,
    baseline: delivered.baseline_id,
    bug_type: bugType,
    criteria: delivered.criteria_met.map((criterion) => criterion.label),
    observed_failure: delivered.summary.observed_failure,
    how_checked: delivered.summary.how_checked,
    original_suite_tests: delivered.matrix.original_suite.test_count,
    bug_case_file: delivered.packages.bug_case.filename,
    validator_file: delivered.packages.validator.filename,
    kit_image: material.kit_image,
    setup: material.setup,
    incident: material.incident,
  };
}

/**
 * POST /api/factory/assist/delivery-brief { request_id, case_id }: what the team received, written from the
 * delivered case's public material (its status entry and its bug-case archive, never the validator), and
 * the novelty check of the incident report's wording. A request that is not finished, or a case that is
 * not delivered with a ready bug case, answers not_found.
 */
export function postDeliveryBrief(request: Request, server: FactoryServer, deps: AssistDeps): Promise<Response> {
  return guard(server, "delivery-brief", async () => {
    const prepared = await prepare(request, server, "delivery-brief");
    if (!prepared.ok) return prepared.response;
    const { request_id: requestId, case_id: caseId } = prepared.body;
    const { tokenFactoryKey, tavilyKey, model } = deps.config;
    if (tokenFactoryKey === null || tavilyKey === null) return assistError("assist_unavailable");
    const status = await server.ports.status(requestId, NO_EVENTS, deps.now());
    const delivered = status?.state === "finished" ? status.cases.find((item) => item.case_id === caseId) : undefined;
    if (delivered?.packages.bug_case.ready !== true) return assistError("not_found");
    const limited = limit(deps, "delivery-brief", request);
    if (limited !== null) return limited;

    const material = await readBugCase(server, requestId, delivered);
    const bugType = capabilitiesOf(server, deps.now())?.bug_types.find((item) => item.bug_type_id === delivered.bug_type_id)?.label ?? delivered.bug_type_id;
    const prompt = briefPrompt(briefFacts(delivered, material, bugType));
    const phrases = distinctivePhrases(material.incident);
    // The model call and the phrase searches run side by side, so the route stays within one timeout.
    const [{ output, model: info }, found] = await Promise.all([
      chat(deps.fetch, { apiKey: tokenFactoryKey, model, schema: "delivery_brief", ...prompt, maxTokens: MAX_TOKENS["delivery-brief"] }, deps.now),
      Promise.all(phrases.map((phrase) => search(deps.fetch, { apiKey: tavilyKey, query: `"${phrase}"`, maxResults: NOVELTY_MAX_RESULTS, exactMatch: true }))),
    ]);
    const matches = phrases.flatMap((phrase, index) => (found[index] ?? []).map((result) => ({ phrase, url: result.url })));
    const brief = { what_it_is: output.what_it_is.trim(), how_to_run: output.how_to_run.trim(), how_to_validate: output.how_to_validate.trim() };
    return sendJson({
      brief,
      novelty: { provider: SEARCH_PROVIDER, checked_at: deps.now().toISOString(), phrases, public_matches: matches },
      caveat: NOVELTY_CAVEAT,
      model: info,
    });
  });
}
