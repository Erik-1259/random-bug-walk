import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../../src/assist/limits.ts";
import { CHAT_COMPLETIONS_URL } from "../../src/assist/providers.ts";
import { factorySessionCookie } from "../../src/factory-server/session.ts";
import { classify, CLASSIFIER_MODEL, handleOtfClassify, ruleRouteProblems, type ClassifyDeps } from "../../src/otf/classify.ts";
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

// Invented rules in the phrasings the classifier model tends to use: a method right before the path,
// "Submit a PATCH to /path", a sentence that reads a second path with no method, quoted values and
// inline JSON. All values are synthetic.
const MODEL_STYLE_RULES = [
  "Create a task with title 'x,y' using POST /api/tasks. Read it back with GET /api/tasks/{id}. The title comes back as 'x' only, so the part after the comma is lost.",
  "PATCH /api/tasks/{id} with a new note leaves the stored note unchanged when read back, while the PATCH answer shows the new note.",
  "POST /api/tasks with a title of length 180 succeeds (201) but GET /api/tasks/{id} returns a title cut to 64 characters.",
  "Submit a PATCH to /api/tasks/{id} changing the title, then immediately GET /api/tasks/{id}; the returned task still shows the earlier title although the PATCH answered 200.",
  "PATCH /api/tasks/{id} with only a note set saves successfully but empties the title; a later GET /api/tasks/{id} shows an empty title.",
  "POST /api/tasks/{id}/completions answers 201, yet GET /api/reports/completions/daily for that local day reports one fewer completion.",
  "Submit a PATCH /api/tasks/{id} with title 'Synthetic' and note 'Value', then GET /api/tasks/{id}; the returned task shows the previous title.",
  "PATCH /api/tasks/{id} with {title:\"synthetic\"} succeeds and returns that title; a subsequent GET /api/tasks/{id} returns the previous title.",
] as const;
/** An invented rule that reads GET /api/tasks, which the service does not have (only POST /api/tasks). */
const GET_TASKS_RULE = "GET /api/tasks returns a task whose created_at falls outside the requested day, showing the listing uses the wrong day boundary.";

