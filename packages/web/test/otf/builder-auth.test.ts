// HMAC auth of the builder routes: the signature over ts, method, path and body hash, the
// timestamp window, the constant-time compare, the body limit and fail-closed without a secret.
// The secret is a synthetic test value.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { builderHeaders, builderSignature, verifyBuilderRequest } from "../../src/otf/builder-auth.ts";
import { BUILDER_HEADERS, SIGNATURE_WINDOW_MS } from "../../src/otf/contract.ts";

const SECRET = "synthetic-builder-secret-0123456789abcdef";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const PATH = "/api/factory/otf/builder/claim";
const BODY = JSON.stringify({ builder_id: "builder-a" });

function signed(options: { body?: string; ts?: number; method?: string; path?: string; url?: string; headers?: Record<string, string> } = {}): Request {
  const method = options.method ?? "POST";
  const body = options.body ?? BODY;
  const headers = { ...builderHeaders(SECRET, "builder-a", options.ts ?? NOW, method, options.path ?? PATH, body), ...options.headers };
  return new Request(options.url ?? `https://otf.test${PATH}`, { method, headers, ...(method === "GET" ? {} : { body }) });
}

describe("builder auth", () => {
  it("signs hex HMAC-SHA256 over ts, METHOD, path and the body's sha256, as the contract states", () => {
    const bodyHash = createHash("sha256").update(BODY).digest("hex");
    const expected = createHmac("sha256", SECRET).update(`${String(NOW)}\nPOST\n${PATH}\n${bodyHash}`).digest("hex");
    expect(builderSignature(SECRET, String(NOW), "post", PATH, BODY)).toBe(expected);
    expect(builderHeaders(SECRET, "builder-a", NOW, "POST", PATH, BODY)).toEqual({ [BUILDER_HEADERS.id]: "builder-a", [BUILDER_HEADERS.ts]: String(NOW), [BUILDER_HEADERS.sig]: expected });
  });

  it("accepts a correctly signed request and returns its builder id and exact body bytes", async () => {
    const result = await verifyBuilderRequest(signed(), SECRET, NOW, 1024);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.builder_id).toBe("builder-a");
    expect(new TextDecoder().decode(result.body)).toBe(BODY);
  });

  it("signs the path without the query, and an empty body as the hash of nothing", async () => {
    expect((await verifyBuilderRequest(signed({ url: `https://otf.test${PATH}?x=1` }), SECRET, NOW, 1024)).ok).toBe(true);
    const path = "/api/factory/otf/builder/jobs/00000000-0000-4000-8000-000000000001/artifacts/agent";
    expect((await verifyBuilderRequest(signed({ method: "GET", body: "", path, url: `https://otf.test${path}` }), SECRET, NOW, 0)).ok).toBe(true);
  });

  it("fails closed without a secret: every request is unavailable", async () => {
    expect(await verifyBuilderRequest(signed(), null, NOW, 1024)).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses a changed body, path, method or secret, and a malformed or missing header", async () => {
    const refused = { ok: false, code: "unauthorized" };
    const tampered = new Request(`https://otf.test${PATH}`, { method: "POST", headers: builderHeaders(SECRET, "builder-a", NOW, "POST", PATH, BODY), body: BODY.replace("builder-a", "builder-b") });
    expect(await verifyBuilderRequest(tampered, SECRET, NOW, 1024)).toMatchObject(refused);
    expect(await verifyBuilderRequest(signed({ path: "/api/factory/otf/builder/stop-intent" }), SECRET, NOW, 1024)).toMatchObject(refused);
    const otherMethod = new Request(`https://otf.test${PATH}`, { method: "PUT", headers: builderHeaders(SECRET, "builder-a", NOW, "POST", PATH, BODY), body: BODY });
    expect(await verifyBuilderRequest(otherMethod, SECRET, NOW, 1024)).toMatchObject(refused);
    expect(await verifyBuilderRequest(signed(), `${SECRET}-other`, NOW, 1024)).toMatchObject(refused);
    expect(await verifyBuilderRequest(signed({ headers: { [BUILDER_HEADERS.sig]: "zz" } }), SECRET, NOW, 1024)).toMatchObject(refused);
    expect(await verifyBuilderRequest(signed({ headers: { [BUILDER_HEADERS.id]: "builder b" } }), SECRET, NOW, 1024)).toMatchObject(refused);
    expect(await verifyBuilderRequest(new Request(`https://otf.test${PATH}`, { method: "POST", body: BODY }), SECRET, NOW, 1024)).toMatchObject(refused);
    // Another builder id in the header changes nothing the signature covers, but the handlers match it to the body.
    expect(await verifyBuilderRequest(signed({ headers: { [BUILDER_HEADERS.id]: "builder-b" } }), SECRET, NOW, 1024)).toMatchObject({ ok: true, builder_id: "builder-b" });
  });

  it("accepts a timestamp within the window either way and refuses one outside it", async () => {
    expect((await verifyBuilderRequest(signed({ ts: NOW - SIGNATURE_WINDOW_MS }), SECRET, NOW, 1024)).ok).toBe(true);
    expect((await verifyBuilderRequest(signed({ ts: NOW + SIGNATURE_WINDOW_MS }), SECRET, NOW, 1024)).ok).toBe(true);
    expect(await verifyBuilderRequest(signed({ ts: NOW - SIGNATURE_WINDOW_MS - 1 }), SECRET, NOW, 1024)).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await verifyBuilderRequest(signed({ ts: NOW + SIGNATURE_WINDOW_MS + 1 }), SECRET, NOW, 1024)).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("refuses a body over the route's limit without checking its signature", async () => {
    expect(await verifyBuilderRequest(signed(), SECRET, NOW, BODY.length - 1)).toMatchObject({ ok: false, code: "invalid_request" });
    expect((await verifyBuilderRequest(signed(), SECRET, NOW, BODY.length)).ok).toBe(true);
  });
});
