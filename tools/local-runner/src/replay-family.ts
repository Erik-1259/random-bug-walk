// The bug family a frozen job was built for, read back from the job's own bytes. A judge replay runs
// from the frozen judge job alone, with no kit stage and no image export, so nothing else names the
// family: the expected trials hold the family's fixture vectors, and the runtime profile hash is
// profileSha256 of the race latency the job was built with. A job whose vectors are no other
// family's fixture's is the default (time-zone) family's, exactly as every replay was before.
import type { ExpectedTrials, JobRequest } from "@rbw/schema";
import { DEFAULT_FAMILY, FAMILIES, MAX_RACE_LATENCY_MS } from "./family.ts";
import type { Family, FamilyId } from "./family.ts";
import { profileSha256 } from "./plan.ts";

export type FrozenFamily = { ok: true; family: FamilyId; raceLatencyMs: number | null } | { ok: false; detail: string };

/** The frozen job fields the family is read from. */
export interface FrozenJob {
  request: Pick<JobRequest, "runtime_profile_sha256">;
  expected: Pick<ExpectedTrials, "trials">;
}

const key = (rows: readonly { check_id: string; expected: string; failure_code: string | null }[]): string =>
  JSON.stringify(rows.map((row) => [row.check_id, row.expected, row.failure_code]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)));

/** Whether every trial expects exactly the family's fixture vector for its code state. */
function holdsVectorsOf(family: Family, expected: FrozenJob["expected"]): boolean {
  const vectors = family.loadFixture().outcome_vectors;
  return (
    expected.trials.length > 0 &&
    expected.trials.every((trial) => {
      const rows = vectors[trial.code_state];
      return rows !== undefined && key(rows.map((row) => ({ check_id: row.check_id, expected: row.observed, failure_code: row.failure_code }))) === key(trial.expected_checks);
    })
  );
}

/** profileSha256 of every latency the proxy accepts, made once on first use. */
let latencies: Map<string, number> | null = null;

/** The latency whose profile hash is `sha256`: null for the plain profile, undefined for none. */
export function latencyOfProfile(sha256: string): number | null | undefined {
  if (sha256 === profileSha256(null)) return null;
  if (latencies === null) {
    latencies = new Map();
    for (let ms = 0; ms <= MAX_RACE_LATENCY_MS; ms += 1) latencies.set(profileSha256(ms), ms);
  }
  return latencies.get(sha256);
}

/**
 * The family and race latency of a frozen job. A family with a database proxy takes its latency
 * from the runtime profile hash; a hash that no latency makes is refused, because the copies could
 * not reproduce the profile the job was graded under. The plain profile (no latency) is refused
 * too: it is the default family's, and a race job is only built with a latency.
 */
export function frozenJobFamily(job: FrozenJob): FrozenFamily {
  const matches = Object.values(FAMILIES).filter((family) => family.id !== DEFAULT_FAMILY && holdsVectorsOf(family, job.expected));
  const [family] = matches;
  if (family === undefined) return { ok: true, family: DEFAULT_FAMILY, raceLatencyMs: null };
  if (matches.length > 1) return { ok: false, detail: `the frozen job's vectors are the fixtures of ${matches.map((item) => item.id).join(" and ")}` };
  if (!family.proxy) return { ok: true, family: family.id, raceLatencyMs: null };
  const latency = latencyOfProfile(job.request.runtime_profile_sha256);
  if (latency === undefined) return { ok: false, detail: `the frozen ${family.id} job's runtime profile is not the copy profile at any latency from 0 to ${String(MAX_RACE_LATENCY_MS)} ms` };
  // The plain profile is the default family's; a race job is only ever built with a latency.
  if (latency === null) return { ok: false, detail: `the frozen ${family.id} job's runtime profile is the plain copy profile, with no race latency` };
  return { ok: true, family: family.id, raceLatencyMs: latency };
}
