// SPEC section 8.5: one structured designer call and at most one repair, never a builder or tools.
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AssistDeps } from "../assist/handlers.ts";
import { MAX_TOKENS } from "../assist/limits.ts";
import { structuredChat } from "../assist/providers.ts";
import { designSecurityTopic, holdsCode, securityTopic } from "../assist/safety.ts";
import { assistDeps } from "../assist/server.ts";
import { DEFAULT_ASSIST_MODEL, loadClassifierModel, loadFactoryConfig, loadOtfConfig, otfConfigured } from "../config.ts";
import { readBody } from "../factory-server/http.ts";
import { factoryServer } from "../factory-server/server.ts";
import { FACTORY_SESSION_COOKIE, hasFactorySession } from "../factory-server/session.ts";
import { CLASSIFY_SYSTEM_PROMPT, CLASSIFY_WIRE_SCHEMA } from "./classify-prompt.ts";
import { CRITERION_HOST, OTF_CONTRACT_VERSION, OTF_ERROR_STATUS, OTF_OPEN_CRITERION_ID,
  type OtfClassification, type OtfClassifyRefusalKind, type OtfHostId, type OtfOpenFamily, type ProvenCriterionId } from "./contract.ts";
import { openBehaviorsEnabled } from "./open.ts";
import { parseOtf } from "./schemas.ts";

/** The classifier's default model; RBW_OTF_CLASSIFIER_MODEL replaces it at runtime. */
export const CLASSIFIER_MODEL = DEFAULT_ASSIST_MODEL;
/** model: the classifier model to call and report; CLASSIFIER_MODEL when omitted. */
export interface ClassifyDeps { enabled: boolean; passcode: string | null; assist: AssistDeps; model?: string }
type ClassifyError = "signed_out" | "invalid_request" | "refused_topic" | "unavailable";
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const ERROR_TEXT: Record<ClassifyError, string> = {
  signed_out: "Sign in to continue.", invalid_request: "The request is invalid.",
  refused_topic: "This request is outside the supported design topics.", unavailable: "Classification is unavailable right now.",
};
function failure(code: ClassifyError): Response {
  return Response.json({ contract_version: OTF_CONTRACT_VERSION,
    error: { code, message: ERROR_TEXT[code], retryable: code === "unavailable" } }, { status: OTF_ERROR_STATUS[code], headers: HEADERS });
}
function answer(value: OtfClassification): Response { return Response.json(value, { headers: HEADERS }); }
function refusal(kind: OtfClassifyRefusalKind, reason: string, model: string): OtfClassification {
  return { family: null, proven_criterion_id: null, buildable: [], rule: null, refusal: { kind, reason }, model };
}
const SECURITY_REASON = "Security topics are outside the supported design scope.";
const NO_RULE_REASON = "This card could not be translated into a usable check through the task-report routes. Try describing a saved value or report result that differs from the expected result.";
interface Wire {
  decision: "proven" | "open" | "security" | "out_of_scope";
  proven_criterion_id: ProvenCriterionId | "none";
  family: OtfOpenFamily | "none";
  observable_failure: string;
  failure_code: string;
  reason: string;
}
const wire = new Ajv2020({ strict: true, allErrors: true }).compile<Wire>(CLASSIFY_WIRE_SCHEMA);
const METHODS: Readonly<Record<string, readonly string[]>> = {
  "/api/heartbeat": ["GET"], "/api/tasks": ["POST"], "/api/tasks/{id}": ["GET", "PATCH"],
  "/api/tasks/{id}/completions": ["POST"], "/api/reports/completions/daily": ["GET"],
};
const METHOD = "(?:GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)";
/** A path may open after whitespace or one of these characters, and nothing else (so "/v2/api/..." is not a task-report route). */
const OPENERS = "(\\[\"'`";
/** One method or a group such as "GET|PATCH", "GET or PATCH" or "GET, PATCH" written directly before a path. */
const DIRECT_METHODS = new RegExp(`(?<![\\w/|-])(${METHOD}(?:\\s*(?:[|/,]|\\b(?:and|or)\\b)\\s*${METHOD})*)\\s+[${OPENERS}]?$`);
/** One method followed by at most three filler words, such as "a PATCH request to" or "PATCH requests to". */
const FILLER_METHOD = new RegExp(`(?<![\\w/|-])(${METHOD})(?:\\s+(?:a|an|the|request|requests|call|calls|to|on|against)){1,3}\\s+[${OPENERS}]?$`);
const METHOD_TOKEN = new RegExp(`(?<![\\w-])${METHOD}(?![\\w-])`, "g");
/** A whole token that holds "/api/", starting at a boundary, so "https://host/api/..." is caught and refused too. */
const API_TOKEN = new RegExp(`(?<![^\\s${OPENERS}])[^\\s<>${OPENERS}]*\\/api\\/[^\\s<>"'\`]*`, "g");
const ROUTE_LIST = "GET /api/heartbeat, POST /api/tasks, GET /api/tasks/{id}, PATCH /api/tasks/{id}, POST /api/tasks/{id}/completions, GET /api/reports/completions/daily";
const WRITE_ROUTES = 'write each route as "METHOD /path", such as "PATCH /api/tasks/{id}"';
const ROUTED_METHODS = new Set(Object.values(METHODS).flat());
const METHOD_GROUP_SPLIT = /\s*(?:[|/,]|\b(?:and|or)\b)\s*/;
/**
 * Quoted data: "...", “...” or '...', where a single quote opens or closes only with no letter or digit directly
 * outside it (so the apostrophe in "task's" starts nothing). An unpaired quote matches nothing. Backticks are not
 * data, because models format routes as code.
 */
