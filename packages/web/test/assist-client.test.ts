// The /api/factory/assist browser client against a mocked fetch: no real provider is ever called.
import { describe, expect, it, vi } from "vitest";
import { createAssistClient, parseFailure, queryProblem, safeUrl } from "../src/assist/client.ts";
import { SHAPES, SPEC, BRIEF } from "./support/assist-fixtures.ts";

const sent = (init: RequestInit | undefined): unknown => JSON.parse(typeof init?.body === "string" ? init.body : "null");
function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));
}

describe("assist client", () => {
  it("posts the contract bodies to the three routes with the session cookie", async () => {
    const fetcher = respond(200, SHAPES);
    const client = createAssistClient(fetcher);
    const shapes = await client.bugShapes("date/time bugs");
    expect(shapes).toEqual({ ok: true, value: SHAPES });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("/api/factory/assist/bug-shapes");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(sent(init)).toEqual({ query: "date/time bugs" });

    const specFetch = respond(200, SPEC);
    const shape = SHAPES.shapes[0];
    if (shape === undefined) throw new Error("fixture");
    expect(await createAssistClient(specFetch).bugSpec(shape, "umami")).toEqual({ ok: true, value: SPEC });
    expect(specFetch.mock.calls[0]?.[0]).toBe("/api/factory/assist/bug-spec");
    expect(sent(specFetch.mock.calls[0]?.[1])).toEqual({ shape: { title: shape.title, summary: shape.summary, sources: shape.sources }, host_id: "umami" });

    const briefFetch = respond(200, BRIEF);
    expect(await createAssistClient(briefFetch).deliveryBrief("0b6a2f0e-2a8f-4a43-9a51-2f1c9e8c4d10", "case-1")).toEqual({ ok: true, value: BRIEF });
    expect(briefFetch.mock.calls[0]?.[0]).toBe("/api/factory/assist/delivery-brief");
    expect(sent(briefFetch.mock.calls[0]?.[1])).toEqual({ request_id: "0b6a2f0e-2a8f-4a43-9a51-2f1c9e8c4d10", case_id: "case-1" });
  });

  it("maps every error envelope to a plain failure and never throws", async () => {
    const cases: [number, unknown, object][] = [
      [401, { error: { code: "signed_out" } }, { code: "signed_out" }],
      [401, undefined, { code: "signed_out" }],
      [400, { error: { code: "invalid_request", message: "query too short" } }, { code: "invalid_request", message: "query too short" }],
      [422, { error: { code: "refused", message: "Security topics are out of scope." } }, { code: "refused", message: "Security topics are out of scope." }],
      [429, { error: { code: "rate_limited", retry_after_s: 12.2 } }, { code: "rate_limited", retryAfterS: 13 }],
      [503, { error: { code: "assist_unavailable", message: "no key" } }, { code: "unavailable" }],
      [500, "<html>", { code: "unavailable" }],
      [418, { error: { code: "teapot" } }, { code: "unavailable" }],
    ];
    for (const [status, body, expected] of cases) {
      const outcome = await createAssistClient(respond(status, body)).bugShapes("lost updates");
      expect(outcome.ok, String(status)).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toMatchObject(expected);
    }
    const network = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("offline")));
    expect(await createAssistClient(network).bugShapes("lost updates")).toEqual({ ok: false, failure: { code: "unavailable", message: null, retryAfterS: null } });
  });

  it("treats an unreadable success as unavailable and drops unsafe links and malformed fits", async () => {
    expect((await createAssistClient(respond(200, { shapes: [] })).bugShapes("abc")).ok).toBe(false);
    expect((await createAssistClient(respond(200, { ...SPEC, spec: { title: "x" } })).bugSpec({ title: "a", summary: "b", sources: [] }, "umami")).ok).toBe(false);
    const messy = { ...SHAPES, shapes: [{ ...SHAPES.shapes[0], sources: [{ title: "bad", url: "javascript:alert(1)" }, { title: "ok", url: "https://example.org/issue/1" }], fit: { host_id: "elsewhere", bug_type_id: "x", phrase: "y" } }, { title: 3 }] };
    const outcome = await createAssistClient(respond(200, messy)).bugShapes("abc");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.shapes).toHaveLength(1);
      expect(outcome.value.shapes[0]?.sources).toEqual([{ title: "ok", url: "https://example.org/issue/1" }]);
      expect(outcome.value.shapes[0]?.fit).toBeNull();
    }
  });

  it("gives up after its timeout as unavailable", async () => {
    const hanging = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new DOMException("aborted", "AbortError")); });
    }));
    expect(await createAssistClient(hanging, 5).bugShapes("abc")).toMatchObject({ ok: false, failure: { code: "unavailable" } });
  });

  it("checks the query length and link schemes locally", () => {
    expect(queryProblem("  ab ")).not.toBeNull();
    expect(queryProblem("abc")).toBeNull();
    expect(queryProblem("a".repeat(301))).not.toBeNull();
    expect(safeUrl("ftp://example.org")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl("http://example.org/a")).toBe("http://example.org/a");
    expect(parseFailure(429, null)).toEqual({ code: "rate_limited", message: null, retryAfterS: null });
  });
});
