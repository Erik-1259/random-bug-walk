import { readFileSync } from "node:fs";

/** The single data file of fixture umami-tz-arg-001. Everything else reads it; nothing retypes it. */
export const FIXTURE_FILE = new URL("../data/umami-tz-arg-001.v1.json", import.meta.url);

export const CODE_STATES = ["clean", "fixed", "planted", "partial", "stub"] as const;
export type CodeState = (typeof CODE_STATES)[number];

export const OBSERVED_VALUES = ["pass", "assertion_fail", "setup_fail"] as const;
export type Observed = (typeof OBSERVED_VALUES)[number];

export const FAILURE_CODES = [
  "local_day_counts_mismatch",
  "bucket_labels_mismatch",
  "unrelated_failure",
  "auth_failed",
  "seed_failed",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface FixtureEvent {
  id: string;
  utc_instant: string;
  timestamp_seconds: number;
}

export interface FixtureCheck {
  check_id: string;
  timezone: string;
  /** Expected pageview count per bucket label, in bucket-label order. */
  expected: number[];
}

export interface ExpectedOutcome {
  check_id: string;
  observed: Observed;
  failure_code: FailureCode | null;
}

export interface Fixture {
  schema_version: 1;
  fixture_id: string;
  host: { upstream: string; commit: string };
  website: { id: string; name: string; domain: string };
  send: { hostname: string; url: string; language: string; screen: string };
  events: FixtureEvent[];
  /** startAt and endAt are in milliseconds; event timestamps are in seconds. */
  request: { path: string; startAt: number; endAt: number; unit: string };
  /** Local calendar days as the API labels them. Compare as strings; the Z is not an instant. */
  bucket_labels: string[];
  checks: FixtureCheck[];
  outcome_vectors: Record<CodeState, ExpectedOutcome[]>;
  /** Predicted, never observed: no code may use these as observed values. */
  predicted_planted_counts: { status: "predicted"; counts: Record<string, number[]> };
  derivation: {
    method: string;
    python_version: string;
    tzdata_version: string;
    local_times: { id: string; local: Record<string, string> }[];
  };
}

export class FixtureError extends Error {
  override name = "FixtureError";
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = Record<string, Json>;

const EVENT_COUNT = 12;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const BUCKET_LABEL = /^\d{4}-\d{2}-\d{2}T00:00:00Z$/;

function fail(message: string): never {
  throw new FixtureError(`fixture data file: ${message}`);
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key] ?? null)]),
    );
  }
  return value;
}

function assertIntegersOnly(value: Json, path: string): void {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    fail(`${path} is not an integer`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertIntegersOnly(item, `${path}[${String(index)}]`);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertIntegersOnly(item, `${path}.${key}`);
    }
  }
}

function object(value: Json | undefined, path: string, keys: readonly string[]): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${path} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (actual.join(",") !== [...keys].sort().join(",")) {
    fail(`${path} must have exactly the keys ${keys.join(", ")}`);
  }
  return value;
}

function array(value: Json | undefined, path: string): Json[] {
  if (!Array.isArray(value)) {
    return fail(`${path} must be an array`);
  }
  return value;
}

function string(value: Json | undefined, path: string): string {
  if (typeof value !== "string" || value === "") {
    return fail(`${path} must be a non-empty string`);
  }
  return value;
}

function integer(value: Json | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fail(`${path} must be an integer`);
  }
  return value;
}

