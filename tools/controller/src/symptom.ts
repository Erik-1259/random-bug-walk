// The symptom the issue writer receives, built from the observe job for the attempt's family.
//
// Time-zone family (umami-tz-arg-001): an ObservedSymptom (spec §9.6) with the fixture's public
// request, its events and expected counts, the counts the observation's recorded responses hold,
// and the private input's prose. The primary zone is the first non-UTC check in fixture order; the
// other non-UTC checks are follow-up examples, and the UTC control is left out. A non-UTC check
// without a recorded response that classify grades local_day_counts_mismatch refuses the symptom.
//
// Race family (rc-1-backup-code-001): a RaceSymptom with the two verify requests of a concurrent
// double spend that the observation graded double_spend, as sent and as answered, with their
// times; the single acceptance a correct app gives against the two acceptances observed; and, for
// contrast, the serial control's first use and reuse from the same round. Only statuses, outcomes,
// error codes and times are copied: the recorded evidence holds no token or body, and the symptom
// never names the backup code.
//
// No value is invented: a missing or ungradable recording refuses the symptom.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertRecord } from "@rbw/schema";
import type { ObservedSymptom, RaceAttempt, RaceSymptom } from "@rbw/schema";
import { classify, loadFixture } from "@rbw/umami-fixture";
import type { FixtureCheck } from "@rbw/umami-fixture";
import * as rc1 from "@rbw/umami-fixture-rc1";

/** The families the symptom builder knows, by fixture ID. */
export const SYMPTOM_FAMILIES = ["umami-tz-arg-001", "rc-1-backup-code-001"] as const;
export type SymptomFamily = (typeof SYMPTOM_FAMILIES)[number];
export const TIME_ZONE_FAMILY = "umami-tz-arg-001" satisfies SymptomFamily;
export const RACE_FAMILY = "rc-1-backup-code-001" satisfies SymptomFamily;

/** The writer input of either family. */
export type CandidateSymptom = ObservedSymptom | RaceSymptom;

/** The symptom's prose fields, from the private candidate input. */
export interface SymptomProse {
  user_action: string;
  locale: string | null;
  fixture_description: string;
  doc_excerpts: { text: string; source_url: string }[];
}

export class SymptomUnavailable extends Error {
  override name = "SymptomUnavailable";
  readonly code = "symptom_unavailable";
}

interface ObservationRow {
  check_id?: unknown;
  repeat_index?: unknown;
  observed?: unknown;
  failure_code?: unknown;
  response_artifact_key?: unknown;
}

interface Evidence {
  trials?: { added?: { observations?: ObservationRow[] } | null }[];
}

function readEvidence(observeJobDir: string): Evidence {
  const evidencePath = join(observeJobDir, "evidence.json");
  if (!existsSync(evidencePath)) throw new SymptomUnavailable("the observation has no evidence");
  return JSON.parse(readFileSync(evidencePath, "utf8")) as Evidence;
}

/** The recorded response file an observation names, or a refusal saying which part is missing. */
function responsePath(observeJobDir: string, row: ObservationRow | undefined, what: string): string {
  const key = row?.response_artifact_key;
  if (typeof key !== "string") throw new SymptomUnavailable(`${what}: the observation has no recorded response`);
  const path = join(observeJobDir, "records", ...key.split("/"));
  if (!existsSync(path)) throw new SymptomUnavailable(`${what}: the recorded response is missing`);
  return path;
}

// ---- Time-zone family ----

type Buckets = ObservedSymptom["expected"];

/** The observed counts of one check: its recorded response body, parsed as classify parses it. */
function observedCounts(observeJobDir: string, evidence: Evidence, check: FixtureCheck): number[] {
  const observation = (evidence.trials ?? []).flatMap((trial) => trial.added?.observations ?? []).find((item) => item.check_id === check.check_id);
  const key = observation?.response_artifact_key;
  if (observation?.failure_code !== "local_day_counts_mismatch" || typeof key !== "string") throw new SymptomUnavailable(`${check.timezone}: the observation records no counts mismatch with a response`);
  const body = readFileSync(responsePath(observeJobDir, observation, check.timezone));
  if (classify({ status: 200, body }, check).failure_code !== "local_day_counts_mismatch") throw new SymptomUnavailable(`${check.timezone}: the recorded response is not a counts mismatch`);
  // classify has checked that the body is JSON whose pageviews items each have a nonnegative integer y.
  return (JSON.parse(body.toString("utf8")) as { pageviews: { y: number }[] }).pageviews.map((item) => item.y);
}