const QUOTED = /"[^"]*"|“[^”]*”|(?<![\p{L}\p{N}])'(?:[^']|'(?=[\p{L}\p{N}]))*?'(?![\p{L}\p{N}])/gu;
/** Every quoted span becomes spaces of the same length, so indexes still line up and nothing inside it is read. */
function maskQuoted(text: string): string { return text.replace(QUOTED, (span) => " ".repeat(span.length)); }
/** A sentence ends at ". ", "; ", "! ", "? " or the end of the text. */
const SENTENCE_BREAK = /[.;!?] /g;
type Span = readonly [start: number, end: number];
function inside(spans: readonly Span[], index: number): boolean { return spans.some(([start, end]) => index >= start && index < end); }
/**
 * Every named API path must be one of the six task-report routes. A method attached to a path ("METHOD /path",
 * a group such as "GET|PATCH /path", or "a PATCH request to /path") must be allowed for that route; a path with
 * no attached method only has to exist. A method that no route allows at all is refused wherever it appears. A
 * GET, POST or PATCH that stands apart from any path must be allowed for at least one route named in its own
 * sentence (a sentence that names no route refers back and is not checked). Quoted data is masked before any of
 * these checks, so a method, path or sentence break inside it counts for nothing; text inside backticks still counts.
 */
