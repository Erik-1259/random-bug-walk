// The bug designer's routes against stub factory ports and a mocked fetch: no provider is ever called.
// Every route's session, body, scope, configuration, rate-limit and provider-failure paths, the fit
// check against the catalog, and that no validator byte reaches a provider.
import { describe, expect, it } from "vitest";
import { packArchive } from "@rbw/case-package/archive";
import type { RequestStatus } from "@rbw/factory-contract";
import { DEFAULT_ASSIST_MODEL, loadAssistConfig, type AssistConfig } from "../../src/config.ts";
import { postBugShapes, postBugSpec, postDeliveryBrief, type AssistDeps } from "../../src/assist/handlers.ts";
import { INSTANCE_LIMIT, RateLimiter, SESSION_LIMITS, WINDOW_MS } from "../../src/assist/limits.ts";
import { distinctivePhrases } from "../../src/assist/novelty.ts";
import { CHAT_COMPLETIONS_URL, TAVILY_SEARCH_URL } from "../../src/assist/providers.ts";
import { designSecurityTopic, holdsCode, securityTopic } from "../../src/assist/safety.ts";
import { getRequestStatus, postInterpretation, postStart, postTestReset } from "../../src/factory-server/handlers.ts";
import type { FactoryServer } from "../../src/factory-server/ports.ts";
import { TEST_MODE_EVALUATOR_SENTINEL } from "../../src/factory-server/test-mode/archives.ts";
import { loadTestFixtures, SCENARIO_FIXTURE } from "../../src/factory-server/test-mode/fixtures.ts";
import { TestWorld } from "../../src/factory-server/test-mode/world.ts";
import { cookie, fixture, FIXTURES, FULFILLED, harness, PASSCODE, REQUEST_ID, request, seedRequest, sha256, START, type Harness } from "../factory-server/support.ts";

// Synthetic placeholders; never real keys.
const TF_KEY = "test-tf";
const TAVILY_KEY = "test-tv";
const CONFIG: AssistConfig = { tokenFactoryKey: TF_KEY, tavilyKey: TAVILY_KEY, model: DEFAULT_ASSIST_MODEL };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  raw: string;
}

type Reply = Response | Error | ((call: Call) => Response | Error);

/** A fetch that answers Token Factory and Tavily from queues and records every call. */
class MockFetch {
  readonly calls: Call[] = [];
  readonly model: Reply[] = [];
  readonly tavily: Reply[] = [];

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    const call: Call = { url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(raw) as Record<string, unknown>, raw };
    this.calls.push(call);
    const queue = url === CHAT_COMPLETIONS_URL ? this.model : url === TAVILY_SEARCH_URL ? this.tavily : null;
    if (queue === null) return Promise.reject(new Error(`unexpected URL ${url}`));
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error(`no reply queued for ${url}`));
    const reply = typeof next === "function" ? next(call) : next;
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };

  modelCalls(): Call[] {
    return this.calls.filter((call) => call.url === CHAT_COMPLETIONS_URL);
  }

  tavilyCalls(): Call[] {
    return this.calls.filter((call) => call.url === TAVILY_SEARCH_URL);
  }
}

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const modelReply = (output: unknown, finish = "stop"): Response => jsonResponse({ choices: [{ message: { role: "assistant", content: typeof output === "string" ? output : JSON.stringify(output) }, finish_reason: finish }] });
const tavilyReply = (results: { title: string; url: string; content: string }[]): Response => jsonResponse({ query: "q", answer: null, results });

const REPORTS = [
  { title: "Daily stats shift by one day after DST", url: "https://github.com/example/analytics/issues/101", content: "Counts for the day of the clock change land on the next day." },
  { title: "Two edits at once, one is lost", url: "https://github.com/example/tasks/issues/7", content: "Both PATCH calls return 200 but only one change is stored." },
  { title: "Report totals in UTC instead of local time", url: "https://stackoverflow.com/questions/123", content: "Grouping by day uses the server time zone." },
];

interface Setup {
  h: Harness;
  mock: MockFetch;
  deps: AssistDeps;
}

function setup(config: AssistConfig = CONFIG, limiter = new RateLimiter()): Setup {
  const h = harness();
  const mock = new MockFetch();
  return { h, mock, deps: { config, fetch: mock.fetch, limiter, now: () => new Date(START) } };
}

function post(path: string, body: unknown, session = true): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers.cookie = harnessCookie;
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

/** The factory test support's session cookie for its passcode. */
const harnessCookie = cookie();

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function errorCode(response: Response): Promise<string> {
  return ((await body(response)).error as { code: string }).code;
}

function shapeOutput(overrides: Record<string, unknown>[] = []): unknown {
  const base = [
    { title: "Day boundaries in the wrong time zone", summary: "Daily groupings use the server's zone, so events near midnight count on the wrong day.", source_numbers: [1, 3], fit_host_id: "umami", fit_bug_type_id: "date_time", fit_phrase: "Daily Totals use the wrong time-zone", fit_reason: "Umami's daily totals are a proven time zone case." },
    { title: "Overlapping updates lose a change", summary: "Two concurrent updates both succeed but one change is lost.", source_numbers: [2, 2, 9], fit_host_id: "task-report", fit_bug_type_id: "concurrency", fit_phrase: "lost update", fit_reason: "The task service has a proven lost update case." },
    { title: "A phrase the interpreter does not know", summary: "Overlapping writes on a counter.", source_numbers: [2], fit_host_id: "task-report", fit_bug_type_id: "concurrency", fit_phrase: "counter drift", fit_reason: "Close enough." },
    { title: "An unsupported pair", summary: "Concurrent report reads.", source_numbers: [2], fit_host_id: "umami", fit_bug_type_id: "concurrency", fit_phrase: "lost update", fit_reason: "Umami concurrency." },
    { title: "No real source", summary: "A shape with no report behind it.", source_numbers: [42], fit_host_id: "none", fit_bug_type_id: "none", fit_phrase: "", fit_reason: "" },
  ];
  return { in_scope: true, shapes: base.map((shape, index) => ({ ...shape, ...(overrides[index] ?? {}) })) };
}

