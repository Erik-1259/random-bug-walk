import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyOperation, copySandboxName, validationOperation } from "../../src/factory-ledger.ts";
import { CopyMeter } from "../../src/factory-meter.ts";
import type { LaunchReport, MeterContext, MeteredCopyPlan } from "../../src/factory-meter.ts";
import type { FactoryRequestRecord } from "../../src/factory-ports.ts";
import { CANDIDATE_A, CANDIDATE_B, CASE_ID, acceptRequest, factoryWorld, operationState, syntheticUuid } from "./factory-fakes.ts";
import type { FactoryWorld } from "./factory-fakes.ts";

let w: FactoryWorld;
let record: FactoryRequestRecord;

beforeEach(async () => {
  w = await factoryWorld();
});

afterEach(async () => {
  await w.close();
});

const LIMITS = { timeout_s: 720, vcpus: 4, memory_mb: 8192 };

function plan(subject: string, state: MeteredCopyPlan["state"], limits = LIMITS): MeteredCopyPlan {
  return { subject, host: "task-report", state, limits };
}

async function requestMeter(overrides: Partial<MeterContext> = {}, budget = 1_500_000): Promise<CopyMeter> {
  record = await acceptRequest(w, { budget });
  return new CopyMeter({
    ledger: w.ledger,
    identity: w.identity,
    rates: w.rates,
    now: w.clock.now,
    root: record.root,
    kind: "request",
    task_revision: record.interpretation_sha256,
    budget_key: record.budget_key,
    provider: "vercel-sandbox",
    deadline: new Date(w.clock.ms + 3_600_000),
    margin_s: 120,
    mode: { kind: "own_operation", role: "request" },
    log: (line) => w.logs.push(line),
    ...overrides,
  });
}

function op(subject: string, state: MeteredCopyPlan["state"], n = 1) {
  return copyOperation({ identity: w.identity, rates: w.rates }, { kind: "request", root: record.root, task_revision: record.interpretation_sha256, subject, state, n, host: "task-report", provider: "vercel-sandbox" });
}

/** A launch that creates its sandbox, lives `ms` and is confirmed stopped. */
function lives(ms: number, extra: Partial<LaunchReport<string>> = {}) {
  return async (name: string, hooks: { created(id: string): Promise<void> }): Promise<LaunchReport<string>> => {
    await hooks.created(name);
    w.clock.advance(ms);
    return { result: `ran ${name}`, created: true, lifetime_ms: ms, stop_confirmed: true, status: "completed", ...extra };
  };
}

