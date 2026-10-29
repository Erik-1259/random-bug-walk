// The on-demand builder lifecycle (docs/otf/SPEC.md section 4) against an in-memory store with the
// parts the lifecycle uses (jobs, events, the builder heartbeat, the power row and its log), a
// scripted VmPower that records every call, and a settable clock. Every value is synthetic.
import { describe, expect, it } from "vitest";
import {
  BUILDER_FRESH_MS,
  BUILDER_LOST_MS,
  MAX_UPTIME_MS,
  OTF_DEFAULTS,
  START_TIMEOUT_MS,
  StartError,
  WATCHDOG_AFTER_LAST_JOB_MS,
  WATCHDOG_MIN_INTERVAL_MS,
  WATCHDOG_NO_HEARTBEAT_MS,
  type NebiusInstanceState,
  type OtfEvent,
  type OtfHostId,
  type OtfJobRecord,
  type OtfJobState,
  type OtfPowerLogEntry,
  type OtfPowerRecord,
  type OtfStore,
  type OtfValidationRecord,
  type OtfValidationState,
  type ProductionEvent,
  type VmPower,
} from "../../src/otf/contract.ts";
import {
  INSTANCE_STATE_STALE_MS,
  START_BACKOFF_MS,
  START_FAILURES_BEFORE_BACKOFF,
  START_SETTLE_MS,
  STOPPING_GRACE_MS,
  builderState,
  freshReadyHosts,
  hostNotReadyReason,
  powerCron,
  requestStart,
  runWatchdog,
  startBlock,
  stopRule,
  vmSecondsUsed,
  type PowerDeps,
} from "../../src/otf/power/lifecycle.ts";

const T0 = Date.parse("2026-11-02T10:00:00.000Z");

class Clock {
  at: number;
  constructor(at: number = T0) {
    this.at = at;
  }
  now = (): Date => new Date(this.at);
  advance(ms: number): void {
    this.at += ms;
  }
  iso(offsetMs = 0): string {
    return new Date(this.at + offsetMs).toISOString();
  }
}

function powerRow(overrides: Partial<OtfPowerRecord> = {}): OtfPowerRecord {
  return {
    state: "stopped",
    since: new Date(T0 - 3_600_000).toISOString(),
    preset: "synthetic-preset",
    instance_state: null,
    last_api_call_at: null,
    last_start_at: null,
    last_stop_at: null,
    start_failures: 0,
    running_since: null,
    last_job_finished_at: null,
    vm_seconds_today: 0,
    vm_day: new Date(T0).toISOString().slice(0, 10),
    hold_until: null,
    ...overrides,
  };
}

let jobCounter = 0;

function job(state: OtfJobState, overrides: Partial<OtfJobRecord> = {}): OtfJobRecord {
  jobCounter += 1;
  const id = `00000000-0000-4000-8000-${String(jobCounter).padStart(12, "0")}`;
  return {
    job_id: id,
    client_key: `synthetic-key-${String(jobCounter)}`,
    create_sha256: "0".repeat(64),
    created_at: new Date(T0).toISOString(),
    host_id: "task-report",
    criterion_id: "concurrency.lost-acknowledged-change",
    sentence: "synthetic sentence",
    spec: { title: "Synthetic", where: "synthetic", change: "synthetic", why_tests_miss: "synthetic", checks_to_add: ["synthetic"], fix: "synthetic" },
    spec_sha256: "1".repeat(64),
    state,
    outcome: null,
    reason: null,
    claimed_by: null,
    claimed_at: null,
    lease_until: null,
    deadline_at: null,
    last_builder_post_at: null,
    stop_requested_at: null,
    stop_reason: null,
    winner_lane: null,
    winner_model: null,
    model_microusd: 0,
    catalog_request_id: null,
    certificate: null,
    finished_at: null,
    ...overrides,
  };
}

let validationCounter = 0;

/** A validation of a delivered job, claimed by the synthetic builder once it runs. */
function validationOf(owner: OtfJobRecord, state: OtfValidationState, overrides: Partial<OtfValidationRecord> = {}): OtfValidationRecord {
  validationCounter += 1;
  return {
    validation_id: `11111111-1111-4111-8111-${String(validationCounter).padStart(12, "0")}`,
    job_id: owner.job_id,
    state,
    cells: null,
    admission: null,
    started_at: new Date(T0 - 5 * 60_000).toISOString(),
    finished_at: null,
    claimed_by: state === "queued" ? null : "synthetic-builder",
    ...overrides,
  };
}

function unused(name: string): never {
  throw new Error(`the power fake does not implement ${name}`);
}

class FakeStore implements OtfStore {
  power: OtfPowerRecord;
  jobs: OtfJobRecord[];
  events: { job_id: string; event: OtfEvent }[] = [];
  log: OtfPowerLogEntry[] = [];
  validations: OtfValidationRecord[] = [];
  lastSeen: string | null;
  readyHosts: OtfHostId[] = ["task-report", "umami"];
  lockDepth = 0;
  lockCount = 0;

  constructor(power: OtfPowerRecord, jobs: OtfJobRecord[] = [], lastSeen: string | null = null) {
    this.power = power;
    this.jobs = jobs;
    this.lastSeen = lastSeen;
  }

  eventsOf(job_id: string): ProductionEvent["type"][] {
    return this.events.filter((entry) => entry.job_id === job_id).map((entry) => entry.event.type as ProductionEvent["type"]);
  }

  jobById(job_id: string): OtfJobRecord {
    const found = this.jobs.find((entry) => entry.job_id === job_id);
    if (found === undefined) throw new Error("no such job");
    return found;
  }

  listJobs(states: readonly OtfJobState[]): Promise<OtfJobRecord[]> {
    return Promise.resolve(this.jobs.filter((entry) => states.includes(entry.state)).map((entry) => ({ ...entry })));
  }