/** Builds the time-zone family's ObservedSymptom from the observe job's directory. */
export function buildTimeZoneSymptom(observeJobDir: string, prose: SymptomProse): ObservedSymptom {
  const fixture = loadFixture();
  const evidence = readEvidence(observeJobDir);
  const labels = fixture.bucket_labels.map((label) => label.slice(0, 10));
  const buckets = (counts: readonly number[]): Buckets => labels.map((bucket_label, index) => ({ bucket_label, count: counts[index] ?? 0 }));
  const zones = fixture.checks
    .filter((check) => check.timezone !== "UTC")
    .map((check) => ({ timezone: check.timezone, expected: buckets(check.expected), observed: buckets(observedCounts(observeJobDir, evidence, check)) }));
  const [primary, ...followUps] = zones;
  if (primary === undefined) throw new SymptomUnavailable("the fixture has no non-UTC check");
  return assertRecord("ObservedSymptom", {
    schema_version: 1,
    user_action: prose.user_action,
    request: {
      method: "GET",
      path: fixture.request.path,
      query: { startAt: String(fixture.request.startAt), endAt: String(fixture.request.endAt), unit: fixture.request.unit, timezone: primary.timezone },
    },
    timezone: primary.timezone,
    locale: prose.locale,
    fixture_description: prose.fixture_description,
    events: fixture.events.map((event) => ({ label: `pageview ${event.id}`, timestamp_seconds: event.timestamp_seconds, utc_instant: event.utc_instant })),
    http_status: 200,
    expected: primary.expected,
    observed: primary.observed,
    follow_up_examples: followUps,
    doc_excerpts: prose.doc_excerpts,
  });
}

// ---- Race family ----

/** What a correct app answers to two concurrent uses of one code: one acceptance and one refusal (the fixture's pass verdict). */
const EXPECTED_ACCEPTANCES = { accepted: 1, refused: 1 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isStatus = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isInteger(value));

/** One recorded attempt, checked field by field, so the fixture's grading sees only the shape it expects. */
function parseAttempt(value: unknown): rc1.VerifyAttempt | null {
  if (!isRecord(value)) return null;
  const { sent_ms, settled_ms, status, error_code, token_issued, failure } = value;
  if (!isTime(sent_ms) || !isTime(settled_ms) || !isStatus(status) || !isNullableString(error_code) || typeof token_issued !== "boolean" || !isNullableString(failure)) return null;
  return { sent_ms, settled_ms, status, error_code, token_issued, failure };
}

/** A recorded evidence file of the given kind and check, with exactly two well-formed attempts. */
function readRaceRecord(path: string, kind: rc1.CheckKind, checkId: string, what: string): { attempts: [rc1.VerifyAttempt, rc1.VerifyAttempt]; value: Record<string, unknown> } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SymptomUnavailable(`${what}: the recorded response is not JSON`);
  }
  const attempts = isRecord(value) && Array.isArray(value.attempts) ? value.attempts.map(parseAttempt) : [];
  const [first, second] = attempts;
  if (!isRecord(value) || value.kind !== kind || value.check_id !== checkId || attempts.length !== 2 || first == null || second == null) {
    throw new SymptomUnavailable(`${what}: the recorded response is not a ${kind} record with two requests`);
  }
  return { attempts: [first, second], value };
}

/**
 * A graded attempt in whole milliseconds. The fixture's grading has already required a response
 * for each one: accepted (HTTP 200 with a session) or refused with the app's invalid-code answer.
 */
function raceAttempt(label: string, recorded: rc1.VerifyAttempt): RaceAttempt {
  const accepted = recorded.token_issued;
  return {
    label,
    sent_ms: Math.round(recorded.sent_ms),
    settled_ms: Math.round(recorded.settled_ms),
    http_status: recorded.status ?? 0,
    outcome: accepted ? "accepted" : "refused",
    error_code: accepted ? null : recorded.error_code,
  };
}

/**
 * Builds the race family's RaceSymptom from the observe job's directory. The concurrent example is
 * the first observation, in trial and observation order, that graded the double-spend check
 * double_spend; its recorded requests must grade double_spend again. The sequential example is the
 * serial control of the same trial and repeat, which must have passed.
 */
