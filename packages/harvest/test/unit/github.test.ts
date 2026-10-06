import { describe, expect, it } from "vitest";
import { RateLimitExceeded, createGitHubClient } from "../../src/github.ts";

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const RESET = 1_790_000_000;

function scripted(replies: Reply[]): { fetch: typeof fetch; seen: { url: string; authorization: string | null }[] } {
  const seen: { url: string; authorization: string | null }[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    seen.push({ url: `${url.pathname}${url.search}`, authorization: new Headers(init?.headers).get("authorization") });
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error("no scripted reply left");
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "content-type": "application/json", ...reply.headers } }),
    );
  };
  return { fetch: fake, seen };
}

function clock(start: number): { now: () => number; sleep: (ms: number) => Promise<void>; waits: number[] } {
  let at = start;
  const waits: number[] = [];
  return {
    now: () => at,
    sleep: (ms) => {
      waits.push(ms);
      at += ms;
      return Promise.resolve();
    },
    waits,
  };
}

const limited = (resource: string, remaining: string): Record<string, string> => ({
  "x-ratelimit-limit": "30",
  "x-ratelimit-remaining": remaining,
  "x-ratelimit-reset": String(RESET),
  "x-ratelimit-resource": resource,
});

describe("rate-limit handling", () => {
  it("waits until the reset time after a primary rate limit and retries", async () => {
    const api = scripted([
      { status: 403, headers: limited("search", "0"), body: { message: "API rate limit exceeded" } },
      { status: 200, headers: limited("search", "29"), body: { items: [] } },
    ]);
    const time = clock(RESET * 1000 - 20_000);
    const client = createGitHubClient({ fetch: api.fetch, now: time.now, sleep: time.sleep });
    const response = await client.get("/search/commits?q=x");
    expect(response.status).toBe(200);
    expect(time.waits).toEqual([21_000]);
    expect(response.attempts).toEqual([{ status: 403, waited_ms: 21_000 }]);
    expect(api.seen).toHaveLength(2);
  });

  it("honours retry-after on a secondary rate limit (429)", async () => {
    const api = scripted([
      { status: 429, headers: { "retry-after": "7" }, body: { message: "secondary rate limit" } },
      { status: 200, body: {} },
    ]);
    const time = clock(0);
    const response = await createGitHubClient({ fetch: api.fetch, now: time.now, sleep: time.sleep }).get("/repos/a/b");
    expect(response.status).toBe(200);
    expect(time.waits).toEqual([7000]);
  });

  it("treats a 403 with retry-after as a secondary rate limit", async () => {
    const api = scripted([
      { status: 403, headers: { "retry-after": "3" }, body: { message: "You have exceeded a secondary rate limit" } },
      { status: 200, body: {} },
    ]);
    const time = clock(0);
    await createGitHubClient({ fetch: api.fetch, now: time.now, sleep: time.sleep }).get("/repos/a/b");
    expect(time.waits).toEqual([3000]);
  });

  it("waits before the next request in a bucket that reported no remaining calls, and not in another bucket", async () => {
    const api = scripted([
      { status: 200, headers: limited("search", "0"), body: {} },
      { status: 200, headers: limited("core", "100"), body: {} },
      { status: 200, headers: limited("search", "29"), body: {} },
    ]);
    const time = clock(RESET * 1000 - 5000);
    const client = createGitHubClient({ fetch: api.fetch, now: time.now, sleep: time.sleep });
    await client.get("/search/commits?q=a");
    await client.get("/repos/a/b");
    expect(time.waits).toEqual([]);
    await client.get("/search/commits?q=b");
    expect(time.waits).toEqual([6000]);
  });

  it("stops without waiting when the reset is further away than the wait cap", async () => {
    const api = scripted([{ status: 403, headers: limited("core", "0"), body: { message: "API rate limit exceeded" } }]);
    const time = clock(RESET * 1000 - 3_600_000);
    const client = createGitHubClient({ fetch: api.fetch, now: time.now, sleep: time.sleep, maxWaitMs: 60_000 });
    await expect(client.get("/repos/a/b")).rejects.toBeInstanceOf(RateLimitExceeded);
    expect(time.waits).toEqual([]);
  });

  it("stops after the retry limit", async () => {
    const reply: Reply = { status: 429, headers: { "retry-after": "1" }, body: { message: "secondary rate limit" } };
    const api = scripted([reply, reply, reply]);
    const time = clock(0);
    const client = createGitHubClient({ fetch: api.fetch, now: time.now, sleep: time.sleep, maxRetries: 2 });
    await expect(client.get("/repos/a/b")).rejects.toBeInstanceOf(RateLimitExceeded);
    expect(time.waits).toEqual([1000, 1000]);
    expect(api.seen).toHaveLength(3);
  });

  it("returns other error statuses as responses without retrying", async () => {
    const api = scripted([{ status: 404, body: { message: "Not Found" } }]);
    const time = clock(0);
    const response = await createGitHubClient({ fetch: api.fetch, now: time.now, sleep: time.sleep }).get("/repos/a/b");
    expect(response).toMatchObject({ status: 404, body: { message: "Not Found" }, attempts: [] });
    expect(time.waits).toEqual([]);
  });

  it("does not treat a plain 403 as a rate limit", async () => {
    const api = scripted([{ status: 403, headers: limited("core", "4000"), body: { message: "Resource not accessible" } }]);
    const time = clock(0);
    const response = await createGitHubClient({ fetch: api.fetch, now: time.now, sleep: time.sleep }).get("/repos/a/b");
    expect(response.status).toBe(403);
    expect(time.waits).toEqual([]);
  });

  it("sends the token only as an authorization header, and none without a token", async () => {
    const api = scripted([{ status: 200 }, { status: 200 }]);
    await createGitHubClient({ fetch: api.fetch, token: "synthetic-token-value" }).get("/repos/a/b");
    await createGitHubClient({ fetch: api.fetch }).get("/repos/a/b");
    expect(api.seen.map((entry) => entry.authorization)).toEqual(["token synthetic-token-value", null]);
  });

  it("keeps the exact path and query it was given", async () => {
    const api = scripted([{ status: 200 }]);
    await createGitHubClient({ fetch: api.fetch }).get("/repos/o/r/contents/src/%5Bid%5D/a%20b.ts?ref=abc");
    expect(api.seen[0]?.url).toBe("/repos/o/r/contents/src/%5Bid%5D/a%20b.ts?ref=abc");
  });
});
