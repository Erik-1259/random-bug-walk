import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_FILE, FixtureError, loadFixture, parseFixture } from "../src/index.ts";

const fixtureText = readFileSync(FIXTURE_FILE, "utf8");
const fixture = loadFixture();

function edited(edit: (data: Record<string, unknown>) => void): string {
  const data = JSON.parse(fixtureText) as Record<string, unknown>;
  edit(data);
  return `${JSON.stringify(data, null, 2)}\n`;
}

function rows(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

/** Local wall time of an instant in a zone, in the derivation's ISO 8601 form, computed with ICU. */
function intlLocalTime(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  const offsetName = part("timeZoneName");
  const offset = offsetName === "GMT" ? "+00:00" : offsetName.replace("GMT", "");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}

describe("fixture data file", () => {
  it("validates and identifies the fixture and the pinned host", () => {
    expect(fixture.schema_version).toBe(1);
    expect(fixture.fixture_id).toBe("umami-tz-arg-001");
    expect(fixture.host).toEqual({ upstream: "umami", commit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae" });
  });

  it("is in canonical form: sorted keys, two-space indent, trailing newline", () => {
    expect(`${JSON.stringify(JSON.parse(fixtureText), null, 2)}\n`).toBe(fixtureText);
  });

  it("holds 12 unique events in ascending time order", () => {
    expect(fixture.events).toHaveLength(12);
    expect(new Set(fixture.events.map((event) => event.id)).size).toBe(12);
    expect(fixture.events.map((event) => event.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `e${String(index + 1).padStart(2, "0")}`),
    );
    for (let index = 1; index < fixture.events.length; index += 1) {
      expect(fixture.events[index]?.timestamp_seconds).toBeGreaterThan(fixture.events[index - 1]?.timestamp_seconds ?? Infinity);
    }
  });

  it("has seconds times 1000 equal to each UTC instant in milliseconds", () => {
    for (const event of fixture.events) {
      expect(event.timestamp_seconds * 1000).toBe(Date.parse(event.utc_instant));
      expect(new Date(event.timestamp_seconds * 1000).toISOString()).toBe(event.utc_instant.replace("Z", ".000Z"));
    }
  });

  it("bounds the request from March 7 00:00:00.000Z to March 9 23:59:59.999Z in milliseconds", () => {
    expect(fixture.request.startAt).toBe(Date.parse("2026-03-07T00:00:00.000Z"));
    expect(fixture.request.endAt).toBe(Date.parse("2026-03-09T23:59:59.999Z"));
    expect(fixture.request.unit).toBe("day");
    expect(fixture.request.path).toBe(`/api/websites/${fixture.website.id}/pageviews`);
  });

  it("lists the four checks with the UTC control first", () => {
    expect(fixture.checks.map((check) => [check.check_id, check.timezone])).toEqual([
      ["tzarg.utc-day-counts", "UTC"],
      ["tzarg.la-day-counts", "America/Los_Angeles"],
      ["tzarg.auckland-day-counts", "Pacific/Auckland"],
      ["tzarg.kolkata-day-counts", "Asia/Kolkata"],
    ]);
  });

  it("has expected counts that sum to 12 in every zone, one per bucket label", () => {
    for (const check of fixture.checks) {
      expect(check.expected).toHaveLength(fixture.bucket_labels.length);
      expect(check.expected.reduce((sum, count) => sum + count, 0)).toBe(12);
    }
  });

  it("matches an independent recomputation with Intl.DateTimeFormat", () => {
    for (const check of fixture.checks) {
      const counts = fixture.bucket_labels.map(() => 0);
      for (const event of fixture.events) {
        const local = intlLocalTime(event.timestamp_seconds * 1000, check.timezone);
        const index = fixture.bucket_labels.indexOf(`${local.slice(0, 10)}T00:00:00Z`);
        expect(index, `${event.id} in ${check.timezone}`).toBeGreaterThanOrEqual(0);
        counts[index] = (counts[index] ?? 0) + 1;
        const recorded = fixture.derivation.local_times.find((row) => row.id === event.id);
        expect(recorded?.local[check.timezone], `${event.id} in ${check.timezone}`).toBe(local);
      }
      expect(counts, check.check_id).toEqual(check.expected);
    }
  });

  it("records the Python zoneinfo derivation and its tzdata version", () => {
    expect(fixture.derivation.method).toBe("python-zoneinfo");
    expect(fixture.derivation.python_version).toMatch(/^3\.12$/);
    expect(fixture.derivation.tzdata_version).toMatch(/^\d{4}\.\d+$/);
    expect(fixture.derivation.local_times.map((row) => row.id)).toEqual(fixture.events.map((event) => event.id));
  });

  it("keeps the planted counts labelled as predicted", () => {
    expect(fixture.predicted_planted_counts.status).toBe("predicted");
    expect(Object.keys(fixture.predicted_planted_counts.counts).sort()).toEqual([
      "tzarg.auckland-day-counts",
      "tzarg.kolkata-day-counts",
      "tzarg.la-day-counts",
    ]);
  });

  it("states the outcome vector of every code state", () => {
    const vector = (state: keyof typeof fixture.outcome_vectors): string[] =>
      fixture.outcome_vectors[state].map((row) => `${row.check_id}:${row.observed}:${String(row.failure_code)}`);
    const pass = (id: string): string => `${id}:pass:null`;
    const counts = (id: string): string => `${id}:assertion_fail:local_day_counts_mismatch`;
    const labels = (id: string): string => `${id}:assertion_fail:bucket_labels_mismatch`;
    const [utc, la, auckland, kolkata] = ["tzarg.utc-day-counts", "tzarg.la-day-counts", "tzarg.auckland-day-counts", "tzarg.kolkata-day-counts"] as const;
    expect(vector("clean")).toEqual([pass(utc), pass(la), pass(auckland), pass(kolkata)]);
    expect(vector("fixed")).toEqual([pass(utc), pass(la), pass(auckland), pass(kolkata)]);
    expect(vector("planted")).toEqual([pass(utc), counts(la), counts(auckland), counts(kolkata)]);
    expect(vector("partial")).toEqual([pass(utc), counts(la), pass(auckland), counts(kolkata)]);
    expect(vector("stub")).toEqual([pass(utc), labels(la), labels(auckland), labels(kolkata)]);
  });

  it("matches the SHA-256 committed in the package README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const committed = /data\/umami-tz-arg-001\.v1\.json` SHA-256: `([0-9a-f]{64})`/.exec(readme)?.[1];
    expect(committed).toBe(createHash("sha256").update(readFileSync(FIXTURE_FILE)).digest("hex"));
  });
});

describe("parseFixture", () => {
  it("accepts the committed bytes", () => {
    expect(parseFixture(fixtureText)).toEqual(fixture);
  });

  it("rejects a duplicate key", () => {
    const duplicated = fixtureText.replace('"fixture_id": "umami-tz-arg-001",', '"fixture_id": "umami-tz-arg-001",\n  "fixture_id": "umami-tz-arg-001",');
    expect(duplicated).not.toBe(fixtureText);
    expect(() => parseFixture(duplicated)).toThrow(FixtureError);
  });

  it("rejects unsorted keys", () => {
    const unsorted = fixtureText.replace('{\n  "bucket_labels"', '{\n  "zzz": 1,\n  "bucket_labels"');
    expect(() => parseFixture(unsorted)).toThrow(FixtureError);
  });

  it("rejects a float", () => {
    expect(() =>
      parseFixture(
        edited((data) => {
          (data.request as Record<string, unknown>).startAt = 1772841600000.5;
        }),
      ),
    ).toThrow(FixtureError);
  });

  it("rejects expected counts that do not sum to 12", () => {
    expect(() =>
      parseFixture(
        edited((data) => {
          rows(data.checks)[1] = { ...rows(data.checks)[1], expected: [3, 8, 2] };
        }),
      ),
    ).toThrow(FixtureError);
  });

  it("rejects an unknown schema version", () => {
    expect(() =>
      parseFixture(
        edited((data) => {
          data.schema_version = 2;
        }),
      ),
    ).toThrow(FixtureError);
  });

  it("rejects bucket labels out of ascending order", () => {
    expect(() =>
      parseFixture(
        edited((data) => {
          data.bucket_labels = ["2026-03-08T00:00:00Z", "2026-03-07T00:00:00Z", "2026-03-09T00:00:00Z"];
        }),
      ),
    ).toThrow(FixtureError);
  });

  it("rejects an event whose seconds disagree with its instant", () => {
    expect(() =>
      parseFixture(
        edited((data) => {
          rows(data.events)[0] = { ...rows(data.events)[0], timestamp_seconds: 1772881141 };
        }),
      ),
    ).toThrow(FixtureError);
  });
});