export function buildRaceSymptom(observeJobDir: string, prose: SymptomProse): RaceSymptom {
  const fixture = rc1.loadFixture();
  const concurrentCheck = fixture.checks.find((check) => check.kind === "concurrent_double_spend");
  const serialCheck = fixture.checks.find((check) => check.kind === "serial_reuse");
  if (concurrentCheck === undefined || serialCheck === undefined) throw new SymptomUnavailable("the fixture lacks a race check");
  const evidence = readEvidence(observeJobDir);

  const round = (evidence.trials ?? [])
    .map((trial) => trial.added?.observations ?? [])
    .map((rows) => ({ rows, row: rows.find((item) => item.check_id === concurrentCheck.check_id && item.failure_code === "double_spend") }))
    .find((item) => item.row !== undefined);
  if (round?.row === undefined) throw new SymptomUnavailable("the observation records no double acceptance");
  const raceWhat = "the concurrent requests";
  const race = readRaceRecord(responsePath(observeJobDir, round.row, raceWhat), "concurrent_double_spend", concurrentCheck.check_id, raceWhat);
  const overlapMs = race.value.overlap_ms;
  if (typeof overlapMs !== "number" || !Number.isFinite(overlapMs)) throw new SymptomUnavailable(`${raceWhat}: the recorded response has no overlap`);
  const graded = rc1.classifyDoubleSpend({ check_id: concurrentCheck.check_id, kind: "concurrent_double_spend", attempts: race.attempts, overlap_ms: overlapMs });
  if (graded.failure_code !== "double_spend") throw new SymptomUnavailable(`${raceWhat}: the recorded response is not a double acceptance`);

  const repeat = round.row.repeat_index;
  const controlRow = round.rows.find((item) => item.check_id === serialCheck.check_id && item.repeat_index === repeat && item.observed === "pass");
  const controlWhat = "the sequential reuse";
  if (controlRow === undefined) throw new SymptomUnavailable(`${controlWhat}: the observation records no passing control in the same round`);
  const control = readRaceRecord(responsePath(observeJobDir, controlRow, controlWhat), "serial_reuse", serialCheck.check_id, controlWhat);
  if (rc1.classifySerialReuse({ check_id: serialCheck.check_id, kind: "serial_reuse", attempts: control.attempts }).observed !== "pass") {
    throw new SymptomUnavailable(`${controlWhat}: the recorded control did not pass`);
  }

  const concurrent = race.attempts.map((item, index) => raceAttempt(index === 0 ? "request a" : "request b", item));
  const overlap = Math.min(...concurrent.map((item) => item.settled_ms)) - Math.max(...concurrent.map((item) => item.sent_ms));
  if (overlap <= 0) throw new SymptomUnavailable(`${raceWhat}: they overlap by less than a whole millisecond`);
  const count = (outcome: RaceAttempt["outcome"]): number => concurrent.filter((item) => item.outcome === outcome).length;
  const request = rc1.verifyBackupCodeRequest("", "");
  return assertRecord("RaceSymptom", {
    schema_version: 1,
    symptom_kind: "concurrent_double_acceptance",
    user_action: prose.user_action,
    request: { method: request.method, path: request.path, query: {} },
    locale: prose.locale,
    fixture_description: prose.fixture_description,
    concurrent_attempts: concurrent,
    overlap_ms: overlap,
    expected: { ...EXPECTED_ACCEPTANCES },
    observed: { accepted: count("accepted"), refused: count("refused") },
    sequential_attempts: control.attempts.map((item, index) => raceAttempt(index === 0 ? "first use" : "reuse after the first use finished", item)),
    doc_excerpts: prose.doc_excerpts,
  });
}

/** Builds the family's symptom from the observe job's directory (its evidence.json and records/). */
export function buildSymptom(observeJobDir: string, prose: SymptomProse, family: "umami-tz-arg-001"): ObservedSymptom;
export function buildSymptom(observeJobDir: string, prose: SymptomProse, family: "rc-1-backup-code-001"): RaceSymptom;
export function buildSymptom(observeJobDir: string, prose: SymptomProse, family: SymptomFamily): CandidateSymptom;
export function buildSymptom(observeJobDir: string, prose: SymptomProse, family: SymptomFamily): CandidateSymptom {
  switch (family) {
    case "umami-tz-arg-001":
      return buildTimeZoneSymptom(observeJobDir, prose);
    case "rc-1-backup-code-001":
      return buildRaceSymptom(observeJobDir, prose);
  }
}
