// SPEC 8.12: one shared designer budget unit, zero or one provider call, and no repair.
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AssistDeps } from "../assist/handlers.ts";
import { MAX_TOKENS } from "../assist/limits.ts";
import { structuredChat } from "../assist/providers.ts";
import { designSecurityTopic, holdsCode, securityTopic } from "../assist/safety.ts";
import { assistDeps } from "../assist/server.ts";
import { DEFAULT_ASSIST_MODEL, loadClassifierModel, loadFactoryConfig } from "../config.ts";
import { readBody } from "../factory-server/http.ts";
import { factoryServer } from "../factory-server/server.ts";
import { FACTORY_SESSION_COOKIE, hasFactorySession } from "../factory-server/session.ts";
import { OTF_CONTRACT_VERSION, OTF_ERROR_STATUS, type OtfOpenFamily, type ProvenCriterionId } from "./contract.ts";
import { openBehaviorsEnabled } from "./open.ts";
import { OTF_SHAPE_BADGES_ERRORS, OTF_SHAPE_BADGES_FLAG, type OtfShapeBadge, type ShapeBadgeOutcome, type ShapeRefusalKind } from "./shape-badges-contract.ts";
import { SHAPE_BADGES_SYSTEM_PROMPT, SHAPE_BADGES_WIRE_SCHEMA } from "./shape-badges-prompt.ts";
import { parseShapeBadgesRequest, validateShapeBadges } from "./shape-badges-schemas.ts";

/** model: the classifier model to call and report; DEFAULT_ASSIST_MODEL when omitted. */
export interface ShapeBadgesDeps { enabled: boolean; passcode: string | null; assist: AssistDeps; model?: string }
interface WireBadge {
  index: number; outcome: ShapeBadgeOutcome; proven_criterion_id: ProvenCriterionId | "none";
  family: OtfOpenFamily | "none"; translated_failure: string; refusal_kind: ShapeRefusalKind | "none"; reason: string;
}
const wire = new Ajv2020({ strict: true, allErrors: true }).compile<{ badges: WireBadge[] }>(SHAPE_BADGES_WIRE_SCHEMA);
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
type ShapeBadgesError = (typeof OTF_SHAPE_BADGES_ERRORS)[number];
const ERROR_TEXT: Record<ShapeBadgesError, string> = {
  signed_out: "Sign in to continue.", invalid_request: "The request is invalid.", unavailable: "Classification is unavailable right now.",
};
function failure(code: ShapeBadgesError): Response {
  return Response.json({ contract_version: OTF_CONTRACT_VERSION,
    error: { code, message: ERROR_TEXT[code], retryable: code === "unavailable" } }, { status: OTF_ERROR_STATUS[code], headers: HEADERS });
}