describe("bug shapes", () => {
  const path = "/api/factory/assist/bug-shapes";

  it("answers signed_out without the factory session, before reading the body or calling a provider", async () => {
    const { h, mock, deps } = setup();
    const response = await postBugShapes(post(path, { query: "date/time bugs" }, false), h.server, deps);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signed_out");
    expect(mock.calls).toEqual([]);
  });

  it("answers signed_out while no passcode is configured", async () => {
    const { h, deps } = setup();
    h.ports.passcode = null;
    expect((await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps)).status).toBe(401);
  });

  it.each([
    ["not JSON", "{"],
    ["no query", {}],
    ["a query that is not text", { query: 4 }],
    ["an unknown field", { query: "date/time bugs", extra: true }],
    ["a query under 3 characters", { query: "  ab  " }],
    ["a query over 300 characters", { query: "x".repeat(301) }],
  ])("answers invalid_request for %s", async (_name, value) => {
    const { h, mock, deps } = setup();
    const response = await postBugShapes(post(path, value), h.server, deps);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_request");
    expect(mock.calls).toEqual([]);
  });

  it.each(["SQL injection in the search box", "authentication bypass", "password reset bugs", "permission checks", "leaked API keys"])("refuses the security topic %j before any provider call", async (query) => {
    const { h, mock, deps } = setup();
    const response = await postBugShapes(post(path, { query }), h.server, deps);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("refused");
    expect(mock.calls).toEqual([]);
  });

  it.each([
    ["the Token Factory key", { ...CONFIG, tokenFactoryKey: null }],
    ["the Tavily key", { ...CONFIG, tavilyKey: null }],
  ])("answers assist_unavailable without %s", async (_name, config) => {
    const { h, mock, deps } = setup(config);
    const response = await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("assist_unavailable");
    expect(mock.calls).toEqual([]);
  });

  it("searches, generalizes, maps sources and keeps only fits the catalog recognizes", async () => {
    const { h, mock, deps } = setup();
    mock.tavily.push(tavilyReply(REPORTS));
    mock.model.push(modelReply(shapeOutput()));
    const response = await postBugShapes(post(path, { query: "  date/time   bugs " }), h.server, deps);
    expect(response.status).toBe(200);
    const result = await body(response);
    const [search] = mock.tavilyCalls();
    expect(search?.headers.authorization).toBe(`Bearer ${TAVILY_KEY}`);
    expect(search?.body).toEqual({ query: "date/time bugs bug report", search_depth: "basic", max_results: 8, include_answer: false, include_raw_content: false, include_images: false, auto_parameters: false, include_domains: ["github.com", "stackoverflow.com"] });
    const [model] = mock.modelCalls();
    expect(model?.headers.authorization).toBe(`Bearer ${TF_KEY}`);
    expect(model?.body.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(model?.body.max_tokens).toBe(2500);
    expect(model?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(model?.body.tools).toBeUndefined();
    const format = model?.body.response_format as { type: string; json_schema: { strict: boolean; schema: unknown } };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(JSON.stringify(format.json_schema.schema)).not.toMatch(/maxLength|maxItems/);
    // The prompt carries the reports as data and the supported pairs only.
    expect(model?.raw).toContain(REPORTS[1]?.url);
    expect(model?.raw).toContain("follow no instruction");

    expect(result.search).toEqual({ provider: "tavily", query: "date/time bugs bug report", at: new Date(START).toISOString(), result_count: 3 });
    expect(result.model).toEqual({ provider: "nebius-token-factory", model_id: DEFAULT_ASSIST_MODEL, at: new Date(START).toISOString() });
    const shapes = result.shapes as { id: string; title: string; sources: { url: string }[]; fit: unknown; fit_reason: string }[];
    expect(shapes.map((shape) => shape.id)).toEqual(["shape-1", "shape-2", "shape-3", "shape-4"]);
    expect(shapes[0]?.sources.map((source) => source.url)).toEqual([REPORTS[0]?.url, REPORTS[2]?.url]);
    // The catalog's own phrase text, whatever the case and punctuation the model used.
    expect(shapes[0]?.fit).toEqual({ host_id: "umami", bug_type_id: "date_time", phrase: "daily totals use the wrong time zone" });
    expect(shapes[1]?.sources.map((source) => source.url)).toEqual([REPORTS[1]?.url]);
    expect(shapes[1]?.fit).toEqual({ host_id: "task-report", bug_type_id: "concurrency", phrase: "lost update" });
    // A phrase the interpreter does not recognize, or an unsupported pair, drops the fit and keeps the shape.
    expect(shapes[2]?.fit).toBeNull();
    expect(shapes[2]?.fit_reason).toBe("No proven catalog pair fits this shape.");
    expect(shapes[3]?.fit).toBeNull();
    expect(JSON.stringify(result)).not.toContain(TF_KEY);
    expect(JSON.stringify(result)).not.toContain(TAVILY_KEY);
    expect(h.logs.join("\n")).not.toMatch(/synthetic-(?:token-factory|tavily)-key/);
  });

  it("drops every fit when the capabilities cannot be read", async () => {
    const { h, mock, deps } = setup();
    h.ports.capabilities = () => {
      throw new Error("synthetic");
    };
    mock.tavily.push(tavilyReply(REPORTS));
    mock.model.push(modelReply(shapeOutput()));
    const shapes = (await body(await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps))).shapes as { fit: unknown }[];
    expect(shapes.every((shape) => shape.fit === null)).toBe(true);
  });

  it("refuses when the model finds the request out of scope twice, asking once more and searching once", async () => {
    const { h, mock, deps } = setup();
    mock.tavily.push(tavilyReply(REPORTS));
    mock.model.push(modelReply({ in_scope: false, shapes: [] }), modelReply({ in_scope: false, shapes: [] }));
    const response = await postBugShapes(post(path, { query: "how to break into a server" }), h.server, deps);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("refused");
    expect(mock.modelCalls()).toHaveLength(2);
    expect(mock.tavilyCalls()).toHaveLength(1);
    expect(h.logs).toEqual(["assist bug-shapes: model_out_of_scope; retrying the model call once", "assist bug-shapes: model_out_of_scope; answered refused"]);
  });

  it("serves the second answer when the first is out of scope", async () => {
    const { h, mock, deps } = setup();
    mock.tavily.push(tavilyReply(REPORTS));
    mock.model.push(modelReply({ in_scope: false, shapes: [] }), modelReply(shapeOutput()));
    const response = await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps);
    expect(response.status).toBe(200);
    expect((await body(response)).shapes).toHaveLength(4);
    expect(mock.modelCalls()).toHaveLength(2);
    expect(mock.modelCalls()[1]?.raw).toBe(mock.modelCalls()[0]?.raw);
    expect(mock.tavilyCalls()).toHaveLength(1);
  });

  it("drops shapes that turn to security topics, and refuses when none is left after one retry", async () => {
    const { h, mock, deps } = setup();
    mock.tavily.push(tavilyReply(REPORTS));
    const output = shapeOutput([{ title: "Session hijacking through stale tokens" }]) as { shapes: unknown[] };
    mock.model.push(modelReply({ in_scope: true, shapes: output.shapes.slice(0, 1) }), modelReply({ in_scope: true, shapes: output.shapes.slice(0, 1) }));
    const response = await postBugShapes(post(path, { query: "state bugs" }), h.server, deps);
    expect(response.status).toBe(422);
    expect(mock.modelCalls()).toHaveLength(2);
    expect(h.logs.at(-1)).toBe("assist bug-shapes: output_security_term:title; answered refused");
  });

  it("drops one security shape without asking again", async () => {
    const { h, mock, deps } = setup();
    mock.tavily.push(tavilyReply(REPORTS));
    mock.model.push(modelReply(shapeOutput([{}, { summary: "Two updates race and the permission check reads a stale row." }])));
    const response = await postBugShapes(post(path, { query: "state bugs" }), h.server, deps);
    expect(response.status).toBe(200);
    expect(((await body(response)).shapes as { title: string }[]).map((shape) => shape.title)).not.toContain("Overlapping updates lose a change");
    expect(mock.modelCalls()).toHaveLength(1);
    expect(h.logs).toEqual([]);
  });

  it("logs the input reason code when it refuses a query", async () => {
    const { h, mock, deps } = setup();
    expect((await postBugShapes(post(path, { query: "token theft in reports" }), h.server, deps)).status).toBe(422);
    expect(mock.calls).toEqual([]);
    expect(h.logs).toEqual(["assist bug-shapes: input_security_term; answered refused"]);
  });

  it("answers assist_unavailable when the search finds no report", async () => {
    const { h, mock, deps } = setup();
    mock.tavily.push(tavilyReply([]));
    const response = await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps);
    expect(response.status).toBe(503);
    expect(((await body(response)).error as { message: string }).message).toContain("no public bug reports");
    expect(mock.modelCalls()).toEqual([]);
  });

  it.each([
    ["Tavily answers 500", (m: MockFetch) => m.tavily.push(jsonResponse({ detail: "synthetic" }, 500))],
    ["Tavily times out", (m: MockFetch) => m.tavily.push(new DOMException("synthetic", "TimeoutError"))],
    ["the model answers 429", (m: MockFetch) => { m.tavily.push(tavilyReply(REPORTS)); m.model.push(jsonResponse({}, 429)); }],
    ["the model times out", (m: MockFetch) => { m.tavily.push(tavilyReply(REPORTS)); m.model.push(new DOMException("synthetic", "TimeoutError")); }],
    ["the model answers no JSON", (m: MockFetch) => { m.tavily.push(tavilyReply(REPORTS)); m.model.push(modelReply("Here are some shapes")); }],
    ["the model answers another shape", (m: MockFetch) => { m.tavily.push(tavilyReply(REPORTS)); m.model.push(modelReply({ shapes: "none" })); }],
    ["the model stops at max_tokens", (m: MockFetch) => { m.tavily.push(tavilyReply(REPORTS)); m.model.push(modelReply(shapeOutput(), "length")); }],
    ["no shape has a real source", (m: MockFetch) => { m.tavily.push(tavilyReply(REPORTS)); m.model.push(modelReply({ in_scope: true, shapes: [(shapeOutput() as { shapes: unknown[] }).shapes[4]] })); }],
  ])("answers assist_unavailable when %s, without retrying", async (_name, arrange) => {
    const { h, mock, deps } = setup();
    arrange(mock);
    const response = await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("assist_unavailable");
    expect(mock.modelCalls().length).toBeLessThanOrEqual(1);
    expect(mock.tavilyCalls()).toHaveLength(1);
    expect(h.logs.join("\n")).not.toContain("synthetic-");
  });

  it("accepts a fenced JSON answer", async () => {
    const { h, mock, deps } = setup();
    mock.tavily.push(tavilyReply(REPORTS));
    mock.model.push(modelReply(`\`\`\`json\n${JSON.stringify(shapeOutput())}\n\`\`\``));
    expect((await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps)).status).toBe(200);
  });

  it("answers rate_limited after 60 calls per session in an hour", async () => {
    const { h, mock, deps } = setup();
    for (let index = 0; index < 60; index += 1) {
      mock.tavily.push(tavilyReply(REPORTS));
      mock.model.push(modelReply(shapeOutput()));
      expect((await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps)).status).toBe(200);
    }
    const response = await postBugShapes(post(path, { query: "date/time bugs" }), h.server, deps);
    expect(response.status).toBe(429);
    const error = (await body(response)).error as { code: string; retry_after_s: number };
    expect(error.code).toBe("rate_limited");
    expect(error.retry_after_s).toBe(3600);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(mock.tavilyCalls()).toHaveLength(60);
  });
});

