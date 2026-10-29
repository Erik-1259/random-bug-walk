import { describe, expect, it, vi } from "vitest";
import { factorySessionCookie } from "../../src/factory-server/session.ts";
import { ruleSha256, sha256Hex, specSha256 } from "../../src/otf/canonical.ts";
import { BUILDER_LOST_MS, OTF_OPEN_CRITERION_ID, OTF_OPEN_LABEL, START_TIMEOUT_MS, StartError, type OtfCreateJob, type OtfOpenRule, type OtfHostId, type OtfSpecCard } from "../../src/otf/contract.ts";
import { createCustomerHandlers, handleOtfTestReset, setOtfCustomerDependencies, setOtfTestReset, type OtfCustomerDependencies, type OtfStartResult } from "../../src/otf/handlers.ts";
import { parseOtf, type OtfBodies, type OtfSchemaName } from "../../src/otf/schemas.ts";
import { FAKE_AT, FakeOtfStore, FakeVmPower } from "./customer-fakes.ts";
import { GET as availabilityRoute } from "../../app/api/factory/otf/availability/route.ts";
import { POST as createRoute } from "../../app/api/factory/otf/jobs/route.ts";
import { GET as statusRoute } from "../../app/api/factory/otf/jobs/[id]/route.ts";
import { POST as stopRoute } from "../../app/api/factory/otf/jobs/[id]/stop/route.ts";
import { GET as artifactRoute } from "../../app/api/factory/otf/jobs/[id]/artifacts/[part]/route.ts";
import { POST as validateRoute } from "../../app/api/factory/otf/jobs/[id]/validations/route.ts";
import { POST as testResetRoute } from "../../app/api/factory/otf/test/reset/route.ts";

