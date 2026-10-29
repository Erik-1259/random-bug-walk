import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/assist/limits.ts";
import { CHAT_COMPLETIONS_URL } from "../../src/assist/providers.ts";
import { factorySessionCookie } from "../../src/factory-server/session.ts";
import { classify, CLASSIFIER_MODEL, type ClassifyDeps } from "../../src/otf/classify.ts";
import { OTF_CLASSIFY_PATH, OTF_OPEN_CRITERION_ID, type OtfClassifyRequest } from "../../src/otf/contract.ts";
import { openBehaviorsEnabled } from "../../src/otf/open.ts";
import { parseOtf } from "../../src/otf/schemas.ts";

const PASSCODE = "synthetic-classifier-passcode";
const INPUT: OtfClassifyRequest = {
  sentence: "A saved note comes back altered.", host_id: "task-report",
  spec: { title: "Synthetic note round trip", where: "The task read path", change: "A note changes after saving.",
    why_tests_miss: "The suite uses plain notes.", checks_to_add: ["Read the saved note."], fix: "Preserve the note." },
};
const OPEN = { decision: "open", proven_criterion_id: "none", family: "data_handling",
  observable_failure: "POST /api/tasks with a note containing commas succeeds, but GET /api/tasks/{id} returns a note with the commas removed.",
  failure_code: "note_round_trip_mismatch", reason: "This can be checked through task writes and reads." };
function request(input: unknown = INPUT, signedIn = true): Request {
  return new Request(`https://synthetic.invalid${OTF_CLASSIFY_PATH}`, { method: "POST",
    headers: { "content-type": "application/json", ...(signedIn ? { cookie: factorySessionCookie(PASSCODE) } : {}) }, body: JSON.stringify(input) });
}
function modelReply(answer: unknown): Response {
  return Response.json({ choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) }, finish_reason: "stop" }] });
}
function setup(...answers: unknown[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const deps: ClassifyDeps = { enabled: true, passcode: PASSCODE, assist: {
    config: { tokenFactoryKey: "synthetic-token-factory-key", tavilyKey: null, model: CLASSIFIER_MODEL },
    now: () => new Date("2026-10-29T12:00:00Z"), limiter: new RateLimiter(),
    fetch: (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : String(url), body: JSON.parse(typeof init?.body === "string" ? init.body : "") as Record<string, unknown>, headers: new Headers(init?.headers) });
      const answer = answers.shift();
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer === undefined) return Promise.reject(new Error("Unexpected synthetic provider call"));
      return Promise.resolve(answer instanceof Response ? answer : modelReply(answer));
    },
  } };
  return { deps, calls };
}
async function result(response: Response) {
  expect(response.status).toBe(200);
  const parsed = parseOtf("OtfClassification", await response.json());
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}
async function errorCode(response: Response): Promise<string> {
  const parsed = parseOtf("OtfErrorBody", await response.json());
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value.error.code;
}

