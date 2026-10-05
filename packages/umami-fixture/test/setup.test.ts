import { describe, expect, it } from "vitest";
import { loadFixture, runSetup } from "../src/index.ts";
import { fakeContext, healthyReply, type RecordedCall, type Reply } from "./helpers.ts";

const fixture = loadFixture();
const credentials = { username: "synthetic-admin", password: "synthetic-password" };

function sends(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url === "/api/send");
}

function failingSend(atIndex: number, reply: Reply): (call: RecordedCall, calls: RecordedCall[]) => Reply {
  return (call, calls) => (call.url === "/api/send" && sends(calls).length === atIndex + 1 ? reply : healthyReply(call));
}

describe("runSetup", () => {
  it("logs in, creates the website and sends the twelve events once each, in order", async () => {
    const { context, calls } = fakeContext(healthyReply);
    const result = await runSetup(context, fixture, credentials);
    expect(result).toEqual({ ok: true, token: "synthetic-token" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /api/auth/login",
      "POST /api/websites",
      ...Array.from({ length: 12 }, () => "POST /api/send"),
    ]);
    expect(sends(calls).map((call) => (JSON.parse(call.data ?? "") as { payload: { id: string } }).payload.id)).toEqual(
      fixture.events.map((event) => event.id),
    );
    expect(calls[1]?.headers.authorization).toBe("Bearer synthetic-token");
    for (const call of sends(calls)) {
      expect(Object.keys(call.headers).map((name) => name.toLowerCase())).not.toContain("x-umami-cache");
    }
  });

  it.each<[string, Reply]>([
    ["no token", { status: 200, body: { user: { id: "synthetic-user" } } }],
    ["an empty token", { status: 200, body: { token: "" } }],
    ["HTTP 401", { status: 401, body: { error: "synthetic unauthorized" } }],
    ["a non-JSON body", { status: 200, body: "synthetic text" }],
    ["a network error", new Error("synthetic connection refused")],
  ])("gives auth_failed for a login with %s and sends nothing", async (_name, reply) => {
    const { context, calls } = fakeContext((call) => (call.url === "/api/auth/login" ? reply : healthyReply(call)));
    const result = await runSetup(context, fixture, credentials);
    expect(result).toMatchObject({ ok: false, failure_code: "auth_failed" });
    expect(calls).toHaveLength(1);
  });

  it.each<[string, Reply]>([
    ["the wrong id", { status: 200, body: { id: "22222222-2222-4222-8222-222222222222" } }],
    ["no id", { status: 200, body: { name: "Timezone fixture" } }],
    ["HTTP 400", { status: 400, body: { error: "synthetic bad request" } }],
    ["a network error", new Error("synthetic connection reset")],
  ])("gives seed_failed for a website created with %s and sends nothing", async (_name, reply) => {
    const { context, calls } = fakeContext((call) => (call.url === "/api/websites" ? reply : healthyReply(call)));
    const result = await runSetup(context, fixture, credentials);
    expect(result).toMatchObject({ ok: false, failure_code: "seed_failed" });
    expect(sends(calls)).toHaveLength(0);
  });

  it.each<[string, Reply]>([
    ["HTTP 500", { status: 500, body: { error: "synthetic server error" } }],
    ["a beep field", { status: 200, body: { beep: "boop", cache: "synthetic-cache" } }],
    ["an empty cache field", { status: 200, body: { cache: "" } }],
    ["no cache field", { status: 200, body: { ok: true } }],
    ["a non-JSON body", { status: 200, body: "synthetic text" }],
    ["a network error", new Error("synthetic socket hang up")],
  ])("gives seed_failed for a send with %s and makes no further send", async (_name, reply) => {
    const { context, calls } = fakeContext(failingSend(4, reply));
    const result = await runSetup(context, fixture, credentials);
    expect(result).toMatchObject({ ok: false, failure_code: "seed_failed" });
    expect(sends(calls)).toHaveLength(5);
    expect(calls.at(-1)?.url).toBe("/api/send");
  });

  it("never puts the token in a failure reason", async () => {
    const { context } = fakeContext((call, calls) => (call.url === "/api/send" ? { status: 500, body: { echoed: calls[1]?.headers.authorization } } : healthyReply(call)));
    const result = await runSetup(context, fixture, credentials);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("synthetic-token");
  });
});