  updateJob(job_id: string, whenStates: readonly OtfJobState[], patch: Parameters<OtfStore["updateJob"]>[2]): Promise<OtfJobRecord | null> {
    const found = this.jobs.find((entry) => entry.job_id === job_id);
    if (found === undefined || !whenStates.includes(found.state)) return Promise.resolve(null);
    Object.assign(found, patch);
    return Promise.resolve({ ...found });
  }

  appendJobEvent(job_id: string, event: ProductionEvent, at: string): Promise<OtfEvent> {
    const stored = { ...event, seq: this.events.filter((entry) => entry.job_id === job_id).length + 1, at } as OtfEvent;
    this.events.push({ job_id, event: stored });
    return Promise.resolve(stored);
  }

  lastBuilderSeen(): ReturnType<OtfStore["lastBuilderSeen"]> {
    return Promise.resolve(this.lastSeen === null ? null : { builder_id: "synthetic-builder", builder_revision: "synthetic-rev", boot_id: "synthetic-boot", booted_at: this.lastSeen, ready_hosts: [...this.readyHosts], last_seen_at: this.lastSeen });
  }

  getPower(): Promise<OtfPowerRecord> {
    return Promise.resolve({ ...this.power });
  }

  /** Runs once when the lock is next taken, before the locked work: a claim racing the watchdog. */
  beforeLock: (() => void) | null = null;

  async withPowerLock<T>(fn: (power: OtfPowerRecord) => Promise<{ patch: Partial<OtfPowerRecord> | null; log: OtfPowerLogEntry[]; result: T }>): Promise<T> {
    if (this.lockDepth > 0) throw new Error("the power lock is not reentrant");
    const hook = this.beforeLock;
    this.beforeLock = null;
    hook?.();
    this.lockDepth += 1;
    this.lockCount += 1;
    try {
      const { patch, log, result } = await fn({ ...this.power });
      if (patch !== null) this.power = { ...this.power, ...patch };
      this.log.push(...log);
      return result;
    } finally {
      this.lockDepth -= 1;
    }
  }

  createJob = (): never => unused("createJob");
  getJob = (): never => unused("getJob");
  countJobsCreatedSince = (): never => unused("countJobsCreatedSince");
  totalModelMicrousd = (): never => unused("totalModelMicrousd");
  appendBuilderEvents = (): never => unused("appendBuilderEvents");
  listEvents = (): never => unused("listEvents");
  recordBuilderSeen = (): never => unused("recordBuilderSeen");
  claimNext = (): never => unused("claimNext");
  storeDelivery = (): never => unused("storeDelivery");
  listArtifacts = (): never => unused("listArtifacts");
  getArtifact = (): never => unused("getArtifact");
  createValidation = (): never => unused("createValidation");
  getValidation = (): never => unused("getValidation");
  latestValidation(job_id: string): Promise<OtfValidationRecord | null> {
    const found = this.validations.filter((entry) => entry.job_id === job_id).at(-1);
    return Promise.resolve(found === undefined ? null : { ...found });
  }

  updateValidation(validation_id: string, whenStates: readonly OtfValidationState[], patch: Parameters<OtfStore["updateValidation"]>[2]): Promise<OtfValidationRecord | null> {
    const found = this.validations.find((entry) => entry.validation_id === validation_id);
    if (found === undefined || !whenStates.includes(found.state)) return Promise.resolve(null);
    Object.assign(found, patch);
    return Promise.resolve({ ...found });
  }

  validationById(validation_id: string): OtfValidationRecord {
    const found = this.validations.find((entry) => entry.validation_id === validation_id);
    if (found === undefined) throw new Error("no such validation");
    return found;
  }
}

/** A VmPower whose instance state the test sets; it records every call in order. */
class FakePower implements VmPower {
  state: NebiusInstanceState;
  calls: ("get" | "start" | "stop")[] = [];
  startFailure: StartError | null = null;
  stopFailure: Error | null = null;
  getFailure: Error | null = null;
  constructor(state: NebiusInstanceState = "STOPPED") {
    this.state = state;
  }
  /** Runs during the next Get: a builder post that lands while the cloud call is in flight. */
  duringGet: (() => void) | null = null;
  get(): Promise<{ state: NebiusInstanceState; preset: string }> {
    this.calls.push("get");
    const hook = this.duringGet;
    this.duringGet = null;
    hook?.();
    if (this.getFailure !== null) return Promise.reject(this.getFailure);
    return Promise.resolve({ state: this.state, preset: "synthetic-preset" });
  }
  start(): Promise<{ operation_id: string }> {
    this.calls.push("start");
    if (this.startFailure !== null) return Promise.reject(this.startFailure);
    if (this.state === "STOPPED") this.state = "STARTING";
    return Promise.resolve({ operation_id: `synthetic-op-${String(this.calls.length)}` });
  }
  stop(): Promise<{ operation_id: string }> {
    this.calls.push("stop");
    if (this.stopFailure !== null) return Promise.reject(this.stopFailure);
    if (this.state === "RUNNING" || this.state === "STARTING") this.state = "STOPPING";
    return Promise.resolve({ operation_id: `synthetic-op-${String(this.calls.length)}` });
  }
}

// ---- helpers

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY_CAP_S = OTF_DEFAULTS.vm_hours_per_day * 3600;

function deps(store: FakeStore, power: FakePower | null, clock: Clock, vmHoursPerDay?: number): PowerDeps {
  return vmHoursPerDay === undefined ? { store, power, now: clock.now } : { store, power, now: clock.now, vmHoursPerDay };
}

