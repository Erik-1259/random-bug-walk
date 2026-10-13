// The firing engine of the concurrency-check template. It owns the parts that are the same for
// every race candidate: setting each context up in order, choosing a single burst origin, firing
// the requests together (or one after another), timing each from that origin, and measuring how
// long the burst's requests overlapped in flight. What a request is and how to read its answer are
// the host's, supplied through a RequestPlan.

import { execute } from "../http.ts";
import type { AttemptTiming, Burst, Clock, FireFailure, RequestContext, RequestPlan, Sequence, SetupResult } from "./types.ts";

/** Milliseconds from the origin, rounded to 3 places, so recorded times and overlaps are stable. */
function elapsed(now: number, origin: number): number {
  return Math.round((now - origin) * 1000) / 1000;
}

/**
 * Fires one request, without retries, timed from `origin`, and records it through the plan. A
 * thrown send is recorded as unsettled rather than rejected, so one failed request in a burst
 * never drops the others' records. The bursts and sequences below fire every request through it.
 */
export async function fireOne<State, Attempt>(
  context: RequestContext,
  state: State,
  plan: Pick<RequestPlan<State, Attempt, never>, "request" | "record">,
  now: Clock,
  origin: number,
): Promise<{ attempt: Attempt; timing: AttemptTiming }> {
  const sent = now();
  try {
    const result = await execute(context, plan.request(state));
    const timing = { sent_ms: elapsed(sent, origin), settled_ms: elapsed(now(), origin) };
    return { attempt: plan.record({ settled: true, result }, timing, state), timing };
  } catch (error) {
    const timing = { sent_ms: elapsed(sent, origin), settled_ms: elapsed(now(), origin) };
    return { attempt: plan.record({ settled: false, error }, timing, state), timing };
  }
}

async function setUpAll<State, Attempt, Failure extends { ok: false }>(
  contexts: readonly RequestContext[],
  plan: RequestPlan<State, Attempt, Failure>,
): Promise<{ ok: true; states: State[] } | Failure> {
  const states: State[] = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index];
    if (context === undefined) {
      throw new Error("concurrency template: a request context was undefined");
    }
    const outcome: SetupResult<State, Failure> = await plan.setup(context, index);
    if (!outcome.ok) {
      return outcome;
    }
    states.push(outcome.state);
  }
  return { ok: true, states };
}

/** The earlier settle minus the later send over all timings, rounded to 3 places; <= 0 means no overlap. */
export function overlapOf(timings: readonly AttemptTiming[]): number {
  if (timings.length === 0) {
    return 0;
  }
  const latestSend = Math.max(...timings.map((timing) => timing.sent_ms));
  const earliestSettle = Math.min(...timings.map((timing) => timing.settled_ms));
  return Math.round((earliestSettle - latestSend) * 1000) / 1000;
}

/**
 * Sets each context up in order, then fires one request per context together on a single origin,
 * so none waits for another on the client side. Returns the records and the burst's overlap, or
 * the first setup failure, in which case no request was fired.
 */
export async function fireConcurrent<State, Attempt, Failure extends { ok: false }>(
  contexts: readonly RequestContext[],
  plan: RequestPlan<State, Attempt, Failure>,
  now: Clock,
): Promise<Burst<Attempt> | FireFailure<Attempt, Failure>> {
  const prepared = await setUpAll(contexts, plan);
  if (!prepared.ok) {
    return { ok: false, failure: prepared, attempts: [] };
  }
  const origin = now();
  const fired = await Promise.all(
    contexts.map((context, index) => {
      const state = prepared.states[index];
      if (state === undefined) {
        throw new Error("concurrency template: a setup state was undefined");
      }
      return fireOne(context, state, plan, now, origin);
    }),
  );
  return { ok: true, attempts: fired.map((item) => item.attempt), overlap_ms: overlapOf(fired.map((item) => item.timing)) };
}

/**
 * Sets one context up and fires one request, then, only when `repeatAfter` says so, sets the same
 * context up again and fires a second request on the same origin (so its send time is later). The
 * control for a race candidate: do the operation, then, if it took effect, try the same thing
 * again and see whether the app refuses it.
 */
export async function fireSequential<State, Attempt, Failure extends { ok: false }>(
  context: RequestContext,
  plan: RequestPlan<State, Attempt, Failure>,
  repeatAfter: (first: Attempt) => boolean,
  now: Clock,
): Promise<Sequence<Attempt> | FireFailure<Attempt, Failure>> {
  const first = await plan.setup(context, 0);
  if (!first.ok) {
    return { ok: false, failure: first, attempts: [] };
  }
  const origin = now();
  const firstFired = await fireOne(context, first.state, plan, now, origin);
  const attempts = [firstFired.attempt];
  if (repeatAfter(firstFired.attempt)) {
    const second = await plan.setup(context, 1);
    if (!second.ok) {
      return { ok: false, failure: second, attempts };
    }
    attempts.push((await fireOne(context, second.state, plan, now, origin)).attempt);
  }
  return { ok: true, attempts };
}