const SHAPE = { title: "Day boundaries in the wrong time zone", summary: "Daily groupings use the server's zone, so events near midnight count on the wrong day.", sources: [{ title: REPORTS[0]?.title ?? "", url: REPORTS[0]?.url ?? "" }] };
const SPEC = {
  in_scope: true,
  title: "Daily totals grouped in the server's time zone",
  where: "The website statistics query that groups page views by day, and the daily chart that reads it.",
  change: "The grouping uses the database session's zone instead of the viewer's zone, so views near midnight land on the neighboring day.",
  why_tests_miss: "The existing tests run with the server and the viewer in UTC, where both zones agree.",
  checks_to_add: ["Record a view at 23:30 in a UTC-5 zone and check it counts on that local day.", "Check the daily totals sum to the range total for a non-UTC zone."],
  fix: "Group by the viewer's zone again.",
};

describe("bug spec", () => {
  const path = "/api/factory/assist/bug-spec";

  it("answers signed_out without the session", async () => {
    const { h, mock, deps } = setup();
    expect(await errorCode(await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }, false), h.server, deps))).toBe("signed_out");
    expect(mock.calls).toEqual([]);
  });

  it.each([
    ["an unknown host", { shape: SHAPE, host_id: "other" }],
    ["no shape", { host_id: "umami" }],
    ["a source that is not a web URL", { shape: { ...SHAPE, sources: [{ title: "x", url: "file:///etc/hosts" }] }, host_id: "umami" }],
    ["a summary over the cap", { shape: { ...SHAPE, summary: "x".repeat(1201) }, host_id: "umami" }],
  ])("answers invalid_request for %s", async (_name, value) => {
    const { h, mock, deps } = setup();
    const response = await postBugSpec(post(path, value), h.server, deps);
    expect(response.status).toBe(400);
    expect(mock.calls).toEqual([]);
  });

  it("refuses a security shape before any provider call", async () => {
    const { h, mock, deps } = setup();
    const response = await postBugSpec(post(path, { shape: { ...SHAPE, title: "Login lockout race" }, host_id: "umami" }), h.server, deps);
    expect(response.status).toBe(422);
    expect(mock.calls).toEqual([]);
  });

  it("answers assist_unavailable without the Token Factory key", async () => {
    const { h, mock, deps } = setup({ ...CONFIG, tokenFactoryKey: null });
    expect((await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps)).status).toBe(503);
    expect(mock.calls).toEqual([]);
  });

  it("writes a component-level design for the target app, taking the whole shape the page was shown", async () => {
    const { h, mock, deps } = setup({ ...CONFIG, tavilyKey: null });
    mock.model.push(modelReply(SPEC));
    const shown = { ...SHAPE, id: "shape-1", fit: null, fit_reason: "none" };
    const response = await postBugSpec(post(path, { shape: shown, host_id: "umami" }), h.server, deps);
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result.spec).toEqual({ title: SPEC.title, target_app: "Umami", where: SPEC.where, change: SPEC.change, why_tests_miss: SPEC.why_tests_miss, checks_to_add: SPEC.checks_to_add, fix: SPEC.fix });
    expect(result.model).toEqual({ provider: "nebius-token-factory", model_id: DEFAULT_ASSIST_MODEL, at: new Date(START).toISOString() });
    const [model] = mock.modelCalls();
    expect(model?.body.max_tokens).toBe(1800);
    expect(model?.raw).toContain("umami@ec0ff503");
    expect(model?.raw).toContain("component level");
    expect(mock.tavilyCalls()).toEqual([]);
  });

  it.each([
    ["marks out of scope", { ...SPEC, in_scope: false }, "model_out_of_scope"],
    ["turns to login or permissions", { ...SPEC, change: "The login handler skips the permission check under load." }, "output_security_term:change"],
    ["names authentication", { ...SPEC, where: "The authentication middleware that stamps each request's time." }, "output_security_term:where"],
    ["names a credential in a check", { ...SPEC, checks_to_add: ["Check the totals.", "Rotate the credential and check again."] }, "output_security_term:checks_to_add"],
  ])("refuses a design the model %s twice, after asking once more", async (_name, output, reason) => {
    const { h, mock, deps } = setup();
    mock.model.push(modelReply(output), modelReply(output));
    const response = await postBugSpec(post(path, { shape: SHAPE, host_id: "task-report" }), h.server, deps);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("refused");
    expect(mock.modelCalls()).toHaveLength(2);
    expect(h.logs).toEqual([`assist bug-spec: ${reason}; retrying the model call once`, `assist bug-spec: ${reason}; answered refused`]);
  });

  it.each([
    ["marked out of scope", { ...SPEC, in_scope: false }, "model_out_of_scope"],
    ["naming a security term", { ...SPEC, fix: "Remove the injected offset." }, "output_security_term:fix"],
  ])("serves the second design when the first is %s", async (_name, first, reason) => {
    const { h, mock, deps } = setup();
    mock.model.push(modelReply(first), modelReply(SPEC));
    const response = await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps);
    expect(response.status).toBe(200);
    expect(((await body(response)).spec as { title: string }).title).toBe(SPEC.title);
    const calls = mock.modelCalls();
    expect(calls).toHaveLength(2);
    // The same call again: the same prompt, max_tokens and model.
    expect(calls[1]?.raw).toBe(calls[0]?.raw);
    expect(h.logs).toEqual([`assist bug-spec: ${reason}; retrying the model call once`]);
  });

  it("allows bypass and payload in a design, at the first answer", async () => {
    const { h, mock, deps } = setup();
    const design = { ...SPEC, change: "The cached path bypasses the time-zone conversion, so event payloads near midnight land on the neighboring day.", checks_to_add: ["Send a payload at 23:30 in a UTC-5 zone and check the day it counts on."] };
    mock.model.push(modelReply(design));
    const response = await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps);
    expect(response.status).toBe(200);
    expect(((await body(response)).spec as { change: string }).change).toBe(design.change);
    expect(mock.modelCalls()).toHaveLength(1);
    expect(h.logs).toEqual([]);
  });

  it("refuses a shape that names bypass before any provider call, with the input reason code", async () => {
    const { h, mock, deps } = setup();
    const response = await postBugSpec(post(path, { shape: { ...SHAPE, summary: "A cache bypass shifts daily totals." }, host_id: "umami" }), h.server, deps);
    expect(response.status).toBe(422);
    expect(mock.calls).toEqual([]);
    expect(h.logs).toEqual(["assist bug-spec: input_security_term; answered refused"]);
  });

  it("does not retry a provider failure", async () => {
    const { h, mock, deps } = setup();
    mock.model.push(jsonResponse({}, 503), modelReply(SPEC));
    const response = await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("assist_unavailable");
    expect(mock.modelCalls()).toHaveLength(1);
  });

  it("counts the retry against the session's limit, and answers refused when no call is left for it", async () => {
    const { h, mock, deps } = setup();
    mock.model.push(modelReply({ ...SPEC, in_scope: false }), modelReply(SPEC));
    expect((await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps)).status).toBe(200);
    for (let index = 0; index < 57; index += 1) {
      mock.model.push(modelReply(SPEC));
      expect((await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps)).status).toBe(200);
    }
    // 59 calls taken: this request takes the 60th, and its retry finds no room.
    mock.model.push(modelReply({ ...SPEC, in_scope: false }), modelReply(SPEC));
    const response = await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps);
    expect(response.status).toBe(422);
    expect(mock.modelCalls()).toHaveLength(60);
    expect(h.logs.at(-1)).toBe("assist bug-spec: model_out_of_scope (no retry: rate limited); answered refused");
    expect((await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps)).status).toBe(429);
  });

  it("does not use a design that holds code or patch text", async () => {
    for (const change of ["```diff\n- a\n+ b\n```", "@@ -1,2 +1,2 @@ the grouping", "const zone = 'UTC';"]) {
      const { h, mock, deps } = setup();
      mock.model.push(modelReply({ ...SPEC, change }));
      const response = await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps);
      expect(response.status).toBe(503);
    }
  });

  it("answers assist_unavailable when the model fails", async () => {
    const { h, mock, deps } = setup();
    mock.model.push(new TypeError("synthetic network failure"));
    expect(await errorCode(await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps))).toBe("assist_unavailable");
  });

  it("answers rate_limited after 60 calls per session", async () => {
    const { h, mock, deps } = setup();
    for (let index = 0; index < 60; index += 1) {
      mock.model.push(modelReply(SPEC));
      expect((await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps)).status).toBe(200);
    }
    expect((await postBugSpec(post(path, { shape: SHAPE, host_id: "umami" }), h.server, deps)).status).toBe(429);
  });
});

