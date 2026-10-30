import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RateLimiter, SESSION_LIMITS } from "../../src/assist/limits.ts";
import { CHAT_COMPLETIONS_URL } from "../../src/assist/providers.ts";
import type { AssistDeps } from "../../src/assist/handlers.ts";
import { DEFAULT_ASSIST_MODEL } from "../../src/config.ts";
import { factorySessionCookie } from "../../src/factory-server/session.ts";
import { classifyShapes, shapeBadgesEnabled } from "../../src/otf/classify-shapes.ts";
import { parseOtf } from "../../src/otf/schemas.ts";
import { OTF_CLASSIFY_SHAPES_PATH, type OtfShapeBadgesRequest } from "../../src/otf/shape-badges-contract.ts";
import { parseShapeBadges } from "../../src/otf/shape-badges-schemas.ts";

const PASSCODE = "synthetic-shape-badges-passcode";
const NOW = new Date("2026-10-30T00:00:00Z");
const SAFE_SHAPE = { title: "Synthetic note round trip", summary: "A saved note comes back with its commas removed." };
const UNSAFE_SHAPE = { title: "Synthetic permissions problem", summary: "A task is readable without permission." };
const INPUT: OtfShapeBadgesRequest = {
  query: "Saved notes change after a write", host_id: "task-report",
  shapes: [SAFE_SHAPE],
};
const OPEN = { index: 0, outcome: "open", proven_criterion_id: "none", family: "data_handling",
  translated_failure: "A saved task note comes back with its commas removed.", refusal_kind: "none", reason: "" };
const REFUSED = { index: 0, outcome: "refused", proven_criterion_id: "none", family: "none",
  translated_failure: "", refusal_kind: "out_of_scope", reason: "This behavior has no task-report equivalent." };
const PROVEN = { index: 0, outcome: "proven", proven_criterion_id: "concurrency.stale-success-response", family: "concurrency",
  translated_failure: "", refusal_kind: "none", reason: "" };
const UNSAFE: OtfShapeBadgesRequest = { ...INPUT, shapes: [UNSAFE_SHAPE] };

function request(input: unknown = INPUT, signedIn = true): Request {
  return new Request(`https://synthetic.invalid${OTF_CLASSIFY_SHAPES_PATH}`, { method: "POST",
    headers: { "content-type": "application/json", ...(signedIn ? { cookie: factorySessionCookie(PASSCODE) } : {}) }, body: JSON.stringify(input) });
}
function modelReply(answer: unknown, finishReason = "stop"): Response {
  return Response.json({ choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) }, finish_reason: finishReason }] });
}
function setup(answer: unknown = { badges: [OPEN] }) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const assist: AssistDeps = {
    config: { tokenFactoryKey: "synthetic-token-factory-key", tavilyKey: null, model: "synthetic/other-designer" },
    now: () => NOW, limiter: new RateLimiter(),
    fetch: (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : String(url), body: JSON.parse(typeof init?.body === "string" ? init.body : "") as Record<string, unknown>, headers: new Headers(init?.headers) });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer instanceof Response ? answer : modelReply(answer));
    },
  };
  return { deps: { enabled: true, passcode: PASSCODE as string | null, assist }, calls };
}
async function result(response: Response, input: OtfShapeBadgesRequest = INPUT) {
  expect(response.status).toBe(200);
  const parsed = parseShapeBadges(await response.json(), input);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}
async function errorCode(response: Response, status: number): Promise<string> {
  expect(response.status).toBe(status);
  const parsed = parseOtf("OtfErrorBody", await response.json());
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value.error.code;
}
function fillBudget(limiter: RateLimiter, count: number): void {
  const cookie = factorySessionCookie(PASSCODE).split(";")[0] ?? "";
  const session = createHash("sha256").update(cookie).digest("hex");
  for (let index = 0; index < count; index++) expect(limiter.take("bug-spec", session, NOW.getTime()).ok).toBe(true);
}

