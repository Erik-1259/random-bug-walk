// The one GitHub REST client: @octokit/core for GET requests by exact path and query, with
// rate-limit handling around it. A primary limit (no calls remaining) waits until the bucket's
// reset time; a secondary limit waits for `retry-after`, or a minute when GitHub gives no time.
// A bucket that reports no calls remaining makes the next request in that bucket wait first.
// Waits longer than the cap, and limits that persist past the retry count, stop the run.
// The token goes only into octokit's authorization header and is never returned or recorded.
import { Octokit } from "@octokit/core";
import { RequestError } from "@octokit/request-error";

export const API_BASE_URL = "https://api.github.com";

export interface Attempt {
  /** The rate-limited status that made the client wait and retry. */
  readonly status: number;
  readonly waited_ms: number;
}

export interface LiveResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** Rate-limited attempts before this response, in order. */
  readonly attempts: readonly Attempt[];
}

export interface GitHubClient {
  get(url: string): Promise<LiveResponse>;
}

export interface GitHubClientOptions {
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The longest single wait the client accepts before it stops. */
  readonly maxWaitMs?: number;
  readonly maxRetries?: number;
}

export class RateLimitExceeded extends Error {
  override name = "RateLimitExceeded";
}

const SECONDARY_WAIT_MS = 60_000;
// Slack after the reset time, because GitHub's reset is in whole seconds.
const RESET_SLACK_MS = 1000;

function headerMap(headers: Record<string, unknown> | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string" || typeof value === "number") {
      map[name.toLowerCase()] = String(value);
    }
  }
  return map;
}

/** GitHub's rate-limit bucket for a request: search endpoints have their own. */
function bucketOf(url: string): string {
  return url.startsWith("/search/") ? "search" : "core";
}

function resetAt(headers: Readonly<Record<string, string>>): number | undefined {
  const reset = Number(headers["x-ratelimit-reset"]);
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 + RESET_SLACK_MS : undefined;
}

/** How long to wait before retrying a rate-limited response, or undefined when it is not rate limited. */
function rateLimitWait(status: number, headers: Readonly<Record<string, string>>, body: unknown, now: number): number | undefined {
  if (status !== 403 && status !== 429) {
    return undefined;
  }
  const retryAfter = Number(headers["retry-after"]);
  if (headers["retry-after"] !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter * 1000;
  }
  if (headers["x-ratelimit-remaining"] === "0") {
    const reset = resetAt(headers);
    return reset === undefined ? SECONDARY_WAIT_MS : Math.max(0, reset - now);
  }
  const message = typeof body === "object" && body !== null && "message" in body ? String(body.message) : "";
  if (status === 429 || /rate limit/i.test(message)) {
    return SECONDARY_WAIT_MS;
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const octokit = new Octokit({
    ...(options.token === undefined ? {} : { auth: options.token }),
    baseUrl: options.baseUrl ?? API_BASE_URL,
    userAgent: "random-bug-walk-harvest",
    ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
  });
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxWaitMs = options.maxWaitMs ?? 61 * 60_000;
  const maxRetries = options.maxRetries ?? 3;
  // Bucket -> the time before which no request may start, set when a bucket reports none remaining.
  const blockedUntil = new Map<string, number>();

  async function wait(ms: number, what: string): Promise<void> {
    if (ms > maxWaitMs) {
      throw new RateLimitExceeded(`${what}: the rate limit resets in ${String(Math.ceil(ms / 1000))} s, beyond the ${String(maxWaitMs / 1000)} s cap`);
    }
    await sleep(ms);
  }

  async function send(url: string): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    try {
      const response = await octokit.request({ method: "GET", url });
      return { status: response.status, headers: headerMap(response.headers), body: response.data };
    } catch (error) {
      if (error instanceof RequestError && error.response !== undefined) {
        return { status: error.status, headers: headerMap(error.response.headers), body: error.response.data };
      }
      throw error;
    }
  }

  return {
    async get(url) {
      const attempts: Attempt[] = [];
      const bucket = bucketOf(url);
      for (;;) {
        const blocked = (blockedUntil.get(bucket) ?? 0) - now();
        if (blocked > 0) {
          await wait(blocked, url);
        }
        blockedUntil.delete(bucket);
        const response = await send(url);
        const reset = resetAt(response.headers);
        if (response.headers["x-ratelimit-remaining"] === "0" && reset !== undefined) {
          blockedUntil.set(bucket, reset);
        }
        const retryIn = rateLimitWait(response.status, response.headers, response.body, now());
        if (retryIn === undefined) {
          return { ...response, attempts };
        }
        blockedUntil.delete(bucket);
        if (attempts.length >= maxRetries) {
          throw new RateLimitExceeded(`${url}: still rate limited after ${String(maxRetries)} retries`);
        }
        await wait(retryIn, url);
        attempts.push({ status: response.status, waited_ms: retryIn });
      }
    },
  };
}