const VALIDATOR_MARKER = "VALIDATOR-ONLY-7f3c: expected vector 42 for the held-out check";
const INCIDENT = "Two clients completed the same task within a few milliseconds. Both received a success response. The daily completion report for that date later showed only one completion. Nothing in the service logs pointed at a failure.";

const encoder = new TextEncoder();
const CASE = FULFILLED.cases[0];
const CASE_ID = CASE?.case_id ?? "";
const BUG_CASE = packArchive([
  { path: "bug-case.json", bytes: encoder.encode(JSON.stringify({ format: "rbw-bug-case/1", runtime: { kit_image: "rbw-kit-task-report:v2", kit_image_digest: `sha256:${"0".repeat(64)}`, setup: ["npm ci"] } })) },
  { path: "incident/report.md", bytes: encoder.encode(INCIDENT) },
  { path: "source/src/server.ts", bytes: encoder.encode("// buggy source, not sent to the model\n") },
]);
const VALIDATOR = packArchive([{ path: "checks/f3.json", bytes: encoder.encode(VALIDATOR_MARKER) }]);

const BRIEF = {
  what_it_is: "Overlapping completions of one task both succeed, but the daily report counts one.",
  how_to_run: "Unpack the bug case and run its setup in the kit image.",
  how_to_validate: "Keep the validator away from the agent, then judge its repair against the validator's checks.",
};