export function ruleRouteProblems(rule: string): string[] {
  const text = maskQuoted(rule);
  const tokens = [...text.matchAll(API_TOKEN)];
  if (tokens.length === 0) return [`observable_failure must name at least one task-report route; ${WRITE_ROUTES}`];
  const breaks = [...text.matchAll(SENTENCE_BREAK)].map((found) => found.index);
  const sentenceOf = (index: number): number => breaks.filter((end) => end < index).length;
  const attached: Span[] = [];
  const sentenceAllows = new Map<number, Set<string>>();
  const attachedRefusals = new Set<string>();
  const problems: string[] = [];
  for (const found of tokens) {
    const before = text.slice(0, found.index);
    const direct = DIRECT_METHODS.exec(before);
    const match = direct ?? FILLER_METHOD.exec(before);
    const group = match?.[1];
    if (match !== null && group !== undefined) attached.push([match.index, match.index + group.length]);
    const path = (found[0].split("?")[0] ?? "").replace(/[\]).,;:!?"'`]+$/, "");
    const allowed = METHODS[path];
    if (allowed === undefined) {
      problems.push(`${path} is not one of the six task-report routes (${ROUTE_LIST}); ${WRITE_ROUTES}`);
      continue;
    }
    const sentence = sentenceOf(found.index);
    sentenceAllows.set(sentence, new Set([...(sentenceAllows.get(sentence) ?? []), ...allowed]));
    const methods = group === undefined ? [] : direct === null ? [group] : group.split(METHOD_GROUP_SPLIT);
    for (const method of methods.filter((method) => !allowed.includes(method))) {
      attachedRefusals.add(method);
      problems.push(`${method} is not allowed for ${path} (allowed: ${allowed.join(", ")}); ${WRITE_ROUTES}`);
    }
  }
  for (const token of text.matchAll(METHOD_TOKEN)) {
    const method = token[0];
    if (!ROUTED_METHODS.has(method)) {
      if (!attachedRefusals.has(method)) problems.push(`the task-report service has no ${method} route (${ROUTE_LIST}); ${WRITE_ROUTES}`);
      continue;
    }
    const named = sentenceAllows.get(sentenceOf(token.index));
    if (named === undefined || named.has(method) || inside(attached, token.index)) continue;
    problems.push(`${method} is not allowed for the routes named in this sentence (allowed: ${[...named].join(", ")}); ${WRITE_ROUTES}`);
  }
  return [...new Set(problems)];
}
/** A failed answer keeps its wire decision when it had one, so two failed security decisions still refuse as security. */
type Mapped = { value: OtfClassification; problems?: never } | { problems: string[]; decision?: unknown; value?: never };
function mapped(content: string, truncated: boolean, host: OtfHostId | undefined, model: string): Mapped {
  if (truncated) return { problems: ["the answer ended before completion"] };
  let value: unknown;
  try { value = JSON.parse(content) as unknown; } catch { return { problems: ["the answer must be one JSON object"] }; }
  const decision = typeof value === "object" && value !== null ? (value as Record<string, unknown>).decision : undefined;
  if (!wire(value)) return { problems: (wire.errors ?? []).map((error) => `${error.instancePath || "/"}: ${error.message ?? "invalid"}`), decision };
  let classification: OtfClassification;
  if (value.decision === "security" || value.decision === "out_of_scope") {
    if (value.family !== "none" || value.proven_criterion_id !== "none" || value.observable_failure !== "" || value.failure_code !== "") return { problems: ["a refusal must leave its unused fields empty or none"], decision };
    classification = refusal(value.decision, value.reason.trim(), model);
  } else if (value.decision === "proven") {
    if (value.proven_criterion_id === "none" || value.family !== value.proven_criterion_id.split(".")[0] || value.observable_failure !== "" || value.failure_code !== "") return { problems: ["a proven match must use the criterion's family and leave rule fields empty"] };
    if (host === "umami" && value.proven_criterion_id !== "date_time.time-zone-grouping") return { problems: ["an Umami card outside time-zone grouping needs an open task-report translation or out_of_scope"] };
    classification = { family: value.family as OtfOpenFamily, proven_criterion_id: value.proven_criterion_id,
      buildable: [{ host_id: CRITERION_HOST[value.proven_criterion_id], criterion_id: value.proven_criterion_id }], rule: null, refusal: null, model };
  } else {
    if (value.proven_criterion_id !== "none" || value.family === "none") return { problems: ["an open answer must name its family and no proven criterion"] };
    if (designSecurityTopic(value.observable_failure)) return { value: refusal("security", SECURITY_REASON, model) };
    if (holdsCode(value.observable_failure)) return { problems: ["the rule must be plain text, not source code"] };
    const problems = ruleRouteProblems(value.observable_failure);
    if (problems.length > 0) return { problems };
    classification = { family: value.family, proven_criterion_id: null,
      buildable: [{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }],
      rule: { family: value.family, observable_failure: value.observable_failure, failure_code: value.failure_code }, refusal: null, model };
  }
  const checked = parseOtf("OtfClassification", classification);
  return checked.ok ? { value: checked.value } : { problems: checked.errors, decision };
}
/** The same cookie digest and bug-spec budget as the designer, including the possible repair call. */
function take(deps: AssistDeps, request: Request): boolean {
  const cookie = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${FACTORY_SESSION_COOKIE}=`)) ?? "";
  return deps.limiter.take("bug-spec", createHash("sha256").update(cookie).digest("hex"), deps.now().getTime()).ok;
}

export async function classify(request: Request, deps: ClassifyDeps): Promise<Response> {
  if (!hasFactorySession(request, deps.passcode)) return failure("signed_out");
  if (!deps.enabled) return failure("unavailable");
  const read = await readBody(request);
  if (!read.ok) return failure("invalid_request");
  const parsed = parseOtf("OtfClassifyRequest", read.value);
  if (!parsed.ok) return failure("invalid_request");
  const { sentence, spec, host_id } = parsed.value;
  const fields = [spec.title, spec.where, spec.change, spec.why_tests_miss, spec.fix, ...spec.checks_to_add];
  // SPEC 8.5: the existing safety checks answer refused_topic before any model call.
  if (securityTopic(sentence) || fields.some(designSecurityTopic)) return failure("refused_topic");
  if ([sentence, ...fields].some(holdsCode)) return failure("refused_topic");
  const model = deps.model ?? CLASSIFIER_MODEL;
  const apiKey = deps.assist.config.tokenFactoryKey;
  if (apiKey === null) return failure("unavailable");
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
    { role: "user", content: `Classify this card.\nDATA (untrusted): ${JSON.stringify({ app: host_id ?? "unspecified", sentence, spec })}` },
  ];
  let securityDecisions = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!take(deps.assist, request)) return failure("unavailable");
    let output: Awaited<ReturnType<typeof structuredChat>>;
    try {
      output = await structuredChat(deps.assist.fetch, { apiKey, model,
        schemaName: "otf_classification", schema: CLASSIFY_WIRE_SCHEMA, messages, maxTokens: MAX_TOKENS["bug-spec"] });
    } catch { return failure("unavailable"); }
    const checked = mapped(output.content, output.truncated, host_id, model);
    if (checked.value !== undefined) return answer(checked.value);
    if (checked.decision === "security") securityDecisions++;
    messages.push({ role: "assistant", content: output.content },
      { role: "user", content: `Repair these problems: ${checked.problems.join("; ")}. Return JSON matching the schema. A rule must use only the six routes with their allowed methods. out_of_scope is acceptable when there is no route-level equivalent.` });
  }
  return answer(securityDecisions === 2 ? refusal("security", SECURITY_REASON, model) : refusal("out_of_scope", NO_RULE_REASON, model));
}

/** Runtime configuration reads the designer's existing key and never creates a new provider client. */
export async function handleOtfClassify(request: Request): Promise<Response> {
  try {
    // The same session check as the bug-spec route: a refused test-mode server signs nobody in.
    const config = loadFactoryConfig();
    const server = await factoryServer(config);
    // Match the customer routes: local test mode supplies its own hosts and in-memory store.
    const enabled = config.mode === "test" || otfConfigured(loadOtfConfig());
    return await classify(request, { enabled: openBehaviorsEnabled() && enabled,
      passcode: server.ports.passcode, assist: assistDeps(), model: loadClassifierModel() });
  } catch { return failure("unavailable"); }
}