describe("CopyMeter (one operation per copy)", () => {
  it("reserves each copy, records its sandbox as a child, confirms the stop and settles the measured lifetime", async () => {
    const meter = await requestMeter();
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), lives(125_400));
    const expected = op(CANDIDATE_A, "clean");
    expect(outcome).toMatchObject({ kind: "ran", result: `ran ${copySandboxName(expected.execution_id)}`, operation_id: expected.operation_id });
    // 126 s at 4 vCPU and 8 GB: 504 vCPU-s = 17,920 µUSD, 1,008 GB-s = 5,936 µUSD, one creation 1 µUSD.
    expect(outcome.kind === "ran" && outcome.settled_microusd).toBe(23_857);
    const status = await w.spend.operationStatus({ operation_id: expected.operation_id });
    expect(status.ok && [status.state, status.settled_microusd, status.open_microusd]).toEqual(["reconciled", 23_857n, 0n]);
    const slot = await w.spend.slotStatus({ slot_key: "factory" });
    expect(slot.ok && slot.children.map((child) => [child.resource_id, child.confirmed])).toEqual([[copySandboxName(expected.execution_id), true]]);
    // The meter appends no request events: the factory core's loop appends budget_updated after each copy.
    expect(w.records.types(record.request_id)).toEqual(["request_accepted"]);
  });

  it("runs copies one at a time: a second copy is not reserved or launched while one is active", async () => {
    const meter = await requestMeter();
    const launched: string[] = [];
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = meter.run(plan(CANDIDATE_A, "clean"), async (name, hooks) => {
      launched.push(name);
      await hooks.created(name);
      await blocker;
      return { result: "first", created: true, lifetime_ms: 1000, stop_confirmed: true, status: "completed" as const };
    });
    const second = meter.run(plan(CANDIDATE_A, "buggy"), async (name, hooks) => {
      launched.push(name);
      await hooks.created(name);
      return { result: "second", created: true, lifetime_ms: 1000, stop_confirmed: true, status: "completed" as const };
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(meter.active).toBe(true);
    expect(launched).toHaveLength(1);
    expect(await operationState(w, op(CANDIDATE_A, "buggy").operation_id)).toBeNull();
    release();
    await Promise.all([first, second]);
    expect(launched).toHaveLength(2);
    expect(meter.active).toBe(false);
  });

  it("numbers repeated copies of one state and keeps candidates apart", async () => {
    const meter = await requestMeter();
    for (const subject of [CANDIDATE_A, CANDIDATE_A, CANDIDATE_B]) expect((await meter.run(plan(subject, "buggy"), lives(1000))).kind).toBe("ran");
    for (const [subject, n] of [[CANDIDATE_A, 1], [CANDIDATE_A, 2], [CANDIDATE_B, 1]] as const) expect(await operationState(w, op(subject, "buggy", n).operation_id)).toBe("reconciled");
  });

  it("refuses a plan whose limits exceed the host's copy limits, reserving and launching nothing", async () => {
    const meter = await requestMeter();
    let called = false;
    for (const limits of [{ ...LIMITS, timeout_s: 900 }, { ...LIMITS, vcpus: 8 }, { ...LIMITS, memory_mb: 16384 }]) {
      const outcome = await meter.run(plan(CANDIDATE_A, "clean", limits), () => {
        called = true;
        return Promise.reject(new Error("must not launch"));
      });
      expect(outcome).toMatchObject({ kind: "refused", reason: "limits_exceed_profile" });
    }
    expect(called).toBe(false);
    expect(await operationState(w, op(CANDIDATE_A, "clean").operation_id)).toBeNull();
  });

  it("starts no copy whose timeout, shutdown allowance and margin do not fit before the deadline", async () => {
    const meter = await requestMeter({ deadline: new Date(Date.parse("2026-10-20T19:00:00.000Z") + (720 + 60 + 120) * 1000 - 1) });
    expect(await meter.run(plan(CANDIDATE_A, "clean"), lives(1000))).toMatchObject({ kind: "refused", reason: "no_time" });
    expect(await operationState(w, op(CANDIDATE_A, "clean").operation_id)).toBeNull();
  });

  it("launches nothing when the budget refuses the copy's reservation", async () => {
    const meter = await requestMeter({}, 100_000);
    let called = false;
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), () => {
      called = true;
      return Promise.reject(new Error("must not launch"));
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "budget" });
    expect(meter.lastRefusal).toMatchObject({ reason: "budget" });
    expect(called).toBe(false);
    expect(w.budgets.refusals.map((refusal) => refusal.code)).toEqual(["budget_exhausted"]);
  });

  it("makes a copy uncertain, never a rejection, when a ledger call throws after the reservation, and starts no later copy", async () => {
    const meter = await requestMeter();
    const transition = w.spend.transition.bind(w.spend);
    w.ledger.spend = { ...w.spend, transition: (request) => (request.to_state === "terminal" ? Promise.reject(new Error("synthetic: the connection dropped")) : transition(request)) };
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), lives(1000));
    expect(outcome.kind).toBe("uncertain");
    expect(meter.uncertain).toBe(true);
    // It was running when the call failed: it is uncertain now, its reservation held for reconciliation.
    expect(await operationState(w, op(CANDIDATE_A, "clean").operation_id)).toBe("uncertain");
    expect(await meter.run(plan(CANDIDATE_A, "buggy"), lives(1000))).toMatchObject({ kind: "refused", reason: "uncertain" });
  });

  it("makes a copy uncertain when its reservation call throws, launching nothing", async () => {
    const meter = await requestMeter();
    let called = false;
    w.ledger.budgets = { reserve: () => Promise.reject(new Error("synthetic: the connection dropped")), close: (key, cause) => w.budgets.close(key, cause), status: (key) => w.budgets.status(key) };
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), () => {
      called = true;
      return Promise.reject(new Error("must not launch"));
    });
    expect(outcome.kind).toBe("uncertain");
    expect(meter.uncertain).toBe(true);
    expect(called).toBe(false);
  });

  it("never launches a copy whose operation already existed: it is uncertain and left as it was", async () => {
    const meter = await requestMeter();
    const existing = op(CANDIDATE_A, "clean");
    expect((await w.ledger.budgets.reserve(record.budget_key, "request", existing.request)).ok).toBe(true);
    let called = false;
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), () => {
      called = true;
      return Promise.reject(new Error("must not launch"));
    });
    expect(outcome.kind).toBe("uncertain");
    expect(called).toBe(false);
    expect(await operationState(w, existing.operation_id)).toBe("prepared");
  });

  it("starts no copy after a settlement over its envelope, which halts new work", async () => {
    const meter = await requestMeter();
    const settle = w.spend.settle.bind(w.spend);
    w.ledger.spend = {
      ...w.spend,
      settle: async (request) => {
        const settled = await settle(request);
        return settled.ok ? { ...settled, over_envelope: true } : settled;
      },
    };
    expect((await meter.run(plan(CANDIDATE_A, "clean"), lives(1000))).kind).toBe("ran");
    expect(await meter.run(plan(CANDIDATE_A, "buggy"), lives(1000))).toMatchObject({ kind: "refused", reason: "halted" });
    expect(await operationState(w, op(CANDIDATE_A, "buggy").operation_id)).toBeNull();
  });

  it("checks for a stop before each copy and reserves nothing once stopped", async () => {
    let stop = false;
    const meter = await requestMeter({ beforeLaunch: () => Promise.resolve(!stop) });
    expect((await meter.run(plan(CANDIDATE_A, "clean"), lives(1000))).kind).toBe("ran");
    stop = true;
    expect(await meter.run(plan(CANDIDATE_A, "buggy"), lives(1000))).toMatchObject({ kind: "refused", reason: "stopped" });
    expect(await operationState(w, op(CANDIDATE_A, "buggy").operation_id)).toBeNull();
  });

  it("records a launch that rejects as uncertain, never retries it, and starts no later copy", async () => {
    const meter = await requestMeter();
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), async (name, hooks) => {
      await hooks.created(name);
      throw new Error("synthetic: the provider's answer was lost");
    });
    expect(outcome.kind).toBe("uncertain");
    expect(meter.uncertain).toBe(true);
    expect(await operationState(w, op(CANDIDATE_A, "clean").operation_id)).toBe("uncertain");
    let called = false;
    const next = await meter.run(plan(CANDIDATE_A, "buggy"), () => {
      called = true;
      return Promise.reject(new Error("must not launch"));
    });
    expect(next).toMatchObject({ kind: "refused", reason: "uncertain" });
    expect(called).toBe(false);
  });

  it("keeps a copy whose stop could not be confirmed uncertain, with its reservation held", async () => {
    const meter = await requestMeter();
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), lives(5000, { stop_confirmed: false }));
    expect(outcome.kind).toBe("uncertain");
    const status = await w.spend.operationStatus({ operation_id: op(CANDIDATE_A, "clean").operation_id });
    expect(status.ok && [status.state, status.open_microusd]).toEqual(["uncertain", 147_682n]);
  });

  it("never settles a copy past its sandbox's provider timeout, so a full-length copy stays within its envelope", async () => {
    const meter = await requestMeter();
    // Measured from before the create call to after the status checks: longer than the 720 s + 60 s the provider allows.
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), lives(783_000));
    expect(outcome).toMatchObject({ kind: "ran", over_envelope: false, settled_microusd: 147_682 });
    const halt = await w.spend.haltStatus();
    expect(halt.ok && halt.halted).toBe(false);
  });

  it("settles a copy that never created anything at zero", async () => {
    const meter = await requestMeter();
    const outcome = await meter.run(plan(CANDIDATE_A, "clean"), () => Promise.resolve({ result: "setup_failed", created: false, lifetime_ms: 0, stop_confirmed: true, status: "failed" as const }));
    expect(outcome).toMatchObject({ kind: "ran", settled_microusd: 0 });
    expect(await operationState(w, op(CANDIDATE_A, "clean").operation_id)).toBe("reconciled");
  });
});

