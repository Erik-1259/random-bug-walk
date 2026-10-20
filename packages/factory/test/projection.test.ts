import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertContract, validateContract } from "@rbw/factory-contract/validate";
import type { Event, QualificationRecord, RequestStatus, ValidationRun } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import { lostWorkerEvents, projectStatus, ProjectionError, workerAttentionEvent } from "../src/projection.ts";
import type { CaseEvidence, ProjectionInput } from "../src/projection.ts";
import type { CandidateInfo } from "../src/sources.ts";
import { EventConflictError, EventNotAllowedError, MemoryEventStore } from "../src/testing/memory.ts";
import { REPO_ROOT, statusFixture } from "./support.ts";

const RECORD = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "factory-contract", "test", "fixtures", "qualification-record-accepted.json"), "utf8")) as QualificationRecord;

const STATUS_FIXTURES = [
  "status-queued.json",
  "status-running.json",
  "status-fulfilled.json",
  "status-validated.json",
  "status-partial-budget.json",
  "status-exhausted.json",
  "status-duplicate-defect.json",
  "status-cancelled.json",
  "status-operational-error.json",
  "status-zero-result.json",
  "status-wrong-failure.json",
] as const;

/** The projection's inputs as the stores would hold them for a fixture's request. */
function inputsOf(status: RequestStatus, overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  const candidates = new Map<string, CandidateInfo>(
    status.candidates.map((c) => [c.candidate_id, { candidate_id: c.candidate_id, defect_id: c.defect_id, host_id: c.host_id, bug_type_id: c.bug_type_id, source_id: c.source_id, entry_id: c.entry_id }]),
  );
  const evidence: CaseEvidence[] = status.cases.map((c) => ({ schema_version: 1, case: { ...structuredClone(c), validation: null }, record: { ...RECORD, case_id: c.case_id } }));
  const validations: Record<string, ValidationRun> = {};
  for (const c of status.cases) if (c.validation !== null) validations[c.case_id] = c.validation;
  const active = status.state !== "finished";
  const now = active && status.last_heartbeat_at !== null ? new Date(Date.parse(status.last_heartbeat_at) + 1000) : new Date(status.updated_at);
  return {
    request: { request_id: status.request_id, created_at: status.created_at, interpretation: status.interpretation },
    events: status.events,
    candidates,
    evidence,
    validations,
    budget: { budget_microusd: status.budget.budget_microusd, reserved_microusd: status.budget.reserved_microusd, spent_microusd: status.budget.spent_microusd },
    last_heartbeat_at: status.last_heartbeat_at,
    stop_recorded: status.events.some((event) => event.type === "stop_requested"),
    now,
    after: 0,
    ...overrides,
  };
}

/** Generated texts that the fixtures show only as illustrations. */
function withoutGeneratedText(status: RequestStatus): unknown {
  const copy = structuredClone(status) as RequestStatus & Record<string, unknown>;
  if (copy.stop_reason !== null) copy.stop_reason = { ...copy.stop_reason, message: "" };
  if (copy.attention !== null) copy.attention = { ...copy.attention, message: "" };
  return copy;
}