/** A power row for an instance the last Get (`seenAgoMs` ago) saw RUNNING since `upForMs`. */
function runningRow(clock: Clock, upForMs: number, seenAgoMs: number, overrides: Partial<OtfPowerRecord> = {}): OtfPowerRecord {
  return powerRow({ state: "running", since: clock.iso(-upForMs), instance_state: "RUNNING", running_since: clock.iso(-upForMs), last_start_at: clock.iso(-upForMs), last_api_call_at: clock.iso(-seenAgoMs), ...overrides });
}

// ---- derived state

describe("builderState", () => {
  const clock = new Clock();
  it("is running only with a heartbeat younger than BUILDER_FRESH_MS", () => {
    const row = powerRow({ state: "starting", instance_state: "RUNNING" });
    expect(builderState(row, clock.iso(-(BUILDER_FRESH_MS - 1)), clock.now())).toBe("running");
    expect(builderState(row, clock.iso(-BUILDER_FRESH_MS), clock.now())).toBe("starting");
  });
  it("reads stopping once a stop was granted, even while the builder still heartbeats", () => {
    expect(builderState(powerRow({ state: "stopping", instance_state: "RUNNING" }), clock.iso(-1000), clock.now())).toBe("stopping");
  });
  it("reads an instance that is up without a heartbeat as starting, and maps the other instance states", () => {
    expect(builderState(powerRow({ state: "unknown", instance_state: "RUNNING" }), null, clock.now())).toBe("starting");
    expect(builderState(powerRow({ state: "unknown", instance_state: "STOPPED" }), null, clock.now())).toBe("stopped");
    expect(builderState(powerRow({ state: "unknown", instance_state: "STOPPING" }), null, clock.now())).toBe("stopping");
    expect(builderState(powerRow({ state: "unknown", instance_state: null }), null, clock.now())).toBe("unknown");
    expect(builderState(powerRow({ state: "stopped", instance_state: null }), null, clock.now())).toBe("stopped");
  });
});

describe("vmSecondsUsed", () => {
  it("adds the open interval to the closed seconds of today", () => {
    const clock = new Clock();
    expect(vmSecondsUsed(powerRow({ vm_seconds_today: 600, running_since: clock.iso(-30 * MIN) }), clock.now())).toBe(600 + 1800);
  });
  it("counts only today's part of an interval that began yesterday, and drops yesterday's closed seconds", () => {
    const clock = new Clock(Date.parse("2026-11-03T00:20:00.000Z"));
    const row = powerRow({ vm_day: "2026-11-02", vm_seconds_today: 5000, running_since: "2026-11-02T23:00:00.000Z" });
    expect(vmSecondsUsed(row, clock.now())).toBe(20 * 60);
  });
});

describe("startBlock", () => {
  const clock = new Clock();
  const power = new FakePower();
  it("blocks without credentials, under the operator hold and at the VM-hours day cap", () => {
    expect(startBlock(powerRow(), clock.now(), { power: null })).toBe("unconfigured");
    expect(startBlock(powerRow({ hold_until: clock.iso(MIN) }), clock.now(), { power })).toBe("hold");
    expect(startBlock(powerRow({ hold_until: clock.iso(-MIN) }), clock.now(), { power })).toBeNull();
    expect(startBlock(powerRow({ vm_seconds_today: DAY_CAP_S }), clock.now(), { power })).toBe("day_cap");
    expect(startBlock(powerRow({ vm_seconds_today: DAY_CAP_S - 1 }), clock.now(), { power })).toBeNull();
    expect(startBlock(powerRow({ vm_seconds_today: 3 * 3600 }), clock.now(), { power, vmHoursPerDay: 3 })).toBe("day_cap");
  });
  it("pauses starts for START_BACKOFF_MS after two failed starts in a row", () => {
    const failed = (agoMs: number) => powerRow({ start_failures: START_FAILURES_BEFORE_BACKOFF, last_start_at: clock.iso(-agoMs) });
    expect(startBlock(failed(MIN), clock.now(), { power })).toBe("start_backoff");
    expect(startBlock(failed(START_BACKOFF_MS), clock.now(), { power })).toBeNull();
    expect(startBlock(powerRow({ start_failures: 1, last_start_at: clock.iso(-MIN) }), clock.now(), { power })).toBeNull();
  });
});

// ---- start on create

