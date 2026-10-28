// The bug designer's server: the factory server (for the session check, the capabilities and a
// delivered case's status and bug case) and the designer's own dependencies, built per call from the
// environment, with one rate limiter per server instance.
import { assistTestProviderOrigin, loadAssistConfig } from "../config.ts";
import { factoryServer } from "../factory-server/server.ts";
import type { FactoryServer } from "../factory-server/ports.ts";
import type { AssistDeps } from "./handlers.ts";
import { assistError } from "./http.ts";
import { RateLimiter } from "./limits.ts";
import { CHAT_COMPLETIONS_URL, TAVILY_SEARCH_URL, type Fetch } from "./providers.ts";

const shared = globalThis as typeof globalThis & { __rbwAssistLimiter?: RateLimiter };

/**
 * Test only: sends the two provider URLs to a local stub instead (RBW_ASSIST_TEST_PROVIDER_ORIGIN, honored
 * in local factory test mode only; see src/config.ts). Every other URL, and every call without the
 * override, goes to the real fetch unchanged.
 */
export function providerFetch(fetchFn: Fetch, testOrigin: string | null): Fetch {
  if (testOrigin === null) return fetchFn;
  const stub: Readonly<Record<string, string>> = { [CHAT_COMPLETIONS_URL]: `${testOrigin}/v1/chat/completions`, [TAVILY_SEARCH_URL]: `${testOrigin}/search` };
  return (input, init) => fetchFn(typeof input === "string" ? stub[input] ?? input : input, init);
}

export function assistDeps(): AssistDeps {
  shared.__rbwAssistLimiter ??= new RateLimiter();
  const fetchFn = providerFetch(globalThis.fetch.bind(globalThis), assistTestProviderOrigin());
  return { config: loadAssistConfig(), fetch: fetchFn, limiter: shared.__rbwAssistLimiter, now: () => new Date() };
}

/** Runs a designer route; a factory server that cannot be built answers assist_unavailable. */
export async function handleAssist(run: (server: FactoryServer, deps: AssistDeps) => Promise<Response>): Promise<Response> {
  let server: FactoryServer;
  try {
    server = await factoryServer();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.log(`assist: the factory server could not be built (${error.name}); answered assist_unavailable`);
    return assistError("assist_unavailable");
  }
  return run(server, assistDeps());
}
