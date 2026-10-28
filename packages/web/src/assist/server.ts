// The bug designer's server: the factory server (for the session check, the capabilities and a
// delivered case's status and bug case) and the designer's own dependencies, built per call from the
// environment, with one rate limiter per server instance.
import { loadAssistConfig } from "../config.ts";
import { factoryServer } from "../factory-server/server.ts";
import type { FactoryServer } from "../factory-server/ports.ts";
import type { AssistDeps } from "./handlers.ts";
import { assistError } from "./http.ts";
import { RateLimiter } from "./limits.ts";

const shared = globalThis as typeof globalThis & { __rbwAssistLimiter?: RateLimiter };

export function assistDeps(): AssistDeps {
  shared.__rbwAssistLimiter ??= new RateLimiter();
  return { config: loadAssistConfig(), fetch: globalThis.fetch.bind(globalThis), limiter: shared.__rbwAssistLimiter, now: () => new Date() };
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
