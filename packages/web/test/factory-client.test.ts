import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertContract } from "@rbw/factory-contract/validate";
import { createFactoryClient, FactoryController, FactoryError, REQUEST_KEY, VALIDATION_ID_KEY } from "../src/factory/client.ts";
import type { Capabilities, FactoryClient, Interpretation, RequestStatus, StartRequest, ValidationRun, FactoryIdentityLock } from "../src/factory/client.ts";
function fixture<T>(name: string, transform: (value: unknown) => T = value => value as T): T { return transform(JSON.parse(readFileSync(new URL(`./fixtures/factory-v1/${name}.json`, import.meta.url), "utf8"))); }
const input = fixture<StartRequest>("start-request");
function setup() {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  const api = {
    capabilities: vi.fn<FactoryClient["capabilities"]>().mockResolvedValue(fixture<Capabilities>("capabilities")),
    session: vi.fn<FactoryClient["session"]>().mockResolvedValue({ contract_version: "bug-request/1", signed_in: true }), signIn: vi.fn<FactoryClient["signIn"]>().mockResolvedValue(undefined),
    interpret: vi.fn<FactoryClient["interpret"]>().mockResolvedValue(fixture<Interpretation>("interpretation-supported")),
    start: vi.fn<FactoryClient["start"]>().mockResolvedValue(fixture<RequestStatus>("status-queued")),
    status: vi.fn<FactoryClient["status"]>().mockResolvedValue(fixture<RequestStatus>("status-running")),
    stop: vi.fn<FactoryClient["stop"]>().mockResolvedValue({ ...fixture<RequestStatus>("status-cancelled"), request_id: input.request_id }),
    validate: vi.fn<FactoryClient["validate"]>().mockResolvedValue(fixture<ValidationRun>("validation-running")),
    validation: vi.fn<FactoryClient["validation"]>().mockResolvedValue(fixture<ValidationRun>("validation-running")),
  };
  const uuid = vi.fn(() => input.request_id);
  let time = 0;
  const advance = () => { time += 60000; };
  let queued = Promise.resolve();
  const lock: FactoryIdentityLock = operation => {
    const result = queued.then(operation);
    queued = result.then(() => undefined, () => undefined); // Release the queue; the caller still receives its rejection.
    return result;
  };
  const controller = new FactoryController(api, storage, uuid, () => time, lock);
  return { memory, storage, api, uuid, controller, advance, lock };
}
async function prepared() { const context = setup(); await context.controller.initialize(); await context.controller.interpret(input.input); return context; }

describe("draft revision 2 transport, synthetic contract fixtures only", () => {
  it("uses exact endpoints and bodies without a replay session or replacement identity", async () => {
    const calls: { path: string; options: RequestInit | undefined }[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((path, options) => {
      calls.push({ path: typeof path === "string" ? path : path instanceof URL ? path.href : path.url, options });
      return Promise.resolve(new Response(JSON.stringify(fixture<RequestStatus>("status-queued")), { status: 200 }));
    });
    const client = createFactoryClient(fetcher);
    await client.start(input); await client.status(input.request_id, 12); await client.stop(input.request_id);
    expect(calls.map(call => call.path)).toEqual(["/api/factory/requests", `/api/factory/requests/${input.request_id}?after=12`, `/api/factory/requests/${input.request_id}/stop`]);
    expect(calls[0]?.options?.body).toBe(JSON.stringify(input));
    expect(calls[0]?.options?.credentials).toBe("same-origin");
    expect(calls[2]?.options?.body).toBe("{}");
  });
  it("reports missing HTML endpoints and wrong contract versions as unavailable", async () => {
    for (const response of [new Response("<html>Not found</html>", { status: 404 }), Response.json({ contract_version: "future/2" })]) {
      const client = createFactoryClient(vi.fn<typeof fetch>().mockResolvedValue(response));
      await expect(client.capabilities()).rejects.toMatchObject({ code: "unavailable" });
    }
  });
  it("branches on refusal codes, not prose", async () => {
    const body = fixture<{ contract_version: string; error: { code: string; message: string } }>("error-busy");
    body.error.message = "Synthetic alternate message";
    const client = createFactoryClient(vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 409 })));
    await expect(client.start(input)).rejects.toMatchObject({ code: "busy", status: 409 });
  });
  it("handles the session's bodyless 204", async () => {
    const client = createFactoryClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(client.signIn("synthetic-passcode")).resolves.toBeUndefined();
  });
});

