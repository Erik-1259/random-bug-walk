import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarWindowMs, createOtfClient, formatUtcDate, nextCalendarOpen, OtfClientError, OtfController, browserOtfIdentityLock, type OtfClient, type OtfIdentityLock } from "../../src/otf/client.ts";
import { specSha256 } from "../../src/otf/canonical.ts";
import { OTF_ERROR_STATUS, hostCalendarOpen, type OtfAvailability, type OtfCreateJob, type OtfJobStatus, type OtfValidation } from "../../src/otf/contract.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const KEY = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const T = "2026-10-29T10:00:00.000Z";
const input = {
  host_id: "task-report" as const,
  criterion_id: "concurrency.lost-acknowledged-change" as const,
  sentence: "Synthetic overlapping edits lose a saved change.",
  spec: { title: "Synthetic lost edit", where: "The edit handler.", change: "Overlapping edits overwrite a saved change.", why_tests_miss: "The suite edits in sequence.", checks_to_add: ["Both saved changes remain."], fix: "Serialize writes." },
};
const availability: OtfAvailability = {
  enabled: true, builder: "stopped", active_jobs: 0, queued_jobs: 0, max_queued: 4,
  behaviors: [{ criterion_id: input.criterion_id, host_id: "task-report", label: "Synthetic lost change", example_phrases: ["An edit disappears."], measured: true }],
  hosts: [
    { host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], deadline_min: 45, typical: null },
    { host_id: "umami", label: "Umami", offered: false, unavailable_reason: "calendar", active_jobs: 0, queued_jobs: 0, max_active: 1, lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], deadline_min: 60, typical: null },
  ],
  cold_start_min: null, spend_left_microusd: 8_000_000,
};
const validation: OtfValidation = { validation_id: OTHER, state: "queued", cells: null, admission: null, started_at: T, finished_at: null, where: "RBW builder (Nebius VM)" };
async function request(): Promise<OtfCreateJob> { return { ...structuredClone(input), client_key: KEY, spec_sha256: await specSha256(input.spec) }; }
async function status(change: Partial<OtfJobStatus> = {}): Promise<OtfJobStatus> {
  return {
    job_id: JOB, created_at: T, state: "queued", host_id: "task-report", queue_position: 1, builder: "running", outcome: null, reason: null,
    criterion_id: input.criterion_id, spec: structuredClone(input.spec), spec_sha256: await specSha256(input.spec), deadline_at: null,
    elapsed_ms: 0, lanes: [], events: [{ seq: 1, at: T, type: "job_queued", lane_id: null, data: { position: 1 } }], next_after: 1,
    poll_after_ms: 2000, spend: { model_microusd: 0, cap_microusd: 8_000_000, source: "builder proxy meter (upper bound)" },
    winner: null, artifacts: [], certificate: null, validation: null, catalog_request_id: null, ...change,
  };
}
async function setup() {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  let queue = Promise.resolve();
  const lock: OtfIdentityLock = operation => {
    const next = queue.then(operation);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const api = {
    availability: vi.fn<OtfClient["availability"]>().mockResolvedValue(availability),
    create: vi.fn<OtfClient["create"]>().mockResolvedValue({ job_id: JOB, status: await status() }),
    status: vi.fn<OtfClient["status"]>().mockResolvedValue(await status({ events: [], next_after: 1 })),
    stop: vi.fn<OtfClient["stop"]>().mockResolvedValue(await status()),
    validate: vi.fn<OtfClient["validate"]>().mockResolvedValue(validation),
  };
  const uuid = vi.fn(() => KEY);
  const controller = new OtfController(api, storage, uuid, lock);
  await controller.initialize();
  return { memory, storage, lock, api, uuid, controller };
}
function serveStatus(api: Awaited<ReturnType<typeof setup>>["api"], value: OtfJobStatus): void {
  api.status.mockImplementation((_id, after = 0) => Promise.resolve({ ...value, events: value.events.filter(event => event.seq > after) }));
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("OTF HTTP client", () => {
  it("uses only customer endpoints and exact bodies with same-origin credentials", async () => {
    const body = await request(); const state = await status();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(availability))
      .mockResolvedValueOnce(Response.json({ job_id: JOB, status: state }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ ...state, events: [], next_after: 1 }))
      .mockResolvedValueOnce(Response.json(state, { status: 202 }))
      .mockResolvedValueOnce(Response.json(validation, { status: 201 }));
    const client = createOtfClient(fetcher);
    await client.availability(); await client.create(body); await client.status(JOB, 1); await client.stop(JOB); await client.validate(JOB);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/factory/otf/availability", "/api/factory/otf/jobs", `/api/factory/otf/jobs/${JOB}?after=1`, `/api/factory/otf/jobs/${JOB}/stop`, `/api/factory/otf/jobs/${JOB}/validations`]);
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "POST", "GET", "POST", "POST"]);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(body));
    expect(fetcher.mock.calls[3]?.[1]?.body).toBeUndefined();
    expect(fetcher.mock.calls[4]?.[1]?.body).toBeUndefined();
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });
  it("accepts create and validation replays with HTTP 200", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ job_id: JOB, status: await status() })).mockResolvedValueOnce(Response.json(validation));
    const client = createOtfClient(fetcher);
    expect((await client.create(await request())).job_id).toBe(JOB);
    expect(await client.validate(JOB)).toEqual(validation);
  });
  it.each(["busy", "daily_cap", "spend_cap", "refused_topic", "invalid_spec", "idempotency_conflict", "signed_out", "host_unavailable", "unavailable"] as const)("preserves the validated %s refusal", async code => {
    const client = createOtfClient(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ contract_version: "otf/0", error: { code, message: "Synthetic refusal.", retryable: false } }, { status: OTF_ERROR_STATUS[code] })));
    await expect(client.create(await request())).rejects.toMatchObject({ code, status: OTF_ERROR_STATUS[code], retryable: false });
  });
  it.each(["html", "unknown-code", "wrong-error-status", "wrong-success-status", "malformed-body"])("rejects %s instead of inventing success", async kind => {
    const responses: Record<string, Response> = {
      html: new Response("<html>Unavailable</html>", { status: 503 }),
      "unknown-code": Response.json({ contract_version: "otf/0", error: { code: "synthetic-unknown", message: "Synthetic.", retryable: false } }, { status: 409 }),
      "wrong-error-status": Response.json({ contract_version: "otf/0", error: { code: "busy", message: "Synthetic.", retryable: false } }, { status: 422 }),
      "wrong-success-status": Response.json(availability, { status: 201 }),
      "malformed-body": Response.json({ ...availability, enabled: "yes" }),
    };
    const response = responses[kind]; if (response === undefined) throw new Error("Missing synthetic response.");
    await expect(createOtfClient(vi.fn<typeof fetch>().mockResolvedValue(response)).availability()).rejects.toMatchObject({ code: "unavailable" });
  });
  it("rejects a create response whose envelope and status name different jobs", async () => {
    const client = createOtfClient(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ job_id: OTHER, status: await status() }, { status: 201 })));
    await expect(client.create(await request())).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each(["status", "stop"] as const)("rejects wrong-job %s responses", async method => {
    const client = createOtfClient(vi.fn<typeof fetch>().mockResolvedValue(Response.json(await status({ job_id: OTHER }), { status: method === "stop" ? 202 : 200 })));
    await expect(client[method](JOB)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("does not POST an invalid spec or mismatched hash", async () => {
    const fetcher = vi.fn<typeof fetch>(); const client = createOtfClient(fetcher);
    await expect(client.create({ ...await request(), spec_sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "invalid_spec" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("times out a stalled fetch with an unavailable error", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_path, options) => new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => { reject(new Error("Synthetic abort.")); }); }));
    const pending = createOtfClient(fetcher, 25).availability();
    const assertion = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(25); await assertion;
  });
});