describe("task-report route check", () => {
  it.each(MODEL_STYLE_RULES)("accepts a rule in the model's phrasing: %s", (rule) => {
    expect(ruleRouteProblems(rule)).toEqual([]);
  });
  it("refuses a rule that reads GET /api/tasks and names the allowed method", () => {
    expect(ruleRouteProblems(GET_TASKS_RULE)).toEqual(['GET is not allowed for /api/tasks (allowed: POST); write each route as "METHOD /path", such as "PATCH /api/tasks/{id}"']);
  });
  it.each([
    "Overlapping PATCH requests to /api/tasks/{id} both return 200, but a later GET /api/tasks/{id} shows only one of the two saved notes.",
    "PATCH /api/tasks/{id} changes the note and returns 200, but a later read of /api/tasks/{id} returns the earlier note.",
    "Read /api/tasks/{id} returns altered text that differs from the saved original note.",
    "A task saved through POST /api/tasks keeps its title. Reading /api/tasks/{id} afterward shows a title with its commas removed.",
    "After POST /api/tasks/{id}/completions, the daily report /api/reports/completions/daily still shows the old count.",
    "POST /api/tasks creates a task, and later reading /api/tasks/{id} differs.",
    "A PATCH to /api/tasks/{id} returns 200, but the next read of [/api/tasks/{id}] shows the earlier title.",
    "GET /api/reports/completions/daily?date=2026-01-01&time_zone=UTC omits a completion recorded at 23:30 in that zone.",
    "Two overlapping PATCH requests to /api/tasks/{id} both return 200, but only one note is kept.",
    "POST /api/tasks with title \"DELETE\" returns 201, and GET /api/tasks/{id} returns the title \"DELETE ME\" cut to \"DELETE\".",
    "PATCH /api/tasks/{id} with the note 'POST' returns 200, but GET /api/tasks/{id} returns the note 'PUT' instead.",
    "PATCH /api/tasks/{id} with the title `HEAD` returns 200, but GET /api/tasks/{id} returns the title “OPTIONS” instead.",
    "Read /api/tasks/{id} after a PATCH changes the note; the GET still shows the earlier note.",
  ])("accepts an attached allowed method or a bare mention of an existing route: %s", (rule) => {
    expect(ruleRouteProblems(rule)).toEqual([]);
  });
  it.each([
    ["DELETE /api/tasks/{id} returns 200 but GET /api/tasks/{id} still returns the saved task afterward.", "DELETE is not allowed for /api/tasks/{id} (allowed: GET, PATCH)"],
    ["Sending a DELETE request to /api/tasks/{id} returns 200 but the task can still be read afterward.", "DELETE is not allowed for /api/tasks/{id} (allowed: GET, PATCH)"],
    ["A POST request to /api/reports/completions/daily returns 200, but the next daily report omits the completion.", "POST is not allowed for /api/reports/completions/daily (allowed: GET)"],
    ["Send a DELETE request and then read /api/tasks/{id}; the task is still returned afterward.", "the task-report service has no DELETE route"],
    ["Calling PUT on /api/tasks/{id} returns 200, but the title is unchanged afterward.", "PUT is not allowed for /api/tasks/{id} (allowed: GET, PATCH)"],
    ["Send a POST request with a title to /api/tasks/{id}; it reports success but GET /api/tasks/{id} returns the old title.", "POST is not allowed for the routes named in this sentence (allowed: GET, PATCH)"],
    ["GET /api/reports/completions/daily shows one fewer completion after a PATCH of the task.", "PATCH is not allowed for the routes named in this sentence (allowed: GET)"],
    ["POST /api/tasks with title \"PUT\" returns 201, but the stored title is read back with a PUT from /api/tasks/{id}.", "the task-report service has no PUT route"],
    ["GET /v2/api/tasks/{id} returns a title that differs from the saved title.", "/v2/api/tasks/{id} is not one of the six task-report routes"],
    ["GET https://synthetic.invalid/api/tasks/{id} returns a title that differs from the saved title.", "https://synthetic.invalid/api/tasks/{id} is not one of the six task-report routes"],
    ["GET /api/websites/x/stats returns a page view count that is one lower than the number of recorded views.", "/api/websites/x/stats is not one of the six task-report routes"],
    ["After saving a note through the task route, the returned note has silently lost its commas.", "observable_failure must name at least one task-report route"],
  ])("refuses a disallowed method, an unknown route or no route: %s", (rule, problem) => {
    const problems = ruleRouteProblems(rule);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
    expect(problems[0]).toContain('write each route as "METHOD /path", such as "PATCH /api/tasks/{id}"');
  });
});

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
  it("answers refused_topic for a security topic found before a provider call", async () => {
    const s = setup(OPEN);
    const response = await classify(request({ ...INPUT, sentence: "Authentication accepts the wrong password." }), s.deps);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("refused_topic");
    expect(s.calls).toHaveLength(0);
  });
  it("screens every spec field and refuses source code before a call", async () => {
    for (const field of ["title", "where", "change", "why_tests_miss", "checks_to_add", "fix"] as const) {
      const s = setup(OPEN);
      const spec = { ...INPUT.spec, [field]: field === "checks_to_add" ? ["Permissions are not checked."] : "Permissions are not checked." };
      expect(await errorCode(await classify(request({ ...INPUT, spec }), s.deps))).toBe("refused_topic");
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
    "After saving a note, the result has silently removed all commas from the text.",
    "POST /api/tasks/{id}/completions succeeds but GET /api/reports/summary shows the wrong count.",
    "Send a POST request with a title to /api/tasks/{id}; it reports success but GET /api/tasks/{id} returns the old title.",
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
  it("accepts 'Submit a PATCH to /path', which names PATCH before a filler word and its path", async () => {
    const observable_failure = MODEL_STYLE_RULES[3];
    const s = setup({ ...OPEN, observable_failure });
    expect((await result(await classify(request(), s.deps))).rule?.observable_failure).toBe(observable_failure);
    expect(s.calls).toHaveLength(1);
  });
  it("names the allowed form in its repair request", async () => {
    const s = setup({ ...OPEN, observable_failure: "DELETE /api/tasks/{id} returns success but GET /api/tasks/{id} still returns the saved task." }, OPEN);
    await classify(request(), s.deps);
    expect(JSON.stringify(s.calls[1]?.body.messages)).toContain('write each route as \\"METHOD /path\\", such as \\"PATCH /api/tasks/{id}\\"');
  });
  it("answers out_of_scope after one still-unusable retry without returning its rule", async () => {
    const invalid = { ...OPEN, observable_failure: "GET /api/search returns no matching tasks even after a task was saved." };
    const s = setup(invalid, invalid, OPEN);
    expect(await result(await classify(request(), s.deps))).toMatchObject({ family: null, rule: null, proven_criterion_id: null, buildable: [], refusal: { kind: "out_of_scope" } });
    expect(s.calls).toHaveLength(2);
  });
  it.each([
    { ...OPEN, decision: "security", proven_criterion_id: "none", family: "none", observable_failure: "", failure_code: "", reason: "" },
    { ...OPEN, decision: "security", proven_criterion_id: "none", family: "none", reason: "Synthetic model reason." },
  ])("answers a plain security refusal when both security decisions fail validation", async (invalid) => {
    const s = setup(invalid, invalid, OPEN);
    expect(await result(await classify(request(), s.deps))).toEqual({ family: null, proven_criterion_id: null, buildable: [], rule: null,
      refusal: { kind: "security", reason: "Security topics are outside the supported design scope." }, model: CLASSIFIER_MODEL });
    expect(s.calls).toHaveLength(2);
  });
  it("answers out_of_scope when only one of two failed answers decided security", async () => {
    const security = { ...OPEN, decision: "security", proven_criterion_id: "none", family: "none", observable_failure: "", failure_code: "", reason: "" };
    const s = setup(security, "not JSON");
    expect((await result(await classify(request(), s.deps))).refusal?.kind).toBe("out_of_scope");
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
  it.each(["preview", "production"])("signs nobody in through the route handler when test mode is refused on VERCEL_ENV %s, as the bug-spec route does", async (environment) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("RBW_FACTORY_TEST_MODE", "1"); vi.stubEnv("VERCEL_ENV", environment);
    vi.stubEnv("RBW_JUDGE_PASSCODE", PASSCODE); vi.stubEnv("RBW_OTF_OPEN_BEHAVIORS", "1");
    try {
      expect(await errorCode(await handleOtfClassify(request()))).toBe("signed_out");
      vi.stubEnv("RBW_FACTORY_TEST_MODE", "0");
      expect(await errorCode(await handleOtfClassify(request()))).toBe("unavailable");
    } finally {
      vi.unstubAllEnvs(); vi.restoreAllMocks();
    }
  });
  it("is unavailable when the existing Token Factory key is absent", async () => {
    const s = setup(OPEN); s.deps.assist.config.tokenFactoryKey = null;
    expect(await errorCode(await classify(request(), s.deps))).toBe("unavailable");
    expect(s.calls).toHaveLength(0);
  });
});
