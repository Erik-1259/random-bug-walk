import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { describe, expect, it } from "vitest";
import { LIVE_HTTP_TIMEOUT_MS, liveFetch } from "../../src/live-fetch.ts";
import { KIMI_PROFILE } from "../../src/profiles.ts";

function agentOptions(dispatcher: unknown): Record<string, unknown> {
  if (!(dispatcher instanceof Agent)) {
    throw new Error("the request carries no undici Agent");
  }
  const key = Object.getOwnPropertySymbols(dispatcher).find((symbol) => symbol.description === "options");
  if (key === undefined) {
    throw new Error("the Agent has no options");
  }
  return (dispatcher as unknown as Record<symbol, Record<string, unknown>>)[key] ?? {};
}

describe("the live fetch", () => {
  it("sends each request with an Agent whose header and body timeouts cover Kimi's 120,000 ms", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const fetch = liveFetch((_input, init) => {
      seen.push(init);
      return Promise.resolve(new Response("{}"));
    });
    await fetch("https://synthetic.example.invalid/v1/chat/completions", { method: "POST", body: "{}" });

    expect(KIMI_PROFILE.hashed.request_timeout_ms).toBe(120_000);
    expect(LIVE_HTTP_TIMEOUT_MS).toBe(120_000);
    const init = seen[0];
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    const options = agentOptions(init?.dispatcher);
    expect(options.headersTimeout).toBeGreaterThanOrEqual(KIMI_PROFILE.hashed.request_timeout_ms);
    expect(options.bodyTimeout).toBeGreaterThanOrEqual(KIMI_PROFILE.hashed.request_timeout_ms);
  });

  it("makes Node's built-in fetch apply the Agent's header timeout", async () => {
    const timers: NodeJS.Timeout[] = [];
    const server = createServer((_request, response) => {
      timers.push(setTimeout(() => response.end("late"), 10_000));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
    try {
      // undici's timers fire up to about 1 s late; without the Agent this would wait the full 10 s.
      await expect(liveFetch(globalThis.fetch, 1_000)(url)).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    } finally {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
  });
});
