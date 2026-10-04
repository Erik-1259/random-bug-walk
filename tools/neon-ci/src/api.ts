import type { Config } from "./config.ts";

/** Injected so tests can run without a network, real time or real sleeps. */
export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const realDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export type Attempt =
  | { kind: "response"; status: number; text: string }
  | { kind: "error"; error: string };

export interface Branch {
  id: string;
  name: string;
  isDefault: boolean;
  isProtected: boolean;
  createdAt: string | undefined;
  expiresAt: string | undefined;
}

export type ListResult = { branches: Branch[] } | { unreadable: string };

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 15_000;
const LIST_BUDGET_MS = 30_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

export function isRetryable(attempt: Attempt): boolean {
  if (attempt.kind === "error") return true;
  const { status } = attempt;
  return status === 423 || status === 429 || status >= 500;
}

export function isSuccess(attempt: Attempt): attempt is Extract<Attempt, { kind: "response" }> {
  return attempt.kind === "response" && attempt.status >= 200 && attempt.status < 300;
}

/** Short, value-free description of a failed attempt for log lines. */
export function describe(attempt: Attempt): string {
  return attempt.kind === "response" ? `http ${String(attempt.status)}` : attempt.error;
}

async function once(deps: Deps, config: Config, method: string, path: string, body?: unknown): Promise<Attempt> {
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await deps.fetch(`${config.apiBase}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { kind: "response", status: response.status, text: await response.text() };
  } catch (error) {
    return { kind: "error", error: error instanceof Error ? error.name : "unknown error" };
  }
}

/** Retries 423, 429, 5xx and network errors with backoff until the time budget is spent. */
export async function send(
  deps: Deps,
  config: Config,
  method: string,
  path: string,
  budgetMs: number,
  body?: unknown,
): Promise<Attempt> {
  const start = deps.now();
  let delay = 1000;
  for (;;) {
    const attempt = await once(deps, config, method, path, body);
    if (!isRetryable(attempt) || deps.now() - start + delay > budgetMs) return attempt;
    await deps.sleep(delay);
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseBranch(value: unknown): Branch | undefined {
  const item = asRecord(value);
  if (item === undefined) return undefined;
  const { id, name } = item;
  if (typeof id !== "string" || typeof name !== "string") return undefined;
  const optionalString = (key: string): string | undefined => {
    const field = item[key];
    return typeof field === "string" ? field : undefined;
  };
  return {
    id,
    name,
    isDefault: item.default === true,
    isProtected: item.protected === true,
    createdAt: optionalString("created_at"),
    expiresAt: optionalString("expires_at"),
  };
}

/** Reads every page; any failed or malformed page makes the whole list unreadable. */
export async function listBranches(deps: Deps, config: Config): Promise<ListResult> {
  const branches: Branch[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const attempt = await send(
      deps,
      config,
      "GET",
      `/projects/${config.projectId}/branches?${query.toString()}`,
      LIST_BUDGET_MS,
    );
    if (!isSuccess(attempt)) return { unreadable: `list request failed (${describe(attempt)})` };
    const body = asRecord(parseJson(attempt.text));
    const rawBranches = body?.branches;
    if (body === undefined || !Array.isArray(rawBranches)) return { unreadable: "list response is malformed" };
    for (const raw of rawBranches as unknown[]) {
      const branch = parseBranch(raw);
      if (branch === undefined) return { unreadable: "list response contains a malformed branch" };
      branches.push(branch);
    }
    const next = asRecord(body.pagination)?.next;
    if (next === undefined || next === null || next === "") return { branches };
    if (typeof next !== "string" || seenCursors.has(next)) return { unreadable: "list pagination is malformed" };
    seenCursors.add(next);
    cursor = next;
  }
  return { unreadable: "list exceeded the page cap" };
}