/** A finished request whose first case's bug case and validator are stored. */
function seedDelivered(h: Harness, overrides: Partial<RequestStatus> = {}): void {
  const status = structuredClone(FULFILLED);
  const delivered = status.cases[0];
  if (delivered === undefined) throw new Error("the fixture has no case");
  delivered.packages.bug_case = { ...delivered.packages.bug_case, sha256: sha256(BUG_CASE), size_bytes: BUG_CASE.length };
  delivered.packages.validator = { ...delivered.packages.validator, sha256: sha256(VALIDATOR), size_bytes: VALIDATOR.length };
  seedRequest(h, { ...status, ...overrides });
  h.ports.packages.set(`${REQUEST_ID}/${CASE_ID}/bug-case`, { bytes: BUG_CASE, sha256: sha256(BUG_CASE), size: BUG_CASE.length, filename: delivered.packages.bug_case.filename });
  h.ports.packages.set(`${REQUEST_ID}/${CASE_ID}/validator`, { bytes: VALIDATOR, sha256: sha256(VALIDATOR), size: VALIDATOR.length, filename: delivered.packages.validator.filename });
}

describe("delivery brief", () => {
  const path = "/api/factory/assist/delivery-brief";
  const ask = { request_id: REQUEST_ID, case_id: CASE_ID };

  it("answers signed_out without the session, before any port or provider call", async () => {
    const { h, mock, deps } = setup();
    seedDelivered(h);
    expect(await errorCode(await postDeliveryBrief(post(path, ask, false), h.server, deps))).toBe("signed_out");
    expect(h.ports.calls).toEqual([]);
    expect(mock.calls).toEqual([]);
  });

  it.each([
    ["a request ID that is not a UUID", { request_id: "1", case_id: CASE_ID }],
    ["a case ID that is not a SHA-256", { request_id: REQUEST_ID, case_id: "ab" }],
    ["an unknown field", { ...ask, part: "validator" }],
  ])("answers invalid_request for %s", async (_name, value) => {
    const { h, deps } = setup();
    expect((await postDeliveryBrief(post(path, value), h.server, deps)).status).toBe(400);
  });

  it.each([
    ["an unknown request", (): void => undefined, ask],
    ["a request that is not finished", (h: Harness) => { seedDelivered(h, { state: "running", outcome: null, stop_reason: null }); }, ask],
    ["a case the request did not deliver", (h: Harness) => { seedDelivered(h); }, { request_id: REQUEST_ID, case_id: "ee".repeat(32) }],
  ])("answers not_found for %s", async (_name, arrange, value) => {
    const { h, mock, deps } = setup();
    arrange(h);
    const response = await postDeliveryBrief(post(path, value), h.server, deps);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
    expect(mock.calls).toEqual([]);
    expect(h.ports.calls.some((call) => call.startsWith("readPackage"))).toBe(false);
  });

  it("answers not_found while the bug case is not ready", async () => {
    const { h, deps } = setup();
    seedDelivered(h);
    h.ports.statusOverride = (status) => ({ ...status, cases: status.cases.map((item) => ({ ...item, packages: { ...item.packages, bug_case: { ...item.packages.bug_case, ready: false, download_path: null } } })) });
    expect((await postDeliveryBrief(post(path, ask), h.server, deps)).status).toBe(404);
  });

  it.each([
    ["the Token Factory key", { ...CONFIG, tokenFactoryKey: null }],
    ["the Tavily key", { ...CONFIG, tavilyKey: null }],
  ])("answers assist_unavailable without %s", async (_name, config) => {
    const { h, mock, deps } = setup(config);
    seedDelivered(h);
    expect((await postDeliveryBrief(post(path, ask), h.server, deps)).status).toBe(503);
    expect(mock.calls).toEqual([]);
  });

  it("writes the brief from the public bug case only and checks the incident wording", async () => {
    const { h, mock, deps } = setup();
    seedDelivered(h);
    mock.model.push(modelReply(BRIEF));
    for (let index = 0; index < 3; index += 1) mock.tavily.push((call) => tavilyReply(index === 0 ? [{ title: "Match", url: "https://example.com/post", content: String(call.body.query) }] : []));
    const response = await postDeliveryBrief(post(path, ask), h.server, deps);
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result.brief).toEqual(BRIEF);
    const novelty = result.novelty as { provider: string; checked_at: string; phrases: string[]; public_matches: { phrase: string; url: string }[] };
    expect(novelty.provider).toBe("tavily");
    expect(novelty.checked_at).toBe(new Date(START).toISOString());
    expect(novelty.phrases.length).toBeGreaterThan(0);
    expect(novelty.phrases.length).toBeLessThanOrEqual(3);
    for (const phrase of novelty.phrases) expect(INCIDENT).toContain(phrase);
    expect(novelty.public_matches).toHaveLength(1);
    expect(result.caveat).toMatch(/public catalog/);
    expect(result.caveat).toMatch(/wording/);
    expect(result.model).toEqual({ provider: "nebius-token-factory", model_id: DEFAULT_ASSIST_MODEL, at: new Date(START).toISOString() });

    const searches = mock.tavilyCalls();
    expect(searches).toHaveLength(novelty.phrases.length);
    for (const [index, search] of searches.entries()) {
      expect(search.body.exact_match).toBe(true);
      expect(search.body.include_answer).toBe(false);
      expect(search.body.query).toBe(`"${novelty.phrases[index] ?? ""}"`);
    }
    const [model] = mock.modelCalls();
    expect(model?.body.max_tokens).toBe(1500);
    expect(model?.raw).toContain(JSON.stringify(INCIDENT).slice(1, -1));
    expect(model?.raw).toContain("rbw-kit-task-report:v2");
    expect(model?.raw).not.toContain("buggy source, not sent to the model");
  });

  it("never reads the validator part, and no validator byte reaches any provider", async () => {
    const { h, mock, deps } = setup();
    seedDelivered(h);
    mock.model.push(modelReply(BRIEF));
    for (let index = 0; index < 3; index += 1) mock.tavily.push(tavilyReply([]));
    expect((await postDeliveryBrief(post(path, ask), h.server, deps)).status).toBe(200);
    expect(h.ports.calls.filter((call) => call.startsWith("readPackage"))).toEqual(["readPackage:bug-case"]);
    expect(mock.calls.length).toBeGreaterThan(0);
    for (const call of mock.calls) {
      expect(call.raw).not.toContain(VALIDATOR_MARKER);
      expect(call.raw).not.toContain("VALIDATOR-ONLY");
      expect(call.raw).not.toContain(sha256(VALIDATOR));
    }
  });

  it("answers assist_unavailable when the stored bug case does not match the case", async () => {
    const { h, mock, deps } = setup();
    seedDelivered(h);
    const other = packArchive([{ path: "incident/report.md", bytes: encoder.encode("another report") }]);
    h.ports.packages.set(`${REQUEST_ID}/${CASE_ID}/bug-case`, { bytes: other, sha256: sha256(BUG_CASE), size: BUG_CASE.length, filename: "x.tar.gz" });
    const response = await postDeliveryBrief(post(path, ask), h.server, deps);
    expect(response.status).toBe(503);
    expect(mock.calls).toEqual([]);
  });

  it("answers assist_unavailable when a phrase search fails", async () => {
    const { h, mock, deps } = setup();
    seedDelivered(h);
    mock.model.push(modelReply(BRIEF));
    mock.tavily.push(jsonResponse({}, 502), tavilyReply([]), tavilyReply([]));
    expect((await postDeliveryBrief(post(path, ask), h.server, deps)).status).toBe(503);
  });

  it("answers assist_unavailable when the status cannot be read", async () => {
    const { h, deps } = setup();
    h.ports.status = () => Promise.reject(new Error("synthetic database outage"));
    const response = await postDeliveryBrief(post(path, ask), h.server, deps);
    expect(response.status).toBe(503);
    expect(h.logs.join("\n")).not.toContain("synthetic database outage");
  });

  it("answers rate_limited after 30 briefs per session", async () => {
    const { h, mock, deps } = setup();
    seedDelivered(h);
    for (let index = 0; index < 30; index += 1) {
      mock.model.push(modelReply(BRIEF));
      for (let search = 0; search < 3; search += 1) mock.tavily.push(tavilyReply([]));
      expect((await postDeliveryBrief(post(path, ask), h.server, deps)).status).toBe(200);
    }
    expect((await postDeliveryBrief(post(path, ask), h.server, deps)).status).toBe(429);
  });
});

