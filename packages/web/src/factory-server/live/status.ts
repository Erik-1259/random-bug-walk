// The request's status in live mode: the ledger's request record and every event, each delivered
// case's recorded evidence, each case's latest validation run and the request budget, projected by the
// factory core (projectStatus). The status side's two appends live here too: the worker_unresponsive
// attention change and the user's stop.
import { ROUTE_ACTOR, validationRunView } from "@rbw/controller/factory-web";
import type { FactoryDatabase, FactoryEventInput } from "@rbw/controller/factory-web";
import { projectStatus, workerAttentionEvent } from "@rbw/factory";
import type { CandidateInfo, CaseEvidence, NewEvent } from "@rbw/factory";
import type { Event, RequestStatus, ValidationRun } from "@rbw/factory-contract";
import type { RequestRecord } from "@rbw/spend";

/** The most events one ledger read returns. */
const EVENT_PAGE = 1000;

export const STOP_MESSAGE = "The user asked to stop. No new candidate or check will start.";

/** The request's record as of its last page, with every event; null for an unknown request. */
export async function readRequest(db: FactoryDatabase, requestId: string): Promise<{ record: RequestRecord; events: Event[] } | null> {
  const events: Event[] = [];
  let after = 0;
  for (;;) {
    const page = await db.records.readRequest({ request_id: requestId, after, limit: EVENT_PAGE });
    if (!page.ok) {
      if (page.code === "unknown_request") return null;
      throw new Error(`the request read was refused (${page.code})`);
    }
    events.push(...page.events);
    if (page.next_after >= page.last_seq) return { record: page, events };
    if (page.events.length === 0) throw new Error("the request's events ended before its last seq");
    after = page.next_after;
  }
}

/** The latest validation run of each case (by acceptance), as its record and events stand. */
async function latestRuns(db: FactoryDatabase, record: RequestRecord): Promise<Record<string, ValidationRun>> {
  const latest = new Map<string, RequestRecord["validations"][number]>();
  for (const run of record.validations) {
    const found = latest.get(run.case_id);
    if (found === undefined || Date.parse(run.accepted_at) >= Date.parse(found.accepted_at)) latest.set(run.case_id, run);
  }
  const runs: Record<string, ValidationRun> = {};
  for (const [caseId, run] of latest) runs[caseId] = validationRunView(run, await db.factoryRecords.validationEvents(run.validation_id));
  return runs;
}

/** RequestStatus for `after`; null for an unknown request. A record the projection refuses throws ProjectionError. */
export async function readStatus(db: FactoryDatabase, candidates: ReadonlyMap<string, CandidateInfo>, requestId: string, after: number, now: Date): Promise<RequestStatus | null> {
  const read = await readRequest(db, requestId);
  if (read === null) return null;
  const { record, events } = read;
  const evidence: CaseEvidence[] = [];
  for (const summary of record.evidence) {
    const found = await db.factoryRecords.readEvidence(requestId, summary.case_id);
    if (found === null) throw new Error(`the evidence of case ${summary.case_id} is listed but not readable`);
    evidence.push(found);
  }
  const budget = await db.ledger.budgets.status(record.request.budget_key);
  if (!budget.ok) throw new Error(`the request budget's status was refused (${budget.code})`);
  return projectStatus({
    request: { request_id: requestId, created_at: record.request.created_at, interpretation: record.request.interpretation },
    events,
    candidates,
    evidence,
    validations: await latestRuns(db, record),
    budget: { budget_microusd: Number(budget.budget_microusd), reserved_microusd: Number(budget.open_microusd), spent_microusd: Number(budget.settled_microusd) },
    last_heartbeat_at: record.last_heartbeat_at,
    stop_recorded: record.stop !== null,
    now,
    after,
  });
}

function eventInput(event: NewEvent): FactoryEventInput {
  return { event_key: event.event_key, type: event.type, host_id: event.host_id, candidate_id: event.candidate_id, item_key: event.item_key, case_id: event.case_id, message: event.message, data: { ...event.data } };
}

/**
 * Appends the worker_unresponsive attention change the heartbeat calls for, at the time the factory
 * core gives it (not the poll's), so concurrent polls build the same event and replay. True when it
 * appended; a refusal (the request finished meanwhile) appends nothing.
 */
export async function noteUnresponsive(db: FactoryDatabase, requestId: string, now: Date): Promise<boolean> {
  const read = await readRequest(db, requestId);
  if (read === null) return false;
  const event = workerAttentionEvent({ events: read.events, last_heartbeat_at: read.record.last_heartbeat_at, created_at: read.record.request.created_at, now });
  if (event === null) return false;
  const appended = await db.factoryRecords.appendEvent(requestId, eventInput(event), new Date(event.at));
  if (appended.kind === "conflict") throw new Error(`the attention event ${event.event_key} differs from the one recorded under its key`);
  return appended.kind === "appended";
}

/**
 * Records the stop (the worker reads the stop record) and appends stop_requested once. After the
 * request finished, the append is refused and the stop answers as a replay.
 */
export async function recordStop(db: FactoryDatabase, requestId: string, now: Date): Promise<"recorded" | "replay" | "not_found"> {
  const stopped = await db.records.recordStop({ request_id: requestId, actor_role: ROUTE_ACTOR });
  if (!stopped.ok) {
    if (stopped.code === "unknown_request") return "not_found";
    throw new Error(`the stop was refused (${stopped.code})`);
  }
  const appended = await db.factoryRecords.appendEvent(
    requestId,
    { event_key: "stop_requested", type: "stop_requested", host_id: null, candidate_id: null, item_key: null, case_id: null, message: STOP_MESSAGE, data: {} },
    now,
  );
  if (appended.kind === "conflict") throw new Error("the stop_requested event differs from the one recorded under its key");
  return appended.kind === "appended" ? "recorded" : "replay";
}