const PASSCODE = "synthetic-customer-passcode";
const CLIENT = "00000000-0000-4000-8000-000000000001";
const SPEC: OtfSpecCard = {
  title: "Synthetic overlapping saves", where: "The task save component.",
  change: "An overlapping save replaces an earlier saved edit.", why_tests_miss: "The original suite saves one edit at a time.",
  checks_to_add: ["Both overlapping saves remain visible."], fix: "Serialize overlapping saves.",
};
async function body(extra: Partial<OtfCreateJob> = {}): Promise<OtfCreateJob> {
  return { client_key: CLIENT, host_id: "task-report", criterion_id: "concurrency.lost-acknowledged-change", sentence: "Overlapping saves lose my edit.", spec: SPEC, spec_sha256: await specSha256(SPEC), ...extra };
}
function request(value?: unknown, signedIn = true, query = ""): Request {
  return new Request(`https://synthetic.invalid/api/factory/otf/jobs${query}`, {
    method: value === undefined ? "GET" : "POST",
    headers: { ...(signedIn ? { cookie: factorySessionCookie(PASSCODE) } : {}), "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
async function parsedResponse<N extends OtfSchemaName>(schema: N, response: Response): Promise<OtfBodies[N]> {
  const value: unknown = await response.json();
  const parsed = parseOtf(schema, value);
  if (!parsed.ok) throw new Error(`Response does not match ${schema}: ${parsed.errors.join("; ")}`);
  return parsed.value;
}
function requiredValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error("Expected synthetic record is missing");
  return value;
}
function requiredElement<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Expected response element is missing");
  return value;
}
function setup() {
  const store = new FakeOtfStore(); const power = new FakeVmPower(); let serial = 10;
  let time = new Date(FAKE_AT);
  const deps: OtfCustomerDependencies = {
    store, power, now: () => new Date(time), id: () => `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`,
    config: { enabled: true, builderSecretConfigured: true, passcode: PASSCODE,
      maxQueued: 4, maxPerDay: 30, totalSpendCapMicrousd: 100_000_000, vmHoursPerDay: 12,
      behaviors: [
        { criterion_id: "concurrency.lost-acknowledged-change", host_id: "task-report", label: "Overlapping saves", example_phrases: ["An edit disappears."], measured: true },
        { criterion_id: "date_time.time-zone-grouping", host_id: "umami", label: "Time-zone grouping", example_phrases: ["A late event lands on the wrong day."], measured: true },
      ],
      hosts: {
        "task-report": { enabled: true, lanes: [{ lane_id: "lane-1", model: "synthetic-model", model_label: "Synthetic model" }],
          maxActive: 2, jobSpendCapMicrousd: 8_000_000, deadlineMs: 45 * 60_000,
          typical: { source: "development_attempts", median_min: 5, p90_min: 35, samples: 5, measured_on: "2026-01-01" } },
        umami: { enabled: true, lanes: [{ lane_id: "lane-1", model: "synthetic-model-two", model_label: "Synthetic model two" }],
          maxActive: 1, jobSpendCapMicrousd: 6_000_000, deadlineMs: 60 * 60_000, typical: null },
      },
      coldStartMin: null },
    inScope: () => Promise.resolve(true),
    lifecycle: {
      // These effects are scripted fixtures, not a replacement for W5's lifecycle tests.
      builderState: (current) => current.state,
      runWatchdog: () => Promise.resolve({ action: "none", reason: null, timed_out: 0 }),
      requestStart: (input) => store.withPowerLock<OtfStartResult>(async (current) => {
        if (input.power === null) return { patch: null, log: [], result: { kind: "unavailable", block: "unconfigured" } };
        if (current.state === "running") return { patch: null, log: [], result: { kind: "running" } };
        if (current.state === "starting") return { patch: null, log: [], result: { kind: "starting" } };
        if (current.state === "stopping") return { patch: null, log: [], result: { kind: "deferred" } };
        const at = input.now().toISOString();
        try {
          await input.power.start();
          for (const job of await store.listJobs(["starting_builder"])) {
            await store.appendJobEvent(job.job_id, { type: "builder_starting", lane_id: null,
              data: { preset: "synthetic-preset", requested_at: at } }, at);
          }
          return { patch: { state: "starting", since: at, last_start_at: at }, log: [], result: { kind: "started", requested_at: at } };
        } catch (error) {
          if (!(error instanceof StartError)) throw error;
          for (const job of await store.listJobs(["starting_builder"])) {
            await store.updateJob(job.job_id, ["starting_builder"], { state: "finished", outcome: "builder_start_failed", reason: error.reason, finished_at: at });
            await store.appendJobEvent(job.job_id, { type: "builder_start_failed", lane_id: null, data: { reason: error.reason } }, at);
            await store.appendJobEvent(job.job_id, { type: "job_finished", lane_id: null,
              data: { outcome: "builder_start_failed", reason: error.reason } }, at);
          }
          return { patch: null, log: [], result: { kind: "failed", reason: error.reason } };
        }
      }),
    },
  };
  return { store, power, deps, handlers: createCustomerHandlers(deps), advance: (ms: number) => { time = new Date(time.getTime() + ms); },
    at: (iso: string) => { time = new Date(iso); } };
}
/** A fresh heartbeat from a running builder that lists these hosts as ready. */
async function heartbeat(s: ReturnType<typeof setup>, ready: OtfHostId[] = ["task-report", "umami"], at = FAKE_AT): Promise<void> {
  s.store.power.state = "running";
  await s.store.recordBuilderSeen({ builder_id: "synthetic-builder", builder_revision: "synthetic-revision", boot_id: "synthetic-boot", booted_at: FAKE_AT, ready_hosts: ready }, at);
}

describe("OTF customer routes", () => {
  it("requires the existing factory session without writing a job", async () => {
    const s = setup(); const response = await s.handlers.create(request(await body(), false));
    expect(response.status).toBe(401); expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
  });
  it("starts a stopped builder once and preserves idempotent identity", async () => {
    const s = setup(); const input = await body();
    const start = vi.spyOn(s.deps.lifecycle, "requestStart");
    const first = await s.handlers.create(request(input)); const firstBody = await parsedResponse("OtfCreateResponse", first);
    const repeated = await s.handlers.create(request(input));
    expect(first.status).toBe(201); expect(firstBody.status.state).toBe("starting_builder");
    expect(repeated.status).toBe(200); expect((await parsedResponse("OtfCreateResponse", repeated)).job_id).toBe(firstBody.job_id);
    expect(s.store.jobs.size).toBe(1); expect(s.power.startCalls).toBe(1);
    expect(start).toHaveBeenCalledOnce();
    expect(firstBody.status.events.filter((event) => event.type === "builder_starting")).toHaveLength(1);
    expect(await requiredElement(start.mock.results, 0).value).toEqual({ kind: "started", requested_at: FAKE_AT });
  });
  it("rejects edited code before scope, storage or power", async () => {
    const s = setup(); const spec = { ...SPEC, fix: "const syntheticValue = 1;" };
    const response = await s.handlers.create(request(await body({ spec, spec_sha256: await specSha256(spec) })));
    expect(response.status).toBe(422); expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("refused_topic");
    expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
  });
  it.each(["availability", "create", "status", "stop", "artifact", "validate"] as const)("fails closed without builder configuration: %s", async (method) => {
    const s = setup(); s.deps.config.builderSecretConfigured = false;
    const response = await s.handlers[method](request(await body()), CLIENT, "agent");
    expect(response.status).toBe(503); expect(s.power.startCalls).toBe(0); expect(s.store.jobs.size).toBe(0);
  });
  it("availability needs no session and never starts a stopped builder", async () => {
    const s = setup(); const response = await s.handlers.availability(request(undefined, false));
    expect(response.status).toBe(200); expect(await parsedResponse("OtfAvailability", response)).toMatchObject({ enabled: true, builder: "stopped", active_jobs: 0, queued_jobs: 0 });
    expect(s.power.startCalls).toBe(0);
  });
  it.each(["title", "where", "change", "why_tests_miss", "fix", "checks_to_add"] as const)("rechecks security and code in edited %s", async (field) => {
    for (const value of ["Steal a password", "const syntheticValue = 1;"]) {
      const s = setup(); const spec = { ...SPEC, [field]: field === "checks_to_add" ? ["Keep both saves.", value] : value };
      const scope = vi.spyOn(s.deps, "inScope");
      const response = await s.handlers.create(request(await body({ spec, spec_sha256: await specSha256(spec) })));
      expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("refused_topic"); expect(scope).not.toHaveBeenCalled();
      expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
    }
  });
  it("rejects a security topic in the sentence", async () => {
    const s = setup(); const response = await s.handlers.create(request(await body({ sentence: "Steal a password" })));
    expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("refused_topic"); expect(s.store.jobs.size).toBe(0);
  });
  it("rejects unknown fields and a mismatched spec digest", async () => {
    const s = setup();
    for (const value of [{ ...await body(), extra: "synthetic-extra" }, await body({ spec_sha256: "0".repeat(64) })]) {
      expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(value))))).error.code).toBe("invalid_spec");
    }
    expect(s.store.jobs.size).toBe(0);
  });
  it("maps malformed and oversized JSON to invalid_spec", async () => {
    const s = setup();
    for (const text of ["{", " ".repeat(70_000)]) {
      const response = await s.handlers.create(new Request("https://synthetic.invalid/", { method: "POST", headers: { cookie: factorySessionCookie(PASSCODE) }, body: text }));
      expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("invalid_spec");
    }
  });
  it("requires the offered criterion and the trusted scope check", async () => {
    const s = setup();
    const response = await s.handlers.create(request(await body({ criterion_id: "concurrency.stale-success-response" })));
    expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("invalid_spec");
    s.deps.inScope = () => Promise.resolve(false);
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(await body()))))).error.code).toBe("invalid_spec");
    expect(s.store.jobs.size).toBe(0);
  });
  it("refuses the open criterion invalid_spec even when a behavior lists it, before storage or power", async () => {
    const s = setup();
    s.deps.config.behaviors.push({ criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: OTF_OPEN_LABEL, example_phrases: ["A synthetic report total is off."], measured: false });
    const rule: OtfOpenRule = { family: "data_handling", observable_failure: "The synthetic report total omits a task completed through the API.", failure_code: "synthetic_total_mismatch" };
    for (const value of [await body({ criterion_id: OTF_OPEN_CRITERION_ID, rule, rule_sha256: await ruleSha256(rule) }), await body({ criterion_id: OTF_OPEN_CRITERION_ID })]) {
      const response = await s.handlers.create(request(value));
      expect(response.status).toBe(422); expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("invalid_spec");
    }
    expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
  });
  it("omits a stored null rule from a proven job's status", async () => {
    const s = setup();
    const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await body())));
    requiredValue(s.store.jobs, created.job_id).rule = null;
    const status = await parsedResponse("OtfJobStatus", await s.handlers.status(request(), created.job_id));
    expect(status).not.toHaveProperty("rule");
  });
  it("accepts an enabled open rule and preserves it through create, status and idempotent replay", async () => {
    const s = setup();
    s.deps.config.openBehaviors = true;
    s.deps.config.behaviors.push({ criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: OTF_OPEN_LABEL, example_phrases: [], measured: false });
    const rule: OtfOpenRule = { family: "data_handling", observable_failure: "POST /api/tasks saves a title, but GET /api/tasks/{id} returns a different title after the create completes.", failure_code: "synthetic_title_mismatch" };
    const input = await body({ criterion_id: OTF_OPEN_CRITERION_ID, rule, rule_sha256: await ruleSha256(rule) });
    const response = await s.handlers.create(request(input));
    expect(response.status).toBe(201);
    const created = await parsedResponse("OtfCreateResponse", response);
    expect(created.status.rule).toEqual(rule);
    expect((await s.store.getJob(created.job_id))?.rule).toEqual(rule);
    const replay = await s.handlers.create(request(input));
    expect(replay.status).toBe(200);
    expect((await parsedResponse("OtfCreateResponse", replay)).status.rule).toEqual(rule);
    expect((await parsedResponse("OtfJobStatus", await s.handlers.status(request(), created.job_id))).rule).toEqual(rule);
    expect(s.store.jobs.size).toBe(1); expect(s.power.startCalls).toBe(1);
    const edited = { ...rule, observable_failure: rule.observable_failure + " The note is also altered." };
    const conflict = await s.handlers.create(request({ ...input, rule: edited, rule_sha256: await ruleSha256(edited) }));
    expect((await parsedResponse("OtfErrorBody", conflict)).error.code).toBe("idempotency_conflict");
  });
  it("validates the submitted open rule and its hash before storage or power", async () => {
    const s = setup(); s.deps.config.openBehaviors = true;
    s.deps.config.behaviors.push({ criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: OTF_OPEN_LABEL, example_phrases: [], measured: false });
    const rule: OtfOpenRule = { family: "data_handling", observable_failure: "POST /api/tasks saves a title, but GET /api/tasks/{id} returns a different title after the create completes.", failure_code: "synthetic_title_mismatch" };
    const valid = await body({ criterion_id: OTF_OPEN_CRITERION_ID, rule, rule_sha256: await ruleSha256(rule) });
    for (const input of [
      { ...valid, rule: undefined }, { ...valid, rule_sha256: undefined },
      { ...valid, rule_sha256: "0".repeat(64) },
      { ...valid, rule: { ...rule, observable_failure: "Too short" } },
      { ...valid, rule: { ...rule, failure_code: "control_failed" } },
    ]) {
      expect((await parsedResponse("OtfErrorBody", await s.handlers.create(request(input)))).error.code).toBe("invalid_spec");
    }
    expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
  });
  it("screens edited rule text for security and code before scope or power", async () => {
    const s = setup(); s.deps.config.openBehaviors = true;
    s.deps.config.behaviors.push({ criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: OTF_OPEN_LABEL, example_phrases: [], measured: false });
    const scope = vi.spyOn(s.deps, "inScope");
    for (const text of ["GET /api/tasks/{id} returns credentials after a task title is changed.", "const syntheticTaskTitle = 'This synthetic title is returned incorrectly';"]) {
      const rule: OtfOpenRule = { family: "data_handling", observable_failure: text, failure_code: "synthetic_title_mismatch" };
      const response = await s.handlers.create(request(await body({ criterion_id: OTF_OPEN_CRITERION_ID, rule, rule_sha256: await ruleSha256(rule) })));
      expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("refused_topic");
    }
    expect(scope).not.toHaveBeenCalled(); expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
  });
  it("passes the edited rule to the trusted scope check and honors its refusal", async () => {
    const s = setup(); s.deps.config.openBehaviors = true;
    s.deps.config.behaviors.push({ criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: OTF_OPEN_LABEL, example_phrases: [], measured: false });
    const rule: OtfOpenRule = { family: "data_handling", observable_failure: "POST /api/tasks saves a title, but GET /api/tasks/{id} returns a different title after the create completes.", failure_code: "synthetic_title_mismatch" };
    const scope = vi.spyOn(s.deps, "inScope").mockResolvedValue(false);
    const input = await body({ criterion_id: OTF_OPEN_CRITERION_ID, rule, rule_sha256: await ruleSha256(rule) });
    expect((await parsedResponse("OtfErrorBody", await s.handlers.create(request(input)))).error.code).toBe("invalid_spec");
    expect(scope).toHaveBeenCalledWith(input); expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
  });
  it("replays before all admission caps and refuses a changed body", async () => {
    const s = setup(); const input = await body();
    const first = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(input))));
    s.deps.config.enabled = false; s.deps.config.maxPerDay = 0; s.deps.config.totalSpendCapMicrousd = 0;
    expect((await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(input))))).job_id).toBe(first.job_id);
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request({ ...input, sentence: "Different overlapping saves." }))))).error.code).toBe("idempotency_conflict");
    expect(s.store.jobs.size).toBe(1); expect(s.power.startCalls).toBe(1);
  });
  it.each(["unavailable", "busy", "daily_cap", "spend_cap"] as const)("enforces %s before insertion", async (code) => {
    const s = setup();
    if (code === "unavailable") s.deps.config.enabled = false;
    if (code === "busy") { s.deps.config.hosts["task-report"].maxActive = 0; s.deps.config.hosts.umami.maxActive = 0; s.deps.config.maxQueued = 0; }
    if (code === "daily_cap") s.deps.config.maxPerDay = 0;
    if (code === "spend_cap") s.deps.config.totalSpendCapMicrousd = 0;
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(await body()))))).error.code).toBe(code);
    expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
  });
  it("enforces the operator hold and UTC machine-hours cap", async () => {
    const s = setup(); s.store.power.hold_until = "2026-01-02T00:00:00.000Z";
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(await body()))))).error.code).toBe("unavailable");
    s.store.power.hold_until = null; s.store.power.vm_seconds_today = 12 * 3600;
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(await body()))))).error.code).toBe("unavailable");
    s.store.power.vm_day = "2025-12-31";
    expect((await s.handlers.create(request(await body()))).status).toBe(201);
  });
  it("serializes concurrent admission at the queue cap", async () => {
    const s = setup(); s.deps.config.hosts["task-report"].maxActive = 0; s.deps.config.hosts.umami.maxActive = 0; s.deps.config.maxQueued = 1;
    const results = await Promise.all([s.handlers.create(request(await body())), s.handlers.create(request(await body({ client_key: "00000000-0000-4000-8000-000000000002" })))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]); expect(s.store.jobs.size).toBe(1); expect(s.power.startCalls).toBe(1);
  });
  it("queues concurrent creates while only one power start is issued", async () => {
    const s = setup(); const start = vi.spyOn(s.deps.lifecycle, "requestStart");
    const results = await Promise.all([s.handlers.create(request(await body())), s.handlers.create(request(await body({ client_key: "00000000-0000-4000-8000-000000000002" })))]);
    expect(results.map((r) => r.status)).toEqual([201, 201]); expect(s.power.startCalls).toBe(1);
    expect((await Promise.all(results.map((r) => parsedResponse("OtfCreateResponse", r)))).map((r) => r.status.queue_position).sort()).toEqual([1, 2]);
    expect(start).toHaveBeenCalledTimes(2);
    const outcomes = await Promise.all(start.mock.results.map((call) => {
      if (call.type !== "return") throw new Error("Synthetic start did not return a result");
      return call.value;
    }));
    expect(outcomes.map((result) => result.kind)).toEqual(["started", "starting"]);
  });
  it("queues for a fresh running builder without starting it", async () => {
    const s = setup(); s.store.power.state = "running";
    const start = vi.spyOn(s.deps.lifecycle, "requestStart").mockImplementation(() => {
      expect(s.store.jobs.size).toBe(1);
      return Promise.resolve({ kind: "running" });
    });
    await s.store.recordBuilderSeen({ builder_id: "synthetic-builder", builder_revision: "synthetic-revision", boot_id: "synthetic-boot", booted_at: FAKE_AT, ready_hosts: ["task-report", "umami"] }, FAKE_AT);
    const response = await s.handlers.create(request(await body()));
    expect((await parsedResponse("OtfCreateResponse", response)).status.state).toBe("queued"); expect(s.power.startCalls).toBe(0);
    expect(start).toHaveBeenCalledOnce();
  });
  it("waits during stopping instead of requesting another power start", async () => {
    const s = setup(); s.store.power.state = "stopping";
    const start = vi.spyOn(s.deps.lifecycle, "requestStart");
    const response = await s.handlers.create(request(await body()));
    expect((await parsedResponse("OtfCreateResponse", response)).status.state).toBe("starting_builder"); expect(s.power.startCalls).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(await requiredElement(start.mock.results, 0).value).toEqual({ kind: "deferred" });
  });
  it.each(["capacity", "api_error"] as const)("records %s start failure without exposing the provider error", async (reason) => {
    const s = setup(); s.power.startError = new StartError(reason, "synthetic-provider-detail");
    const response = await s.handlers.create(request(await body())); const value = await parsedResponse("OtfCreateResponse", response);
    expect(response.status).toBe(201); expect(value.status).toMatchObject({ state: "finished", outcome: "builder_start_failed", reason });
    expect(JSON.stringify(value)).not.toContain("synthetic-provider-detail");
    expect(value.status.events.map((e: { type: string }) => e.type)).toContain("builder_start_failed");
    expect(value.status.events.filter((event) => event.type === "builder_start_failed")).toHaveLength(1);
    expect(value.status.events.filter((event) => event.type === "job_finished")).toHaveLength(1);
  });
  it("finishes an unclaimed start at the eight-minute boundary on read", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    s.advance(START_TIMEOUT_MS - 1);
    expect((await parsedResponse("OtfJobStatus", (await s.handlers.status(request(), created.job_id)))).state).toBe("starting_builder");
    s.advance(1);
    const watchdog = vi.spyOn(s.deps.lifecycle, "runWatchdog").mockImplementationOnce(async (input) => {
      const at = input.now().toISOString();
      await input.store.updateJob(created.job_id, ["starting_builder"], { state: "finished", outcome: "builder_start_failed", reason: "timeout", finished_at: at });
      await input.store.appendJobEvent(created.job_id, { type: "builder_start_failed", lane_id: null, data: { reason: "timeout" } }, at);
      await input.store.appendJobEvent(created.job_id, { type: "job_finished", lane_id: null, data: { outcome: "builder_start_failed", reason: "timeout" } }, at);
      return { action: "none", reason: "synthetic-start-timeout", timed_out: 1 };
    });
    expect(await parsedResponse("OtfJobStatus", (await s.handlers.status(request(), created.job_id)))).toMatchObject({ state: "finished", outcome: "builder_start_failed", reason: "timeout" });
    expect(s.power.startCalls).toBe(1); expect(watchdog).toHaveBeenCalledOnce();
  });
  it("uses the last builder post and the 180-second boundary, not lease expiry", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    const job = requiredValue(s.store.jobs, created.job_id);
    Object.assign(job, { state: "building", claimed_at: FAKE_AT, last_builder_post_at: FAKE_AT, lease_until: FAKE_AT });
    s.advance(BUILDER_LOST_MS - 1);
    expect((await parsedResponse("OtfJobStatus", (await s.handlers.status(request(), created.job_id)))).state).toBe("building");
    s.advance(1);
    expect((await parsedResponse("OtfJobStatus", (await s.handlers.status(request(), created.job_id)))).outcome).toBe("builder_lost");
    expect((s.store.events.get(created.job_id) ?? []).filter((e) => e.type === "job_finished")).toHaveLength(1);
    await s.handlers.status(request(), created.job_id);
    expect((s.store.events.get(created.job_id) ?? []).filter((e) => e.type === "job_finished")).toHaveLength(1);
  });
  it("finishes a claimed job at its deadline despite fresh progress", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    Object.assign(requiredValue(s.store.jobs, created.job_id), { state: "building", claimed_at: FAKE_AT, last_builder_post_at: FAKE_AT, deadline_at: FAKE_AT });
    expect((await parsedResponse("OtfJobStatus", (await s.handlers.status(request(), created.job_id)))).outcome).toBe("time_limit");
  });
  it("preserves delivery when a result wins the finish compare-and-set", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    Object.assign(requiredValue(s.store.jobs, created.job_id), { state: "building", claimed_at: FAKE_AT }); s.advance(BUILDER_LOST_MS);
    const update = s.store.updateJob.bind(s.store);
    vi.spyOn(s.store, "updateJob").mockImplementationOnce(async () => {
      await update(created.job_id, ["building"], { state: "finished", outcome: "delivered", finished_at: FAKE_AT }); return null;
    });
    expect((await parsedResponse("OtfJobStatus", (await s.handlers.status(request(), created.job_id)))).outcome).toBe("delivered");
    expect((s.store.events.get(created.job_id) ?? []).filter((e) => e.type === "job_finished")).toHaveLength(0);
  });
  it("returns only incremental events while projecting lanes from the complete history", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    s.store.events.set(created.job_id, [
      { seq: 1, at: FAKE_AT, type: "lane_files", lane_id: "lane-1", data: { change: true, checks: 2, fix: true } },
      { seq: 2, at: FAKE_AT, type: "lane_stage", lane_id: "lane-1", data: { stage: "setting_up", iteration: 0 } },
    ]);
    const result = await parsedResponse("OtfJobStatus", (await s.handlers.status(request(undefined, true, "?after=1"), created.job_id)));
    expect(result.events).toHaveLength(1); expect(requiredElement(result.events, 0).seq).toBe(2); expect(result.next_after).toBe(2);
    expect(result.lanes[0]).toMatchObject({ stage: "setting_up", files: { change: true, checks: 2, fix: true } });
    const empty = await parsedResponse("OtfJobStatus", (await s.handlers.status(request(undefined, true, "?after=2"), created.job_id)));
    expect(empty.events).toEqual([]); expect(empty.next_after).toBe(2);
  });
  it.each(["?after=-1", "?after=1.5", "?after=1&after=2", "?after=9007199254740992", "?other=1"])("rejects invalid cursor %s", async (query) => {
    const s = setup(); expect((await s.handlers.status(request(undefined, true, query), CLIENT)).status).toBe(400);
  });
  it("stops waiting jobs immediately and signals a building job", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    const stopped = await s.handlers.stop(request(), created.job_id);
    expect(stopped.status).toBe(202); expect((await parsedResponse("OtfJobStatus", stopped)).outcome).toBe("cancelled");
    const another = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body({ client_key: "00000000-0000-4000-8000-000000000002" })))));
    Object.assign(requiredValue(s.store.jobs, another.job_id), { state: "building", claimed_at: FAKE_AT });
    expect((await s.handlers.stop(request(), another.job_id)).status).toBe(202);
    expect(s.store.jobs.get(another.job_id)).toMatchObject({ state: "building", stop_requested_at: FAKE_AT, stop_reason: "customer" });
  });
  it("checks delivery and each artifact's bytes before a download", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    expect((await s.handlers.artifact(request(), created.job_id, "agent")).status).toBe(409);
    Object.assign(requiredValue(s.store.jobs, created.job_id), { state: "finished", outcome: "delivered", finished_at: FAKE_AT });
    const bytes = new TextEncoder().encode("synthetic-archive-bytes");
    const artifact = { job_id: created.job_id, part: "agent" as const, filename: "synthetic-agent.tar.gz", media_type: "application/gzip" as const,
      size: bytes.byteLength, sha256: await sha256Hex(bytes), bytes };
    s.store.artifacts.set(`${created.job_id}:agent`, artifact);
    const good = await s.handlers.artifact(request(), created.job_id, "agent");
    expect(good.status).toBe(200); expect(new Uint8Array(await good.arrayBuffer())).toEqual(bytes);
    expect(good.headers.get("content-disposition")).toContain("synthetic-agent.tar.gz");
    for (const patch of [{ size: bytes.length + 1 }, { sha256: "0".repeat(64) }, { filename: "../synthetic.tar.gz" }, { media_type: "application/json" as const }]) {
      s.store.artifacts.set(`${created.job_id}:agent`, { ...artifact, ...patch });
      expect((await s.handlers.artifact(request(), created.job_id, "agent")).status).toBe(503);
    }
    s.store.artifacts.set(`${created.job_id}:agent`, artifact);
    await s.handlers.stop(request(), created.job_id);
    expect((await s.handlers.artifact(request(), created.job_id, "agent")).status).toBe(200);
  });
  it("requires delivery for validation and serializes reuse of an open validation", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    expect((await s.handlers.validate(request(), created.job_id)).status).toBe(409);
    Object.assign(requiredValue(s.store.jobs, created.job_id), { state: "finished", outcome: "delivered", finished_at: FAKE_AT });
    s.store.power.state = "running";
    await s.store.recordBuilderSeen({ builder_id: "synthetic-builder", builder_revision: "synthetic-revision", boot_id: "synthetic-boot", booted_at: FAKE_AT, ready_hosts: ["task-report", "umami"] }, FAKE_AT);
    const responses = await Promise.all([s.handlers.validate(request(), created.job_id), s.handlers.validate(request(), created.job_id)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const values = await Promise.all(responses.map((r) => parsedResponse("OtfValidation", r)));
    expect(requiredElement(values, 0).validation_id).toBe(requiredElement(values, 1).validation_id); expect(requiredElement(values, 0).where).toBe("RBW builder (Nebius VM)");
    expect(s.store.validations.size).toBe(1);
    requiredValue(s.store.validations, requiredElement(values, 0).validation_id).state = "passed";
    expect((await s.handlers.validate(request(), created.job_id)).status).toBe(201); expect(s.store.validations.size).toBe(2);
  });
  it("rejects invalid response data instead of exposing it", async () => {
    const s = setup(); s.deps.config.hosts["task-report"].maxActive = -1;
    const response = await s.handlers.availability(request());
    expect(response.status).toBe(503); expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("unavailable");
  });

  it("finishes a stale building job through the store's compare-and-set on building", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    Object.assign(requiredValue(s.store.jobs, created.job_id), { state: "building", claimed_at: FAKE_AT, last_builder_post_at: FAKE_AT });
    s.advance(BUILDER_LOST_MS);
    const update = vi.spyOn(s.store, "updateJob");
    expect((await parsedResponse("OtfJobStatus", (await s.handlers.status(request(), created.job_id)))).outcome).toBe("builder_lost");
    expect(update).toHaveBeenCalledWith(created.job_id, ["building"], expect.objectContaining({ state: "finished", outcome: "builder_lost" }), { quietSince: FAKE_AT });
  });
  it("keeps a job building when a builder post lands between the status read and the builder_lost finish", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    Object.assign(requiredValue(s.store.jobs, created.job_id), { state: "building", claimed_by: "synthetic-builder", claimed_at: FAKE_AT, last_builder_post_at: FAKE_AT });
    s.advance(BUILDER_LOST_MS);
    const update = s.store.updateJob.bind(s.store);
    vi.spyOn(s.store, "updateJob").mockImplementationOnce(async (...args) => {
      // The builder's heartbeat commits after the status read saw the job quiet.
      requiredValue(s.store.jobs, created.job_id).last_builder_post_at = new Date(Date.parse(FAKE_AT) + BUILDER_LOST_MS).toISOString();
      return update(...args);
    });
    expect((await parsedResponse("OtfJobStatus", (await s.handlers.status(request(), created.job_id))))).toMatchObject({ state: "building", outcome: null });
    expect(requiredValue(s.store.jobs, created.job_id).state).toBe("building");
    expect((s.store.events.get(created.job_id) ?? []).filter((e) => e.type === "job_finished")).toHaveLength(0);
  });
  it("wakes a stopped builder for a new validation", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", (await s.handlers.create(request(await body()))));
    Object.assign(requiredValue(s.store.jobs, created.job_id), { state: "finished", outcome: "delivered", finished_at: FAKE_AT });
    s.store.power.state = "stopped"; s.power.state = "STOPPED";
    const start = vi.spyOn(s.deps.lifecycle, "requestStart");
    const response = await s.handlers.validate(request(), created.job_id);
    expect(response.status).toBe(201); expect((await parsedResponse("OtfValidation", response))).toMatchObject({ state: "queued", admission: null });
    expect(start).toHaveBeenCalledOnce(); expect(s.power.startCalls).toBe(2); expect(s.store.validations.size).toBe(1);
  });

  it.each(["status", "stop", "artifact", "validate"] as const)("checks the factory session on %s", async (method) => {
    const s = setup(); expect((await s.handlers[method](request(undefined, false), CLIENT, "agent")).status).toBe(401);
    expect(s.store.jobs.size).toBe(0); expect(s.store.validations.size).toBe(0);
  });
  it("keeps the cap refusal order and resets the daily count at UTC midnight", async () => {
    const s = setup(); s.deps.config.enabled = false; s.deps.config.hosts["task-report"].maxActive = 0; s.deps.config.hosts.umami.maxActive = 0; s.deps.config.maxQueued = 0;
    s.deps.config.maxPerDay = 0; s.deps.config.totalSpendCapMicrousd = 0;
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(await body()))))).error.code).toBe("unavailable");
    s.deps.config.enabled = true;
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(await body()))))).error.code).toBe("busy");
    s.deps.config.maxQueued = 4;
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(await body()))))).error.code).toBe("daily_cap");
    s.deps.config.maxPerDay = 1;
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(await body()))))).error.code).toBe("spend_cap");
    s.deps.config.totalSpendCapMicrousd = 10_000_000;
    expect((await s.handlers.create(request(await body()))).status).toBe(201);
    const next = await body({ client_key: "00000000-0000-4000-8000-000000000002" });
    expect((await parsedResponse("OtfErrorBody", (await s.handlers.create(request(next))))).error.code).toBe("daily_cap");
    s.advance(24 * 3600_000);
    expect((await s.handlers.create(request(next))).status).toBe(201);
  });
  it("returns contract errors for unknown jobs and storage failures", async () => {
    const s = setup(); expect((await s.handlers.status(request(), CLIENT)).status).toBe(404);
    vi.spyOn(s.store, "getJob").mockRejectedValue(new Error("synthetic-storage-detail"));
    const response = await s.handlers.status(request(), CLIENT);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-storage-detail");
  });
  it("mounts each customer route and fails closed until dependencies are bound", async () => {
    expect((await availabilityRoute(request())).status).toBe(503);
    const s = setup(); setOtfCustomerDependencies(() => Promise.resolve(s.deps));
    try {
      expect((await availabilityRoute(request(undefined, false))).status).toBe(200);
      const created = await createRoute(request(await body())); expect(created.status).toBe(201);
      const { job_id } = await parsedResponse("OtfCreateResponse", created); const params = Promise.resolve({ id: job_id });
      expect((await statusRoute(request(), { params })).status).toBe(200);
      expect((await artifactRoute(request(), { params: Promise.resolve({ id: job_id, part: "agent" }) })).status).toBe(409);
      expect((await validateRoute(request(), { params })).status).toBe(409);
      expect((await stopRoute(request(), { params })).status).toBe(202);
    } finally { setOtfCustomerDependencies(null); }
  });

  it("cancels a waiting job even when a healthy builder promotes it to queued", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await body())));
    const update = s.store.updateJob.bind(s.store);
    vi.spyOn(s.store, "updateJob").mockImplementationOnce((jobId, states, patch) => {
      requiredValue(s.store.jobs, jobId).state = "queued";
      return update(jobId, states, patch);
    });
    const response = await s.handlers.stop(request(), created.job_id);
    expect(response.status).toBe(202);
    expect(await parsedResponse("OtfJobStatus", response)).toMatchObject({ state: "finished", outcome: "cancelled" });
    expect(requiredValue(s.store.jobs, created.job_id).state).toBe("finished");
  });

  it.each([["unconfigured", "builder_unavailable"], ["hold", "builder_unavailable"], ["day_cap", "builder_unavailable"], ["start_backoff", "builder_start_failed"]] as const)(
    "finishes the inserted job for W5 start block %s and answers 201", async (block, outcome) => {
      const s = setup();
      const start = vi.spyOn(s.deps.lifecycle, "requestStart").mockResolvedValue({ kind: "unavailable", block });
      const response = await s.handlers.create(request(await body()));
      expect(response.status).toBe(201);
      expect((await parsedResponse("OtfCreateResponse", response)).status).toMatchObject({ state: "finished", outcome });
      expect(start).toHaveBeenCalledOnce(); expect(s.store.jobs.size).toBe(1); expect(s.power.startCalls).toBe(0);
      expect([...s.store.events.values()].flat().map((event) => event.type)).toEqual(["job_queued", "job_finished"]);
    });
  it("answers 201 with the running job when a claim takes it before a start block finishes it", async () => {
    const s = setup();
    vi.spyOn(s.deps.lifecycle, "requestStart").mockImplementation(() => {
      const [job] = [...s.store.jobs.values()];
      if (job === undefined) throw new Error("Expected the inserted synthetic job");
      Object.assign(job, { state: "building", claimed_at: FAKE_AT, last_builder_post_at: FAKE_AT });
      return Promise.resolve({ kind: "unavailable", block: "hold" });
    });
    const response = await s.handlers.create(request(await body()));
    expect(response.status).toBe(201);
    expect((await parsedResponse("OtfCreateResponse", response)).status).toMatchObject({ state: "building", outcome: null });
    expect([...s.store.events.values()].flat().map((event) => event.type)).toEqual(["job_queued"]);
  });
  it("leaves a waiting start unchanged when W5 has not timed it out", async () => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await body())));
    s.advance(START_TIMEOUT_MS + 1);
    const watchdog = vi.spyOn(s.deps.lifecycle, "runWatchdog");
    const value = await parsedResponse("OtfJobStatus", await s.handlers.status(request(), created.job_id));
    expect(value.state).toBe("starting_builder"); expect(value.outcome).toBeNull();
    expect(watchdog).toHaveBeenCalledOnce();
    expect(value.events.some((event) => event.type === "builder_start_failed" || event.type === "job_finished")).toBe(false);
  });
  it.each(["status", "availability"] as const)("runs W5 watchdog before loading %s state", async (method) => {
    const s = setup(); const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await body())));
    const watchdog = vi.spyOn(s.deps.lifecycle, "runWatchdog").mockImplementationOnce(async (input) => {
      await input.store.updateJob(created.job_id, ["starting_builder"], { state: "finished", outcome: "builder_start_failed", reason: "timeout", finished_at: input.now().toISOString() });
      s.store.power.state = "stopped";
      return { action: "none", reason: "synthetic-timeout-effect", timed_out: 1 };
    });
    const getJob = vi.spyOn(s.store, "getJob"); const getPower = vi.spyOn(s.store, "getPower");
    const response = await s.handlers[method](request(), created.job_id);
    expect(response.status).toBe(200); expect(watchdog).toHaveBeenCalledOnce();
    const watchdogOrder = requiredElement(watchdog.mock.invocationCallOrder, 0);
    expect(watchdogOrder).toBeLessThan(requiredElement(getPower.mock.invocationCallOrder, 0));
    if (method === "status") {
      expect(watchdogOrder).toBeLessThan(requiredElement(getJob.mock.invocationCallOrder, 0));
      expect(await parsedResponse("OtfJobStatus", response)).toMatchObject({ state: "finished", outcome: "builder_start_failed", builder: "stopped" });
    } else {
      expect(await parsedResponse("OtfAvailability", response)).toMatchObject({ queued_jobs: 0, builder: "stopped" });
    }
  });
  it("uses W5 builder state when a fresh heartbeat overrides the stored state", async () => {
    const s = setup(); s.store.power.state = "stopped";
    await s.store.recordBuilderSeen({ builder_id: "synthetic-builder", builder_revision: "synthetic-revision", boot_id: "synthetic-boot", booted_at: FAKE_AT, ready_hosts: ["task-report", "umami"] }, FAKE_AT);
    const state = vi.spyOn(s.deps.lifecycle, "builderState").mockReturnValue("running");
    const start = vi.spyOn(s.deps.lifecycle, "requestStart").mockResolvedValue({ kind: "running" });
    const response = await s.handlers.create(request(await body()));
    expect((await parsedResponse("OtfCreateResponse", response)).status).toMatchObject({ state: "queued", builder: "running" });
    expect(state).toHaveBeenCalledWith(expect.objectContaining({ state: "stopped" }), FAKE_AT, new Date(FAKE_AT));
    expect(start).toHaveBeenCalledOnce(); expect(s.power.startCalls).toBe(0);
  });
  it("fails closed with a null power port before any insertion or lifecycle call", async () => {
    const s = setup(); s.deps.power = null;
    const start = vi.spyOn(s.deps.lifecycle, "requestStart"); const watchdog = vi.spyOn(s.deps.lifecycle, "runWatchdog");
    for (const method of ["availability", "create", "status", "stop", "artifact", "validate"] as const) {
      const response = await s.handlers[method](request(await body()), CLIENT, "agent");
      expect(response.status).toBe(503); expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("unavailable");
    }
    expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
    expect(start).not.toHaveBeenCalled(); expect(watchdog).not.toHaveBeenCalled();
  });

  it("counts the open VM interval before availability and admission", async () => {
    const s = setup(); s.store.power.running_since = FAKE_AT; s.store.power.vm_seconds_today = 0;
    s.advance(12 * 3600_000);
    expect((await parsedResponse("OtfAvailability", await s.handlers.availability(request()))).enabled).toBe(false);
    const response = await s.handlers.create(request(await body()));
    expect(response.status).toBe(503); expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("unavailable");
    expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
  });
  it("counts only today's open VM interval across midnight and ignores yesterday's closed counter", async () => {
    const s = setup(); s.deps.config.vmHoursPerDay = 2;
    s.store.power.running_since = "2026-01-01T23:30:00.000Z";
    s.store.power.vm_day = "2026-01-01"; s.store.power.vm_seconds_today = 12 * 3600;
    s.advance(25 * 3600_000);
    expect((await parsedResponse("OtfAvailability", await s.handlers.availability(request()))).enabled).toBe(true);
    expect((await s.handlers.create(request(await body()))).status).toBe(201);
    s.advance(3600_000);
    expect((await parsedResponse("OtfAvailability", await s.handlers.availability(request()))).enabled).toBe(false);
    const response = await s.handlers.create(request(await body({ client_key: "00000000-0000-4000-8000-000000000002" })));
    expect(response.status).toBe(503); expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("unavailable");
    expect(s.store.jobs.size).toBe(1);
  });

  describe("hosts", () => {
    const UMAMI_SPEC: OtfSpecCard = {
      title: "Synthetic late-evening grouping", where: "A date-grouped report.",
      change: "An event late in the evening is grouped under the next day.", why_tests_miss: "The original suite uses midday times only.",
      checks_to_add: ["A late-evening event stays on its own day."], fix: "Group by the viewer's time zone.",
    };
    async function umami(extra: Partial<OtfCreateJob> = {}): Promise<OtfCreateJob> {
      return body({ host_id: "umami", criterion_id: "date_time.time-zone-grouping", sentence: "Late events land on the wrong day.",
        spec: UMAMI_SPEC, spec_sha256: await specSha256(UMAMI_SPEC), ...extra });
    }
    it("stores host_id on create and status, with the host's spend cap and lanes", async () => {
      const s = setup(); const response = await s.handlers.create(request(await umami()));
      expect(response.status).toBe(201);
      const created = await parsedResponse("OtfCreateResponse", response);
      expect(created.status).toMatchObject({ host_id: "umami", spend: { cap_microusd: 6_000_000 } });
      expect(created.status.lanes.map((lane) => lane.model)).toEqual(["synthetic-model-two"]);
      expect(requiredValue(s.store.jobs, created.job_id).host_id).toBe("umami");
    });
    it("refuses a host that does not pair with the criterion", async () => {
      const s = setup();
      expect((await parsedResponse("OtfErrorBody", await s.handlers.create(request(await umami({ host_id: "task-report" }))))).error.code).toBe("invalid_spec");
      expect(s.store.jobs.size).toBe(0);
    });
    it.each(["Concurrent report loads group an event on the wrong day.", "A race between two reports."])("refuses an Umami card outside the host's scope: %s", async (change) => {
      const s = setup(); const spec = { ...UMAMI_SPEC, change };
      const response = await s.handlers.create(request(await umami({ spec, spec_sha256: await specSha256(spec) })));
      expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("invalid_spec");
      expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
    });
    it("refuses a disabled host with host_unavailable before insertion", async () => {
      const s = setup(); s.deps.config.hosts.umami.enabled = false;
      const response = await s.handlers.create(request(await umami()));
      expect(response.status).toBe(409); expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("host_unavailable");
      expect(s.store.jobs.size).toBe(0); expect(s.power.startCalls).toBe(0);
      expect((await s.handlers.create(request(await body()))).status).toBe(201);
    });
    it("refuses a host left out of a running builder's fresh ready_hosts", async () => {
      const s = setup(); await heartbeat(s, ["task-report"]);
      expect((await parsedResponse("OtfErrorBody", await s.handlers.create(request(await umami())))).error.code).toBe("host_unavailable");
      expect(s.store.jobs.size).toBe(0);
    });
    it("creates against a stopped builder whose last ready_hosts was empty", async () => {
      const s = setup(); await heartbeat(s, []); s.store.power.state = "stopped";
      const response = await s.handlers.create(request(await umami()));
      expect(response.status).toBe(201);
      const value = await parsedResponse("OtfCreateResponse", response);
      expect(value.status.state).toBe("starting_builder");
      expect(value.status.events.map((event) => event.type)).toEqual(["job_queued", "builder_starting"]);
    });
    it.each([["2026-01-01T22:37:00.000Z", 409], ["2026-01-01T22:36:59.999Z", 201], ["2026-01-03T12:00:00.000Z", 409], ["2026-01-06T00:00:00.000Z", 201]] as const)(
      "checks the Umami calendar window at create (%s)", async (at, status) => {
        const s = setup(); s.at(at); s.store.power.vm_day = at.slice(0, 10);
        const response = await s.handlers.create(request(await umami()));
        expect(response.status).toBe(status);
        if (status === 409) expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("host_unavailable");
        expect((await s.handlers.create(request(await body({ client_key: "00000000-0000-4000-8000-000000000002" })))).status).toBe(201);
      });
    it("finishes a waiting Umami job on read once its window touches a blocked day", async () => {
      const s = setup(); s.at("2026-01-01T22:00:00.000Z");
      const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await umami())));
      s.at("2026-01-01T22:44:59.999Z");
      expect((await parsedResponse("OtfJobStatus", await s.handlers.status(request(), created.job_id))).state).toBe("starting_builder");
      s.at("2026-01-01T22:45:00.000Z");
      const value = await parsedResponse("OtfJobStatus", await s.handlers.status(request(), created.job_id));
      expect(value).toMatchObject({ state: "finished", outcome: "builder_unavailable", reason: "Umami is unavailable on UTC days 2–5." });
      expect(value.events.filter((event) => event.type === "job_finished")).toHaveLength(1);
    });
    it("finishes a waiting job on read when the first fresh heartbeat leaves its host out", async () => {
      const s = setup(); const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await umami())));
      await heartbeat(s, ["task-report"]);
      expect(await parsedResponse("OtfJobStatus", await s.handlers.status(request(), created.job_id)))
        .toMatchObject({ state: "finished", outcome: "builder_unavailable", reason: "Umami is not ready on the builder machine." });
    });
    it("finishes a waiting job on read when its host is turned off", async () => {
      const s = setup(); const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await body())));
      s.deps.config.hosts["task-report"].enabled = false;
      expect(await parsedResponse("OtfJobStatus", await s.handlers.status(request(), created.job_id)))
        .toMatchObject({ state: "finished", outcome: "builder_unavailable", reason: "task-report service builds were turned off while this job waited." });
    });
    it.each([["disabled", "Custom builds were turned off while this Umami job waited."], ["hold", "Custom builds were put on hold while this Umami job waited."]] as const)(
      "names the host and the cause when OTF becomes unavailable for a waiting job (%s)", async (cause, reason) => {
        const s = setup(); const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await umami())));
        if (cause === "disabled") s.deps.config.enabled = false; else s.store.power.hold_until = "2026-01-02T00:00:00.000Z";
        expect(await parsedResponse("OtfJobStatus", await s.handlers.status(request(), created.job_id)))
          .toMatchObject({ state: "finished", outcome: "builder_unavailable", reason });
      });
    it("lists every host once with its reason, lanes, deadline and typical time", async () => {
      const s = setup(); s.deps.config.coldStartMin = 4;
      const value = await parsedResponse("OtfAvailability", await s.handlers.availability(request(undefined, false)));
      expect(value.cold_start_min).toBe(4);
      expect(value.hosts).toEqual([
        { host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2,
          lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], deadline_min: 45,
          typical: { source: "development_attempts", median_min: 5, p90_min: 35, samples: 5, measured_on: "2026-01-01" } },
        { host_id: "umami", label: "Umami", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 1,
          lanes: [{ lane_id: "lane-1", model_label: "Synthetic model two" }], deadline_min: 60, typical: null },
      ]);
      expect(value.behaviors.map((behavior) => behavior.host_id)).toEqual(["task-report", "umami"]);
    });
    it("reports disabled, calendar and builder_not_ready and lists only offered behaviors", async () => {
      const s = setup(); await s.handlers.create(request(await umami()));
      const reasons = async () => (await parsedResponse("OtfAvailability", await s.handlers.availability(request())));
      await heartbeat(s, ["task-report"]);
      let value = await reasons();
      expect(value.hosts.find((host) => host.host_id === "umami")).toMatchObject({ offered: false, unavailable_reason: "builder_not_ready", queued_jobs: 1 });
      expect(value.behaviors.map((behavior) => behavior.host_id)).toEqual(["task-report"]);
      s.store.power.state = "stopped"; s.advance(60_000);
      expect((await reasons()).hosts.find((host) => host.host_id === "umami")).toMatchObject({ offered: true, unavailable_reason: null });
      s.at("2026-01-02T00:00:00.000Z"); s.store.power.vm_day = "2026-01-02";
      expect((await reasons()).hosts.find((host) => host.host_id === "umami")).toMatchObject({ offered: false, unavailable_reason: "calendar" });
      s.deps.config.hosts.umami.enabled = false;
      value = await reasons();
      expect(value.hosts.find((host) => host.host_id === "umami")).toMatchObject({ offered: false, unavailable_reason: "disabled" });
      expect(value.hosts.find((host) => host.host_id === "task-report")).toMatchObject({ offered: true, unavailable_reason: null });
    });
  });

  describe("validations", () => {
    async function delivered(s: ReturnType<typeof setup>): Promise<string> {
      const created = await parsedResponse("OtfCreateResponse", await s.handlers.create(request(await body())));
      Object.assign(requiredValue(s.store.jobs, created.job_id), { state: "finished", outcome: "delivered", finished_at: FAKE_AT });
      return created.job_id;
    }
    it.each([{ kind: "failed", reason: "capacity" }, { kind: "unavailable", block: "start_backoff" }] as const)("marks a new validation error when its start is refused (%o)", async (result) => {
      const s = setup(); const jobId = await delivered(s);
      vi.spyOn(s.deps.lifecycle, "requestStart").mockResolvedValue(result);
      const response = await s.handlers.validate(request(), jobId);
      expect(response.status).toBe(201);
      expect(await parsedResponse("OtfValidation", response)).toMatchObject({ state: "error", finished_at: FAKE_AT });
    });
    it("asks again on read for a validation start that was deferred", async () => {
      const s = setup(); const jobId = await delivered(s);
      s.store.power.state = "stopping";
      const start = vi.spyOn(s.deps.lifecycle, "requestStart");
      expect(await parsedResponse("OtfValidation", await s.handlers.validate(request(), jobId))).toMatchObject({ state: "queued" });
      expect(await requiredElement(start.mock.results, 0).value).toEqual({ kind: "deferred" });
      s.store.power.state = "stopped"; s.power.state = "STOPPED";
      const startsBefore = s.power.startCalls;
      expect((await parsedResponse("OtfJobStatus", await s.handlers.status(request(), jobId))).validation).toMatchObject({ state: "queued" });
      expect(start).toHaveBeenCalledTimes(2); expect(await requiredElement(start.mock.results, 1).value).toMatchObject({ kind: "started" });
      expect(s.power.startCalls).toBe(startsBefore + 1);
      s.store.power.state = "running";
      await s.handlers.status(request(), jobId);
      expect(start).toHaveBeenCalledTimes(2);
    });
    it("finishes an unclaimed validation error on read after the start timeout", async () => {
      const s = setup(); const jobId = await delivered(s);
      const first = await parsedResponse("OtfValidation", await s.handlers.validate(request(), jobId));
      s.advance(START_TIMEOUT_MS - 1);
      expect((await parsedResponse("OtfJobStatus", await s.handlers.status(request(), jobId))).validation).toMatchObject({ state: "queued" });
      s.advance(1);
      expect((await parsedResponse("OtfJobStatus", await s.handlers.status(request(), jobId))).validation)
        .toMatchObject({ validation_id: first.validation_id, state: "error" });
      const next = await s.handlers.validate(request(), jobId);
      expect(next.status).toBe(201); expect((await parsedResponse("OtfValidation", next)).validation_id).not.toBe(first.validation_id);
    });
    it("refuses a validation while its host is unavailable", async () => {
      const s = setup(); const jobId = await delivered(s); s.deps.config.hosts["task-report"].enabled = false;
      const response = await s.handlers.validate(request(), jobId);
      expect((await parsedResponse("OtfErrorBody", response)).error.code).toBe("host_unavailable"); expect(s.store.validations.size).toBe(0);
    });
  });

  describe("test reset", () => {
    const resetRequest = (value: unknown) => new Request("https://synthetic.invalid/api/factory/otf/test/reset", { method: "POST", body: JSON.stringify(value) });
    it("answers 404 outside test mode and when no reset is bound", async () => {
      const reset = vi.fn(() => true);
      setOtfTestReset(reset);
      try {
        expect((await handleOtfTestReset(resetRequest({ scenario: "delivered" }), {})).status).toBe(404);
        expect((await handleOtfTestReset(resetRequest({ scenario: "delivered" }), { RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "preview" })).status).toBe(404);
        expect((await testResetRoute(resetRequest({ scenario: "delivered" }))).status).toBe(process.env.RBW_FACTORY_TEST_MODE === "1" ? 200 : 404);
      } finally { setOtfTestReset(null); }
      expect((await handleOtfTestReset(resetRequest({ scenario: "delivered" }), { RBW_FACTORY_TEST_MODE: "1" })).status).toBe(404);
    });
    it("resets the bound test world in test mode and refuses an unknown scenario", async () => {
      const reset = vi.fn((scenario: string) => scenario === "delivered");
      setOtfTestReset(reset);
      try {
        const env = { RBW_FACTORY_TEST_MODE: "1" };
        const good = await handleOtfTestReset(resetRequest({ scenario: "delivered" }), env);
        expect(good.status).toBe(200); expect(await good.json()).toEqual({ scenario: "delivered" });
        expect((await handleOtfTestReset(resetRequest({ scenario: "unknown" }), env)).status).toBe(400);
        expect((await handleOtfTestReset(resetRequest({ scenario: "delivered", extra: 1 }), env)).status).toBe(400);
        expect(reset).toHaveBeenCalledTimes(2);
      } finally { setOtfTestReset(null); }
    });
  });
});
