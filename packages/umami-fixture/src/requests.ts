import type { Fixture, FixtureCheck, FixtureEvent } from "./fixture.ts";
import type { ApiRequest } from "./http.ts";

export interface Credentials {
  username: string;
  password: string;
}

export interface SendRequest extends ApiRequest {
  event_id: string;
}

export interface QueryRequest {
  check: FixtureCheck;
  request: ApiRequest;
}

const JSON_CONTENT = { "content-type": "application/json" } as const;

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** POST /api/auth/login with the disposable install's admin credentials. */
export function loginRequest(credentials: Credentials): ApiRequest {
  return {
    method: "POST",
    path: "/api/auth/login",
    headers: { ...JSON_CONTENT },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  };
}

/** POST /api/websites with exactly the fixture's id, name and domain. */
export function createWebsiteRequest(fixture: Fixture, token: string): ApiRequest {
  const { id, name, domain } = fixture.website;
  return {
    method: "POST",
    path: "/api/websites",
    headers: { ...JSON_CONTENT, ...bearer(token) },
    body: JSON.stringify({ id, name, domain }),
  };
}

/**
 * The /api/send body for one event. Keys are written in this order on purpose: the bytes are
 * part of the fixture. There is no name field, so Umami records a pageview.
 */
export function sendBody(fixture: Fixture, event: FixtureEvent): string {
  const { hostname, url, language, screen } = fixture.send;
  return JSON.stringify({
    type: "event",
    payload: { website: fixture.website.id, hostname, url, language, screen, id: event.id, timestamp: event.timestamp_seconds },
  });
}

/** One POST /api/send per event, in table order. No send carries an x-umami-cache header. */
export function sendRequests(fixture: Fixture): SendRequest[] {
  return fixture.events.map((event) => ({
    event_id: event.id,
    method: "POST",
    path: "/api/send",
    headers: { ...JSON_CONTENT },
    body: sendBody(fixture, event),
  }));
}

/** The query string of one check: exactly startAt, endAt, unit and timezone, URL-encoded. */
export function queryString(fixture: Fixture, check: FixtureCheck): string {
  return new URLSearchParams([
    ["startAt", String(fixture.request.startAt)],
    ["endAt", String(fixture.request.endAt)],
    ["unit", fixture.request.unit],
    ["timezone", check.timezone],
  ]).toString();
}

/** One GET of the pageviews endpoint per check, in the data file's order (the UTC control first). */
export function queryRequests(fixture: Fixture, token: string): QueryRequest[] {
  return fixture.checks.map((check) => ({
    check,
    request: { method: "GET", path: `${fixture.request.path}?${queryString(fixture, check)}`, headers: bearer(token), body: null },
  }));
}