describe("OTF persisted controller", () => {
  it("reads availability without creating work or writing factory storage", async () => {
    const c = await setup();
    expect(c.controller.snapshot()).toMatchObject({ availability, status: null, busy: false, message: null, jobId: null, canRetryCreate: false });
    expect(c.api.create).not.toHaveBeenCalled(); expect(c.memory.size).toBe(0);
  });
  it("hashes and persists the exact accepted request before POST", async () => {
    const c = await setup();
    c.api.create.mockImplementation(async body => {
      const stored: unknown = JSON.parse(c.storage.getItem("rbw.otf.job") ?? "null");
      expect(stored).toMatchObject({ request: body });
      expect(body).toEqual(await request());
      return { job_id: JOB, status: await status() };
    });
    await c.controller.create(input);
    expect(c.controller.snapshot().status?.job_id).toBe(JOB);
    const stored: unknown = JSON.parse(c.storage.getItem("rbw.otf.job") ?? "null");
    expect(stored).toMatchObject({ job_id: JOB });
    expect([...c.memory.keys()]).toEqual(["rbw.otf.job"]);
  });
  it("retains the body and key after an ambiguous create and retries exactly those bytes", async () => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new Error("Synthetic lost response."));
    await c.controller.create(input);
    expect(c.controller.snapshot()).toMatchObject({ status: null, canRetryCreate: true });
    const saved = c.storage.getItem("rbw.otf.job");
    await c.controller.newDraft(); expect(c.storage.getItem("rbw.otf.job")).toBe(saved);
    await c.controller.retryCreate();
    expect(c.api.create.mock.calls[1]?.[0]).toEqual(c.api.create.mock.calls[0]?.[0]); expect(c.uuid).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid_spec", "refused_topic", "busy"] as const)("permits an explicit edit after a definite first %s refusal", async code => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new OtfClientError(code, "Synthetic refusal.", OTF_ERROR_STATUS[code]));
    await c.controller.create(input); expect(c.controller.snapshot().canNewDraft).toBe(true);
    await c.controller.newDraft(); expect(c.controller.snapshot().pendingRequest).toBeNull();
    c.uuid.mockReturnValueOnce(OTHER); await c.controller.create({ ...input, sentence: "Synthetic edited sentence about saved changes." });
    expect(c.api.create.mock.calls[1]?.[0]).toMatchObject({ client_key: OTHER, sentence: "Synthetic edited sentence about saved changes." });
  });
  it("never treats a later refusal as proof that an earlier ambiguous create did not record a job", async () => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new Error("Synthetic lost response.")).mockRejectedValueOnce(new OtfClientError("invalid_spec", "Synthetic changed availability.", 422));
    await c.controller.create(input); await c.controller.retryCreate(); const saved = c.storage.getItem("rbw.otf.job");
    expect(c.controller.snapshot().canNewDraft).toBe(false); await c.controller.newDraft(); expect(c.storage.getItem("rbw.otf.job")).toBe(saved);
  });
  it("clears a prior definite-refusal marker before retrying so a lost replay cannot be discarded", async () => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new OtfClientError("busy", "Synthetic refusal.", 409)).mockRejectedValueOnce(new Error("Synthetic lost response."));
    await c.controller.create(input); await c.controller.retryCreate();
    expect(c.controller.snapshot().canNewDraft).toBe(false);
    c.api.create.mockRejectedValue(new OtfClientError("invalid_spec", "Synthetic changed availability.", 422));
    const reloaded = new OtfController(c.api, c.storage, c.uuid, c.lock); await reloaded.initialize();
    expect(reloaded.snapshot().canNewDraft).toBe(false); expect(reloaded.snapshot().canRetryCreate).toBe(true);
  });
  it("replays an ambiguous saved create on reload without generating another key", async () => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new Error("Synthetic lost response.")); await c.controller.create(input);
    const reloaded = new OtfController(c.api, c.storage, c.uuid, c.lock); await reloaded.initialize();
    expect(reloaded.snapshot().jobId).toBe(JOB); expect(c.uuid).toHaveBeenCalledTimes(1);
    expect(c.api.create.mock.calls[1]?.[0]).toEqual(c.api.create.mock.calls[0]?.[0]);
  });
  it("reads an accepted job on reload without repeating create", async () => {
    const c = await setup(); await c.controller.create(input); c.api.status.mockResolvedValue(await status());
    const reloaded = new OtfController(c.api, c.storage, c.uuid, c.lock); await reloaded.initialize();
    expect(c.api.create).toHaveBeenCalledTimes(1); expect(c.api.status).toHaveBeenCalledWith(JOB, 0); expect(reloaded.snapshot().jobId).toBe(JOB);
  });
  it("serializes two tabs and adopts the first saved request rather than replacing it", async () => {
    const c = await setup(); c.api.status.mockResolvedValue(await status());
    const other = new OtfController(c.api, c.storage, c.uuid, c.lock); await other.initialize();
    await Promise.all([c.controller.create(input), other.create({ ...input, sentence: "Synthetic different accepted sentence." })]);
    expect(c.api.create).toHaveBeenCalledTimes(1); expect(c.uuid).toHaveBeenCalledTimes(1); expect(other.snapshot().jobId).toBe(JOB);
  });
  it("never sends create when persistence fails", async () => {
    const c = await setup(); const blocked = new OtfController(c.api, { ...c.storage, setItem() { throw new Error("Synthetic quota."); } }, c.uuid, c.lock);
    await blocked.initialize(); await blocked.create(input);
    expect(c.api.create).not.toHaveBeenCalled(); expect(blocked.snapshot().message).not.toBeNull();
  });
  it("preserves malformed saved identity and refuses replacement work", async () => {
    const c = await setup(); c.memory.set("rbw.otf.job", "{");
    await c.controller.create(input);
    expect(c.api.create).not.toHaveBeenCalled(); expect(c.storage.getItem("rbw.otf.job")).toBe("{");
  });
  it("fails closed when Web Locks is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(browserOtfIdentityLock(() => Promise.resolve())).rejects.toBeInstanceOf(OtfClientError);
  });
  it("uses a distinct OTF lock name", async () => {
    const requestLock = vi.fn(async (_name: string, _options: unknown, operation: () => Promise<void>) => operation());
    vi.stubGlobal("navigator", { locks: { request: requestLock } }); await browserOtfIdentityLock(() => Promise.resolve());
    expect(requestLock.mock.calls[0]?.[0]).toBe("rbw.otf.job.lock");
  });
  it.each(["spec", "criterion", "hash", "catalog"])("retains pending identity on mismatched accepted %s", async mismatch => {
    const c = await setup(); const changed = await status();
    if (mismatch === "spec") changed.spec = { ...changed.spec, fix: "Synthetic different fix." };
    if (mismatch === "criterion") changed.criterion_id = "concurrency.stale-success-response";
    if (mismatch === "hash") changed.spec_sha256 = "0".repeat(64);
    if (mismatch === "catalog") changed.catalog_request_id = OTHER;
    c.api.create.mockResolvedValue({ job_id: JOB, status: changed }); await c.controller.create(input);
    expect(c.controller.snapshot()).toMatchObject({ status: null, canRetryCreate: true });
  });
  it("merges event pages and respects the two-second running interval", async () => {
    vi.useFakeTimers(); const c = await setup(); await c.controller.create(input);
    c.api.status.mockResolvedValue(await status({ events: [{ seq: 2, at: T, type: "job_claimed", lane_id: null, data: { builder_revision: "synthetic-revision" } }], next_after: 2, state: "building", queue_position: null }));
    await c.controller.poll(); expect(c.api.status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); await c.controller.poll();
    expect(c.api.status).toHaveBeenCalledWith(JOB, 1); expect(c.controller.snapshot().status?.events.map(event => event.seq)).toEqual([1, 2]);
  });
  it("rejects a gapped status page without discarding prior events", async () => {
    vi.useFakeTimers(); const c = await setup(); await c.controller.create(input);
    c.api.status.mockResolvedValue(await status({ events: [{ seq: 3, at: T, type: "job_claimed", lane_id: null, data: { builder_revision: "synthetic-revision" } }], next_after: 3 }));
    await vi.advanceTimersByTimeAsync(2000); await c.controller.poll();
    expect(c.controller.snapshot().status?.next_after).toBe(1); expect(c.controller.snapshot().message).not.toBeNull();
  });
  it("keeps finished jobs polling at thirty seconds for later validation updates", async () => {
    vi.useFakeTimers(); const c = await setup(); c.api.create.mockResolvedValue({ job_id: JOB, status: await status({ state: "finished", outcome: "not_qualified", poll_after_ms: 500 }) });
    await c.controller.create(input);
    expect(c.controller.needsPoll()).toBe(true); expect(c.controller.pollAfter()).toBe(30000);
    await vi.advanceTimersByTimeAsync(29999); await c.controller.poll(); expect(c.api.status).not.toHaveBeenCalled();
  });
  it("does not discard an unfinished job for a new draft", async () => {
    const c = await setup(); await c.controller.create(input); const stored = c.storage.getItem("rbw.otf.job"); await c.controller.newDraft();
    expect(c.storage.getItem("rbw.otf.job")).toBe(stored); expect(c.controller.snapshot().jobId).toBe(JOB);
  });
  it("clears only OTF storage after a finished job is explicitly dismissed", async () => {
    const c = await setup(); c.memory.set("rbw-factory-request-id", OTHER);
    c.api.create.mockResolvedValue({ job_id: JOB, status: await status({ state: "finished", outcome: "cancelled" }) });
    serveStatus(c.api, await status({ state: "finished", outcome: "cancelled" }));
    await c.controller.create(input); await c.controller.newDraft();
    expect(c.controller.snapshot().jobId).toBeNull(); expect(c.storage.getItem("rbw.otf.job")).toBeNull(); expect(c.storage.getItem("rbw-factory-request-id")).toBe(OTHER);
  });
  it("observes validation through status and never presents queued as passed", async () => {
    vi.useFakeTimers(); const c = await setup(); c.api.create.mockResolvedValue({ job_id: JOB, status: await status({ state: "finished", outcome: "delivered", poll_after_ms: 30000 }) });
    serveStatus(c.api, await status({ state: "finished", outcome: "delivered" }));
    await c.controller.create(input); await c.controller.validate();
    expect(c.api.validate).toHaveBeenCalledWith(JOB); expect(c.controller.snapshot().status?.validation?.state).toBe("queued");
    serveStatus(c.api, await status({ state: "finished", outcome: "delivered", validation }));
    await c.controller.newDraft(); expect(c.controller.snapshot().jobId).toBe(JOB);
    c.api.status.mockResolvedValue(await status({ state: "finished", outcome: "delivered", events: [], validation: { ...validation, state: "error", finished_at: T } }));
    await vi.advanceTimersByTimeAsync(30000); await c.controller.poll(); expect(c.controller.snapshot().status?.validation?.state).toBe("error");
  });
  it("does not automatically repeat validation after a lost response, including reload; only an explicit click sends it again", async () => {
    const c = await setup(); c.api.create.mockResolvedValue({ job_id: JOB, status: await status({ state: "finished", outcome: "delivered" }) });
    serveStatus(c.api, await status({ state: "finished", outcome: "delivered" }));
    c.api.validate.mockRejectedValue(new Error("Synthetic lost validation response.")); await c.controller.create(input); await c.controller.validate();
    const reloaded = new OtfController(c.api, c.storage, c.uuid, c.lock); await reloaded.initialize(); await reloaded.newDraft();
    expect(c.api.validate).toHaveBeenCalledTimes(1); expect(reloaded.snapshot()).toMatchObject({ jobId: JOB, validationPending: true, busy: false, canNewDraft: false });
    c.api.validate.mockResolvedValueOnce(validation); await reloaded.validate();
    expect(c.api.validate).toHaveBeenCalledTimes(2); expect(reloaded.snapshot()).toMatchObject({ validationPending: false });
    expect(reloaded.snapshot().status?.validation?.state).toBe("queued");
  });
  it("drops the saved marker of an unanswered validation when the explicit retry is refused", async () => {
    const c = await setup(); const finished = await status({ state: "finished", outcome: "delivered" });
    c.api.create.mockResolvedValue({ job_id: JOB, status: finished }); serveStatus(c.api, finished);
    c.api.validate.mockRejectedValueOnce(new Error("Synthetic lost validation response.")); await c.controller.create(input); await c.controller.validate();
    c.api.validate.mockRejectedValueOnce(new OtfClientError("host_unavailable", "Synthetic host refusal.", 409)); await c.controller.validate();
    expect(c.api.validate).toHaveBeenCalledTimes(2);
    const reloaded = new OtfController(c.api, c.storage, c.uuid, c.lock); await reloaded.initialize();
    expect(reloaded.snapshot()).toMatchObject({ validationPending: false, canNewDraft: true });
    await reloaded.newDraft(); expect(reloaded.snapshot().jobId).toBeNull(); expect(c.storage.getItem("rbw.otf.job")).toBeNull();
  });
  it("adopts a validation that an unanswered POST created instead of sending another", async () => {
    const c = await setup(); const finished = await status({ state: "finished", outcome: "delivered" });
    c.api.create.mockResolvedValue({ job_id: JOB, status: finished }); serveStatus(c.api, finished);
    c.api.validate.mockRejectedValueOnce(new Error("Synthetic lost validation response.")); await c.controller.create(input); await c.controller.validate();
    expect(c.controller.snapshot().validationPending).toBe(true);
    c.api.status.mockResolvedValue({ ...finished, events: [], validation: { ...validation, state: "passed", finished_at: T } });
    await c.controller.validate();
    expect(c.api.validate).toHaveBeenCalledTimes(1);
    expect(c.controller.snapshot()).toMatchObject({ validationPending: false, canNewDraft: true }); expect(c.controller.snapshot().status?.validation?.state).toBe("passed");
  });
  it("retains a local catalog association without changing the immutable replay body", async () => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new Error("Synthetic lost response.")); await c.controller.create(input);
    const body = c.api.create.mock.calls[0]?.[0]; await c.controller.setCatalogRequestId(OTHER); await c.controller.retryCreate();
    expect(c.api.create.mock.calls[1]?.[0]).toEqual(body); expect(body?.catalog_request_id).toBeUndefined();
    c.api.status.mockResolvedValue(await status()); const reloaded = new OtfController(c.api, c.storage, c.uuid, c.lock); await reloaded.initialize();
    expect(reloaded.snapshot().catalogRequestId).toBe(OTHER);
  });
  it("notifies external-store subscribers and supports unsubscribe", async () => {
    const c = await setup(); const listener = vi.fn(); const unsubscribe = c.controller.subscribe(listener);
    const before = c.controller.snapshot(); await c.controller.create(input); expect(listener).toHaveBeenCalled(); expect(c.controller.snapshot()).not.toBe(before);
    unsubscribe(); listener.mockClear(); await c.controller.newDraft(); expect(listener).not.toHaveBeenCalled();
  });
  it("saves a catalog association arriving while create is still in flight", async () => {
    const c = await setup(); const pending = Promise.withResolvers<Awaited<ReturnType<OtfClient["create"]>>>();
    c.api.create.mockReturnValueOnce(pending.promise);
    const creating = c.controller.create(input); await vi.waitFor(() => { expect(c.api.create).toHaveBeenCalledTimes(1); });
    const associating = c.controller.setCatalogRequestId(OTHER); pending.resolve({ job_id: JOB, status: await status() });
    await Promise.all([creating, associating]);
    expect(c.controller.snapshot().catalogRequestId).toBe(OTHER);
    expect(c.api.create.mock.calls[0]?.[0].catalog_request_id).toBeUndefined();
  });
  it("does not create a second validation from a stale tab after the first already completed", async () => {
    const c = await setup(); const finished = await status({ state: "finished", outcome: "delivered" });
    c.api.create.mockResolvedValue({ job_id: JOB, status: finished }); serveStatus(c.api, finished); await c.controller.create(input);
    const other = new OtfController(c.api, c.storage, c.uuid, c.lock); await other.initialize();
    await c.controller.validate();
    serveStatus(c.api, { ...finished, validation: { ...validation, state: "passed", finished_at: T } });
    await other.validate();
    expect(c.api.validate).toHaveBeenCalledTimes(1); expect(other.snapshot().status?.validation?.state).toBe("passed");
  });
  it("does not discard a job while another tab has started validation", async () => {
    const c = await setup(); const finished = await status({ state: "finished", outcome: "delivered" });
    c.api.create.mockResolvedValue({ job_id: JOB, status: finished }); serveStatus(c.api, finished); await c.controller.create(input);
    const other = new OtfController(c.api, c.storage, c.uuid, c.lock); await other.initialize();
    await c.controller.validate(); serveStatus(c.api, { ...finished, validation }); await other.newDraft();
    expect(other.snapshot().jobId).toBe(JOB); expect(c.storage.getItem("rbw.otf.job")).not.toBeNull();
  });
  it("allows a fresh explicit validation after a definite signed-out refusal", async () => {
    const c = await setup(); const finished = await status({ state: "finished", outcome: "delivered" });
    c.api.create.mockResolvedValue({ job_id: JOB, status: finished }); serveStatus(c.api, finished); await c.controller.create(input);
    c.api.validate.mockRejectedValueOnce(new OtfClientError("signed_out", "Sign in again.", 401));
    await c.controller.validate(); expect(c.controller.snapshot().validationPending).toBe(false);
    await c.controller.validate(); expect(c.api.validate).toHaveBeenCalledTimes(2);
  });
  it("clears pending validation after a host_unavailable refusal, across reload, and sends again only on a new click", async () => {
    const c = await setup(); const finished = await status({ state: "finished", outcome: "delivered" });
    c.api.create.mockResolvedValue({ job_id: JOB, status: finished }); serveStatus(c.api, finished); await c.controller.create(input);
    const closed: OtfAvailability = { ...availability, hosts: availability.hosts.map(host => ({ ...host, offered: false, unavailable_reason: host.host_id === "umami" ? "calendar" : "disabled" })) };
    c.api.availability.mockResolvedValue(closed); const reads = c.api.availability.mock.calls.length;
    c.api.validate.mockRejectedValueOnce(new OtfClientError("host_unavailable", "Synthetic host refusal.", 409));
    await c.controller.validate();
    expect(c.api.availability.mock.calls.length).toBe(reads + 1);
    expect(c.controller.snapshot()).toMatchObject({ validationPending: false, validationRefused: true, message: null, availability: closed, busy: false, canNewDraft: true });
    const reloaded = new OtfController(c.api, c.storage, c.uuid, c.lock); await reloaded.initialize();
    expect(reloaded.snapshot()).toMatchObject({ validationPending: false, canNewDraft: true }); expect(c.api.validate).toHaveBeenCalledTimes(1);
    c.api.availability.mockResolvedValue(availability); await reloaded.validate();
    expect(c.api.validate).toHaveBeenCalledTimes(2); expect(reloaded.snapshot()).toMatchObject({ validationRefused: false, validationPending: false });
    expect(reloaded.snapshot().status?.validation?.state).toBe("queued");
  });
  it("keeps a known job pollable when its create response has an invalid event cursor", async () => {
    const c = await setup(); c.api.create.mockResolvedValue({ job_id: JOB, status: await status({ next_after: 2 }) }); await c.controller.create(input);
    expect(c.controller.snapshot().jobId).toBe(JOB); expect(c.controller.needsPoll()).toBe(true); expect(c.controller.snapshot().status).toBeNull();
  });
  it("keeps a Stop click through an in-flight poll and applies the newer response last", async () => {
    vi.useFakeTimers(); const c = await setup(); await c.controller.create(input); await vi.advanceTimersByTimeAsync(2000);
    const pending = Promise.withResolvers<OtfJobStatus>(); c.api.status.mockReturnValueOnce(pending.promise);
    const polling = c.controller.poll(); await vi.waitFor(() => { expect(c.api.status).toHaveBeenCalledTimes(1); });
    const stopping = c.controller.stop(); const finished = await status({ state: "finished", outcome: "cancelled" }); c.api.stop.mockResolvedValue(finished);
    pending.resolve(await status({ events: [], next_after: 1 })); await Promise.all([polling, stopping]);
    expect(c.api.stop).toHaveBeenCalledWith(JOB); expect(c.controller.snapshot().status?.state).toBe("finished");
  });
});