describe("rate limiter", () => {
  it("counts each session and route apart, caps the instance and frees calls an hour later", () => {
    const limiter = new RateLimiter();
    for (let index = 0; index < 30; index += 1) expect(limiter.take("delivery-brief", "a", 0).ok).toBe(true);
    expect(limiter.take("delivery-brief", "a", 1000)).toEqual({ ok: false, retry_after_s: 3599 });
    expect(limiter.take("delivery-brief", "b", 1000).ok).toBe(true);
    expect(limiter.take("bug-spec", "a", 1000).ok).toBe(true);
    expect(limiter.take("delivery-brief", "a", WINDOW_MS + 1).ok).toBe(true);
  });

  it("shares 60 shape searches, 60 specifications and 30 briefs per session, and 600 calls per instance, an hour", () => {
    expect(SESSION_LIMITS).toEqual({ "bug-shapes": 60, "bug-spec": 60, "delivery-brief": 30 });
    expect(INSTANCE_LIMIT).toBe(600);
  });

  it("refuses every session once the instance took 600 calls in the hour", () => {
    const limiter = new RateLimiter();
    for (let index = 0; index < INSTANCE_LIMIT; index += 1) expect(limiter.take("bug-shapes", `session-${String(index)}`, index).ok).toBe(true);
    expect(limiter.take("bug-spec", "fresh", INSTANCE_LIMIT).ok).toBe(false);
    expect(limiter.take("bug-spec", "fresh", WINDOW_MS + 1).ok).toBe(true);
  });
});