function exact<T extends Json>(value: Json | undefined, expected: T, path: string): T {
  if (value !== expected) {
    fail(`${path} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function counts(value: Json | undefined, path: string, length: number): number[] {
  const items = array(value, path).map((item, index) => integer(item, `${path}[${String(index)}]`));
  if (items.length !== length || items.some((item) => item < 0)) {
    fail(`${path} must hold ${String(length)} nonnegative counts`);
  }
  return items;
}

function parseEvents(value: Json | undefined): FixtureEvent[] {
  const events = array(value, "events").map((item, index): FixtureEvent => {
    const path = `events[${String(index)}]`;
    const row = object(item, path, ["id", "utc_instant", "timestamp_seconds"]);
    const event = {
      id: string(row.id, `${path}.id`),
      utc_instant: string(row.utc_instant, `${path}.utc_instant`),
      timestamp_seconds: integer(row.timestamp_seconds, `${path}.timestamp_seconds`),
    };
    if (!UTC_INSTANT.test(event.utc_instant) || Date.parse(event.utc_instant) !== event.timestamp_seconds * 1000) {
      fail(`${path} timestamp_seconds must equal utc_instant in seconds`);
    }
    return event;
  });
  if (events.length !== EVENT_COUNT || new Set(events.map((event) => event.id)).size !== EVENT_COUNT) {
    fail(`events must hold ${String(EVENT_COUNT)} rows with unique ids`);
  }
  events.forEach((event, index) => {
    const previous = events[index - 1];
    if (previous !== undefined && event.timestamp_seconds <= previous.timestamp_seconds) {
      fail("events must be in ascending time order");
    }
  });
  return events;
}

function parseBucketLabels(value: Json | undefined): string[] {
  const labels = array(value, "bucket_labels").map((item, index) => string(item, `bucket_labels[${String(index)}]`));
  if (labels.length === 0 || labels.some((label) => !BUCKET_LABEL.test(label))) {
    fail("bucket_labels must be day labels of the form YYYY-MM-DDT00:00:00Z");
  }
  labels.forEach((label, index) => {
    const previous = labels[index - 1];
    if (previous !== undefined && label <= previous) {
      fail("bucket_labels must be unique and ascending");
    }
  });
  return labels;
}

function parseChecks(value: Json | undefined, labelCount: number): FixtureCheck[] {
  const checks = array(value, "checks").map((item, index): FixtureCheck => {
    const path = `checks[${String(index)}]`;
    const row = object(item, path, ["check_id", "timezone", "expected"]);
    const expected = counts(row.expected, `${path}.expected`, labelCount);
    if (expected.reduce((sum, count) => sum + count, 0) !== EVENT_COUNT) {
      fail(`${path}.expected must sum to ${String(EVENT_COUNT)}`);
    }
    return { check_id: string(row.check_id, `${path}.check_id`), timezone: string(row.timezone, `${path}.timezone`), expected };
  });
  if (checks.length === 0 || new Set(checks.map((check) => check.check_id)).size !== checks.length) {
    fail("checks must hold unique check ids");
  }
  if (checks[0]?.timezone !== "UTC") {
    fail("the UTC control must be the first check");
  }
  return checks;
}

function parseOutcomeVectors(value: Json | undefined, checks: FixtureCheck[]): Record<CodeState, ExpectedOutcome[]> {
  const vectors = object(value, "outcome_vectors", CODE_STATES);
  const parse = (state: CodeState): ExpectedOutcome[] => {
    const rows = array(vectors[state], `outcome_vectors.${state}`).map((item, index): ExpectedOutcome => {
      const path = `outcome_vectors.${state}[${String(index)}]`;
      const row = object(item, path, ["check_id", "observed", "failure_code"]);
      const observed = OBSERVED_VALUES.find((candidate) => candidate === row.observed) ?? fail(`${path}.observed is unknown`);
      const failureCode = row.failure_code === null ? null : (FAILURE_CODES.find((candidate) => candidate === row.failure_code) ?? fail(`${path}.failure_code is unknown`));
      if ((observed === "pass") !== (failureCode === null)) {
        fail(`${path} must pair pass with a null failure code`);
      }
      return { check_id: string(row.check_id, `${path}.check_id`), observed, failure_code: failureCode };
    });
    if (rows.map((row) => row.check_id).join(",") !== checks.map((check) => check.check_id).join(",")) {
      fail(`outcome_vectors.${state} must list the checks in order`);
    }
    return rows;
  };
  return { clean: parse("clean"), fixed: parse("fixed"), planted: parse("planted"), partial: parse("partial"), stub: parse("stub") };
}

function parsePredicted(value: Json | undefined, checks: FixtureCheck[], labelCount: number): Fixture["predicted_planted_counts"] {
  const row = object(value, "predicted_planted_counts", ["status", "counts"]);
  const nonUtc = checks.filter((check) => check.timezone !== "UTC").map((check) => check.check_id);
  const byCheck = object(row.counts, "predicted_planted_counts.counts", nonUtc);
  return {
    status: exact(row.status, "predicted", "predicted_planted_counts.status"),
    counts: Object.fromEntries(Object.entries(byCheck).map(([id, item]) => [id, counts(item, `predicted_planted_counts.counts.${id}`, labelCount)])),
  };
}

function parseDerivation(value: Json | undefined, events: FixtureEvent[], checks: FixtureCheck[]): Fixture["derivation"] {
  const row = object(value, "derivation", ["method", "python_version", "tzdata_version", "local_times"]);
  const zones = checks.map((check) => check.timezone).sort();
  const localTimes = array(row.local_times, "derivation.local_times").map((item, index) => {
    const path = `derivation.local_times[${String(index)}]`;
    const entry = object(item, path, ["id", "local"]);
    const local = object(entry.local, `${path}.local`, zones);
    return { id: string(entry.id, `${path}.id`), local: Object.fromEntries(zones.map((zone) => [zone, string(local[zone], `${path}.local.${zone}`)])) };
  });
  if (localTimes.map((entry) => entry.id).join(",") !== events.map((event) => event.id).join(",")) {
    fail("derivation.local_times must list every event in order");
  }
  return {
    method: exact(row.method, "python-zoneinfo", "derivation.method"),
    python_version: string(row.python_version, "derivation.python_version"),
    tzdata_version: string(row.tzdata_version, "derivation.tzdata_version"),
    local_times: localTimes,
  };
}

/**
 * Validates the data file's bytes and returns it typed. The file must be canonical JSON: keys
 * sorted at every level, two-space indent and a trailing newline, as the derivation script writes
 * it. Re-rendering the parsed value must reproduce the bytes, which also rejects duplicate keys
 * (the parser keeps only one) and non-integer numbers.
 */
export function parseFixture(text: string): Fixture {
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch (error) {
    throw new FixtureError("fixture data file: not valid JSON", { cause: error });
  }
  assertIntegersOnly(parsed, "$");
  if (`${JSON.stringify(sortKeys(parsed), null, 2)}\n` !== text) {
    fail("not in canonical form (sorted keys, no duplicate keys, two-space indent, trailing newline)");
  }
  const root = object(parsed, "$", [
    "schema_version",
    "fixture_id",
    "host",
    "website",
    "send",
    "events",
    "request",
    "bucket_labels",
    "checks",
    "outcome_vectors",
    "predicted_planted_counts",
    "derivation",
  ]);
  const host = object(root.host, "host", ["upstream", "commit"]);
  const website = object(root.website, "website", ["id", "name", "domain"]);
  const send = object(root.send, "send", ["hostname", "url", "language", "screen"]);
  const request = object(root.request, "request", ["path", "startAt", "endAt", "unit"]);
  const events = parseEvents(root.events);
  const bucketLabels = parseBucketLabels(root.bucket_labels);
  const checks = parseChecks(root.checks, bucketLabels.length);
  const fixture: Fixture = {
    schema_version: exact(root.schema_version, 1, "schema_version"),
    fixture_id: string(root.fixture_id, "fixture_id"),
    host: { upstream: string(host.upstream, "host.upstream"), commit: string(host.commit, "host.commit") },
    website: { id: string(website.id, "website.id"), name: string(website.name, "website.name"), domain: string(website.domain, "website.domain") },
    send: {
      hostname: string(send.hostname, "send.hostname"),
      url: string(send.url, "send.url"),
      language: string(send.language, "send.language"),
      screen: string(send.screen, "send.screen"),
    },
    events,
    request: {
      path: string(request.path, "request.path"),
      startAt: integer(request.startAt, "request.startAt"),
      endAt: integer(request.endAt, "request.endAt"),
      unit: string(request.unit, "request.unit"),
    },
    bucket_labels: bucketLabels,
    checks,
    outcome_vectors: parseOutcomeVectors(root.outcome_vectors, checks),
    predicted_planted_counts: parsePredicted(root.predicted_planted_counts, checks, bucketLabels.length),
    derivation: parseDerivation(root.derivation, events, checks),
  };
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined || fixture.request.startAt > first.timestamp_seconds * 1000 || fixture.request.endAt < last.timestamp_seconds * 1000) {
    fail("request bounds must cover every event");
  }
  return fixture;
}

let cached: Fixture | undefined;

/** Reads and validates the committed data file once per process. */
export function loadFixture(): Fixture {
  cached ??= parseFixture(readFileSync(FIXTURE_FILE, "utf8"));
  return cached;
}