describe("requestStart", () => {
  it("sends one Start from a stopped machine and appends builder_starting to every waiting job", async () => {
    const clock = new Clock();
    const a = job("starting_builder");
    const b = job("starting_builder");
    const store = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-5 * MIN) }), [a, b]);
    const power = new FakePower("STOPPED");
    const result = await requestStart(deps(store, power, clock));
    expect(result).toEqual({ kind: "started", requested_at: clock.iso() });
    expect(power.calls).toEqual(["start"]);
    expect(store.power).toMatchObject({ state: "starting", instance_state: "STARTING", last_start_at: clock.iso(), last_api_call_at: clock.iso(), running_since: clock.iso() });
    expect(store.eventsOf(a.job_id)).toEqual(["builder_starting"]);
    expect(store.eventsOf(b.job_id)).toEqual(["builder_starting"]);
    expect(store.events[0]?.event).toMatchObject({ data: { preset: "synthetic-preset", requested_at: clock.iso() } });
    expect(store.log).toEqual([{ at: clock.iso(), actor: "create", action: "start", before: "STOPPED", after: "STARTING", operation_id: "synthetic-op-1" }]);
  });

  it("only queues a second create while the first start is in flight", async () => {
    const clock = new Clock();
    const store = new FakeStore(powerRow(), [job("starting_builder")]);
    const power = new FakePower("STOPPED");
    await requestStart(deps(store, power, clock));
    clock.advance(45_000);
    store.jobs.push(job("starting_builder"));
    expect(await requestStart(deps(store, power, clock))).toEqual({ kind: "starting" });
    expect(power.calls).toEqual(["start"]);
  });

  it("makes no call while the builder heartbeat is fresh", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, HOUR, 5 * MIN), [job("queued")], clock.iso(-10_000));
    const power = new FakePower("RUNNING");
    expect(await requestStart(deps(store, power, clock))).toEqual({ kind: "running" });
    expect(power.calls).toEqual([]);
  });

  it("defers within WATCHDOG_MIN_INTERVAL_MS of the last cloud call", async () => {
    const clock = new Clock();
    const store = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-(WATCHDOG_MIN_INTERVAL_MS - 1)) }), [job("starting_builder")]);
    const power = new FakePower("STOPPED");
    expect(await requestStart(deps(store, power, clock))).toEqual({ kind: "deferred" });
    expect(power.calls).toEqual([]);
  });

  it("answers unavailable under the operator hold, at the day cap and without credentials, with no call", async () => {
    const clock = new Clock();
    const power = new FakePower("STOPPED");
    const held = new FakeStore(powerRow({ hold_until: clock.iso(HOUR) }), [job("starting_builder")]);
    expect(await requestStart(deps(held, power, clock))).toEqual({ kind: "unavailable", block: "hold" });
    const capped = new FakeStore(powerRow({ vm_seconds_today: DAY_CAP_S }), [job("starting_builder")]);
    expect(await requestStart(deps(capped, power, clock))).toEqual({ kind: "unavailable", block: "day_cap" });
    expect(await requestStart(deps(new FakeStore(powerRow()), null, clock))).toEqual({ kind: "unavailable", block: "unconfigured" });
    expect(power.calls).toEqual([]);
  });

  it("finishes every waiting job builder_start_failed on a capacity error, then backs off after the second", async () => {
    const clock = new Clock();
    const waiting = job("starting_builder");
    const store = new FakeStore(powerRow({ instance_state: "STOPPED" }), [waiting]);
    const power = new FakePower("STOPPED");
    power.startFailure = new StartError("capacity", "synthetic capacity failure");
    expect(await requestStart(deps(store, power, clock))).toEqual({ kind: "failed", reason: "capacity" });
    expect(store.jobById(waiting.job_id)).toMatchObject({ state: "finished", outcome: "builder_start_failed", reason: "capacity", finished_at: clock.iso() });
    expect(store.eventsOf(waiting.job_id)).toEqual(["builder_starting", "builder_start_failed", "job_finished"]);
    expect(store.power).toMatchObject({ start_failures: 1, state: "stopped" });
    expect(store.log[0]).toMatchObject({ actor: "create", action: "start", after: "error:capacity" });

    clock.advance(WATCHDOG_MIN_INTERVAL_MS);
    store.jobs.push(job("starting_builder"));
    expect(await requestStart(deps(store, power, clock))).toEqual({ kind: "failed", reason: "capacity" });
    clock.advance(WATCHDOG_MIN_INTERVAL_MS);
    expect(await requestStart(deps(store, power, clock))).toEqual({ kind: "unavailable", block: "start_backoff" });
    expect(power.calls).toEqual(["start", "start"]);
  });

  it("reports a non-capacity start error as api_error", async () => {
    const clock = new Clock();
    const store = new FakeStore(powerRow(), [job("starting_builder")]);
    const power = new FakePower("STOPPED");
    power.startFailure = new StartError("api_error", "synthetic failure");
    expect(await requestStart(deps(store, power, clock))).toEqual({ kind: "failed", reason: "api_error" });
  });

  it("checks with a Get while a stop is in progress, and the watchdog starts the machine once it reports stopped", async () => {
    const clock = new Clock();
    const waiting = job("starting_builder");
    const store = new FakeStore(runningRow(clock, HOUR, 5 * MIN, { state: "stopping", since: clock.iso(-MIN) }), [waiting], clock.iso(-5000));
    const power = new FakePower("STOPPED");
    expect(await requestStart(deps(store, power, clock))).toEqual({ kind: "deferred" });
    expect(power.calls).toEqual(["get"]);
    expect(store.power).toMatchObject({ state: "stopped", instance_state: "STOPPED", running_since: null });

    clock.advance(WATCHDOG_MIN_INTERVAL_MS);
    store.lastSeen = null;
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "start", reason: "jobs_waiting" });
    expect(power.calls).toEqual(["get", "start"]);
    expect(store.eventsOf(waiting.job_id)).toEqual(["builder_starting"]);
  });
});

// ---- the watchdog

