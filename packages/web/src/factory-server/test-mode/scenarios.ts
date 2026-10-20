// The fake worker's script per scenario (contract section 15.1), taken from the scenario's end-state
// fixture: its events after the start's two (request_accepted and the worker's budget_updated), with
// the scenario's pause, stall, uncertain create, setup failure or pending-package hold in place. Budget
// amounts are not taken from the fixture: every budget_updated step settles or reserves at the test
// profile's worst cases.
import { REASON_TEXT } from "@rbw/factory";
import type { Event, RequestStatus, TestScenario } from "@rbw/factory-contract";

/** A hold delays the step after it: that step runs `ms` after the step before the hold. */
export type Step = { kind: "event"; event: Event } | { kind: "pause" } | { kind: "stall" } | { kind: "hold"; ms: number };

/** two-host-fulfilled: how long the first case waits between its package_ready and its case_delivered (contract revision 3). */
export const PENDING_PACKAGE_MS = 5000;

type Located = "host_id" | "candidate_id" | "item_key" | "case_id";
/** An event without seq and at, which the fake sets when it appends it; the location fields default to null. */
export type Draft = Event extends infer E ? (E extends Event ? Omit<E, "seq" | "at" | Located> & Partial<Pick<E, Located>> : never) : never;

export function draft(fields: Draft): Event {
  return { seq: 1, at: "1970-01-01T00:00:00.000Z", host_id: null, candidate_id: null, item_key: null, case_id: null, ...fields };
}

const events = (list: readonly Event[]): Step[] => list.map((event) => ({ kind: "event", event }));

/** The steps the fake worker runs after the start, for one scenario and its end-state fixture. */
export function scriptFor(scenario: TestScenario, end: RequestStatus): Step[] {
  const [accepted, reserved, ...rest] = end.events;
  if (accepted?.type !== "request_accepted" || reserved?.type !== "budget_updated") throw new Error(`test mode: the ${scenario} fixture does not start with request_accepted and budget_updated`);
  switch (scenario) {
    case "cancel-midway": {
      // Pause after the second candidate's first check_finished; the stop route appends stop_requested.
      const kept = rest.filter((event) => event.type !== "stop_requested");
      const second = kept.filter((event) => event.type === "candidate_selected")[1]?.candidate_id;
      const pauseAfter = kept.findIndex((event) => event.type === "check_finished" && event.candidate_id === second);
      if (second === undefined || pauseAfter < 0) throw new Error("test mode: the cancel-midway fixture has no second candidate check");
      return [...events(kept.slice(0, pauseAfter + 1)), { kind: "pause" }, ...events(kept.slice(pauseAfter + 1))];
    }
    case "worker-lost": {
      // The worker stops sending heartbeats after the checks before the first attention event; the
      // rest is the lost-worker finish, which only the status and stop routes trigger.
      const stall = rest.findIndex((event) => event.type === "attention");
      if (stall < 0) throw new Error("test mode: the worker-lost fixture has no attention event");
      return [...events(rest.slice(0, stall)), { kind: "stall" }];
    }
    case "uncertain-provider": {
      // The first candidate's first sandbox create has an uncertain outcome: its reservation step creates
      // the copy, the request stops and the worker settles; the copy stays uncertain.
      const reserve = rest.findIndex((event) => event.type === "budget_updated");
      const candidate = rest.find((event) => event.type === "candidate_selected");
      if (reserve < 0 || candidate === undefined) throw new Error("test mode: the uncertain-provider fixture has no candidate reservation");
      const on = { host_id: candidate.host_id, candidate_id: candidate.candidate_id };
      return [
        ...events(rest.slice(0, reserve + 1)),
        ...events([
          draft({ type: "attention", message: "A sandbox create returned an uncertain outcome; its spend needs reconciliation.", data: { code: "needs_reconciliation" } }),
          draft({ type: "candidate_incomplete", ...on, message: "Incomplete: a sandbox create returned an uncertain outcome. It is not reproduction and was not retried.", data: { reason: "incomplete_run" } }),
          draft({ type: "budget_updated", message: "", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 0 } }),
          draft({ type: "budget_updated", message: "", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 0 } }),
          draft({ type: "request_finished", message: "Request finished: operational error.", data: { outcome: "operational_error", stop_code: "needs_reconciliation" } }),
        ]),
      ];
    }
    case "setup-failed": {
      // The zero-result run up to the candidate's reservation; then its clean copy, which was created,
      // cannot be prepared: the check finishes error, the candidate is invalid, and the fixture's tail
      // after its rejection follows (the settlement, the exhausted source, the worker and the finish).
      const reserve = rest.findIndex((event) => event.type === "budget_updated");
      const candidate = rest.find((event) => event.type === "candidate_selected");
      const ended = rest.findIndex((event) => event.type === "candidate_rejected");
      if (reserve < 0 || candidate === undefined || ended < reserve) throw new Error("test mode: the setup-failed fixture has no rejected candidate after its reservation");
      const on = { host_id: candidate.host_id, candidate_id: candidate.candidate_id };
      return [
        ...events(rest.slice(0, reserve + 1)),
        ...events([
          draft({ type: "check_finished", ...on, message: "Original suite on the clean copy: error (0 of 3 runs valid).", data: { check_set: "original_suite", copy: "clean", outcome: "error", runs_valid: 0, runs_total: 3 } }),
          draft({ type: "candidate_invalid", ...on, message: REASON_TEXT.setup_failed, data: { reason: "setup_failed" } }),
        ]),
        ...events(rest.slice(ended + 1)),
      ];
    }
    case "two-host-fulfilled": {
      // The first case is announced and stored, then delivered PENDING_PACKAGE_MS later.
      const ready = rest.findIndex((event) => event.type === "package_ready");
      if (ready < 0) throw new Error("test mode: the two-host-fulfilled fixture has no package_ready");
      return [...events(rest.slice(0, ready + 1)), { kind: "hold", ms: PENDING_PACKAGE_MS }, ...events(rest.slice(ready + 1))];
    }
    default:
      return events(rest);
  }
}