describe("OTF review fixes and host refusals", () => {
  it.each(["unavailable", "network"] as const)("hides OTF on a failed %s availability read without an alert", async mode => {
    const c = await setup();
    if (mode === "unavailable") c.api.availability.mockRejectedValue(new OtfClientError("unavailable", "Synthetic unconfigured.", 503));
    else c.api.availability.mockRejectedValue(new Error("Synthetic network failure."));
    await c.controller.initialize();
    expect(c.controller.snapshot()).toMatchObject({ availability: null, message: null });
  });
  it("clears earlier availability when a refresh fails", async () => {
    const c = await setup(); expect(c.controller.snapshot().availability).toEqual(availability);
    c.api.availability.mockRejectedValue(new OtfClientError("unavailable", "Synthetic hold.", 503));
    await c.controller.initialize(); expect(c.controller.snapshot().availability).toBeNull();
  });
  it.each(["busy", "daily_cap", "spend_cap", "host_unavailable"] as const)("never re-sends a definite %s refusal on reload, refresh or sign-in change", async code => {
    const c = await setup(); c.api.create.mockRejectedValue(new OtfClientError(code, "Synthetic refusal.", OTF_ERROR_STATUS[code]));
    await c.controller.create(input); expect(c.api.create).toHaveBeenCalledTimes(1);
    await c.controller.initialize();
    const reloaded = new OtfController(c.api, c.storage, c.uuid, c.lock); await reloaded.initialize(); await reloaded.initialize();
    expect(c.api.create).toHaveBeenCalledTimes(1);
    expect(reloaded.snapshot()).toMatchObject({ canRetryCreate: true, canNewDraft: true, jobId: null });
  });
  it("lets only the explicit retry send a refused create again", async () => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new OtfClientError("busy", "Synthetic refusal.", 409));
    await c.controller.create(input); await c.controller.retryCreate();
    expect(c.api.create).toHaveBeenCalledTimes(2); expect(c.api.create.mock.calls[1]?.[0]).toEqual(c.api.create.mock.calls[0]?.[0]);
    expect(c.controller.snapshot().jobId).toBe(JOB);
  });
  it("does not send a refused create from another tab's accept click", async () => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new OtfClientError("daily_cap", "Synthetic refusal.", 409));
    await c.controller.create(input);
    const other = new OtfController(c.api, c.storage, c.uuid, c.lock); await other.initialize();
    await other.create({ ...input, sentence: "Synthetic sentence from another tab." });
    expect(c.api.create).toHaveBeenCalledTimes(1); expect(c.uuid).toHaveBeenCalledTimes(1);
  });
  it("treats host_unavailable as a refusal, refreshes availability and keeps the accepted request", async () => {
    const c = await setup(); c.api.create.mockRejectedValueOnce(new OtfClientError("host_unavailable", "Synthetic host refusal.", 409));
    const closed: OtfAvailability = { ...availability, behaviors: [], hosts: availability.hosts.map(host => ({ ...host, offered: false, unavailable_reason: host.host_id === "umami" ? "calendar" : "disabled" })) };
    c.api.availability.mockResolvedValue(closed);
    await c.controller.create(input);
    expect(c.api.availability).toHaveBeenCalledTimes(2);
    expect(c.controller.snapshot()).toMatchObject({ refusal: "host_unavailable", message: null, availability: closed, canNewDraft: true, canRetryCreate: true, pendingRequest: await request() });
  });
  it("calls the sign-out hook on a signed_out answer", async () => {
    const c = await setup(); const signedOut = vi.fn(); c.controller.onSignedOut = signedOut;
    await c.controller.create(input); c.api.status.mockRejectedValue(new OtfClientError("signed_out", "Sign in again.", 401));
    await c.controller.initialize(); expect(signedOut).toHaveBeenCalledTimes(1);
    c.api.status.mockRejectedValue(new OtfClientError("unavailable", "Synthetic.", 503)); await c.controller.initialize(); expect(signedOut).toHaveBeenCalledTimes(1);
  });
  it("polls without the shared busy flag so Stop stays clickable", async () => {
    vi.useFakeTimers(); const c = await setup(); await c.controller.create(input); await vi.advanceTimersByTimeAsync(2000);
    const pending = Promise.withResolvers<OtfJobStatus>(); c.api.status.mockReturnValueOnce(pending.promise);
    const polling = c.controller.poll(); await vi.waitFor(() => { expect(c.api.status).toHaveBeenCalledTimes(1); });
    expect(c.controller.snapshot()).toMatchObject({ busy: false, polling: true });
    await c.controller.poll(); expect(c.api.status).toHaveBeenCalledTimes(1);
    pending.resolve(await status({ events: [], next_after: 1 })); await polling;
    expect(c.controller.snapshot()).toMatchObject({ busy: false, polling: false });
  });
  it("does not stop a replacement job that another tab saved after this tab showed the earlier one", async () => {
    const c = await setup(); await c.controller.create(input); serveStatus(c.api, await status());
    const stale = new OtfController(c.api, c.storage, c.uuid, c.lock); await stale.initialize();
    expect(stale.snapshot()).toMatchObject({ jobId: JOB, status: { state: "queued" } });
    const done = await status({ state: "finished", outcome: "cancelled" }); const next = await status({ job_id: OTHER });
    c.api.status.mockImplementation((id, after = 0) => { const value = id === JOB ? done : next; return Promise.resolve({ ...value, events: value.events.filter(event => event.seq > after) }); });
    await c.controller.initialize(); await c.controller.newDraft();
    c.uuid.mockReturnValue("00000000-0000-4000-8000-000000000004"); c.api.create.mockResolvedValue({ job_id: OTHER, status: await status({ job_id: OTHER }) });
    await c.controller.create(input); expect(c.controller.snapshot().jobId).toBe(OTHER);
    await stale.stop();
    expect(c.api.stop).not.toHaveBeenCalled();
    expect(stale.snapshot()).toMatchObject({ jobId: OTHER, stopRequested: false, status: { job_id: OTHER, state: "queued" } });
  });
  it("does not stop a replacement job that an awaited poll adopts after the click", async () => {
    vi.useFakeTimers(); const c = await setup(); await c.controller.create(input); serveStatus(c.api, await status());
    const stale = new OtfController(c.api, c.storage, c.uuid, c.lock); await stale.initialize();
    const done = await status({ state: "finished", outcome: "cancelled" }); const next = await status({ job_id: OTHER });
    c.api.status.mockImplementation((id, after = 0) => { const value = id === JOB ? done : next; return Promise.resolve({ ...value, events: value.events.filter(event => event.seq > after) }); });
    await c.controller.initialize(); await c.controller.newDraft();
    c.uuid.mockReturnValue("00000000-0000-4000-8000-000000000004"); c.api.create.mockResolvedValue({ job_id: OTHER, status: await status({ job_id: OTHER }) });
    await c.controller.create(input); await vi.advanceTimersByTimeAsync(2000);
    expect(stale.snapshot()).toMatchObject({ jobId: JOB, status: { job_id: JOB, state: "queued" } });
    const polling = stale.poll(); const stopping = stale.stop(); await Promise.all([polling, stopping]);
    expect(c.api.stop).not.toHaveBeenCalled();
    expect(stale.snapshot()).toMatchObject({ jobId: OTHER, stopRequested: false, status: { job_id: OTHER } });
  });
  it("records a stop sent from this tab", async () => {
    const c = await setup(); await c.controller.create(input); c.api.stop.mockResolvedValue(await status({ state: "finished", outcome: "delivered" }));
    expect(c.controller.snapshot().stopRequested).toBe(false); await c.controller.stop();
    expect(c.controller.snapshot()).toMatchObject({ stopRequested: true, status: { outcome: "delivered" } });
  });
});