describe("configuration", () => {
  it("reads the designer's variables by name; absence or empty leaves them unset", () => {
    expect(loadAssistConfig({})).toEqual({ tokenFactoryKey: null, tavilyKey: null, model: DEFAULT_ASSIST_MODEL });
    expect(loadAssistConfig({ RBW_ASSIST_TOKEN_FACTORY_KEY: "", RBW_ASSIST_TAVILY_KEY: "" })).toEqual({ tokenFactoryKey: null, tavilyKey: null, model: DEFAULT_ASSIST_MODEL });
    expect(loadAssistConfig({ RBW_ASSIST_TOKEN_FACTORY_KEY: "a", RBW_ASSIST_TAVILY_KEY: "b", RBW_ASSIST_MODEL: "nvidia/other-model-1" })).toEqual({ tokenFactoryKey: "a", tavilyKey: "b", model: "nvidia/other-model-1" });
    expect(loadAssistConfig({ RBW_ASSIST_MODEL: "not a model id" }).model).toBe(DEFAULT_ASSIST_MODEL);
  });
});

describe("scope and novelty helpers", () => {
  it.each(["date/time bugs", "concurrency: lost updates", "state machine stuck after retry", "UI logic in the date picker", "author name sorting"])("keeps %j in scope", (text) => {
    expect(securityTopic(text)).toBe(false);
  });

  it.each(["XSS in comments", "OAuth redirect", "privilege escalation", "sign-in page race", "secret rotation", "CVE-2024-1234"])("treats %j as a security topic", (text) => {
    expect(securityTopic(text)).toBe(true);
  });

  it("leaves bypass and payload out of the design check only", () => {
    for (const text of ["The cached path bypasses the time-zone conversion.", "Umami's event payloads carry a local timestamp."]) {
      expect(securityTopic(text)).toBe(true);
      expect(designSecurityTopic(text)).toBe(false);
    }
    for (const text of ["The authentication step runs first.", "SQL injection in the filter.", "A permission check races."]) expect(designSecurityTopic(text)).toBe(true);
  });

  it("finds code and patch text but not prose", () => {
    expect(holdsCode("The grouping uses the server's zone; the fix restores the viewer's zone.")).toBe(false);
    expect(holdsCode("```ts\nx\n```")).toBe(true);
    expect(holdsCode("--- a/src/x.ts")).toBe(true);
  });

  it("picks at most three distinct phrases from the incident text", () => {
    const phrases = distinctivePhrases(INCIDENT);
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases.length).toBeLessThanOrEqual(3);
    expect(new Set(phrases).size).toBe(phrases.length);
    expect(distinctivePhrases("")).toEqual([]);
  });
});

