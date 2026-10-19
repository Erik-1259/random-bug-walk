import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFactoryClient, FactoryController, FactoryError, REQUEST_KEY } from "../src/factory/client.ts";
import type { Capabilities, FactoryClient, Interpretation, RequestStatus, StartRequest, ValidationRun } from "../src/factory/client.ts";
function fixture<T>(name: string, transform: (value: unknown) => T = value => value as T): T { return transform(JSON.parse(readFileSync(new URL(`./fixtures/factory-v1/${name}.json`, import.meta.url), "utf8"))); }
const input = fixture<StartRequest>("start-request");
function setup() {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  const api = {
    capabilities: vi.fn<FactoryClient["capabilities"]>().mockResolvedValue(fixture<Capabilities>("capabilities")),
    session: vi.fn<FactoryClient["session"]>().mockResolvedValue({ signed_in: true }), signIn: vi.fn<FactoryClient["signIn"]>().mockResolvedValue(undefined),
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
  const controller = new FactoryController(api, storage, uuid, () => time);
  return { memory, storage, api, uuid, controller, advance };
}
async function prepared() { const context = setup(); await context.controller.initialize(); await context.controller.interpret(input.input); return context; }

describe("draft revision 1 transport, synthetic contract fixtures only", () => {
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
  it("persists identity before POST and blocks overlapping starts", async () => {
    const c = await prepared();
    let release: ((status: RequestStatus) => void) | undefined;
    c.api.start.mockImplementation(() => { expect(c.storage.getItem(REQUEST_KEY)).toBe(input.request_id); return new Promise(resolve => { release = resolve; }); });
    const first = c.controller.start(); await c.controller.start();
    expect(c.api.start).toHaveBeenCalledTimes(1); expect(c.uuid).toHaveBeenCalledTimes(1);
    release?.(fixture<RequestStatus>("status-queued")); await first;
    expect(c.controller.snapshot().status?.state).toBe("queued");
  });
  it("does not send a paid start when local storage fails", async () => {
    const c = setup();
    const controller = new FactoryController(c.api, { ...c.storage, setItem: () => { throw new Error("storage unavailable"); } }, c.uuid);
    await controller.initialize(); await controller.interpret(input.input); await controller.start();
    expect(c.api.start).not.toHaveBeenCalled();
  });
  it("reconciles a lost POST response using the same ID and resumes on reload", async () => {
    const c = await prepared(); c.api.start.mockRejectedValue(new FactoryError("unavailable", "Synthetic network failure", 503));
    await c.controller.start();
    expect(c.api.status).toHaveBeenCalledWith(input.request_id, 0);
    const resumed = new FactoryController(c.api, c.storage, c.uuid); await resumed.initialize();
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
    finished.events = Array.from({ length: 200 }, (_, index) => ({ seq: index + 1, at: "2026-10-20T14:03:07.120Z", type: "budget_updated", message: "Synthetic pagination event" }));
    finished.next_after = 200; c.api.start.mockResolvedValue(finished);
    await c.controller.start(); expect(c.controller.needsPoll()).toBe(true);
    c.api.status.mockResolvedValue({ ...finished, events: [], next_after: 200 }); c.advance(); await c.controller.poll();
    expect(c.controller.needsPoll()).toBe(false); expect(c.controller.snapshot().status?.events).toHaveLength(200);
    const run = fixture<ValidationRun>("validation-passed"); c.uuid.mockReturnValue(run.validation_id); c.api.validate.mockResolvedValue(run);
    await c.controller.validate(run.case_id); expect(c.controller.needsPoll()).toBe(true);
    c.advance(); await c.controller.poll(); expect(c.controller.needsPoll()).toBe(false);
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
    const resumed = new FactoryController(c.api, c.storage, c.uuid); await resumed.initialize();
    expect(resumed.snapshot().validation?.validation_id).toBe(run.validation_id); expect(c.api.validate).toHaveBeenCalledTimes(1);
  });
  it.each(["budget_unavailable", "not_ready", "invalid_request", "not_found"])("clears a definitely refused validation after %s without losing delivered cases", async (code) => {
    const c = await prepared();
    const status = fixture<RequestStatus>("status-fulfilled");
    c.api.start.mockResolvedValue(status); c.api.status.mockResolvedValue(status); await c.controller.start();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    c.api.validate.mockRejectedValue(new FactoryError(code, "Synthetic definite refusal", 409));
    c.api.validation.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await c.controller.validate(run.case_id);
    expect(c.api.validation).not.toHaveBeenCalled();
    expect(c.storage.getItem("rbw-factory-validation")).toBeNull();
    expect(c.controller.snapshot().canRetryValidation).toBe(false);
    expect(c.controller.snapshot().message).toBe(`${code}: Synthetic definite refusal`);
    expect(c.controller.snapshot().status?.cases).toEqual(status.cases);
    await c.controller.retryValidation(); expect(c.api.validate).toHaveBeenCalledTimes(1);
    const resumed = new FactoryController(c.api, c.storage, c.uuid); await resumed.initialize();
    expect(c.api.validation).not.toHaveBeenCalled();
    resumed.newDraft(); expect(resumed.snapshot().requestId).toBeNull();
    c.controller.newDraft(); expect(c.controller.snapshot().requestId).toBeNull();
  });
  it("retains an uncertain validation when its reconciliation read is not found", async () => {
    const c = await prepared(); c.api.start.mockResolvedValue(fixture<RequestStatus>("status-fulfilled")); await c.controller.start();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    c.api.validate.mockRejectedValue(new FactoryError("unavailable", "Synthetic timeout"));
    c.api.validation.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await c.controller.validate(run.case_id);
    expect(c.storage.getItem("rbw-factory-validation")).toContain(run.validation_id);
    expect(c.controller.snapshot().canRetryValidation).toBe(true);
    await c.controller.retryValidation();
    expect(c.api.validate).toHaveBeenCalledTimes(2);
    expect(c.api.validate.mock.calls[1]).toEqual(c.api.validate.mock.calls[0]);
  });
  it("does not post a validation after failed persistence, polling and retry", async () => {
    const c = setup(); c.api.start.mockResolvedValue(fixture<RequestStatus>("status-fulfilled")); c.api.status.mockResolvedValue(fixture<RequestStatus>("status-fulfilled"));
    const controller = new FactoryController(c.api, { ...c.storage, setItem: (key, value) => { if (key === "rbw-factory-validation") throw new Error("Synthetic storage failure"); c.storage.setItem(key, value); } }, c.uuid);
    await controller.initialize(); await controller.interpret(input.input); await controller.start();
    const run = fixture<ValidationRun>("validation-running"); c.uuid.mockReturnValue(run.validation_id);
    c.api.validation.mockRejectedValue(new FactoryError("not_found", "Synthetic not recorded", 404));
    await controller.validate(run.case_id); await controller.poll(); await controller.retryValidation();
    expect(c.api.validate).not.toHaveBeenCalled(); expect(c.api.validation).not.toHaveBeenCalled();
  });
  it("cannot start unavailable service, unsigned session, or unsupported interpretation", async () => {
    const c = await prepared(); c.controller.invalidateInterpretation(); await c.controller.start(); expect(c.api.start).not.toHaveBeenCalled();
    c.api.interpret.mockResolvedValue(fixture<Interpretation>("interpretation-unsupported")); await c.controller.interpret(input.input); await c.controller.start(); expect(c.api.start).not.toHaveBeenCalled();
    const other = setup(); other.api.session.mockResolvedValue({ signed_in: false }); await other.controller.initialize(); await other.controller.interpret(input.input); await other.controller.start(); expect(other.api.start).not.toHaveBeenCalled();
  });
});