describe("shape badge request gates and shared budget", () => {
  it("requires both flags to have the exact enabled value", () => {
    const values = [undefined, "", "0", "true", " 1", "1 ", "1"];
    for (const open of values) for (const badges of values) {
      expect(shapeBadgesEnabled({ RBW_OTF_OPEN_BEHAVIORS: open, RBW_OTF_SHAPE_BADGES: badges })).toBe(open === "1" && badges === "1");
    }
  });
  it("requires a signed-in judge before checking configuration or spending budget", async () => {
    const s = setup(); s.deps.enabled = false;
    const take = vi.spyOn(s.deps.assist.limiter, "take");
    expect(await errorCode(await classifyShapes(request(INPUT, false), s.deps), 401)).toBe("signed_out");
    expect(s.calls).toHaveLength(0); expect(take).not.toHaveBeenCalled();
  });
  it("does not accept a cookie when the server refuses sessions", async () => {
    const s = setup(); s.deps.passcode = null;
    expect(await errorCode(await classifyShapes(request(), s.deps), 401)).toBe("signed_out");
    expect(s.calls).toHaveLength(0);
  });
  it("answers unavailable when disabled without a provider call or budget charge", async () => {
    const s = setup(); s.deps.enabled = false;
    const take = vi.spyOn(s.deps.assist.limiter, "take");
    expect(await errorCode(await classifyShapes(request(), s.deps), 503)).toBe("unavailable");
    expect(s.calls).toHaveLength(0); expect(take).not.toHaveBeenCalled();
  });
  it.each([
    ["unknown request field", { ...INPUT, extra: true }],
    ["missing host", { query: INPUT.query, shapes: INPUT.shapes }],
    ["no shapes", { ...INPUT, shapes: [] }],
    ["too many shapes", { ...INPUT, shapes: Array.from({ length: 6 }, () => SAFE_SHAPE) }],
    ["unknown shape field", { ...INPUT, shapes: [{ ...SAFE_SHAPE, extra: true }] }],
  ])("refuses %s before spending budget", async (_label, body) => {
    const s = setup(); const take = vi.spyOn(s.deps.assist.limiter, "take");
    expect(await errorCode(await classifyShapes(request(body), s.deps), 400)).toBe("invalid_request");
    expect(s.calls).toHaveLength(0); expect(take).not.toHaveBeenCalled();
  });
  it("spends one shared bug-spec unit for several badges and stops at that session's budget", async () => {
    const input = { ...INPUT, shapes: [SAFE_SHAPE, { title: "Synthetic stale response", summary: "Two overlapping writes return a stale value." }] };
    const s = setup({ badges: [OPEN, { ...PROVEN, index: 1 }] });
    fillBudget(s.deps.assist.limiter, SESSION_LIMITS["bug-spec"] - 1);
    const take = vi.spyOn(s.deps.assist.limiter, "take");
    expect((await result(await classifyShapes(request(input), s.deps), input)).badges).toHaveLength(2);
    expect(take).toHaveBeenCalledOnce(); expect(take.mock.calls[0]?.[0]).toBe("bug-spec");
    expect(await errorCode(await classifyShapes(request(UNSAFE), s.deps), 503)).toBe("unavailable");
    expect(s.calls).toHaveLength(1);
  });
  it("counts all-local refusals once without needing a provider key", async () => {
    const s = setup(); s.deps.assist.config.tokenFactoryKey = null;
    fillBudget(s.deps.assist.limiter, SESSION_LIMITS["bug-spec"] - 1);
    const take = vi.spyOn(s.deps.assist.limiter, "take");
    expect((await result(await classifyShapes(request(UNSAFE), s.deps), UNSAFE)).badges[0]).toMatchObject({ index: 0, outcome: "refused", refusal_kind: "security" });
    expect(take).toHaveBeenCalledOnce(); expect(s.calls).toHaveLength(0);
    expect(await errorCode(await classifyShapes(request(UNSAFE), s.deps), 503)).toBe("unavailable");
  });
  it("answers unavailable for a missing provider key without spending a unit", async () => {
    const s = setup(); s.deps.assist.config.tokenFactoryKey = null;
    fillBudget(s.deps.assist.limiter, SESSION_LIMITS["bug-spec"] - 1);
    const take = vi.spyOn(s.deps.assist.limiter, "take");
    expect(await errorCode(await classifyShapes(request(), s.deps), 503)).toBe("unavailable");
    expect(take).not.toHaveBeenCalled(); expect(s.calls).toHaveLength(0);
    // The session's last unit is still there for the next request once the key is back.
    s.deps.assist.config.tokenFactoryKey = "synthetic-token-factory-key";
    expect((await result(await classifyShapes(request(), s.deps))).badges[0]?.outcome).toBe("open");
    expect(take).toHaveBeenCalledOnce(); expect(s.calls).toHaveLength(1);
  });
  it("spends exactly one unit per request, including one whose provider call fails", async () => {
    const s = setup(new Error("Synthetic provider failure"));
    const take = vi.spyOn(s.deps.assist.limiter, "take");
    expect(await errorCode(await classifyShapes(request(), s.deps), 503)).toBe("unavailable");
    expect(take).toHaveBeenCalledOnce();
    expect(await errorCode(await classifyShapes(request(), s.deps), 503)).toBe("unavailable");
    expect(take).toHaveBeenCalledTimes(2); expect(s.calls).toHaveLength(2);
  });
});