describe("runWatchdog", () => {
  it("makes at most one cloud call per WATCHDOG_MIN_INTERVAL_MS", async () => {
    const clock = new Clock();
    const store = new FakeStore(powerRow({ instance_state: null }));
    const power = new FakePower("STOPPED");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get", reason: "refresh" });
    clock.advance(WATCHDOG_MIN_INTERVAL_MS - 1);
    const locks = store.lockCount;
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "none", reason: "rate_limited" });
    expect(store.lockCount).toBe(locks);
    clock.advance(1);
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    expect(power.calls).toEqual(["get", "get"]);
  });

  it("refreshes a stale instance state with a Get before acting on it", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, 4 * HOUR, INSTANCE_STATE_STALE_MS));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    clock.advance(WATCHDOG_MIN_INTERVAL_MS);
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop" });
    expect(power.calls).toEqual(["get", "stop"]);
  });

  it("stops a running machine that has sent no heartbeat for 10 min, and finishes its silent jobs builder_lost", async () => {
    const clock = new Clock();
    const silent = job("building", { claimed_at: clock.iso(-20 * MIN), last_builder_post_at: clock.iso(-WATCHDOG_NO_HEARTBEAT_MS) });
    const store = new FakeStore(runningRow(clock, HOUR, MIN), [silent], clock.iso(-WATCHDOG_NO_HEARTBEAT_MS));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "no_heartbeat" });
    expect(store.power).toMatchObject({ state: "stopping", instance_state: "STOPPING", last_stop_at: clock.iso() });
    expect(store.jobById(silent.job_id)).toMatchObject({ state: "finished", outcome: "builder_lost", reason: "builder_stopped" });
    expect(store.log).toEqual([{ at: clock.iso(), actor: "watchdog", action: "stop", before: "RUNNING", after: "STOPPING", operation_id: "synthetic-op-1" }]);
  });

  it("measures the heartbeat silence of a fresh boot from the start, not from an old heartbeat", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, 9 * MIN, MIN, { state: "starting" }), [], clock.iso(-5 * HOUR));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    clock.advance(WATCHDOG_MIN_INTERVAL_MS + MIN);
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "no_heartbeat" });
  });

  it("never stops while a job is building with a fresh post, not even past MAX_UPTIME_MS or the day cap", async () => {
    const clock = new Clock();
    const building = job("building", { claimed_at: clock.iso(-30 * MIN), last_builder_post_at: clock.iso(-10_000) });
    const store = new FakeStore(runningRow(clock, MAX_UPTIME_MS + HOUR, MIN, { vm_seconds_today: DAY_CAP_S + 3600 }), [building], clock.iso(-10_000));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    expect(power.calls).toEqual(["get"]);
    expect(store.jobById(building.job_id).state).toBe("building");
  });

  it("does not stop for a job claimed between the watchdog's job listing and its lock", async () => {
    const clock = new Clock();
    const queued = job("queued", { created_at: clock.iso(-MIN) });
    const store = new FakeStore(runningRow(clock, MAX_UPTIME_MS + HOUR, MIN), [queued], clock.iso(-10_000));
    store.beforeLock = () => {
      Object.assign(store.jobById(queued.job_id), { state: "building", claimed_by: "synthetic-builder", claimed_at: clock.iso() });
    };
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    expect(power.calls).toEqual(["get"]);
    expect(store.jobById(queued.job_id).state).toBe("building");
  });

  it("never stops at the day cap while a validation runs with a fresh heartbeat, and ends it error when a later stop cuts it off", async () => {
    const clock = new Clock();
    const delivered = job("finished", { outcome: "delivered", finished_at: clock.iso(-20 * MIN) });
    const store = new FakeStore(runningRow(clock, HOUR, MIN, { vm_seconds_today: DAY_CAP_S }), [delivered], clock.iso(-10_000));
    const running = validationOf(delivered, "running");
    store.validations.push(running);
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    expect(power.calls).toEqual(["get"]);
    expect(store.validationById(running.validation_id).state).toBe("running");

    // The builder falls silent: past BUILDER_LOST_MS the day cap stops the machine, and the
    // validation it was running ends error instead of staying running for good.
    clock.advance(BUILDER_LOST_MS);
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "day_cap" });
    expect(power.calls).toEqual(["get", "stop"]);
    expect(store.validationById(running.validation_id)).toMatchObject({ state: "error", finished_at: clock.iso() });
  });

  it("ends a running validation error when the no-heartbeat rule stops the machine", async () => {
    const clock = new Clock();
    const delivered = job("finished", { outcome: "delivered", finished_at: clock.iso(-HOUR) });
    const store = new FakeStore(runningRow(clock, HOUR, MIN), [delivered], clock.iso(-WATCHDOG_NO_HEARTBEAT_MS));
    const running = validationOf(delivered, "running");
    const earlier = validationOf(delivered, "passed", { finished_at: clock.iso(-30 * MIN) });
    store.validations.push(earlier, running);
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "no_heartbeat" });
    expect(store.validationById(running.validation_id)).toMatchObject({ state: "error", finished_at: clock.iso() });
    expect(store.validationById(earlier.validation_id).state).toBe("passed");
  });

  it("does not stop for a validation claimed between the watchdog's listings and its lock", async () => {
    const clock = new Clock();
    const delivered = job("finished", { outcome: "delivered", finished_at: clock.iso(-20 * MIN) });
    const store = new FakeStore(runningRow(clock, HOUR, MIN, { vm_seconds_today: DAY_CAP_S }), [delivered], clock.iso(-10 * MIN + 1));
    const queued = validationOf(delivered, "queued");
    store.validations.push(queued);
    store.beforeLock = () => {
      Object.assign(store.validationById(queued.validation_id), { state: "running", claimed_by: "synthetic-builder" });
      store.lastSeen = clock.iso();
    };
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    expect(power.calls).toEqual(["get"]);
    expect(store.validationById(queued.validation_id).state).toBe("running");
  });

  it("stops at MAX_UPTIME_MS when no job is building", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, MAX_UPTIME_MS, MIN, { last_job_finished_at: clock.iso(-10 * MIN) }), [job("queued")], clock.iso(-5000));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "max_uptime" });
  });

  it("stops 90 min after the last job finished, and not before", async () => {
    const clock = new Clock();
    const done = job("finished", { finished_at: clock.iso(-(WATCHDOG_AFTER_LAST_JOB_MS - MIN)) });
    const store = new FakeStore(runningRow(clock, 2 * HOUR, MIN), [done], clock.iso(-5000));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    expect(store.power.last_job_finished_at).toBe(done.finished_at);
    clock.advance(MIN);
    store.lastSeen = clock.iso(-5000);
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "after_last_job" });
  });

  it("stops an idle machine at the VM-hours day cap", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, HOUR, MIN, { vm_seconds_today: DAY_CAP_S - 3600 }), [], clock.iso(-5000));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "day_cap" });
  });

  it("finishes a granted stop the machine has not followed within STOPPING_GRACE_MS", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, HOUR, MIN, { state: "stopping", since: clock.iso(-STOPPING_GRACE_MS) }), [], clock.iso(-5000));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "stopping_stuck" });
  });

  it("under the operator hold only reads the instance, never starts or stops it", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, 5 * HOUR, MIN, { hold_until: clock.iso(HOUR) }), [job("starting_builder")], clock.iso(-HOUR));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get", reason: "hold" });
    store.power = { ...store.power, instance_state: "STOPPED", state: "stopped", running_since: null };
    clock.advance(WATCHDOG_MIN_INTERVAL_MS);
    power.state = "STOPPED";
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get", reason: "hold" });
    expect(power.calls).toEqual(["get", "get"]);
  });

  it("starts a stopped machine for waiting jobs, and not without them", async () => {
    const clock = new Clock();
    const idle = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-MIN) }));
    const idlePower = new FakePower("STOPPED");
    expect(await runWatchdog(deps(idle, idlePower, clock))).toMatchObject({ action: "get" });
    const queued = job("queued");
    const busy = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-MIN) }), [queued]);
    const busyPower = new FakePower("STOPPED");
    expect(await runWatchdog(deps(busy, busyPower, clock))).toMatchObject({ action: "start", reason: "jobs_waiting" });
    expect(busy.log[0]).toMatchObject({ actor: "watchdog", action: "start" });
  });

  it("counts a start the instance never followed as a failed start", async () => {
    const clock = new Clock();
    const waiting = job("starting_builder");
    const store = new FakeStore(powerRow({ state: "starting", instance_state: "STARTING", last_start_at: clock.iso(-START_SETTLE_MS), last_api_call_at: clock.iso(-START_SETTLE_MS), running_since: clock.iso(-START_SETTLE_MS) }), [waiting]);
    const power = new FakePower("STOPPED");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    expect(store.power).toMatchObject({ state: "stopped", start_failures: 1, running_since: null });
    expect(store.jobById(waiting.job_id)).toMatchObject({ state: "finished", outcome: "builder_start_failed", reason: "api_error" });
  });

  it("finishes builder_start_failed (timeout) a job with no healthy claim START_TIMEOUT_MS after the start", async () => {
    const clock = new Clock();
    const early = job("starting_builder", { created_at: clock.iso(-START_TIMEOUT_MS - MIN) });
    const late = job("starting_builder", { created_at: clock.iso(-MIN) });
    const store = new FakeStore(powerRow({ state: "starting", instance_state: "RUNNING", last_start_at: clock.iso(-START_TIMEOUT_MS), running_since: clock.iso(-START_TIMEOUT_MS), last_api_call_at: clock.iso(-10_000) }), [early, late]);
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "none", timed_out: 1 });
    expect(store.jobById(early.job_id)).toMatchObject({ outcome: "builder_start_failed", reason: "timeout" });
    expect(store.eventsOf(early.job_id)).toEqual(["builder_start_failed", "job_finished"]);
    expect(store.jobById(late.job_id).state).toBe("starting_builder");
  });

  it("times out a queued job whose restarted machine never claimed, and keeps one queued behind a healthy builder", async () => {
    const clock = new Clock();
    const queued = job("queued", { created_at: clock.iso(-20 * MIN) });
    const row = powerRow({ state: "starting", instance_state: "RUNNING", last_start_at: clock.iso(-START_TIMEOUT_MS), running_since: clock.iso(-START_TIMEOUT_MS), last_api_call_at: clock.iso(-10_000) });
    const silent = new FakeStore(row, [queued], clock.iso(-30 * MIN));
    expect(await runWatchdog(deps(silent, new FakePower("RUNNING"), clock))).toMatchObject({ action: "none", timed_out: 1 });
    expect(silent.jobById(queued.job_id)).toMatchObject({ state: "finished", outcome: "builder_start_failed", reason: "timeout" });
    const waiting = job("queued", { created_at: clock.iso(-20 * MIN) });
    const healthy = new FakeStore({ ...row, state: "running" }, [waiting], clock.iso(-5000));
    expect(await runWatchdog(deps(healthy, new FakePower("RUNNING"), clock))).toMatchObject({ timed_out: 0 });
    expect(healthy.jobById(waiting.job_id).state).toBe("queued");
    const older = job("queued", { created_at: clock.iso(-20 * MIN) });
    const startedBefore = new FakeStore({ ...row, last_start_at: clock.iso(-30 * MIN) }, [older], clock.iso(-15 * MIN));
    expect(await runWatchdog(deps(startedBefore, new FakePower("RUNNING"), clock))).toMatchObject({ timed_out: 0 });
  });

  it("finishes builder_unavailable a queued job whose host the fresh heartbeat leaves out, and keeps the other host's job", async () => {
    const clock = new Clock();
    const umami = job("queued", { host_id: "umami", criterion_id: "date_time.time-zone-grouping", created_at: clock.iso(-MIN) });
    const taskReport = job("queued", { created_at: clock.iso(-MIN) });
    const store = new FakeStore(runningRow(clock, HOUR, 5 * MIN), [umami, taskReport], clock.iso(-5000));
    store.readyHosts = ["task-report"];
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get", timed_out: 1 });
    expect(store.jobById(umami.job_id)).toMatchObject({ state: "finished", outcome: "builder_unavailable", reason: hostNotReadyReason("umami") });
    expect(hostNotReadyReason("umami")).toContain("Umami");
    expect(store.eventsOf(umami.job_id)).toEqual(["job_finished"]);
    expect(store.jobById(taskReport.job_id).state).toBe("queued");
    // Within the API interval the pass makes no call and still finishes such a job.
    const late = job("queued", { host_id: "umami", criterion_id: "date_time.time-zone-grouping", created_at: clock.iso() });
    store.jobs.push(late);
    clock.advance(1000);
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "none", reason: "rate_limited", timed_out: 1 });
    expect(store.jobById(late.job_id).outcome).toBe("builder_unavailable");
    expect(power.calls).toEqual(["get"]);
  });

  it("judges readiness by the heartbeat of the claim that promoted a job during the pass", async () => {
    const clock = new Clock();
    const waiting = job("starting_builder", { host_id: "umami", criterion_id: "date_time.time-zone-grouping", created_at: clock.iso(-MIN) });
    const store = new FakeStore(powerRow({ state: "starting", instance_state: "RUNNING", last_start_at: clock.iso(-2 * MIN), running_since: clock.iso(-2 * MIN), last_api_call_at: clock.iso(-MIN) }), [waiting], clock.iso(-5000));
    store.readyHosts = [];
    const power = new FakePower("RUNNING");
    power.duringGet = () => {
      // A recovered builder heartbeats with umami ready and its claim promotes the job.
      store.readyHosts = ["task-report", "umami"];
      store.lastSeen = clock.iso();
      store.jobById(waiting.job_id).state = "queued";
    };
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get", timed_out: 0 });
    expect(store.jobById(waiting.job_id).state).toBe("queued");
  });

  it("checks readiness only against a fresh heartbeat, and leaves a starting_builder job to the start timeout", async () => {
    const clock = new Clock();
    const queued = job("queued", { host_id: "umami", criterion_id: "date_time.time-zone-grouping", created_at: clock.iso(-MIN) });
    const stale = new FakeStore(runningRow(clock, HOUR, 5 * MIN), [queued], clock.iso(-BUILDER_FRESH_MS));
    stale.readyHosts = [];
    expect(await runWatchdog(deps(stale, new FakePower("RUNNING"), clock))).toMatchObject({ timed_out: 0 });
    expect(stale.jobById(queued.job_id).state).toBe("queued");
    const waiting = job("starting_builder", { host_id: "umami", criterion_id: "date_time.time-zone-grouping", created_at: clock.iso(-MIN) });
    const booting = new FakeStore(powerRow({ state: "starting", instance_state: "RUNNING", last_start_at: clock.iso(-MIN), running_since: clock.iso(-MIN), last_api_call_at: clock.iso(-10_000) }), [waiting], clock.iso(-5000));
    booting.readyHosts = [];
    expect(await runWatchdog(deps(booting, new FakePower("RUNNING"), clock))).toMatchObject({ timed_out: 0 });
    expect(booting.jobById(waiting.job_id).state).toBe("starting_builder");
    expect(freshReadyHosts(null, clock.at)).toBeNull();
    expect(freshReadyHosts({ ready_hosts: ["umami"], last_seen_at: clock.iso(-(BUILDER_FRESH_MS - 1)) }, clock.at)).toEqual(["umami"]);
  });

  it("starts a stopped machine for a waiting job of any host", async () => {
    const clock = new Clock();
    const store = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-5 * MIN) }), [job("starting_builder", { host_id: "umami", criterion_id: "date_time.time-zone-grouping" })], clock.iso(-HOUR));
    store.readyHosts = ["task-report"];
    const power = new FakePower("STOPPED");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "start", reason: "jobs_waiting" });
    expect(power.calls).toEqual(["start"]);
  });

  it("finishes builder_unavailable a job that waited out START_TIMEOUT_MS under the operator hold", async () => {
    const clock = new Clock();
    const waiting = job("starting_builder", { created_at: clock.iso(-START_TIMEOUT_MS) });
    const store = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-10_000), hold_until: clock.iso(HOUR) }), [waiting]);
    expect(await runWatchdog(deps(store, new FakePower("STOPPED"), clock))).toMatchObject({ action: "none", timed_out: 1 });
    expect(store.jobById(waiting.job_id)).toMatchObject({ state: "finished", outcome: "builder_unavailable", reason: "hold" });
    expect(store.eventsOf(waiting.job_id)).toEqual(["job_finished"]);
  });

  it("finishes builder_unavailable a queued job whose machine stopped at the day cap, and builder_start_failed one during the start backoff", async () => {
    const clock = new Clock();
    const queued = job("queued", { created_at: clock.iso(-START_TIMEOUT_MS) });
    const capped = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-10_000), vm_seconds_today: DAY_CAP_S }), [queued]);
    expect(await runWatchdog(deps(capped, new FakePower("STOPPED"), clock))).toMatchObject({ timed_out: 1 });
    expect(capped.jobById(queued.job_id)).toMatchObject({ outcome: "builder_unavailable", reason: "day_cap" });
    const backoff = job("queued", { created_at: clock.iso(-START_TIMEOUT_MS) });
    const paused = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-10_000), start_failures: 2, last_start_at: clock.iso(-START_TIMEOUT_MS) }), [backoff]);
    expect(await runWatchdog(deps(paused, new FakePower("STOPPED"), clock))).toMatchObject({ timed_out: 1 });
    expect(paused.jobById(backoff.job_id)).toMatchObject({ outcome: "builder_start_failed", reason: "timeout" });
  });

  it("closes the running interval into vm_seconds_today when a Get sees the instance stopped", async () => {
    const clock = new Clock();
    const store = new FakeStore(powerRow({ state: "stopping", since: clock.iso(-10 * MIN), instance_state: "STOPPING", running_since: clock.iso(-70 * MIN), last_api_call_at: clock.iso(-MIN), vm_seconds_today: 100 }));
    const power = new FakePower("STOPPED");
    await runWatchdog(deps(store, power, clock));
    expect(store.power).toMatchObject({ state: "stopped", instance_state: "STOPPED", running_since: null, vm_seconds_today: 100 + 70 * 60 });
  });

  it("keeps a granted stop in force while the instance runs on with a fresh heartbeat, then enforces it", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, HOUR, MIN, { state: "stopping", since: clock.iso(-MIN) }), [], clock.iso(-2000));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get" });
    expect(store.power.state).toBe("stopping");
    clock.advance(STOPPING_GRACE_MS);
    store.lastSeen = clock.iso(-2000);
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "stop", reason: "stopping_stuck" });
    expect(power.calls).toEqual(["get", "stop"]);
  });

  it("finishes a queued job builder_start_failed when its stopped machine cannot be restarted", async () => {
    const clock = new Clock();
    const queued = job("queued", { created_at: clock.iso(-20 * MIN) });
    const store = new FakeStore(powerRow({ instance_state: "STOPPED", last_api_call_at: clock.iso(-MIN), last_stop_at: clock.iso(-2 * MIN) }), [queued]);
    const power = new FakePower("STOPPED");
    power.startFailure = new StartError("capacity", "synthetic capacity failure");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "start", reason: "jobs_waiting" });
    expect(store.jobById(queued.job_id)).toMatchObject({ state: "finished", outcome: "builder_start_failed", reason: "capacity" });
    expect(store.eventsOf(queued.job_id)).toEqual(["builder_starting", "builder_start_failed", "job_finished"]);
  });

  it("marks the builder running on a fresh heartbeat and clears the start failures", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, 5 * MIN, MIN, { state: "starting", start_failures: 1 }), [], clock.iso(-1000));
    const power = new FakePower("RUNNING");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get", reason: "refresh" });
    expect(store.power).toMatchObject({ state: "running", start_failures: 0, instance_state: "RUNNING" });
  });

  it("answers unconfigured without credentials and records a failed Get as an error", async () => {
    const clock = new Clock();
    expect(await runWatchdog(deps(new FakeStore(powerRow()), null, clock))).toMatchObject({ action: "none", reason: "unconfigured" });
    const store = new FakeStore(powerRow());
    const power = new FakePower("STOPPED");
    power.getFailure = new Error("synthetic outage");
    expect(await runWatchdog(deps(store, power, clock))).toMatchObject({ action: "get", reason: "error" });
    expect(store.power.last_api_call_at).toBe(clock.iso());
    expect(store.log[0]).toMatchObject({ action: "get", after: "error" });
  });

  it("resets the day counter on a new UTC day", async () => {
    const clock = new Clock(Date.parse("2026-11-03T00:05:00.000Z"));
    const store = new FakeStore(powerRow({ vm_day: "2026-11-02", vm_seconds_today: 40_000, last_api_call_at: clock.iso(-MIN) }));
    await runWatchdog(deps(store, new FakePower("STOPPED"), clock));
    expect(store.power).toMatchObject({ vm_day: "2026-11-03", vm_seconds_today: 0 });
  });
});