describe("browser request lifecycle with synthetic service responses", () => {
  it("retains an accepted HTTP 202 finished launch failure across reload without another POST", async () => {
    const c = await prepared();
    const finished = fixture<RequestStatus>("status-queued");
    finished.state = "finished";
    finished.outcome = "operational_error";
    finished.stop_reason = { code: "operational_error", message: "Synthetic worker launch failed after request recording." };
    finished.updated_at = "2026-10-20T14:00:01.000Z";
    finished.budget = { ...finished.budget, reserved_microusd: 0, committed_microusd: 0, remaining_microusd: finished.budget.budget_microusd };
    finished.events.push(
      { seq: 3, at: finished.updated_at, type: "budget_updated", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Synthetic unused reservation released.", data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: finished.budget.remaining_microusd } },
      { seq: 4, at: finished.updated_at, type: "request_finished", host_id: null, candidate_id: null, item_key: null, case_id: null, message: finished.stop_reason.message, data: { outcome: "operational_error", stop_code: "operational_error" } },
    );
    finished.next_after = 4;
    assertContract("RequestStatus", finished);
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_path, options) =>
      Promise.resolve(Response.json(finished, { status: options?.method === "POST" ? 202 : 200 })));
    const transport = createFactoryClient(fetcher);
    c.api.start.mockImplementation(body => transport.start(body));
    c.api.status.mockImplementation((id, after) => transport.status(id, after));
    await c.controller.start();
    expect(c.controller.snapshot().status).toEqual(finished);
    expect(c.controller.snapshot().canRetryStart).toBe(false);
    expect(c.storage.getItem(REQUEST_KEY)).toBe(input.request_id);
    await c.controller.retryStart(); await c.controller.start();
    const resumed = new FactoryController(c.api, c.storage, c.uuid, undefined, c.lock);
    await resumed.initialize(); await resumed.retryStart(); await resumed.start();
    expect(resumed.snapshot().status?.outcome).toBe("operational_error");
    expect(resumed.snapshot().requestId).toBe(input.request_id);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(c.uuid).toHaveBeenCalledTimes(1);
  });

  it("keeps completed validation error cost null while later reconciliation updates only the request budget", async () => {
    const c = await prepared();
    const finished = assertContract("RequestStatus", fixture("status-fulfilled"));
    c.api.start.mockResolvedValue(finished); await c.controller.start();
    const run = fixture<ValidationRun>("validation-error");
    run.cost_microusd = null;
    run.message = "Synthetic uncertain validation spend awaits reconciliation.";
    assertContract("ValidationRun", run);
    c.uuid.mockReturnValue(run.validation_id);
    c.api.validate.mockResolvedValue(run);
    const pending = structuredClone(finished);
    pending.attention = { code: "needs_reconciliation", message: run.message };
    const item = pending.cases.find(value => value.case_id === run.case_id);
    if (item === undefined) throw new Error("Missing synthetic validation case");
    const reservation = pending.interpretation.budget.worst_case_per_validation_microusd.find(value => value.host_id === item.host_id)?.microusd;
    if (reservation === undefined) throw new Error("Missing synthetic validation reservation");
    pending.budget = { ...pending.budget, reserved_microusd: reservation, committed_microusd: pending.budget.spent_microusd + reservation, remaining_microusd: pending.budget.remaining_microusd - reservation };
    item.validation = run;
    assertContract("RequestStatus", pending);
    await c.controller.validate(run.case_id);
    c.api.status.mockResolvedValue(pending); c.advance(); await c.controller.poll();
    expect(c.controller.snapshot().validation?.cost_microusd).toBeNull();
    expect(c.controller.needsPoll()).toBe(true);
    const reconciled = structuredClone(pending);
    reconciled.attention = null;
    reconciled.budget = { ...reconciled.budget, reserved_microusd: 0, spent_microusd: reconciled.budget.spent_microusd + reservation };
    assertContract("RequestStatus", reconciled);
    c.api.status.mockResolvedValue(reconciled); c.advance(); await c.controller.poll();
    expect(c.controller.snapshot().status?.budget).toEqual(reconciled.budget);
    expect(c.controller.snapshot().status?.cases).toEqual(reconciled.cases);
    expect(c.controller.snapshot().status?.outcome).toBe("fulfilled");
    expect(c.controller.snapshot().validation).toEqual(run);
    expect(c.controller.snapshot().validation?.cost_microusd).toBeNull();
    expect(c.controller.needsPoll()).toBe(false);
    await c.controller.retryValidation();
    expect(c.api.validate).toHaveBeenCalledTimes(1);
    expect(c.storage.getItem(VALIDATION_ID_KEY)).toBe(run.validation_id);
  });
  it("retains the revision-2 per-item budget warning from the service interpretation", async () => {
    const c = await prepared(); const interpretation = fixture<Interpretation>("interpretation-budget-below-item");
    c.api.interpret.mockResolvedValue(interpretation); await c.controller.interpret(input.input);
    expect(c.controller.snapshot().interpretation).toEqual(interpretation);
    expect(interpretation.items.flatMap(item => item.problems).some(problem => problem.code === "budget_below_item_minimum" && problem.severity === "warning")).toBe(true);
  });
  it("persists identity before POST and blocks overlapping starts", async () => {
    const c = await prepared();
    let release: ((status: RequestStatus) => void) | undefined;
    c.api.start.mockImplementation(() => { expect(c.storage.getItem(REQUEST_KEY)).toBe(input.request_id); return new Promise(resolve => { release = resolve; }); });
    const first = c.controller.start(); await c.controller.start();
    expect(c.api.start).toHaveBeenCalledTimes(1); expect(c.uuid).toHaveBeenCalledTimes(1);
    release?.(fixture<RequestStatus>("status-queued")); await first;
    expect(c.controller.snapshot().status?.state).toBe("queued");
  });
  it("adopts another tab's saved request before a stale tab can start", async () => {
    const c = await prepared();
    const otherId = "00000000-0000-4000-8000-000000000999";
    const otherUuid = vi.fn(() => otherId);
    const other = new FactoryController(c.api, c.storage, otherUuid, undefined, c.lock);
    await other.initialize(); await other.interpret(input.input);
    await c.controller.start();
    await other.start();
    expect(c.api.start).toHaveBeenCalledTimes(1);
    expect(otherUuid).not.toHaveBeenCalled();
    expect(other.snapshot().requestId).toBe(input.request_id);
    expect(c.storage.getItem(REQUEST_KEY)).toBe(input.request_id);
    expect(JSON.parse(c.storage.getItem("rbw-factory-start") ?? "null")).toEqual(input);
    const resumed = new FactoryController(c.api, c.storage, c.uuid, undefined, c.lock); await resumed.initialize();
    expect(resumed.snapshot().requestId).toBe(input.request_id);
  });
  it("holds the shared lock through uncertain start reconciliation before another tab adopts", async () => {
    const c = await prepared();
    const otherUuid = vi.fn(() => "00000000-0000-4000-8000-000000000999");
    const other = new FactoryController(c.api, c.storage, otherUuid, undefined, c.lock);
    await other.initialize(); await other.interpret(input.input);
    let enterRead: () => void = () => undefined;
    const reading = new Promise<void>(resolve => { enterRead = resolve; });
    let finishRead: (value: RequestStatus) => void = () => undefined;
    c.api.start.mockRejectedValue(new FactoryError("unavailable", "Synthetic lost start response"));
    c.api.status.mockImplementationOnce(() => { enterRead(); return new Promise(resolve => { finishRead = resolve; }); });
    const first = c.controller.start(); await reading;
    const second = other.start(); await Promise.resolve();
    expect(otherUuid).not.toHaveBeenCalled(); expect(c.api.start).toHaveBeenCalledTimes(1);
    expect(c.api.status).toHaveBeenCalledTimes(1); expect(other.snapshot().busy).toBe(true);
    expect(c.storage.getItem(REQUEST_KEY)).toBe(input.request_id);
    finishRead(fixture<RequestStatus>("status-running")); await Promise.all([first, second]);
    expect(c.api.start).toHaveBeenCalledTimes(1); expect(other.snapshot().requestId).toBe(input.request_id);
  });
  it("cleanup waits for another tab's validation and preserves its identity and delivered cases", async () => {
    const c = await prepared(); const finished = fixture<RequestStatus>("status-fulfilled");
    c.api.start.mockResolvedValue(finished); c.api.status.mockResolvedValue(finished); await c.controller.start();
    const other = new FactoryController(c.api, c.storage, c.uuid, undefined, c.lock); await other.initialize();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    let entered: () => void = () => undefined;
    const posted = new Promise<void>(resolve => { entered = resolve; });
    let finish: (value: ValidationRun) => void = () => undefined;
    c.api.validate.mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const validation = other.validate(run.case_id); await posted;
    const cleanup = c.controller.newDraft(); await Promise.resolve();
    expect(c.storage.getItem(VALIDATION_ID_KEY)).toBe(run.validation_id);
    finish(run); await Promise.all([validation, cleanup]);
    expect(c.storage.getItem(REQUEST_KEY)).toBe(input.request_id);
    expect(c.storage.getItem(VALIDATION_ID_KEY)).toBe(run.validation_id);
    expect(c.controller.snapshot().validation?.validation_id).toBe(run.validation_id);
    expect(c.controller.snapshot().status?.cases).toEqual(finished.cases);
    const resumed = new FactoryController(c.api, c.storage, c.uuid, undefined, c.lock); await resumed.initialize();
    expect(resumed.snapshot().validation?.validation_id).toBe(run.validation_id);
    expect(c.api.validate).toHaveBeenCalledTimes(1);
  });
  it("does not start work when the cross-tab lock is unavailable", async () => {
    const c = await prepared();
    const unavailable: FactoryIdentityLock = () => Promise.reject(new FactoryError("unavailable", "Synthetic unavailable lock"));
    const controller = new FactoryController(c.api, c.storage, c.uuid, undefined, unavailable);
    await controller.initialize(); await controller.interpret(input.input); await controller.start();
    expect(c.api.start).not.toHaveBeenCalled(); expect(controller.snapshot().message).toContain("Synthetic unavailable lock");
  });
  it("a stale completed tab cannot clear another tab's newer saved request", async () => {
    const c = await prepared(); c.api.start.mockResolvedValue(fixture<RequestStatus>("status-fulfilled")); await c.controller.start();
    const otherId = "00000000-0000-4000-8000-000000000999";
    const otherBody = { ...input, request_id: otherId };
    c.storage.setItem(REQUEST_KEY, otherId); c.storage.setItem("rbw-factory-start", JSON.stringify(otherBody));
    c.storage.setItem("rbw-factory-validation", JSON.stringify({ request_id: otherId, case_id: "synthetic-case", validation_id: "synthetic-validation" }));
    await c.controller.newDraft();
    expect(c.controller.snapshot().requestId).toBe(otherId);
    expect(c.storage.getItem(REQUEST_KEY)).toBe(otherId);
    expect(c.storage.getItem("rbw-factory-start")).toBe(JSON.stringify(otherBody));
    expect(c.storage.getItem("rbw-factory-validation")).not.toBeNull();
  });
  it("does not send a paid start when local storage fails", async () => {
    const c = setup();
    const controller = new FactoryController(c.api, { ...c.storage, setItem: () => { throw new Error("storage unavailable"); } }, c.uuid, undefined, c.lock);
    await controller.initialize(); await controller.interpret(input.input); await controller.start();
    expect(c.api.start).not.toHaveBeenCalled();
  });
  it("reconciles a lost POST response using the same ID and resumes on reload", async () => {
    const c = await prepared(); c.api.start.mockRejectedValue(new FactoryError("unavailable", "Synthetic network failure", 503));
    await c.controller.start();
    expect(c.api.status).toHaveBeenCalledWith(input.request_id, 0);
    const resumed = new FactoryController(c.api, c.storage, c.uuid, undefined, c.lock); await resumed.initialize();
    expect(resumed.snapshot().status?.state).toBe("running"); expect(c.api.start).toHaveBeenCalledTimes(1); expect(c.uuid).toHaveBeenCalledTimes(1);
  });
  it("a 404 after uncertain start permits only a retry of the identical body", async () => {
    const c = await prepared(); c.api.start.mockRejectedValueOnce(new FactoryError("unavailable", "Synthetic timeout"));
    c.api.status.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await c.controller.start(); expect(c.controller.snapshot().canRetryStart).toBe(true);
    await c.controller.start(); expect(c.api.start).toHaveBeenCalledTimes(1);
    await c.controller.retryStart(); expect(c.api.start).toHaveBeenCalledTimes(2);
    expect(c.api.start.mock.calls[0]).toEqual(c.api.start.mock.calls[1]); expect(c.uuid).toHaveBeenCalledTimes(1);
  });
  it("busy reconciles first: only a definite 404 permits a new identity", async () => {
    const c = await prepared(); c.api.start.mockRejectedValue(new FactoryError("busy", "Synthetic slot held", 409));
    await c.controller.start(); expect(c.controller.snapshot().requestId).toBe(input.request_id);
    const other = await prepared(); other.api.start.mockRejectedValue(new FactoryError("busy", "Synthetic slot held", 409));
    other.api.status.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await other.controller.start(); expect(other.api.status).toHaveBeenCalled(); expect(other.controller.snapshot().requestId).toBeNull(); expect(other.controller.snapshot().message).toBe("busy: Synthetic slot held");
  });
  it.each(["budget_unavailable", "unsupported_request", "interpretation_stale", "invalid_request"])("requires new interpretation after definite %s refusal", async (code) => {
    const c = await prepared(); c.api.start.mockRejectedValue(new FactoryError(code, "Synthetic refusal", 409));
    await c.controller.start(); expect(c.controller.snapshot().requestId).toBeNull(); expect(c.controller.snapshot().interpretation).toBeNull();
  });
  it("does not replace an idempotency conflict or expired-session request", async () => {
    for (const code of ["idempotency_conflict", "unauthorized"]) {
      const c = await prepared(); c.api.start.mockRejectedValue(new FactoryError(code, "Synthetic refusal", 409));
      await c.controller.start(); expect(c.controller.snapshot().requestId).toBe(input.request_id); await c.controller.start(); expect(c.api.start).toHaveBeenCalledTimes(1);
    }
  });
  it("backoffs unavailable status reads 15/30/60 seconds and never posts replacement work", async () => {
    const c = await prepared(); await c.controller.start(); c.api.status.mockRejectedValue(new FactoryError("unavailable", "Synthetic outage", 503));
    for (const expected of [15000, 30000, 60000, 60000]) { c.advance(); await c.controller.poll(); expect(c.controller.pollAfter()).toBe(expected); }
    expect(c.api.start).toHaveBeenCalledTimes(1); expect(c.controller.snapshot().status?.state).toBe("queued");
  });
  it("does not let manual refresh bypass the advertised polling interval", async () => {
    const c = await prepared(); await c.controller.start(); await c.controller.poll(); await c.controller.initialize();
    expect(c.api.capabilities).toHaveBeenCalledTimes(2);
    expect(c.api.status).not.toHaveBeenCalled(); c.advance(); await c.controller.poll();
    expect(c.api.status).toHaveBeenCalledTimes(1);
  });
  it("merges event pages once, uses next_after and honors status polling interval", async () => {
    const c = await prepared(); await c.controller.start(); const queued = c.controller.snapshot().status;
    c.advance(); await c.controller.poll(); expect(c.api.status).toHaveBeenCalledWith(input.request_id, queued?.next_after);
    const running = c.controller.snapshot().status; c.advance(); await c.controller.poll();
    expect(c.controller.snapshot().status?.events).toEqual(running?.events);
    expect(c.controller.pollAfter()).toBe(Math.max(1000, running?.poll_after_ms ?? 0));
  });
  it("drains event pages even after finished and refreshes budget after validation", async () => {
    const c = await prepared();
    const finished = fixture<RequestStatus>("status-fulfilled");
    finished.events = Array.from({ length: 200 }, (_, index) => ({ seq: index + 1, at: "2026-10-20T14:03:07.120Z", type: "budget_updated", message: "Synthetic pagination event", host_id: null, candidate_id: null, item_key: null, case_id: null, data: { reserved_microusd: 0, spent_microusd: 0, remaining_microusd: 2000000 } }));
    finished.next_after = 200; c.api.start.mockResolvedValue(finished);
    await c.controller.start(); expect(c.controller.needsPoll()).toBe(true);
    c.api.status.mockResolvedValue({ ...finished, events: [], next_after: 200 }); c.advance(); await c.controller.poll();
    expect(c.controller.needsPoll()).toBe(false); expect(c.controller.snapshot().status?.events).toHaveLength(200);
    const run = fixture<ValidationRun>("validation-passed"); c.uuid.mockReturnValue(run.validation_id); c.api.validate.mockResolvedValue(run);
    await c.controller.validate(run.case_id); expect(c.controller.needsPoll()).toBe(true);
    c.advance(); await c.controller.poll(); expect(c.controller.needsPoll()).toBe(false);
  });
  it.each([1, 2])("queues %i Stop clicks during a status read as one Stop after the read, retaining delivered cases", async clicks => {
    const c = await prepared(); await c.controller.start();
    let enterRead: () => void = () => undefined;
    const reading = new Promise<void>(resolve => { enterRead = resolve; });
    let finishRead: (value: RequestStatus) => void = () => undefined;
    c.api.status.mockImplementationOnce(() => { enterRead(); return new Promise(resolve => { finishRead = resolve; }); });
    c.advance(); const polling = c.controller.poll(); await reading;
    const stops = Array.from({ length: clicks }, () => c.controller.stop());
    expect(c.api.stop).not.toHaveBeenCalled();
    const cancelled = fixture<RequestStatus>("status-cancelled");
    const running = { ...cancelled, state: "running" as const, outcome: null, stop_reason: null };
    finishRead(running); await Promise.all([polling, ...stops]);
    expect(c.api.stop).toHaveBeenCalledExactlyOnceWith(input.request_id);
    expect(c.controller.snapshot().status?.state).toBe("finished");
    expect(c.controller.snapshot().status?.delivery).toBe("partial");
    expect(c.controller.snapshot().status?.cases).toEqual(cancelled.cases);
    expect(c.controller.snapshot().requestId).toBe(input.request_id);
  });
  it.each(["finished", "unauthorized"] as const)("does not send queued Stop when the held poll reports %s", async outcome => {
    const c = await prepared(); await c.controller.start();
    let enterRead: () => void = () => undefined;
    const reading = new Promise<void>(resolve => { enterRead = resolve; });
    let finishRead: (value: RequestStatus) => void = () => undefined;
    let rejectRead: (error: Error) => void = () => undefined;
    c.api.status.mockImplementationOnce(() => { enterRead(); return new Promise((resolve, reject) => { finishRead = resolve; rejectRead = reject; }); });
    c.advance(); const polling = c.controller.poll(); await reading;
    const stopping = c.controller.stop(); expect(c.api.stop).not.toHaveBeenCalled();
    if (outcome === "finished") finishRead(fixture<RequestStatus>("status-fulfilled"));
    else rejectRead(new FactoryError("unauthorized", "Synthetic session expired", 401));
    await Promise.all([polling, stopping]);
    expect(c.api.stop).not.toHaveBeenCalled();
    expect(c.controller.snapshot().requestId).toBe(input.request_id);
    if (outcome === "finished") expect(c.controller.snapshot().status?.state).toBe("finished");
    else expect(c.controller.snapshot().signedIn).toBe(false);
  });
  it("stops without losing previously delivered partial cases", async () => {
    const c = await prepared(); await c.controller.start(); await c.controller.stop();
    expect(c.api.stop).toHaveBeenCalledWith(input.request_id); expect(c.controller.snapshot().status?.delivery).toBe("partial");
    expect(c.controller.snapshot().status?.cases).toHaveLength(1);
  });
  it("retains validation identity after a timeout and reload", async () => {
    const c = await prepared(); c.api.start.mockResolvedValue(fixture<RequestStatus>("status-fulfilled")); await c.controller.start();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    c.api.validate.mockRejectedValue(new FactoryError("unavailable", "Synthetic timeout"));
    await c.controller.validate(run.case_id);
    expect(c.api.validation).toHaveBeenCalledWith(input.request_id, run.case_id, run.validation_id);
    const resumed = new FactoryController(c.api, c.storage, c.uuid, undefined, c.lock); await resumed.initialize();
    expect(resumed.snapshot().validation?.validation_id).toBe(run.validation_id); expect(c.api.validate).toHaveBeenCalledTimes(1);
  });
  it.each(["bug_case", "validator"] as const)("does not create validation work for a missing %s download path", async part => {
    for (const path of [null, ""]) {
      const c = await prepared();
      const status = fixture<RequestStatus>("status-fulfilled");
      const item = status.cases[0];
      if (item === undefined) throw new Error("Missing fixture case");
      const originalPath = item.packages[part].download_path;
      item.packages[part].download_path = path; // Deliberately invalid service response.
      c.api.start.mockResolvedValue(status); await c.controller.start();
      const identities = c.uuid.mock.calls.length;
      await c.controller.validate(item.case_id);
      expect(c.api.validate).not.toHaveBeenCalled();
      expect(c.uuid).toHaveBeenCalledTimes(identities);
      expect(c.storage.getItem(VALIDATION_ID_KEY)).toBeNull();
      expect(c.storage.getItem("rbw-factory-validation")).toBeNull();
      expect(c.controller.snapshot().status?.cases).toEqual(status.cases);
      item.packages[part].download_path = originalPath;
      await c.controller.validate(item.case_id);
      expect(c.api.validate).toHaveBeenCalledTimes(1);
    }
  });
  it.each(["budget_unavailable", "invalid_request", "not_found", "busy"])("clears a definitely refused validation after %s without losing delivered cases", async (code) => {
    const c = await prepared();
    const status = fixture<RequestStatus>("status-fulfilled");
    c.api.start.mockResolvedValue(status); c.api.status.mockResolvedValue(status); await c.controller.start();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    c.api.validate.mockRejectedValue(new FactoryError(code, "Synthetic definite refusal", 409, code === "busy" ? { reason: "needs_reconciliation" } : null));
    c.api.validation.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await c.controller.validate(run.case_id);
    expect(c.api.validation).not.toHaveBeenCalled();
    expect(c.storage.getItem("rbw-factory-validation")).toBeNull();
    expect(c.storage.getItem(VALIDATION_ID_KEY)).toBeNull();
    expect(c.controller.snapshot().canRetryValidation).toBe(false);
    expect(c.controller.snapshot().message).toBe(`${code}: Synthetic definite refusal`);
    expect(c.controller.snapshot().status?.cases).toEqual(status.cases);
    await c.controller.retryValidation(); expect(c.api.validate).toHaveBeenCalledTimes(1);
    const resumed = new FactoryController(c.api, c.storage, c.uuid, undefined, c.lock); await resumed.initialize();
    expect(c.api.validation).not.toHaveBeenCalled();
    await resumed.newDraft(); expect(resumed.snapshot().requestId).toBeNull();
    await c.controller.newDraft(); expect(c.controller.snapshot().requestId).toBeNull();
  });
  it.each(["unavailable", "busy"])("retains an uncertain or active-slot %s validation identity when its read is not found", async (code) => {
    const c = await prepared(); c.api.start.mockResolvedValue(fixture<RequestStatus>("status-fulfilled")); await c.controller.start();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    c.api.validate.mockRejectedValue(new FactoryError(code, "Synthetic retryable outcome", code === "busy" ? 409 : 0, code === "busy" ? { reason: "active" } : null));
    c.api.validation.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await c.controller.validate(run.case_id);
    expect(c.storage.getItem("rbw-factory-validation")).toContain(run.validation_id);
    expect(c.controller.snapshot().canRetryValidation).toBe(true);
    await c.controller.retryValidation();
    expect(c.api.validate).toHaveBeenCalledTimes(2);
    expect(c.api.validate.mock.calls[1]).toEqual(c.api.validate.mock.calls[0]);
  });
  it("persists the revision-2 validation ID before POST and restores legacy scoped metadata", async () => {
    const c = await prepared(); c.api.start.mockResolvedValue(fixture<RequestStatus>("status-fulfilled")); c.api.status.mockResolvedValue(fixture<RequestStatus>("status-fulfilled")); await c.controller.start();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    c.api.validate.mockImplementation(() => { expect(c.storage.getItem(VALIDATION_ID_KEY)).toBe(run.validation_id); return Promise.resolve(run); });
    await c.controller.validate(run.case_id);
    c.storage.removeItem(VALIDATION_ID_KEY); // Revision-1 browsers stored the scoped metadata only.
    const resumed = new FactoryController(c.api, c.storage, c.uuid, undefined, c.lock); await resumed.initialize();
    expect(c.storage.getItem(VALIDATION_ID_KEY)).toBe(run.validation_id);
    expect(resumed.snapshot().validation?.validation_id).toBe(run.validation_id);
    expect(c.api.validate).toHaveBeenCalledTimes(1);
  });
  it("does not post when persistence of the revision-2 validation ID fails", async () => {
    const c = setup(); c.api.start.mockResolvedValue(fixture<RequestStatus>("status-fulfilled"));
    let time = 0;
    const controller = new FactoryController(c.api, { ...c.storage, setItem: (key, value) => { if (key === VALIDATION_ID_KEY) throw new Error("Synthetic storage failure"); c.storage.setItem(key, value); } }, c.uuid, () => time, c.lock);
    await controller.initialize(); await controller.interpret(input.input); await controller.start();
    await controller.validate(fixture<ValidationRun>("validation-running").case_id);
    c.api.validation.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await controller.initialize(); time = 60000; await controller.poll(); await controller.retryValidation();
    expect(c.api.validation).not.toHaveBeenCalled();
    expect(c.api.validate).not.toHaveBeenCalled();
  });
  it("does not post a validation after failed persistence, polling and retry", async () => {
    const c = setup(); c.api.start.mockResolvedValue(fixture<RequestStatus>("status-fulfilled")); c.api.status.mockResolvedValue(fixture<RequestStatus>("status-fulfilled"));
    const controller = new FactoryController(c.api, { ...c.storage, setItem: (key, value) => { if (key === "rbw-factory-validation") throw new Error("Synthetic storage failure"); c.storage.setItem(key, value); } }, c.uuid, undefined, c.lock);
    await controller.initialize(); await controller.interpret(input.input); await controller.start();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    c.api.validation.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await controller.validate(run.case_id); await controller.poll(); await controller.retryValidation();
    expect(c.api.validate).not.toHaveBeenCalled(); expect(c.api.validation).not.toHaveBeenCalled();
  });
  it("cannot start unavailable service, unsigned session, or unsupported interpretation", async () => {
    const c = await prepared(); c.controller.invalidateInterpretation(); await c.controller.start(); expect(c.api.start).not.toHaveBeenCalled();
    c.api.interpret.mockResolvedValue(fixture<Interpretation>("interpretation-unsupported")); await c.controller.interpret(input.input); await c.controller.start(); expect(c.api.start).not.toHaveBeenCalled();
    const other = setup(); other.api.session.mockResolvedValue({ contract_version: "bug-request/1", signed_in: false }); await other.controller.initialize(); await other.controller.interpret(input.input); await other.controller.start(); expect(other.api.start).not.toHaveBeenCalled();
  });
});
