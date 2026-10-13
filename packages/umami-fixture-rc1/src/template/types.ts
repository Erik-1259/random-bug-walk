// Host-agnostic types for the concurrency-check template. Nothing here names a host, an endpoint
// or a bug shape: a race candidate supplies those through the plans and gradings in this folder.

import type { ApiRequest, HttpResult, RequestContext } from "../http.ts";

export type { ApiRequest, HttpResult, RequestContext } from "../http.ts";

/** A monotonic millisecond clock. The checks pass performance.now; the unit tests pass a stepping clock. */
export type Clock = () => number;

/** Harness-side timing of one fired request, in milliseconds from the burst origin, rounded to 3 places. */
export interface AttemptTiming {
  sent_ms: number;
  settled_ms: number;
}

/**
 * How one request settled: either the app answered (a status and body) or the send threw. The
 * record factory turns this, plus the timing and the request's state, into the host's own record.
 */
export type RequestOutcome = { settled: true; result: HttpResult } | { settled: false; error: unknown };

/** Builds the host's attempt record for one fired request. `state` is what setup produced for its context. */
export type RecordAttempt<State, Attempt> = (outcome: RequestOutcome, timing: AttemptTiming, state: State) => Attempt;

/**
 * The result of a setup step run on one request context before the burst. A failure object is
 * opaque to the engine (it only reads `ok`), so a host keeps its own failure type and codes.
 */
export type SetupResult<State, Failure extends { ok: false }> = { ok: true; state: State } | Failure;

/**
 * A description of the requests a race check fires. Everything host-specific lives here: how to
 * set a context up (for example, sign in), which request to fire, and how to record each answer.
 */
export interface RequestPlan<State, Attempt, Failure extends { ok: false }> {
  /** Runs once per context, in order, before the burst. Returning a failure stops the round. */
  setup(context: RequestContext, index: number): Promise<SetupResult<State, Failure>>;
  /** The request to fire for a context's setup state. */
  request(state: State): ApiRequest;
  /** Records one settled or thrown request as the host's attempt type. */
  record: RecordAttempt<State, Attempt>;
}

/** A concurrent burst that completed: the per-request records and how long they overlapped in flight. */
export interface Burst<Attempt> {
  ok: true;
  attempts: Attempt[];
  /** The earlier settle minus the later send over all requests, rounded to 3 places; <= 0 means no overlap. */
  overlap_ms: number;
}

/** A sequence that completed: one or more attempts fired one after another on a shared origin. */
export interface Sequence<Attempt> {
  ok: true;
  attempts: Attempt[];
}

/**
 * A round stopped by a setup failure. It carries the records of any requests fired before the
 * failure (empty for a concurrent burst, since all setup runs before the burst; the first attempt
 * for a sequence whose follow-up setup failed), so the caller can still keep them as evidence.
 */
export interface FireFailure<Attempt, Failure extends { ok: false }> {
  ok: false;
  failure: Failure;
  attempts: Attempt[];
}

/** Verdict on one request: the shared operation took effect, the app correctly refused it, or neither. */
export type Verdict = "applied" | "rejected" | "unexpected";

/** The observed outcome and failure code a grading assigns. Both are the host's own enums. */
export interface Grade<Observed, Failure> {
  observed: Observed;
  failure_code: Failure | null;
}

/** A graded outcome: the grade plus a human-readable detail line (statuses, codes and times only). */
export interface Graded<Observed, Failure> extends Grade<Observed, Failure> {
  detail: string;
}