describe("stopRule", () => {
  it("names no rule for a machine that is busy, fresh and young", () => {
    const clock = new Clock();
    const row = runningRow(clock, HOUR, MIN);
    expect(stopRule(row, [job("queued")], clock.at - 5000, null, clock.at, DAY_CAP_S)).toBeNull();
  });

  it("counts an open validation as open work for after_last_job", () => {
    const clock = new Clock();
    const row = runningRow(clock, 2 * HOUR, MIN, { last_job_finished_at: clock.iso(-WATCHDOG_AFTER_LAST_JOB_MS) });
    const delivered = job("finished", { outcome: "delivered", finished_at: clock.iso(-WATCHDOG_AFTER_LAST_JOB_MS) });
    const lastFinished = clock.at - WATCHDOG_AFTER_LAST_JOB_MS;
    expect(stopRule(row, [], clock.at - 5000, lastFinished, clock.at, DAY_CAP_S)).toBe("after_last_job");
    expect(stopRule(row, [], clock.at - 5000, lastFinished, clock.at, DAY_CAP_S, [validationOf(delivered, "queued")])).toBeNull();
  });
});

// ---- the cron route

describe("powerCron", () => {
  const SECRET = "x".repeat(40);
  const request = (authorization: string | null) => new Request("https://otf.invalid/api/factory/otf/cron/power", { headers: authorization === null ? {} : { authorization } });

  it("answers unavailable without CRON_SECRET and unauthorized for a wrong or missing bearer", async () => {
    const resolve = () => Promise.reject(new Error("must not resolve"));
    const unset = await powerCron(request(`Bearer ${SECRET}`), null, resolve, () => undefined);
    expect(unset.status).toBe(503);
    expect(await unset.json()).toMatchObject({ contract_version: "otf/0", error: { code: "unavailable" } });
    expect((await powerCron(request(`Bearer ${SECRET}x`), SECRET, resolve, () => undefined)).status).toBe(401);
    expect((await powerCron(request(null), SECRET, resolve, () => undefined)).status).toBe(401);
    expect((await powerCron(request(SECRET), SECRET, resolve, () => undefined)).status).toBe(401);
  });

  it("runs one watchdog pass with the right bearer and logs what it did", async () => {
    const clock = new Clock();
    const store = new FakeStore(runningRow(clock, MAX_UPTIME_MS, MIN), [], clock.iso(-5000));
    const power = new FakePower("RUNNING");
    const lines: string[] = [];
    const response = await powerCron(request(`Bearer ${SECRET}`), SECRET, () => Promise.resolve(deps(store, power, clock)), (line) => lines.push(line));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "stop", reason: "max_uptime", timed_out: 0 });
    expect(lines).toEqual(["otf power cron: stop (max_uptime), 0 timed out"]);
  });

  it("answers unavailable when the store or the power port is unconfigured, or the pass throws", async () => {
    expect((await powerCron(request(`Bearer ${SECRET}`), SECRET, () => Promise.resolve(null), () => undefined)).status).toBe(503);
    const lines: string[] = [];
    const failing = await powerCron(request(`Bearer ${SECRET}`), SECRET, () => Promise.reject(new TypeError("synthetic")), (line) => lines.push(line));
    expect(failing.status).toBe(503);
    expect(lines).toEqual(["otf power cron: the pass failed (TypeError)"]);
  });
});