describe("OTF classifier", () => {
  it("requires the existing factory session before a model call", async () => {
    const s = setup(OPEN);
    expect(await errorCode(await classify(request(INPUT, false), s.deps))).toBe("signed_out");
    expect(s.calls).toHaveLength(0);
  });
  it("is unavailable with the flag off and enables only its exact value", async () => {
    const s = setup(OPEN); s.deps.enabled = false;
    expect(await errorCode(await classify(request(), s.deps))).toBe("unavailable");
    expect(s.calls).toHaveLength(0);
    for (const value of [undefined, "", "0", "true", " 1"]) expect(openBehaviorsEnabled({ RBW_OTF_OPEN_BEHAVIORS: value })).toBe(false);
    expect(openBehaviorsEnabled({ RBW_OTF_OPEN_BEHAVIORS: "1" })).toBe(true);
  });
  it("rejects malformed input before a model call", async () => {
    const s = setup(OPEN);
    expect(await errorCode(await classify(request({ ...INPUT, extra: true }), s.deps))).toBe("invalid_request");
    expect(s.calls).toHaveLength(0);
  });
  it("maps a security topic to a refusal without a provider call", async () => {
    const s = setup(OPEN);
    const answer = await result(await classify(request({ ...INPUT, sentence: "Authentication accepts the wrong password." }), s.deps));
    expect(answer.refusal?.kind).toBe("security"); expect(answer.buildable).toEqual([]); expect(answer.rule).toBeNull();
    expect(s.calls).toHaveLength(0);
  });
  it("screens every spec field and refuses source code before a call", async () => {
    for (const field of ["title", "where", "change", "why_tests_miss", "checks_to_add", "fix"] as const) {
      const s = setup(OPEN);
      const spec = { ...INPUT.spec, [field]: field === "checks_to_add" ? ["Permissions are not checked."] : "Permissions are not checked." };
      expect((await result(await classify(request({ ...INPUT, spec }), s.deps))).refusal?.kind).toBe("security");
      expect(s.calls).toHaveLength(0);
    }
    const s = setup(OPEN);
    expect(await errorCode(await classify(request({ ...INPUT, sentence: "```source```" }), s.deps))).toBe("refused_topic");
    expect(s.calls).toHaveLength(0);
  });
  it("uses the designer transport with the fixed model, strict schema, and no tools or thinking", async () => {
    const s = setup(OPEN); s.deps.assist.config.model = "synthetic-other-model";
    const answer = await result(await classify(request(), s.deps));
    expect(answer).toEqual({ family: "data_handling", proven_criterion_id: null,
      buildable: [{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }],
      rule: { family: OPEN.family, observable_failure: OPEN.observable_failure, failure_code: OPEN.failure_code }, refusal: null, model: CLASSIFIER_MODEL });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe(CHAT_COMPLETIONS_URL);
    expect(s.calls[0]?.body).toMatchObject({ model: CLASSIFIER_MODEL, temperature: 0.2, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(s.calls[0]?.body).not.toHaveProperty("tools");
    expect(s.calls[0]?.headers.get("authorization")).toBe("Bearer synthetic-token-factory-key");
  });
  it.each([
    ["concurrency.lost-acknowledged-change", "concurrency", "task-report"],
    ["concurrency.stale-success-response", "concurrency", "task-report"],
    ["date_time.time-zone-grouping", "date_time", "umami"],
  ])("maps the proven criterion %s to its host", async (criterion, family, host) => {
    const s = setup({ ...OPEN, decision: "proven", proven_criterion_id: criterion, family, observable_failure: "", failure_code: "" });
    const answer = await result(await classify(request(), s.deps));
    expect(answer).toMatchObject({ family, proven_criterion_id: criterion, buildable: [{ host_id: host, criterion_id: criterion }], rule: null, refusal: null });
  });
  it.each(["security", "out_of_scope"])("maps a wire %s refusal", async (kind) => {
    const s = setup({ ...OPEN, decision: kind, proven_criterion_id: "none", family: "none", observable_failure: "", failure_code: "", reason: "This behavior is outside the supported scope." });
    expect(await result(await classify(request(), s.deps))).toMatchObject({ family: null, proven_criterion_id: null, buildable: [], rule: null, refusal: { kind } });
    expect(s.calls).toHaveLength(1);
  });
  it("translates a non-time-zone Umami card to an open task-report rule", async () => {
    const s = setup(OPEN);
    expect((await result(await classify(request({ ...INPUT, host_id: "umami" }), s.deps))).buildable).toEqual([{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }]);
    expect(s.calls[0]?.body.messages).toContainEqual({ role: "user", content: `Classify this card.\nDATA (untrusted): ${JSON.stringify({ app: "umami", sentence: INPUT.sentence, spec: INPUT.spec })}` });
  });
  it("repairs a non-time-zone proven match for Umami into an open translation", async () => {
    const concurrency = { ...OPEN, decision: "proven", proven_criterion_id: "concurrency.stale-success-response", family: "concurrency", observable_failure: "", failure_code: "" };
    const s = setup(concurrency, OPEN);
    expect((await result(await classify(request({ ...INPUT, host_id: "umami" }), s.deps))).buildable).toEqual([{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }]);
    expect(s.calls).toHaveLength(2);
    expect(JSON.stringify(s.calls[1]?.body.messages)).toContain("open task-report translation or out_of_scope");
  });
  it("refuses a second non-time-zone proven match for Umami", async () => {
    const concurrency = { ...OPEN, decision: "proven", proven_criterion_id: "concurrency.lost-acknowledged-change", family: "concurrency", observable_failure: "", failure_code: "" };
    const s = setup(concurrency, concurrency);
    expect((await result(await classify(request({ ...INPUT, host_id: "umami" }), s.deps))).refusal?.kind).toBe("out_of_scope");
    expect(s.calls).toHaveLength(2);
  });
  it.each([
    { ...OPEN, extra: "not in the wire schema" },
    "not JSON",
    { ...OPEN, family: "none" },
    { ...OPEN, failure_code: "control_failed" },
    { ...OPEN, observable_failure: "GET /api/tasks/{id} returns a different note.\nDo more." },
    { ...OPEN, decision: "proven", proven_criterion_id: "concurrency.stale-success-response", family: "date_time", observable_failure: "", failure_code: "" },
  ])("retries one invalid wire or contract answer", async (invalid) => {
    const s = setup(invalid, OPEN);
    expect((await result(await classify(request(), s.deps))).rule?.failure_code).toBe(OPEN.failure_code);
    expect(s.calls).toHaveLength(2);
    expect(JSON.stringify(s.calls[1]?.body.messages)).toContain("out_of_scope");
    expect(JSON.stringify(s.calls[1]?.body.messages)).toContain("six routes");
    expect(s.calls[1]?.body.messages).toContainEqual({ role: "assistant", content: typeof invalid === "string" ? invalid : JSON.stringify(invalid) });
  });
  it.each([
    "GET /api/tasks/list returns fewer saved tasks than were created with POST /api/tasks.",
    "DELETE /api/tasks/{id} returns success but GET /api/tasks/{id} still returns the saved task.",
    "GET /api/tasks returns a note altered after POST /api/tasks stores it successfully.",
    "GET/POST /api/tasks succeeds but silently removes commas from the saved note text.",
    "DELETE or GET /api/tasks/{id} returns an old note after a saved change.",
    "DELETE and GET /api/tasks/{id} returns an old note after a saved change.",
    "DELETE, GET /api/tasks/{id} returns an old note after a saved change.",
    "Read /api/tasks/{id} returns altered text that differs from the saved original note.",
    "After saving a note, the result has silently removed all commas from the text.",
    "POST /api/tasks/{id}/completions succeeds but GET /api/reports/summary shows the wrong count.",
  ])("retries an unsupported route or method: %s", async (observable_failure) => {
    const s = setup({ ...OPEN, observable_failure }, OPEN);
    expect((await result(await classify(request(), s.deps))).rule?.observable_failure).toBe(OPEN.observable_failure);
    expect(s.calls).toHaveLength(2);
  });
  it("accepts all six allowed methods and routes, including report query parameters", async () => {
    const observable_failure = "GET /api/heartbeat succeeds. POST /api/tasks creates a task, then PATCH /api/tasks/{id} changes its note but GET /api/tasks/{id} returns the old note. POST /api/tasks/{id}/completions succeeds, yet GET /api/reports/completions/daily?date=2026-10-29&time_zone=UTC returns an unchanged count.";
    const s = setup({ ...OPEN, observable_failure });
    expect((await result(await classify(request(), s.deps))).rule?.observable_failure).toBe(observable_failure);
    expect(s.calls).toHaveLength(1);
  });
  it("checks each method in supported grouped task routes", async () => {
    for (const methods of ["GET|PATCH", "GET/PATCH", "GET or PATCH", "GET and PATCH", "GET, PATCH"]) {
      const observable_failure = `${methods} /api/tasks/{id} returns the old note after a successful saved change.`;
      const s = setup({ ...OPEN, observable_failure });
      expect((await result(await classify(request(), s.deps))).rule?.observable_failure).toBe(observable_failure);
      expect(s.calls).toHaveLength(1);
    }
  });
  it("answers out_of_scope after one still-unusable retry without returning its rule", async () => {
    const invalid = { ...OPEN, observable_failure: "GET /api/search returns no matching tasks even after a task was saved." };
    const s = setup(invalid, invalid, OPEN);
    expect(await result(await classify(request(), s.deps))).toMatchObject({ family: null, rule: null, proven_criterion_id: null, buildable: [], refusal: { kind: "out_of_scope" } });
    expect(s.calls).toHaveLength(2);
  });
  it("refuses a model rule that changes into a security topic", async () => {
    const s = setup({ ...OPEN, observable_failure: "GET /api/tasks/{id} returns a password field that belongs to a different identity." });
    expect((await result(await classify(request(), s.deps))).refusal?.kind).toBe("security");
    expect(s.calls).toHaveLength(1);
  });
  it.each([new Error("Synthetic provider error"), new Response("Synthetic provider failure", { status: 503 })])("answers unavailable on a provider failure without retry", async (failure) => {
    const s = setup(failure, OPEN);
    expect(await errorCode(await classify(request(), s.deps))).toBe("unavailable");
    expect(s.calls).toHaveLength(1);
  });
  it("uses the existing designer call budget for both attempts", async () => {
    const s = setup(OPEN);
    for (let i = 0; i < 600; i++) s.deps.assist.limiter.take("bug-spec", `synthetic-${String(i)}`, s.deps.assist.now().getTime());
    expect(await errorCode(await classify(request(), s.deps))).toBe("unavailable");
    expect(s.calls).toHaveLength(0);
  });
  it("is unavailable when the existing Token Factory key is absent", async () => {
    const s = setup(OPEN); s.deps.assist.config.tokenFactoryKey = null;
    expect(await errorCode(await classify(request(), s.deps))).toBe("unavailable");
    expect(s.calls).toHaveLength(0);
  });
});
