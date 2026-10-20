// The fake worker's script per scenario (contract section 15.1), taken from the scenario's end-state
// fixture: its events after the start's two (request_accepted and the worker's budget_updated), with
// the scenario's pause, stall or uncertain create in place. Budget amounts are not taken from the
// fixture: every budget_updated step settles or reserves at the test profile's worst cases.
import type { Event, RequestStatus, TestScenario } from "@rbw/factory-contract";

export type Step = { kind: "event"; event: Event } | { kind: "pause" } | { kind: "stall" };

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
    default:
      return events(rest);
  }
}
