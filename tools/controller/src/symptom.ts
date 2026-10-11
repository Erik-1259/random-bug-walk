// The ObservedSymptom (spec §9.6) the issue writer receives: the fixture's public request, its
// events and expected counts, the counts the observation's recorded responses hold, and the
// private input's prose. The primary zone is the first non-UTC check in fixture order; the other
// non-UTC checks are follow-up examples, and the UTC control is left out. No value is invented:
// a non-UTC check without a recorded response that classify grades local_day_counts_mismatch
// refuses the symptom.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertRecord } from "@rbw/schema";
import type { ObservedSymptom } from "@rbw/schema";
import { classify, loadFixture } from "@rbw/umami-fixture";
import type { FixtureCheck } from "@rbw/umami-fixture";

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

interface Evidence {
  trials?: { added?: { observations?: { check_id?: unknown; failure_code?: unknown; response_artifact_key?: unknown }[] } | null }[];
}

type Buckets = ObservedSymptom["expected"];

/** The observed counts of one check: its recorded response body, parsed as classify parses it. */
function observedCounts(observeJobDir: string, evidence: Evidence, check: FixtureCheck): number[] {
  const observation = (evidence.trials ?? []).flatMap((trial) => trial.added?.observations ?? []).find((item) => item.check_id === check.check_id);
  const key = observation?.response_artifact_key;
  if (observation?.failure_code !== "local_day_counts_mismatch" || typeof key !== "string") throw new SymptomUnavailable(`${check.timezone}: the observation records no counts mismatch with a response`);
  const path = join(observeJobDir, "records", ...key.split("/"));
  if (!existsSync(path)) throw new SymptomUnavailable(`${check.timezone}: the recorded response is missing`);
  const body = readFileSync(path);
  if (classify({ status: 200, body }, check).failure_code !== "local_day_counts_mismatch") throw new SymptomUnavailable(`${check.timezone}: the recorded response is not a counts mismatch`);
  // classify has checked that the body is JSON whose pageviews items each have a nonnegative integer y.
  return (JSON.parse(body.toString("utf8")) as { pageviews: { y: number }[] }).pageviews.map((item) => item.y);
}

/** Builds the symptom from the observe job's directory (its evidence.json and records/). */
export function buildSymptom(observeJobDir: string, prose: SymptomProse): ObservedSymptom {
  const fixture = loadFixture();
  const evidencePath = join(observeJobDir, "evidence.json");
  if (!existsSync(evidencePath)) throw new SymptomUnavailable("the observation has no evidence");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Evidence;
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