describe("delivery brief over test mode's ports", () => {
  it("reads only the bug case part, whose validator holds the evaluator sentinel, and sends none of it to a provider", async () => {
    const clock = { ms: START };
    const world = new TestWorld({ fixtures: loadTestFixtures(FIXTURES), passcode: PASSCODE, clock: () => clock.ms, stepMs: 100, holdMs: 0 });
    const reads: string[] = [];
    const readPackage = world.readPackage.bind(world);
    world.readPackage = (requestId, caseId, part) => {
      reads.push(part);
      return readPackage(requestId, caseId, part);
    };
    const server: FactoryServer = { ports: world, requestRoot: (id) => `root-of-${id}`, test: world, log: () => undefined };
    await postTestReset(request("/api/factory/test/reset", { body: { scenario: "two-host-fulfilled" }, session: false }), server);
    const input = fixture("RequestStatus", SCENARIO_FIXTURE["two-host-fulfilled"]).interpretation.input;
    const interpretation = (await (await postInterpretation(request("/api/factory/interpretations", { body: input, session: false }), server)).json()) as { interpretation_sha256: string };
    expect((await postStart(request("/api/factory/requests", { body: { request_id: REQUEST_ID, input, interpretation_sha256: interpretation.interpretation_sha256 } }), server)).status).toBe(202);
    let status: RequestStatus | null = null;
    for (let poll = 0; poll < 400 && status?.state !== "finished"; poll += 1) {
      status = (await (await getRequestStatus(request(`/api/factory/requests/${REQUEST_ID}?after=0`), server, { request_id: REQUEST_ID })).json()) as RequestStatus;
      clock.ms += 100;
    }
    const delivered = status?.cases[0];
    if (delivered === undefined) throw new Error("synthetic: test mode delivered no case");

    const mock = new MockFetch();
    mock.model.push(modelReply(BRIEF));
    const deps: AssistDeps = { config: CONFIG, fetch: mock.fetch, limiter: new RateLimiter(), now: () => new Date(clock.ms) };
    const response = await postDeliveryBrief(post("/api/factory/assist/delivery-brief", { request_id: REQUEST_ID, case_id: delivered.case_id }), server, deps);
    expect(response.status).toBe(200);
    expect(reads).toEqual(["bug-case"]);
    expect(mock.modelCalls()).toHaveLength(1);
    for (const call of mock.calls) expect(call.raw).not.toContain(TEST_MODE_EVALUATOR_SENTINEL);
    expect(await response.text()).not.toContain(TEST_MODE_EVALUATOR_SENTINEL);
  });
});

describe("route files", () => {
  it("mount each endpoint under the factory session's path, dynamic, with room for two 20 s calls", async () => {
    const modules = await Promise.all([
      import("../../app/api/factory/assist/bug-shapes/route.ts"),
      import("../../app/api/factory/assist/bug-spec/route.ts"),
      import("../../app/api/factory/assist/delivery-brief/route.ts"),
    ]);
    for (const route of modules) {
      expect(typeof route.POST).toBe("function");
      expect(route.dynamic).toBe("force-dynamic");
      expect(route.maxDuration).toBe(60);
    }
  });
});