describe("status projection", () => {
  it.each(STATUS_FIXTURES)("reproduces %s from its events", (name) => {
    const status = statusFixture(name);
    const projected = projectStatus(inputsOf(status));
    expect(validateContract("RequestStatus", projected)).toEqual([]);
    expect(withoutGeneratedText(projected)).toEqual(withoutGeneratedText(status));
    if (projected.stop_reason !== null) expect(projected.stop_reason.message.length).toBeGreaterThan(0);
    if (projected.attention !== null) expect(projected.attention.message.length).toBeGreaterThan(0);
  });

  it("returns the events after `after` and the next cursor, and the last cursor when none follow", () => {
    const status = statusFixture("status-fulfilled.json");
    const page = projectStatus(inputsOf(status, { after: 30 }));
    expect(page.events.map((event) => event.seq)).toEqual([31, 32, 33, 34, 35]);
    expect(page.next_after).toBe(35);
    const empty = projectStatus(inputsOf(status, { after: 35 }));
    expect(empty.events).toEqual([]);
    expect(empty.next_after).toBe(35);
    // The counts never depend on the page.
    expect(empty.funnel).toEqual(status.funnel);
    expect(empty.items).toEqual(status.items);
  });

  it("returns at most 200 events and asks for the next page at once", () => {
    const status = statusFixture("status-running.json");
    const extra: Event[] = [];
    for (let seq = 13; seq <= 260; seq += 1) {
      extra.push({ seq, at: "2026-10-20T14:06:40.000Z", type: "budget_updated", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Budget updated.", data: { reserved_microusd: 500_000, spent_microusd: 0, remaining_microusd: 1_500_000 } });
    }
    const projected = projectStatus(inputsOf(status, { events: [...status.events, ...extra] }));
    expect(projected.events).toHaveLength(200);
    expect(projected.next_after).toBe(200);
    expect(projected.poll_after_ms).toBe(0);
    expect(validateContract("RequestStatus", projected)).toEqual([]);
  });

  it("reads worker_unresponsive from events only: shown once its raise is appended, gone once its clear is", async () => {
    const status = statusFixture("status-running.json");
    const heartbeat = Date.parse(status.last_heartbeat_at ?? "");
    const stale = new Date(heartbeat + 61_000);
    const store = await storeOf(status.events);
    const project = (lastHeartbeat: string | null, now: Date) => projectStatus(inputsOf(status, { events: store.events, last_heartbeat_at: lastHeartbeat, now }));
    // A stale heartbeat with no event is not attention: the status side appends the raise (contract section 8.1).
    expect(project(status.last_heartbeat_at, stale).attention).toBeNull();
    const raise = workerAttentionEvent({ events: store.events, last_heartbeat_at: status.last_heartbeat_at, created_at: status.created_at, now: stale });
    if (raise === null) throw new Error("a heartbeat 61 s old raises worker_unresponsive");
    await store.append(raise);
    expect(project(status.last_heartbeat_at, stale).attention?.code).toBe("worker_unresponsive");
    // A heartbeat that resumed changes nothing until its clear is appended.
    const resumed = new Date(heartbeat + 90_000).toISOString();
    const later = new Date(heartbeat + 90_500);
    expect(project(resumed, later).attention?.code).toBe("worker_unresponsive");
    const clear = workerAttentionEvent({ events: store.events, last_heartbeat_at: resumed, created_at: status.created_at, now: later });
    if (clear === null) throw new Error("a resumed heartbeat clears worker_unresponsive");
    await store.append(clear);
    expect(project(resumed, later).attention).toBeNull();
    expect(validateContract("RequestStatus", project(resumed, later))).toEqual([]);
  });

  it("shows stopping once a stop is recorded and the request has not finished", () => {
    const status = statusFixture("status-running.json");
    expect(projectStatus(inputsOf(status, { stop_recorded: true })).state).toBe("stopping");
  });

  it("counts funnel stages once per candidate and delivered cases only from case_delivered", () => {
    const status = statusFixture("status-fulfilled.json");
    // Drop the second case's case_delivered: it is no longer delivered, though its package is ready.
    const events = status.events.filter((event) => event.seq <= 31);
    const projected = projectStatus(inputsOf(status, { events, now: new Date("2026-10-20T14:24:20.700Z"), last_heartbeat_at: "2026-10-20T14:24:20.650Z" }));
    // Its parts are ready, but it is not a qualified case until case_delivered (section 8.2).
    expect(projected.funnel).toEqual({ candidates_explored: 2, behavior_checks_passed: 2, requested_criteria_passed: 2, packages_ready: 1 });
    expect(projected.items.map((item) => item.delivered)).toEqual([1, 0]);
    expect(projected.delivery).toBe("partial");
    expect(projected.cases.map((c) => c.case_id)).toEqual([status.cases[0]?.case_id]);
    expect(projected.candidates[1]?.stage).toBe("packaging");
    expect(projected.state).toBe("running");
  });

  it("gives a candidate a case only once it qualified: a packaging candidate has none", () => {
    const status = statusFixture("status-fulfilled.json");
    const events = status.events.filter((event) => event.seq <= 31);
    const projected = projectStatus(inputsOf(status, { events, now: new Date("2026-10-20T14:24:20.700Z"), last_heartbeat_at: "2026-10-20T14:24:20.650Z" }));
    expect(projected.candidates.map((c) => [c.stage, c.case_id === null])).toEqual([
      ["qualified", false],
      ["packaging", true],
    ]);
    expect(validateContract("RequestStatus", projected)).toEqual([]);
  });

  it("counts no ready package for a candidate the worker was lost with between package_ready and case_delivered", async () => {
    const status = statusFixture("status-fulfilled.json");
    const store = await storeOf(status.events.filter((event) => event.seq <= 31));
    for (const event of lostWorkerEvents({ events: store.events, now: new Date("2026-10-20T14:28:00.000Z") })) await store.append(event);
    const projected = projectStatus(inputsOf(status, { events: store.events, budget: { budget_microusd: 2_000_000, reserved_microusd: 500_000, spent_microusd: 210_000 } }));
    expect(validateContract("RequestStatus", projected)).toEqual([]);
    expect(projected.candidates.map((c) => c.stage)).toEqual(["qualified", "incomplete"]);
    expect(projected.funnel).toEqual({ candidates_explored: 2, behavior_checks_passed: 2, requested_criteria_passed: 2, packages_ready: 1 });
    expect(projected).toMatchObject({ outcome: "operational_error", delivery: "partial" });
  });

  it("counts a selected candidate as started while in flight, and as never started when it ends with nothing recorded after its selection", () => {
    const status = statusFixture("status-running.json");
    const selection = status.events.filter((event) => event.seq <= 8);
    const inFlight = projectStatus(inputsOf(status, { events: selection }));
    expect(inFlight.candidates.map((c) => [c.stage, c.started_at])).toEqual([["selected", "2026-10-20T14:02:41.812Z"]]);
    expect([inFlight.funnel.candidates_explored, inFlight.limits.candidates_started]).toEqual([0, 1]);
    const candidateId = inFlight.candidates[0]?.candidate_id ?? null;
    const end: Event = { seq: 9, at: "2026-10-20T14:02:41.900Z", type: "candidate_incomplete", host_id: "task-report", candidate_id: candidateId, item_key: null, case_id: null, message: "Incomplete.", data: { reason: "incomplete_run" } };
    const ended = projectStatus(inputsOf(status, { events: [...selection, end] }));
    expect(ended.candidates.map((c) => [c.stage, c.started_at, c.finished_at])).toEqual([["incomplete", null, "2026-10-20T14:02:41.900Z"]]);
    expect([ended.funnel.candidates_explored, ended.limits.candidates_started]).toEqual([0, 0]);
    expect(validateContract("RequestStatus", ended)).toEqual([]);
  });

  it("keeps a candidate that was only selected, or also reserved, out of candidates_explored and in stage selected", () => {
    // Contract section 8.2: candidates_explored counts candidates that started checks, and a candidate
    // has started checks once its first check_finished is recorded. Seq 8 selects it, seq 9 reserves it.
    const status = statusFixture("status-running.json");
    for (const last of [8, 9]) {
      const projected = projectStatus(inputsOf(status, { events: status.events.filter((event) => event.seq <= last) }));
      expect(projected.candidates.map((c) => c.stage)).toEqual(["selected"]);
      expect([projected.funnel.candidates_explored, projected.limits.candidates_started]).toEqual([0, 1]);
      expect(validateContract("RequestStatus", projected)).toEqual([]);
    }
  });

  it("counts a candidate as explored, in stage checking, from its first check_finished", () => {
    const status = statusFixture("status-running.json");
    const projected = projectStatus(inputsOf(status, { events: status.events.filter((event) => event.seq <= 10) }));
    expect(projected.events.at(-1)?.type).toBe("check_finished");
    expect(projected.candidates.map((c) => c.stage)).toEqual(["checking"]);
    expect([projected.funnel.candidates_explored, projected.limits.candidates_started]).toEqual([1, 1]);
    expect(validateContract("RequestStatus", projected)).toEqual([]);
  });

  it("refuses a delivered case without its evidence", () => {
    const status = statusFixture("status-fulfilled.json");
    expect(() => projectStatus(inputsOf(status, { evidence: [] }))).toThrow(ProjectionError);
  });

  it("projects a status the contract schema accepts for every fixture", () => {
    for (const name of STATUS_FIXTURES) assertContract("RequestStatus", projectStatus(inputsOf(statusFixture(name))));
  });
});

describe("worker heartbeat attention", () => {
  const running = statusFixture("status-running.json");
  const heartbeat = Date.parse(running.last_heartbeat_at ?? "");

  it("raises worker_unresponsive once the heartbeat is older than 60 s", () => {
    expect(workerAttentionEvent({ events: running.events, last_heartbeat_at: running.last_heartbeat_at, created_at: running.created_at, now: new Date(heartbeat + 59_000) })).toBeNull();
    const event = workerAttentionEvent({ events: running.events, last_heartbeat_at: running.last_heartbeat_at, created_at: running.created_at, now: new Date(heartbeat + 61_000) });
    expect(event).toMatchObject({ type: "attention", data: { code: "worker_unresponsive" }, event_key: "heartbeat:1:raise" });
  });

  it("clears it when a heartbeat arrives, and does nothing once the request finished", () => {
    const raised: Event = { seq: 13, at: "2026-10-20T14:07:52.000Z", type: "attention", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "x", data: { code: "worker_unresponsive" } };
    const events = [...running.events, raised];
    expect(workerAttentionEvent({ events, last_heartbeat_at: new Date(heartbeat + 120_000).toISOString(), created_at: running.created_at, now: new Date(heartbeat + 121_000) })).toMatchObject({
      type: "attention_cleared",
      data: { code: "worker_unresponsive" },
      event_key: "heartbeat:1:clear",
    });
    expect(workerAttentionEvent({ events, last_heartbeat_at: running.last_heartbeat_at, created_at: running.created_at, now: new Date(heartbeat + 121_000) })).toBeNull();
    const finished = statusFixture("status-fulfilled.json");
    expect(workerAttentionEvent({ events: finished.events, last_heartbeat_at: finished.last_heartbeat_at, created_at: finished.created_at, now: new Date("2026-10-21T00:00:00.000Z") })).toBeNull();
  });

  it("clears a raised worker_unresponsive once the request finished", () => {
    const finished = statusFixture("status-fulfilled.json");
    const raised: Event = { seq: 36, at: "2026-10-20T14:24:22.000Z", type: "attention", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "x", data: { code: "worker_unresponsive" } };
    const last = finished.events.at(-1);
    if (last === undefined) throw new Error("the fixture has no events");
    const events = [...finished.events.slice(0, -1), raised, last].map((event, index) => ({ ...event, seq: index + 1 }));
    expect(workerAttentionEvent({ events, last_heartbeat_at: finished.last_heartbeat_at, created_at: finished.created_at, now: new Date("2026-10-21T00:00:00.000Z") })).toMatchObject({
      type: "attention_cleared",
      data: { code: "worker_unresponsive" },
      event_key: "heartbeat:1:clear",
    });
  });
});

describe("the lost-worker finish", () => {
  it("ends the candidate in flight, sets needs_reconciliation and finishes worker_lost", () => {
    const running = statusFixture("status-running.json");
    const events = lostWorkerEvents({ events: running.events, now: new Date("2026-10-20T14:10:00.000Z") });
    expect(events.map((event) => [event.type, event.event_key])).toEqual([
      ["candidate_incomplete", "lost:candidate-end"],
      ["attention", "lost:attention"],
      ["request_finished", "lost:finished"],
    ]);
    expect(events[0]).toMatchObject({ candidate_id: running.candidates[0]?.candidate_id, data: { reason: "incomplete_run" } });
    expect(events[1]).toMatchObject({ data: { code: "needs_reconciliation" } });
    expect(events[2]).toMatchObject({ data: { outcome: "operational_error", stop_code: "worker_lost" } });
  });

  it("appends nothing for a request that already finished", () => {
    expect(lostWorkerEvents({ events: statusFixture("status-fulfilled.json").events, now: new Date() })).toEqual([]);
  });

  it("finishes on a retry after a partial append, appending only what is missing", async () => {
    const store = await storeOf(statusFixture("status-running.json").events);
    const first = lostWorkerEvents({ events: store.events, now: new Date("2026-10-20T14:10:00.000Z") });
    // The first finish appends the candidate's end and the attention, then fails before request_finished.
    for (const event of first.slice(0, 2)) await store.append(event);
    const retry = lostWorkerEvents({ events: store.events, now: new Date("2026-10-20T14:11:00.000Z") });
    for (const event of retry) await store.append(event);
    expect(store.events.slice(-3).map((event) => event.type)).toEqual(["candidate_incomplete", "attention", "request_finished"]);
    expect(store.events.at(-1)).toMatchObject({ data: { outcome: "operational_error", stop_code: "worker_lost" } });
    expect(store.events.filter((event) => event.type === "attention")).toHaveLength(1);
    expect(lostWorkerEvents({ events: store.events, now: new Date("2026-10-20T14:12:00.000Z") })).toEqual([]);
  });

  it("replays a second finish built at another time over the same events, as concurrent finishes do", async () => {
    const store = await storeOf(statusFixture("status-running.json").events);
    const first = lostWorkerEvents({ events: store.events, now: new Date("2026-10-20T14:10:00.000Z") });
    const second = lostWorkerEvents({ events: store.events, now: new Date("2026-10-20T14:10:07.000Z") });
    for (const event of first) await store.append(event);
    for (const event of second) await store.append(event);
    expect(store.replays).toEqual(["lost:candidate-end", "lost:attention", "lost:finished"]);
    expect(store.events.filter((event) => event.type === "request_finished")).toHaveLength(1);
    expect(store.events.at(-1)?.at).toBe("2026-10-20T14:10:00.000Z");
  });

  it("keeps a needs_reconciliation the worker raised before it was lost, without a second attention event", () => {
    const running = statusFixture("status-running.json");
    const raised: Event = { seq: 13, at: "2026-10-20T14:07:00.000Z", type: "attention", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "x", data: { code: "needs_reconciliation" } };
    const events = lostWorkerEvents({ events: [...running.events, raised], now: new Date("2026-10-20T14:10:00.000Z") });
    expect(events.map((event) => event.type)).toEqual(["candidate_incomplete", "request_finished"]);
  });
});

/** An in-memory store holding a fixture's events under keys of their own. */
async function storeOf(events: readonly Event[]): Promise<MemoryEventStore> {
  const store = new MemoryEventStore();
  for (const event of events) await store.append({ ...event, event_key: `fixture:${String(event.seq)}` });
  return store;
}

describe("worker heartbeat attention under repeated and concurrent polls", () => {
  const running = statusFixture("status-running.json");
  const heartbeat = Date.parse(running.last_heartbeat_at ?? "");
  const poll = (events: readonly Event[], lastHeartbeat: string | null, now: number) => workerAttentionEvent({ events, last_heartbeat_at: lastHeartbeat, created_at: running.created_at, now: new Date(now) });

  it("builds the same raise from one stale heartbeat whenever the polls run, so a second poll replays", async () => {
    const store = await storeOf(running.events);
    const first = poll(store.events, running.last_heartbeat_at, heartbeat + 61_000);
    const second = poll(store.events, running.last_heartbeat_at, heartbeat + 95_000);
    if (first === null || second === null) throw new Error("both polls see a stale heartbeat");
    await store.append(first);
    await store.append(second);
    expect(store.replays).toEqual(["heartbeat:1:raise"]);
    expect(store.events.at(-1)).toMatchObject({ type: "attention", at: new Date(heartbeat + 60_000).toISOString() });
  });

  it("builds the same clear from one resumed heartbeat, and the same clear after the finish", async () => {
    const store = await storeOf(running.events);
    const raise = poll(store.events, running.last_heartbeat_at, heartbeat + 61_000);
    if (raise === null) throw new Error("the poll sees a stale heartbeat");
    await store.append(raise);
    const resumed = new Date(heartbeat + 120_000).toISOString();
    const first = poll(store.events, resumed, heartbeat + 121_000);
    const second = poll(store.events, resumed, heartbeat + 140_000);
    if (first === null || second === null) throw new Error("both polls see the resumed heartbeat");
    await store.append(first);
    await store.append(second);
    expect(store.replays).toEqual(["heartbeat:1:clear"]);
    expect(store.events.at(-1)).toMatchObject({ type: "attention_cleared", at: resumed });

    const finishedStore = await storeOf(running.events);
    await finishedStore.append(raise);
    const finish = lostWorkerEvents({ events: finishedStore.events, now: new Date(heartbeat + 200_000) }).filter((event) => event.type === "request_finished");
    for (const event of finish) await finishedStore.append(event);
    const afterA = poll(finishedStore.events, running.last_heartbeat_at, heartbeat + 300_000);
    const afterB = poll(finishedStore.events, running.last_heartbeat_at, heartbeat + 400_000);
    if (afterA === null || afterB === null) throw new Error("both polls clear the raised attention after the finish");
    await finishedStore.append(afterA);
    await finishedStore.append(afterB);
    expect(finishedStore.replays).toEqual(["heartbeat:1:clear"]);
  });
});

describe("the in-memory event store", () => {
  const finished = statusFixture("status-fulfilled.json");
  const event = (type: "budget_updated" | "candidate_selected", at: string): Event =>
    type === "budget_updated"
      ? { seq: 0, at, type, host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Budget updated.", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 0 } }
      : { seq: 0, at, type, host_id: "task-report", candidate_id: "c".repeat(64), item_key: null, case_id: null, message: "Selected.", data: { source_id: "synthetic-source", entry_id: "synthetic-entry" } };

  it("compares a replay on everything but its time, and refuses other content under the same key", async () => {
    const store = await storeOf([]);
    await store.append({ ...event("budget_updated", "2026-10-20T14:00:00.000Z"), event_key: "k" });
    await store.append({ ...event("budget_updated", "2026-10-20T14:05:00.000Z"), event_key: "k" });
    expect(store.replays).toEqual(["k"]);
    expect(store.events.map((stored) => stored.at)).toEqual(["2026-10-20T14:00:00.000Z"]);
    await expect(store.append({ ...event("budget_updated", "2026-10-20T14:00:00.000Z"), message: "Other.", event_key: "k" })).rejects.toBeInstanceOf(EventConflictError);
  });

  it("takes only budget, attention and validation events after request_finished, and still replays earlier ones", async () => {
    const store = await storeOf(finished.events);
    const at = "2026-10-21T00:00:00.000Z";
    await expect(store.append({ ...event("candidate_selected", at), event_key: "late:selected" })).rejects.toBeInstanceOf(EventNotAllowedError);
    await store.append({ ...event("budget_updated", at), event_key: "late:budget" });
    const earlier = finished.events[0];
    if (earlier === undefined) throw new Error("the fixture has no events");
    await store.append({ ...earlier, event_key: "fixture:1" });
    expect(store.replays).toEqual(["fixture:1"]);
    expect(store.events.map((stored) => stored.type).slice(-2)).toEqual(["request_finished", "budget_updated"]);
  });
});
