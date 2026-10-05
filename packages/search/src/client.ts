// The one place a Tavily client is constructed. The SDK sends unauthenticated "keyless" requests to
// the real API when it has no key, so construction refuses a missing or blank key before any network
// use, and it requires an explicit base URL so a test cannot reach the real API by default.
import { tavily } from "@tavily/core";
import type { TavilyClient } from "@tavily/core";
import { SearchError } from "./errors.ts";

/** The two Tavily calls this package uses. Library functions take this as an injected dependency. */
export type SearchClient = Pick<TavilyClient, "search" | "extract">;

export interface ClientOptions {
  apiKey: string | undefined;
  apiBaseURL: string;
  /** Allows the real Tavily host. Only the `record` command sets it. */
  allowLive?: boolean;
}

function isTavilyHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "tavily.com" || host.endsWith(".tavily.com");
}

export function createTavilyClient(options: ClientOptions): SearchClient {
  if (options.apiKey === undefined || options.apiKey.trim() === "") {
    throw new SearchError("missing_api_key");
  }
  // `apiBaseURL` is required by the type; the runtime check covers callers that bypass it.
  const base = options.apiBaseURL as string | undefined;
  if (base === undefined || base === "") {
    throw new SearchError("missing_base_url");
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new SearchError("invalid_base_url");
  }
  if (isTavilyHost(url.hostname) && options.allowLive !== true) {
    throw new SearchError("live_endpoint_refused");
  }
  const { search, extract } = tavily({ apiKey: options.apiKey, apiBaseURL: base.replace(/\/+$/, "") });
  return { search, extract };
}