describe("shape badge classifier transport and outcomes", () => {
  it("uses one structured call with the fixed classifier model and maps wire sentinels", async () => {
    const s = setup(); const value = await result(await classifyShapes(request(), s.deps));
    expect(value).toEqual({ badges: [{ ...OPEN, proven_criterion_id: null, refusal_kind: null, reason: null }], model: DEFAULT_ASSIST_MODEL });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe(CHAT_COMPLETIONS_URL);
    expect(s.calls[0]?.body).toMatchObject({ model: DEFAULT_ASSIST_MODEL, temperature: 0.2, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(s.calls[0]?.body).not.toHaveProperty("tools");
    expect(s.calls[0]?.headers.get("authorization")).toBe("Bearer synthetic-token-factory-key");
  });
  it("calls and reports the configured classifier model", async () => {
    const s = setup(); const deps = { ...s.deps, model: "nvidia/synthetic-classifier-1" };
    expect((await result(await classifyShapes(request(), deps))).model).toBe("nvidia/synthetic-classifier-1");
    expect(s.calls[0]?.body).toMatchObject({ model: "nvidia/synthetic-classifier-1" });
  });
  it.each([
    ["task-report", "concurrency.lost-acknowledged-change", "concurrency"],
    ["task-report", "concurrency.stale-success-response", "concurrency"],
    ["umami", "date_time.time-zone-grouping", "date_time"],
  ] as const)("accepts the %s proven criterion %s", async (host, criterion, family) => {
    const input = { ...INPUT, host_id: host }; const s = setup({ badges: [{ ...PROVEN, proven_criterion_id: criterion, family }] });
    expect((await result(await classifyShapes(request(input), s.deps), input)).badges[0]).toEqual({ index: 0, outcome: "proven", proven_criterion_id: criterion, family, translated_failure: null, refusal_kind: null, reason: null });
  });
  it.each(["security", "out_of_scope"] as const)("maps a model %s refusal without another call", async kind => {
    const s = setup({ badges: [{ ...REFUSED, refusal_kind: kind }] });
    expect((await result(await classifyShapes(request(), s.deps))).badges[0]).toEqual({ index: 0, outcome: "refused", proven_criterion_id: null, family: null, translated_failure: null, refusal_kind: kind, reason: REFUSED.reason });
    expect(s.calls).toHaveLength(1);
  });
  it("accepts an Umami open translation, including the contract's empty-wire/null case", async () => {
    const input = { ...INPUT, host_id: "umami" as const, shapes: [SAFE_SHAPE, { title: "Synthetic report count", summary: "A daily total stays unchanged after a recorded event." }] };
    const s = setup({ badges: [OPEN, { ...OPEN, index: 1, translated_failure: "" }] });
    const value = await result(await classifyShapes(request(input), s.deps), input);
    expect(value.badges).toMatchObject([{ index: 0, outcome: "open", translated_failure: OPEN.translated_failure }, { index: 1, outcome: "open", translated_failure: null }]);
  });
  it("checks translated text in code points and permits two plain-text sentences", async () => {
    const s = setup({ badges: [{ ...OPEN, translated_failure: `${"😀".repeat(180)}. A saved note differs.` }] });
    // The translated text exceeds 200 code points even though it fits the wire shape.
    expect(await errorCode(await classifyShapes(request(), s.deps), 503)).toBe("unavailable");
    const valid = setup({ badges: [{ ...OPEN, translated_failure: `${"😀".repeat(150)}. A saved note differs.` }] });
    expect((await result(await classifyShapes(request(), valid.deps))).badges[0]?.outcome).toBe("open");
  });
  it("refuses unsafe titles and summaries locally and preserves original indices in a mixed call", async () => {
    const unsafeTitle = { title: "Synthetic permissions change", summary: "The task's note is changed." };
    const unsafeSummary = { title: "Synthetic source excerpt", summary: "```synthetic source```" };
    const stale = { title: "Synthetic stale response", summary: "Two overlapping writes return a stale value." };
    const input: OtfShapeBadgesRequest = { ...INPUT, shapes: [
      unsafeTitle, SAFE_SHAPE, unsafeSummary, stale,
    ] };
    const s = setup({ badges: [{ ...PROVEN, index: 3 }, { ...OPEN, index: 1 }] });
    const value = await result(await classifyShapes(request(input), s.deps), input);
    expect(value.badges.find(badge => badge.index === 0)).toMatchObject({ outcome: "refused", refusal_kind: "security" });
    expect(value.badges.find(badge => badge.index === 2)).toMatchObject({ outcome: "refused", refusal_kind: "security" });
    expect(value.badges.find(badge => badge.index === 1)).toMatchObject({ outcome: "open" });
    expect(value.badges.find(badge => badge.index === 3)).toMatchObject({ outcome: "proven" });
    const messages = s.calls[0]?.body.messages as { role: string; content: string }[];
    const user = messages.find(message => message.role === "user")?.content ?? "";
    const data = JSON.parse(user.slice(user.indexOf("DATA (untrusted): ") + "DATA (untrusted): ".length)) as { shapes: unknown[] };
    expect(data.shapes).toEqual([{ index: 1, ...SAFE_SHAPE }, { index: 3, ...stale }]);
    expect(user).not.toContain(unsafeTitle.title); expect(user).not.toContain(unsafeSummary.summary);
    expect(s.calls).toHaveLength(1);
  });
  it("does not allow a provider badge to replace a locally refused shape", async () => {
    const input: OtfShapeBadgesRequest = { ...INPUT, shapes: [UNSAFE_SHAPE, SAFE_SHAPE] };
    const s = setup({ badges: [{ ...OPEN, index: 0 }] });
    expect(await errorCode(await classifyShapes(request(input), s.deps), 503)).toBe("unavailable");
    expect(s.calls).toHaveLength(1);
  });
  it("keeps unsafe query text out of a mixed provider request without refusing its safe shape", async () => {
    const query = "Synthetic permissions change through authentication";
    const unsafeQueryShape = { title: query, summary: "The task is readable without permission." };
    const input: OtfShapeBadgesRequest = { ...INPUT, query, shapes: [unsafeQueryShape, SAFE_SHAPE] };
    const s = setup({ badges: [{ ...OPEN, index: 1 }] });
    const value = await result(await classifyShapes(request(input), s.deps), input);
    expect(value.badges.find(badge => badge.index === 0)).toMatchObject({ outcome: "refused", refusal_kind: "security" });
    expect(value.badges.find(badge => badge.index === 1)).toMatchObject({ outcome: "open" });
    const messages = s.calls[0]?.body.messages as { role: string; content: string }[];
    const user = messages.find(message => message.role === "user")?.content ?? "";
    expect(user).not.toContain(query); expect(user).not.toContain(unsafeQueryShape.summary);
    expect(user).toContain(SAFE_SHAPE.title); expect(s.calls).toHaveLength(1);
  });
});

describe("screening the model's badge text", () => {
  it.each([
    ["a security topic", "An attacker can read the saved task note."],
    ["code", "const note = readNote(task);"],
  ])("replaces an open translation that holds %s with null", async (_label, text) => {
    const s = setup({ badges: [{ ...OPEN, translated_failure: text }] });
    expect((await result(await classifyShapes(request(), s.deps))).badges[0]).toEqual({ index: 0, outcome: "open", proven_criterion_id: null, family: "data_handling", translated_failure: null, refusal_kind: null, reason: null });
    expect(s.calls).toHaveLength(1);
  });
  it.each([
    ["a security topic", "This shape describes a vulnerability in the task service."],
    ["code", "const reason = refuse(shape);"],
  ])("replaces a refusal reason that holds %s with the fixed reason", async (_label, text) => {
    const s = setup({ badges: [{ ...REFUSED, reason: text }] });
    expect((await result(await classifyShapes(request(), s.deps))).badges[0]).toEqual({ index: 0, outcome: "refused", proven_criterion_id: null, family: null, translated_failure: null, refusal_kind: "out_of_scope", reason: "This shape is outside what custom builds cover." });
  });
  it("keeps design words that only the input check refuses", async () => {
    const text = "The cached path bypasses the note's comma handling.";
    const s = setup({ badges: [{ ...OPEN, translated_failure: text }] });
    expect((await result(await classifyShapes(request(), s.deps))).badges[0]?.translated_failure).toBe(text);
  });
  it("still refuses unsafe text on an outcome that must leave it empty", async () => {
    const s = setup({ badges: [{ ...REFUSED, translated_failure: "An attacker can read the saved task note." }] });
    expect(await errorCode(await classifyShapes(request(), s.deps), 503)).toBe("unavailable");
  });
});

describe("unusable shape badge responses", () => {
  it.each([
    ["unknown envelope field", { badges: [OPEN], extra: true }],
    ["unknown badge field", { badges: [{ ...OPEN, extra: true }] }],
    ["missing badge", { badges: [] }],
    ["missing required field", { badges: [{ index: 0, outcome: "open", proven_criterion_id: "none", family: "data_handling", translated_failure: OPEN.translated_failure, refusal_kind: "none" }] }],
    ["out-of-range index", { badges: [{ ...OPEN, index: 1 }] }],
    ["wrong outcome fields", { badges: [{ ...OPEN, reason: "This field is only for refusals." }] }],
    ["wrong proven family", { badges: [{ ...PROVEN, family: "date_time" }] }],
    ["short translation", { badges: [{ ...OPEN, translated_failure: "Too short." }] }],
    ["control character", { badges: [{ ...OPEN, translated_failure: "A saved note differs.\nThe next read loses text." }] }],
    ["format character", { badges: [{ ...OPEN, translated_failure: "A saved note differs.\u200dThe next read loses text." }] }],
    ["long refusal reason", { badges: [{ ...REFUSED, reason: "x".repeat(161) }] }],
    ["empty refusal reason", { badges: [{ ...REFUSED, reason: "" }] }],
    ["invalid JSON", "synthetic response without JSON"],
  ])("answers unavailable for %s with no repair", async (_label, answer) => {
    const s = setup(answer);
    expect(await errorCode(await classifyShapes(request(), s.deps), 503)).toBe("unavailable");
    expect(s.calls).toHaveLength(1);
  });
  it("refuses duplicate indices even when the number of badges matches the shapes", async () => {
    const input: OtfShapeBadgesRequest = { ...INPUT, shapes: [SAFE_SHAPE, { title: "Synthetic changed title", summary: "A saved title comes back with its commas removed." }] };
    const s = setup({ badges: [OPEN, OPEN] });
    expect(await errorCode(await classifyShapes(request(input), s.deps), 503)).toBe("unavailable");
    expect(s.calls).toHaveLength(1);
  });
  it.each([
    ["umami", PROVEN],
    ["task-report", { ...PROVEN, proven_criterion_id: "date_time.time-zone-grouping", family: "date_time" }],
  ] as const)("refuses a proven criterion outside the %s host", async (host, badge) => {
    const s = setup({ badges: [badge] });
    expect(await errorCode(await classifyShapes(request({ ...INPUT, host_id: host }), s.deps), 503)).toBe("unavailable");
    expect(s.calls).toHaveLength(1);
  });
  it.each([
    ["truncated", modelReply({ badges: [OPEN] }, "length")],
    ["provider exception", new Error("Synthetic provider failure")],
    ["provider HTTP failure", new Response("Synthetic provider failure", { status: 503 })],
    ["missing content", Response.json({ choices: [{ message: {} }] })],
  ])("answers unavailable for a %s response without retrying", async (_label, answer) => {
    const s = setup(answer);
    expect(await errorCode(await classifyShapes(request(), s.deps), 503)).toBe("unavailable");
    expect(s.calls).toHaveLength(1);
  });
});