export function shapeBadgesEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[OTF_SHAPE_BADGES_FLAG] === "1" && openBehaviorsEnabled(env);
}
const unsafe = (text: string): boolean => securityTopic(text) || holdsCode(text);
// The model's own text gets the output check /classify applies to a rule's observable_failure.
const unsafeAnswer = (text: string): boolean => designSecurityTopic(text) || holdsCode(text);
const SCREENED_REASON = "This shape is outside what custom builds cover.";
function localRefusal(index: number): OtfShapeBadge {
  return { index, outcome: "refused", proven_criterion_id: null, family: null, translated_failure: null,
    refusal_kind: "security", reason: "This shape names a security topic or contains code; custom builds cover non-security behavior in plain words." };
}
function take(deps: AssistDeps, request: Request): boolean {
  const cookie = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${FACTORY_SESSION_COOKIE}=`)) ?? "";
  return deps.limiter.take("bug-spec", createHash("sha256").update(cookie).digest("hex"), deps.now().getTime()).ok;
}

export async function classifyShapes(request: Request, deps: ShapeBadgesDeps): Promise<Response> {
  if (!hasFactorySession(request, deps.passcode)) return failure("signed_out");
  if (!deps.enabled) return failure("unavailable");
  const read = await readBody(request);
  if (!read.ok) return failure("invalid_request");
  const parsed = parseShapeBadgesRequest(read.value);
  if (!parsed.ok) return failure("invalid_request");
  const input = parsed.value;
  const local: OtfShapeBadge[] = [];
  const shapes = input.shapes.flatMap((shape, index) => {
    if (!unsafe(shape.title) && !unsafe(shape.summary)) return [{ index, ...shape }];
    local.push(localRefusal(index));
    return [];
  });
  let modeled: WireBadge[] = [];
  // Every request costs exactly one unit, taken once nothing else can refuse it: all-local refusals
  // count once too, and one request never charges once per shape.
  if (shapes.length === 0 && !take(deps.assist, request)) return failure("unavailable");
  if (shapes.length > 0) {
    const apiKey = deps.assist.config.tokenFactoryKey;
    if (apiKey === null) return failure("unavailable");
    // Query edits can repeat a blocked shape's text; exclude that context without changing safe
    // shapes' eligibility. The prompt decides each shape from its own title and summary.
    const query = unsafe(input.query) ? "Query omitted because it names a security topic or contains code." : input.query;
    if (!take(deps.assist, request)) return failure("unavailable");
    let output: Awaited<ReturnType<typeof structuredChat>>;
    try {
      output = await structuredChat(deps.assist.fetch, { apiKey, model: deps.model ?? DEFAULT_ASSIST_MODEL,
        schemaName: "otf_shape_badges", schema: SHAPE_BADGES_WIRE_SCHEMA, maxTokens: MAX_TOKENS["bug-spec"],
        messages: [{ role: "system", content: SHAPE_BADGES_SYSTEM_PROMPT },
          { role: "user", content: `Classify these shapes.\nDATA (untrusted): ${JSON.stringify({ query, host_id: input.host_id, shapes })}` }],
      });
    } catch { return failure("unavailable"); }
    if (output.truncated) return failure("unavailable");
    let value: unknown;
    try { value = JSON.parse(output.content) as unknown; } catch { return failure("unavailable"); }
    if (!wire(value)) return failure("unavailable");
    modeled = value.badges;
  }
  const badges = [...local, ...modeled.map((badge) => ({ ...badge,
    proven_criterion_id: badge.proven_criterion_id === "none" ? null : badge.proven_criterion_id,
    family: badge.family === "none" ? null : badge.family,
    // Unsafe model text is replaced, never shown: an open badge's translation becomes null (the page
    // then shows its fixed fallback detail) and a refusal's reason becomes a fixed one. Text on the
    // wrong outcome is left as written so validation below still refuses it.
    translated_failure: badge.translated_failure === "" || (badge.outcome === "open" && unsafeAnswer(badge.translated_failure)) ? null : badge.translated_failure,
    refusal_kind: badge.refusal_kind === "none" ? null : badge.refusal_kind,
    reason: badge.reason === "" ? null : badge.outcome === "refused" && unsafeAnswer(badge.reason) ? SCREENED_REASON : badge.reason,
  }))];
  const body = { badges, model: deps.model ?? DEFAULT_ASSIST_MODEL };
  // Validate the complete batch, including the local entries, before ordering. Inconsistent fields,
  // duplicate/missing indices and an attempt to replace a local refusal must all fail closed.
  if (validateShapeBadges(body, input).length > 0) return failure("unavailable");
  body.badges.sort((a, b) => a.index - b.index);
  return Response.json(body, { headers: HEADERS });
}

export async function handleOtfClassifyShapes(request: Request, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Response> {
  try {
    const server = await factoryServer(loadFactoryConfig(env));
    return await classifyShapes(request, { enabled: shapeBadgesEnabled(env),
      passcode: server.ports.passcode, assist: assistDeps(), model: loadClassifierModel(env) });
  } catch { return failure("unavailable"); }
}