describe("Umami calendar hint", () => {
  const windowMs = calendarWindowMs(60);
  const NOV_6 = Date.UTC(2026, 10, 6);
  it("adds the start timeout and margin to the host deadline", () => { expect(windowMs).toBe((8 + 60 + 15) * 60_000); });
  it.each([["Nov 1 23:00Z", Date.UTC(2026, 10, 1, 23)], ["Nov 3 12:00Z", Date.UTC(2026, 10, 3, 12)], ["Nov 5 23:59Z", Date.UTC(2026, 10, 5, 23, 59)], ["Nov 6 00:00Z", NOV_6]])("opens again on Nov 6 00:00Z from %s", (_label, now) => {
    expect(nextCalendarOpen("umami", now, windowMs)).toBe(NOV_6);
    expect(formatUtcDate(NOV_6)).toBe("November 6");
  });
  it("agrees with the contract's calendar on either side of the open time", () => {
    expect(hostCalendarOpen("umami", Date.UTC(2026, 10, 1, 23), Date.UTC(2026, 10, 1, 23) + windowMs)).toBe(false);
    expect(hostCalendarOpen("umami", NOV_6, NOV_6 + windowMs)).toBe(true);
  });
  it("returns the next midnight for a host without a calendar", () => {
    expect(nextCalendarOpen("task-report", Date.UTC(2026, 10, 3, 12), windowMs)).toBe(Date.UTC(2026, 10, 4));
  });
});
