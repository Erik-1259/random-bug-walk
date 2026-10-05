import { describe, expect, it } from "vitest";
import { createWebsiteRequest, loadFixture, loginRequest, queryRequests, sendRequests } from "../src/index.ts";

const fixture = loadFixture();
const E01_BODY =
  '{"type":"event","payload":{"website":"11111111-1111-4111-8111-111111111111","hostname":"timezone-fixture.test","url":"/timezone-fixture","language":"en-US","screen":"1280x720","id":"e01","timestamp":1772881140}}';

describe("request builders", () => {
  it("logs in with a JSON body holding only the credentials", () => {
    const request = loginRequest({ username: "synthetic-admin", password: "synthetic-password" });
    expect(request).toEqual({
      method: "POST",
      path: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: '{"username":"synthetic-admin","password":"synthetic-password"}',
    });
  });

  it("creates the website with exactly the fixture's id, name and domain", () => {
    const request = createWebsiteRequest(fixture, "synthetic-token");
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/websites");
    expect(request.headers).toEqual({ "content-type": "application/json", authorization: "Bearer synthetic-token" });
    expect(request.body).toBe('{"id":"11111111-1111-4111-8111-111111111111","name":"Timezone fixture","domain":"timezone-fixture.test"}');
  });

  it("builds the e01 send body byte for byte", () => {
    const [first] = sendRequests(fixture);
    expect(first?.body).toBe(E01_BODY);
    expect(first?.method).toBe("POST");
    expect(first?.path).toBe("/api/send");
  });

  it("builds twelve sends in table order that differ only in id and timestamp", () => {
    const sends = sendRequests(fixture);
    expect(sends).toHaveLength(12);
    sends.forEach((send, index) => {
      const event = fixture.events[index];
      expect(event).toBeDefined();
      if (event === undefined) {
        return;
      }
      expect(send.event_id).toBe(event.id);
      expect(send.body).toBe(E01_BODY.replace('"id":"e01"', `"id":"${event.id}"`).replace("1772881140", String(event.timestamp_seconds)));
    });
  });

  it("never sets x-umami-cache or authorization on a send", () => {
    for (const send of sendRequests(fixture)) {
      expect(Object.keys(send.headers).map((name) => name.toLowerCase())).toEqual(["content-type"]);
    }
  });

  it("queries with exactly startAt, endAt, unit and timezone, UTC first", () => {
    const queries = queryRequests(fixture, "synthetic-token");
    expect(queries.map((query) => query.check.check_id)).toEqual([
      "tzarg.utc-day-counts",
      "tzarg.la-day-counts",
      "tzarg.auckland-day-counts",
      "tzarg.kolkata-day-counts",
    ]);
    for (const { check, request } of queries) {
      expect(request.method).toBe("GET");
      expect(request.body).toBeNull();
      expect(request.headers).toEqual({ authorization: "Bearer synthetic-token" });
      const url = new URL(request.path, "http://fixture.invalid");
      expect(url.pathname).toBe("/api/websites/11111111-1111-4111-8111-111111111111/pageviews");
      expect([...url.searchParams.keys()]).toEqual(["startAt", "endAt", "unit", "timezone"]);
      expect(url.searchParams.get("startAt")).toBe("1772841600000");
      expect(url.searchParams.get("endAt")).toBe("1773100799999");
      expect(url.searchParams.get("unit")).toBe("day");
      expect(url.searchParams.get("timezone")).toBe(check.timezone);
    }
  });

  it("URL-encodes the zone name", () => {
    const la = queryRequests(fixture, "synthetic-token")[1];
    expect(la?.request.path).toBe(
      "/api/websites/11111111-1111-4111-8111-111111111111/pageviews?startAt=1772841600000&endAt=1773100799999&unit=day&timezone=America%2FLos_Angeles",
    );
  });
});
