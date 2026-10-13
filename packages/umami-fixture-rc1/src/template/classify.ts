// The grading engine of the concurrency-check template. It owns the decision trees that are the
// same for every race candidate; the host supplies how to read one attempt (its verdict and
// whether it was a transport failure), the expected clean and planted counts, the host's own
// observed/failure-code pairs, and how to phrase a detail line.

import type { Graded, Verdict } from "./types.ts";

/**
 * How a race check reads its attempts and what it expects. `cleanApplied` and `plantedApplied`
 * are how many of the concurrent requests take effect on a correct app and on the planted app
 * (for a lost-update double-apply, 1 and 2). The four grades are the host's own enum values.
 */
export interface RaceGrading<Attempt, Observed, Failure> {
  verdictOf(attempt: Attempt): Verdict;
  cleanApplied: number;
  plantedApplied: number;
  planted: { observed: Observed; failure_code: Failure | null };
  clean: { observed: Observed; failure_code: Failure | null };
  unrelated: { observed: Observed; failure_code: Failure | null };
  seedFailed: { observed: Observed; failure_code: Failure | null };
  /** The detail line for a graded burst; sees the attempts and the measured overlap. */
  detail(attempts: readonly Attempt[], overlapMs: number): string;
  /** Wraps the detail line for the no-overlap case; defaults to a short prefix when omitted. */
  noOverlapDetail?: (detail: string) => string;
  /** Wraps the detail line when no request applied; defaults to the plain detail when omitted. */
  seedFailedDetail?: (detail: string) => string;
}

/**
 * Grades a concurrent burst, in this order:
 * 1. unrelated: any request was neither applied nor a clean refusal (a transport failure, an
 *    unexpected status). The round says nothing either way.
 * 2. unrelated: the requests never overlapped in flight (overlap <= 0), so the race was not
 *    exercised.
 * 3. planted: as many requests applied as the planted app would allow, and that differs from the
 *    clean count. The bug is shown.
 * 4. clean: as many applied as a correct app allows.
 * 5. seedFailed: none applied, so the setup or the seeded state is wrong.
 * 6. unrelated: any other count.
 */
export function classifyConcurrent<Attempt, Observed, Failure>(
  attempts: readonly Attempt[],
  overlapMs: number,
  grading: RaceGrading<Attempt, Observed, Failure>,
): Graded<Observed, Failure> {
  const verdicts = attempts.map((attempt) => grading.verdictOf(attempt));
  const detail = grading.detail(attempts, overlapMs);
  if (verdicts.includes("unexpected")) {
    return { ...grading.unrelated, detail };
  }
  if (overlapMs <= 0) {
    const wrap = grading.noOverlapDetail ?? ((text: string) => `the requests did not overlap; ${text}`);
    return { ...grading.unrelated, detail: wrap(detail) };
  }
  const applied = verdicts.filter((verdict) => verdict === "applied").length;
  if (applied === grading.plantedApplied && grading.plantedApplied !== grading.cleanApplied) {
    return { ...grading.planted, detail };
  }
  if (applied === grading.cleanApplied) {
    return { ...grading.clean, detail };
  }
  if (applied === 0) {
    const wrap = grading.seedFailedDetail ?? ((text: string) => text);
    return { ...grading.seedFailed, detail: wrap(detail) };
  }
  return { ...grading.unrelated, detail };
}

/** How a control check reads its two sequential attempts and how to phrase each outcome's detail. */
export interface ReuseGrading<Attempt, Observed, Failure> {
  verdictOf(attempt: Attempt): Verdict;
  /** True when the first attempt was a transport failure, not an app answer. */
  transportFailed(attempt: Attempt): boolean;
  pass: { observed: Observed; failure_code: Failure | null };
  reused: { observed: Observed; failure_code: Failure | null };
  unrelated: { observed: Observed; failure_code: Failure | null };
  seedFailed: { observed: Observed; failure_code: Failure | null };
  /** No request was fired. */
  noFirstDetail: string;
  /** The first request was a transport failure. */
  firstTransportDetail(first: Attempt): string;
  /** The first request did not take effect, so the control's precondition failed. */
  firstNotAppliedDetail(first: Attempt): string;
  /** The first took effect but the follow-up was never fired. */
  noSecondDetail: string;
  /** Both the first and the follow-up ran. */
  pairDetail(first: Attempt, second: Attempt): string;
}

/**
 * Grades a sequential control: the first request must take effect (otherwise the setup or seed is
 * wrong), and the follow-up on the same target must then be refused. A follow-up that is accepted
 * is the failure the control guards against; any other answer is unrelated.
 */
export function classifyReuse<Attempt, Observed, Failure>(
  attempts: readonly Attempt[],
  grading: ReuseGrading<Attempt, Observed, Failure>,
): Graded<Observed, Failure> {
  const [first, second] = attempts;
  if (first === undefined) {
    return { ...grading.unrelated, detail: grading.noFirstDetail };
  }
  if (grading.transportFailed(first)) {
    return { ...grading.unrelated, detail: grading.firstTransportDetail(first) };
  }
  if (grading.verdictOf(first) !== "applied") {
    return { ...grading.seedFailed, detail: grading.firstNotAppliedDetail(first) };
  }
  if (second === undefined) {
    return { ...grading.unrelated, detail: grading.noSecondDetail };
  }
  const detail = grading.pairDetail(first, second);
  switch (grading.verdictOf(second)) {
    case "rejected":
      return { ...grading.pass, detail };
    case "applied":
      return { ...grading.reused, detail };
    case "unexpected":
      return { ...grading.unrelated, detail };
  }
}
