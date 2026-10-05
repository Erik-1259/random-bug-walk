import type { RequestContext, RequestOptions } from "../src/index.ts";
import { loadFixture } from "../src/index.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  data: string | undefined;
}

export type Reply = { status: number; body: unknown } | Error;

/** A request context that records every call and answers from a handler, in place of Playwright's. */
export function fakeContext(handler: (call: RecordedCall, calls: RecordedCall[]) => Reply): {
  context: RequestContext;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const context: RequestContext = {
    fetch(url: string, options: RequestOptions) {
      const call: RecordedCall = { url, method: options.method, headers: { ...options.headers }, data: options.data };
      calls.push(call);
      const reply = handler(call, calls);
      if (reply instanceof Error) {
        return Promise.reject(reply);
      }
      const bytes = Buffer.from(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      return Promise.resolve({ status: () => reply.status, body: () => Promise.resolve(bytes) });
    },
  };
  return { context, calls };
}

/** Answers like a healthy Umami install that holds the fixture's expected data. */
export function healthyReply(call: RecordedCall): Reply {
  const fixture = loadFixture();
  const url = new URL(call.url, "http://fixture.invalid");
  if (url.pathname === "/api/auth/login") {
    return { status: 200, body: { token: "synthetic-token", user: { id: "synthetic-user" } } };
  }
  if (url.pathname === "/api/websites") {
    return { status: 200, body: { id: fixture.website.id, name: fixture.website.name } };
  }
  if (url.pathname === "/api/send") {
    return { status: 200, body: { cache: "synthetic-cache", sessionId: "synthetic-session" } };
  }
  const check = fixture.checks.find((candidate) => candidate.timezone === url.searchParams.get("timezone"));
  if (url.pathname === fixture.request.path && check !== undefined) {
    const points = fixture.bucket_labels.map((x, index) => ({ x, y: check.expected[index] }));
    return { status: 200, body: { pageviews: points, sessions: points } };
  }
  return { status: 404, body: { error: "synthetic not found" } };
}
