import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertContract, validateContract } from "@rbw/factory-contract/validate";
import type { Event, QualificationRecord, RequestStatus, ValidationRun } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import { lostWorkerEvents, projectStatus, ProjectionError, workerAttentionEvent } from "../src/projection.ts";
import type { CaseEvidence, ProjectionInput } from "../src/projection.ts";
import type { CandidateInfo } from "../src/sources.ts";
import { MemoryEventStore } from "../src/testing/memory.ts";
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

  it("shows worker_unresponsive after 60 s without a heartbeat while the request is active", () => {
    const status = statusFixture("status-running.json");
    const heartbeat = Date.parse(status.last_heartbeat_at ?? "");
    expect(projectStatus(inputsOf(status, { now: new Date(heartbeat + 60_000) })).attention).toBeNull();
    expect(projectStatus(inputsOf(status, { now: new Date(heartbeat + 60_001) })).attention?.code).toBe("worker_unresponsive");
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
    expect(projected.funnel).toEqual({ candidates_explored: 2, behavior_checks_passed: 2, requested_criteria_passed: 2, packages_ready: 2 });
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
