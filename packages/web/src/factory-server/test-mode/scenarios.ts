// The fake worker's script per scenario (contract section 15.1), taken from the scenario's end-state
// fixture: its events after the start's two (request_accepted and the worker's budget_updated), with
// the scenario's pause, stall, uncertain create, setup failure or pending-package hold in place. Budget
// amounts are not taken from the fixture: every budget_updated step settles or reserves at the test
// profile's worst cases.
import { REASON_TEXT } from "@rbw/factory";
import type { CheckSet, CopyState, Event, ObservedOutcome, RequestStatus, TestScenario } from "@rbw/factory-contract";

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

/**
 * setup-failed's six checks as the factory core emits them for the scenario's plan, state by state: the
 * harness runs every state, so the clean copy, which cannot be prepared, observes error in both check
 * sets, and the buggy and fixed copies still run and observe what a qualifying candidate's do.
 */
const SETUP_FAILED_CHECKS: readonly (readonly [CopyState, CheckSet, ObservedOutcome, number, number])[] = [
  ["clean", "original_suite", "error", 0, 3],
  ["clean", "verification", "error", 0, 3],
  ["buggy", "original_suite", "pass", 3, 3],
  ["buggy", "verification", "fail", 3, 3],
  ["fixed", "original_suite", "pass", 3, 3],
  ["fixed", "verification", "pass", 3, 3],
];

/** The factory core's check_finished text. */
const CHECK_SET_TEXT: Readonly<Record<CheckSet, string>> = { original_suite: "Original suite", verification: "Verification checks" };
const COPY_TEXT: Readonly<Record<CopyState, string>> = { clean: "clean copy", buggy: "buggy copy", fixed: "reference-fixed copy" };

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
      // The zero-result run up to the candidate's reservation; then the candidate's six checks (its clean
      // copy, which was created, cannot be prepared; its buggy and fixed copies still run), the candidate
      // is invalid, and the fixture's tail after its rejection follows (the settlement, the exhausted
      // source, the worker and the finish).
      const reserve = rest.findIndex((event) => event.type === "budget_updated");
      const candidate = rest.find((event) => event.type === "candidate_selected");
      const ended = rest.findIndex((event) => event.type === "candidate_rejected");
      if (reserve < 0 || candidate === undefined || ended < reserve) throw new Error("test mode: the setup-failed fixture has no rejected candidate after its reservation");
      const on = { host_id: candidate.host_id, candidate_id: candidate.candidate_id };
      const checks = SETUP_FAILED_CHECKS.map(([copy, check_set, outcome, runs_valid, runs_total]) =>
        draft({
          type: "check_finished",
          ...on,
          message: `${CHECK_SET_TEXT[check_set]} on the ${COPY_TEXT[copy]}: ${outcome} (${String(runs_valid)} of ${String(runs_total)} runs valid).`,
          data: { check_set, copy, outcome, runs_valid, runs_total },
        }),
      );
      return [
        ...events(rest.slice(0, reserve + 1)),
        ...events([...checks, draft({ type: "candidate_invalid", ...on, message: REASON_TEXT.setup_failed, data: { reason: "setup_failed" } })]),
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