describe("CopyMeter (copies of a validation run)", () => {
  async function validationMeter(): Promise<{ meter: CopyMeter; operationId: string; root: string }> {
    record = await acceptRequest(w);
    await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: record.root, actor_role: "factory-worker", evidence: null, reason: null });
    const root = w.identity.validationRoot(syntheticUuid("7100"));
    await w.spend.acquireSlot({ slot_key: "factory", root_execution_id: root, actor_role: "factory-route" });
    const validation = validationOperation({ identity: w.identity, rates: w.rates }, { root, case_id: CASE_ID, host_id: "task-report" });
    const reserved = await w.ledger.budgets.reserve(record.budget_key, "validation", validation.request);
    expect(reserved.ok).toBe(true);
    await w.spend.transition({ operation_id: validation.operation_id, from_state: "prepared", to_state: "launching", actor_role: "factory-route", slot_key: "factory" });
    await w.spend.transition({ operation_id: validation.operation_id, from_state: "launching", to_state: "running", actor_role: "factory-route", provider_resource_id: validation.sandbox_name });
    const meter = new CopyMeter({
      ledger: w.ledger,
      identity: w.identity,
      rates: w.rates,
      now: w.clock.now,
      root,
      kind: "validation",
      task_revision: CASE_ID,
      budget_key: record.budget_key,
      provider: "vercel-sandbox",
      deadline: new Date(w.clock.ms + 1_800_000),
      margin_s: 0,
      mode: { kind: "child_of", operation_id: validation.operation_id },
      log: (line) => w.logs.push(line),
    });
    return { meter, operationId: validation.operation_id, root };
  }

  it("records each copy as a child of the validation's operation, confirms its stop and keeps its lifetime, reserving nothing more", async () => {
    const { meter } = await validationMeter();
    const opsBefore = w.budgets.budgets.get(record.budget_key)?.operations.length;
    expect((await meter.run({ ...plan(CASE_ID, "clean") }, lives(90_000))).kind).toBe("ran");
    expect((await meter.run({ ...plan(CASE_ID, "buggy") }, lives(80_000))).kind).toBe("ran");
    expect(meter.usage).toEqual([
      { launched: true, lifetime_ms: 90_000 },
      { launched: true, lifetime_ms: 80_000 },
    ]);
    expect(w.budgets.budgets.get(record.budget_key)?.operations.length).toBe(opsBefore);
    const slot = await w.spend.slotStatus({ slot_key: "factory" });
    expect(slot.ok && slot.children.filter((child) => child.kind === "factory.copy").map((child) => child.confirmed)).toEqual([true, true]);
  });

  it("starts no more copies than its host's validation reservation is priced for", async () => {
    const { meter } = await validationMeter();
    const umami = (state: MeteredCopyPlan["state"]): MeteredCopyPlan => ({ ...plan(CASE_ID, state), host: "umami" });
    for (const state of ["clean", "buggy", "fixed"] as const) expect((await meter.run(umami(state), lives(1000))).kind).toBe("ran");
    expect(await meter.run(umami("buggy"), lives(1000))).toMatchObject({ kind: "refused", reason: "limits_exceed_profile" });
  });

  it("counts only copies that created a sandbox against that limit", async () => {
    const { meter } = await validationMeter();
    const umami = (state: MeteredCopyPlan["state"]): MeteredCopyPlan => ({ ...plan(CASE_ID, state), host: "umami" });
    // A copy that never created anything (a definite create refusal) does not use up one of the run's copies.
    const nothing = () => Promise.resolve({ result: "setup_failed", created: false, lifetime_ms: 0, stop_confirmed: true, status: "failed" as const });
    expect((await meter.run(umami("clean"), nothing)).kind).toBe("ran");
    for (const state of ["clean", "buggy", "fixed"] as const) expect((await meter.run(umami(state), lives(1000))).kind).toBe("ran");
    expect(meter.usage).toHaveLength(3);
    expect(await meter.run(umami("fixed"), lives(1000))).toMatchObject({ kind: "refused", reason: "limits_exceed_profile" });
  });

  it("starts no validation copy whose timeout would pass the window", async () => {
    const { meter } = await validationMeter();
    w.clock.advance((1800 - 720 - 60) * 1000 + 1);
    expect(await meter.run(plan(CASE_ID, "clean"), lives(1000))).toMatchObject({ kind: "refused", reason: "no_time" });
  });

  it("leaves an unconfirmed validation copy as a blocking child and marks the run uncertain", async () => {
    const { meter, root } = await validationMeter();
    expect((await meter.run(plan(CASE_ID, "clean"), lives(1000, { stop_confirmed: false }))).kind).toBe("uncertain");
    expect(meter.uncertain).toBe(true);
    const released = await w.spend.releaseSlot({ slot_key: "factory", root_execution_id: root, actor_role: "factory-worker", evidence: null, reason: null });
    expect(!released.ok && released.blocking_child_resources?.some((child) => child.resource_id.startsWith("rbw-fc-"))).toBe(true);
  });
});
