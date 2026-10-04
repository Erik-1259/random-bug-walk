import type { Deps } from "../src/api.ts";
import type { Config } from "../src/config.ts";

export const config: Config = {
  apiKey: "synthetic-key",
  projectId: "synthetic-project-1",
  apiBase: "https://api.example.invalid/v2",
};

export interface Reply {
  status: number;
  body?: unknown;
  raw?: string;
  networkError?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
}

/** A fake Neon API: a handler answers each request; sleeping advances a fake clock. */
export function fakeDeps(handler: (request: RecordedRequest) => Reply, startMs = 0) {
  const requests: RecordedRequest[] = [];
  let clock = startMs;
  const deps: Deps = {
    fetch: (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const request = { method: init?.method ?? "GET", path: url.pathname.replace("/v2", "") + url.search };
      requests.push(request);
      const reply = handler(request);
      if (reply.networkError === true) return Promise.reject(new TypeError("fetch failed"));
      const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
      return Promise.resolve(new Response(reply.status === 204 ? null : text, { status: reply.status }));
    },
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  return { deps, requests };
}

export interface BranchFixture {
  id: string;
  name: string;
  default?: boolean;
  protected?: boolean;
  created_at?: string;
  expires_at?: string;
}

export const project = `/projects/${config.projectId}`;
