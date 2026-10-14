import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCanonical, sha256Hex } from "@rbw/schema";
import { deriveCodeStates } from "@rbw/local-runner";
import type { Docker } from "@rbw/local-runner";
import { loadProbeSet } from "@rbw/shapes";
import { runJob } from "../../src/controller.ts";
import { JUDGE } from "../../src/limits.ts";
import { FakeClock, FakeDocker } from "../../../local-runner/test/support/fakes.ts";
import type { JobInputs } from "../../src/controller.ts";
import { CLEAN, writeProbeDir, writeRaceProbeDir } from "../../../local-runner/test/support/synthetic.ts";
import { jobInputs, world } from "../support/harness.ts";
import type { LedgerCall, World } from "../support/harness.ts";
import { SERIAL_CHECKS } from "../support/serial-checks.ts";

function methods(calls: readonly LedgerCall[]): string[] {
  return calls.map((call) => {
    const request = call.request as { to_state?: string } | undefined;
    return call.method === "transition" ? `transition:${String(request?.to_state)}` : call.method;
  });
}

function index(calls: readonly LedgerCall[], name: string, nth = 0): LedgerCall {
  const found = calls.filter((call) => methods([call])[0] === name)[nth];
  if (found === undefined) throw new Error(`no ledger call ${name} #${String(nth)}`);
  return found;
}

/** Moves the fake clock by `ms` at the export of a copy (the second and later exports of a job). */
function slowCopyExport(ms: number): (inner: Docker, clock: { advance(ms: number): void }) => Docker {
  let exports = 0;
  return (inner, clock) =>
    new FakeDocker(async (args, options) => {
      if (args[0] === "cp" && String(args[1]).endsWith(":/workspace/app")) {
        exports += 1;
        if (exports > 1) clock.advance(ms);
      }
      return inner.run(args, options);
    });
}

/** Lets `ms` pass after each copy is settled, before the controller decides on the next one. */
function elapseAfterEachSettlement(w: World, ms: number): void {
  const { spend } = w.deps;
  w.deps.spend = {
    ...spend,
    settle: async (settlement) => {
      const result = await spend.settle(settlement);
      w.clock.advance(ms);
      return result;
    },
  };
}

async function slot(w: World, key = "development") {
  const status = await w.spend.slotStatus({ slot_key: key });
  if (!status.ok) throw new Error("synthetic: no slot status");
  return status;
}

describe("the ledger flow of one job on the sandbox backend", () => {
  it("acquires the slot, then per copy reserves before the create, records the child and confirms it after the stop, settles, and releases the slot last", async () => {
    const w = await world();
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01", "clean-02"] }), w.deps);
    expect(outcome.status).toBe("complete");
    expect(outcome.exitCode).toBe(0);

    const ops = w.sdk.ops();
    const creates = ops.flatMap((op, at) => (op === "create" ? [at] : []));
    const stops = ops.flatMap((op, at) => (op === "stop" ? [at] : []));
    expect(creates).toHaveLength(2);
    expect(methods(w.ledgerCalls).filter((name) => !name.endsWith("Status"))).toEqual([
      "acquireSlot",
      ...["reserve", "transition:launching", "transition:running", "confirmChild", "transition:terminal", "settle"],
      ...["reserve", "transition:launching", "transition:running", "confirmChild", "transition:terminal", "settle"],
      "releaseSlot",
    ]);
    for (const [nth, created] of creates.entries()) {
      expect(index(w.ledgerCalls, "reserve", nth).sdkCalls).toBeLessThanOrEqual(created);
      expect(index(w.ledgerCalls, "transition:launching", nth).sdkCalls).toBeLessThanOrEqual(created);
      expect(index(w.ledgerCalls, "confirmChild", nth).sdkCalls).toBeGreaterThan(stops[nth] ?? Infinity);
      expect(index(w.ledgerCalls, "settle", nth).sdkCalls).toBeGreaterThan(stops[nth] ?? Infinity);
    }
    expect(index(w.ledgerCalls, "releaseSlot").sdkCalls).toBe(ops.length);

    const summary = outcome.summary;
    expect(summary.copies.map((copy) => [copy.trial_id, copy.status, copy.launch, copy.ledger_state])).toEqual([
      ["clean-01", "complete", "confirmed", "reconciled"],
      ["clean-02", "complete", "confirmed", "reconciled"],
    ]);
    const [first] = summary.copies;
    expect(first?.child_resource_id).toMatch(/^rbw-[0-9a-f]{8}-kit-check-clean-01$/);
    expect(first?.reserved_microusd).toBe(147_682);
    expect(first?.settled_microusd).toBeGreaterThan(0);
    expect(first?.settled_microusd).toBeLessThanOrEqual(147_682);
    expect(Object.keys(first?.phases_ms ?? {})).toEqual(expect.arrayContaining(["audit", "create", "place", "run", "collect", "stop"]));
    expect(summary.spend.reserved_microusd).toBe(2 * 147_682);
    expect(summary.spend.settled_microusd).toBe(summary.copies.reduce((sum, copy) => sum + (copy.settled_microusd ?? 0), 0));
    expect(summary.spend.open_microusd).toBe(0);
    expect(summary.import.evidence_sha256).toBe(sha256Hex(readFileSync(join(outcome.jobDir, "evidence.json"))));
    expect(summary.import.decision_sha256).toBe(sha256Hex(readFileSync(join(outcome.jobDir, "decision.json"))));
    expect(summary.slot).toMatchObject({ key: "development", acquired: true, released: true });
    expect((await slot(w)).holder).toBeNull();

    const confirm = index(w.ledgerCalls, "confirmChild").request as { evidence: { key: string; sha256: string }; terminal_status: string };
    expect(confirm.terminal_status).toBe("completed");
    expect(sha256Hex(readFileSync(join(outcome.work, ...confirm.evidence.key.split("/"))))).toBe(confirm.evidence.sha256);
    const written = parseCanonical(readFileSync(join(outcome.jobDir, "summary.json"))) as { status: string };
    expect(written.status).toBe("complete");
  });

  it("settles from the create through the confirmed stop, including time outside the timed phases", async () => {
    // Every clock read moves time on, so the untimed steps between phases take time too.
    class TickingClock extends FakeClock {
      override now(): number {
        this.current += 7;
        return this.current;
      }
    }
    const w = await world({ clock: new TickingClock() });
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] }), w.deps);
    expect(outcome.status).toBe("complete");
    const [copy] = outcome.summary.copies;
    const timed = Object.entries(copy?.phases_ms ?? {}).reduce((sum, [name, ms]) => (name === "audit" ? sum : sum + ms), 0);
    expect(copy?.live_ms).toBeGreaterThan(timed);
    const settle = index(w.ledgerCalls, "settle").request as { service_lines: { unit: string; actual_quantity: number }[] };
    const vcpuSeconds = settle.service_lines.find((line) => line.unit === "vcpu_second")?.actual_quantity;
    expect(vcpuSeconds).toBe(4 * Math.ceil((copy?.live_ms ?? 0) / 1000));
  });

  it("keeps the copy's operation in the summary when the reservation's outcome is unknown", async () => {
    const w = await world();
    w.deps.spend = {
      ...w.deps.spend,
      reserve: () => Promise.reject(Object.assign(new Error("synthetic: response lost"), { code: "ECONNRESET" })),
    };
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] }), w.deps);
    expect(outcome).toMatchObject({ status: "needs_reconciliation", exitCode: 1 });
    expect(outcome.summary.reason).toBe("ledger_unavailable");
    expect(outcome.summary.copies).toHaveLength(1);
    expect(outcome.summary.copies[0]?.operation_id).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.summary.copies[0]?.launch).toBe("not_launched");
    expect(w.sdk.calls).toEqual([]);
  });

  it("names the job's real reservation and deadline in its request", async () => {
    const w = await world();
    const started = w.clock.now();
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] }), w.deps);
    const request = JSON.parse(readFileSync(join(outcome.jobDir, "job", "request.json"), "utf8")) as { reservation_microusd: number; deadline_at: string };
    expect(request.reservation_microusd).toBe(147_682);
    expect(Date.parse(request.deadline_at)).toBe(started + 9_000_000);
  });

  it("charges a judge replay to the judge-demo pool's judge allocation under the judge slot key", async () => {
    const w = await world();
    const outcome = await runJob(jobInputs(w, { kind: "judge_verify", name: "judge", ledger: JUDGE }), w.deps);
    expect(outcome.status).toBe("complete");
    expect(outcome.summary.copies.map((copy) => copy.trial_id)).toEqual(["clean-01", "planted-01", "fixed-01"]);
    const reserve = index(w.ledgerCalls, "reserve").request as { pool_key: string; allocation_key: string | null };
    expect(reserve).toMatchObject({ pool_key: "judge-demo", allocation_key: "judge" });
    const pool = await w.spend.poolStatus({ pool_key: "judge-demo" });
    expect(pool.ok && pool.allocations.find((item) => item.allocation_key === "judge")?.settled_microusd).toBe(BigInt(outcome.summary.spend.settled_microusd));
  });

  it("refuses a job whose slot is held by another root, and reserves nothing", async () => {
    const w = await world();
    await w.spend.acquireSlot({ slot_key: "development", root_execution_id: "00000000-0000-4000-9000-000000000001", actor_role: "synthetic" });
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check" }), w.deps);
    expect(outcome).toMatchObject({ status: "refused", exitCode: 1 });
    expect(outcome.summary.reason).toBe("slot_held");
    expect(methods(w.ledgerCalls)).toEqual(["acquireSlot"]);
    expect(w.sdk.calls).toEqual([]);
  });

  it("runs on the Docker backend with the same flow, through the real driver's records", async () => {
    const w = await world();
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", backend: "docker", sandboxImage: null, trials: ["clean-01"] }), w.deps);
    expect(outcome.status).toBe("complete");
    expect(w.sdk.calls).toEqual([]);
    expect(outcome.summary.copies[0]).toMatchObject({ status: "complete", launch: "confirmed", ledger_state: "reconciled" });
    expect(outcome.summary.import.trials[0]).toMatchObject({ trial_id: "clean-01", status: "complete", added_verdict: "match" });
    expect((index(w.ledgerCalls, "reserve").request as { provider: string }).provider).toBe("docker");
  });
});

describe("an uncertain launch", () => {
  it("reports needs_reconciliation when the slot acquisition itself fails, and launches nothing", async () => {
    const w = await world();
    w.deps.spend = {
      ...w.deps.spend,
      acquireSlot: () => Promise.reject(Object.assign(new Error("synthetic: connection dropped"), { code: "ECONNRESET" })),
    };
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check" }), w.deps);
    expect(outcome).toMatchObject({ status: "needs_reconciliation", exitCode: 1 });
    expect(outcome.summary.reason).toBe("ledger_unavailable");
    expect(outcome.summary.detail).toContain("ECONNRESET");
    expect(w.sdk.calls).toEqual([]);
  });

  it("stops the job at an uncertain create, holding the slot and the reservation, and launches nothing more", async () => {
    const w = await world({ sandbox: { create: "refused" } });
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check" }), w.deps);
    expect(outcome).toMatchObject({ status: "needs_reconciliation", exitCode: 1 });
    expect(w.sdk.ops().filter((op) => op === "create")).toHaveLength(1);
    const [copy] = outcome.summary.copies;
    expect(copy).toMatchObject({ trial_id: "clean-01", launch: "uncertain", ledger_state: "uncertain", child_resource_id: null });
    expect(outcome.summary.copies).toHaveLength(1);
    expect(methods(w.ledgerCalls)).not.toContain("releaseSlot");
    expect((await slot(w)).holder).toBe(outcome.summary.job.root_execution_id);
    const status = await w.spend.operationStatus({ operation_id: copy?.operation_id ?? "" });
    expect(status).toMatchObject({ ok: true, state: "uncertain", open_microusd: 147_682n });
    expect(outcome.summary.spend.open_microusd).toBe(147_682);
  });

  it("continues in a sandbox recovered by name after a lost create response, which is not uncertain", async () => {
    const w = await world({ sandbox: { create: "lost" } });
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] }), w.deps);
    expect(outcome.status).toBe("complete");
    expect(outcome.summary.copies[0]).toMatchObject({ launch: "confirmed", ledger_state: "reconciled" });
  });
});

describe("deadlines", () => {
  it("stops launching when the child deadline would be shorter than a copy's 600 s, and reports incomplete", async () => {
    const w = await world();
    elapseAfterEachSettlement(w, 2_200_000);
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check" }), w.deps);
    expect(outcome).toMatchObject({ status: "incomplete", exitCode: 1 });
    expect(outcome.summary.reason).toBe("child_deadline_short");
    expect(outcome.summary.copies.map((copy) => copy.trial_id)).toEqual(["clean-01", "clean-02", "clean-03", "clean-04"]);
    expect(w.sdk.ops().filter((op) => op === "create")).toHaveLength(4);
    expect(outcome.summary.slot.released).toBe(true);
  });

  it("stops launching when the parent deadline leaves no positive child time", async () => {
    const w = await world();
    elapseAfterEachSettlement(w, 2_225_000);
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check" }), w.deps);
    expect(outcome.summary.reason).toBe("parent_deadline");
    expect(w.sdk.ops().filter((op) => op === "create")).toHaveLength(4);
  });

  it("refuses the create itself when the copy's own preparation used up the time, records no launch and releases the slot", async () => {
    const w = await world({ docker: slowCopyExport(8_500_000) });
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] }), w.deps);
    expect(w.sdk.ops().filter((op) => op === "create")).toEqual([]);
    expect(outcome.summary.copies[0]).toMatchObject({ launch: "not_launched", ledger_state: "reconciled", settled_microusd: 0 });
    expect(outcome.summary).toMatchObject({ status: "incomplete", reason: "child_deadline_short" });
    expect(index(w.ledgerCalls, "transition:terminal").request).toMatchObject({ terminal_status: "cancelled" });
    expect(outcome.summary.slot.released).toBe(true);
  });
});

describe("replay", () => {
  it("refuses to replay a job directory with different inputs", async () => {
    const w = await world();
    const inputs = jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] });
    await runJob(inputs, w.deps);
    await expect(runJob({ ...inputs, trials: ["clean-02"] }, w.deps)).rejects.toThrow(/holds another job/);
  });
});

describe("replay fingerprint", () => {
  it("refuses, rather than replays, a job whose image was rebuilt under the same tag", async () => {
    const w = await world();
    const inputs = jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"] });
    await runJob(inputs, w.deps);
    const rebuilt = new FakeDocker((args, options) => (args[0] === "image" ? Promise.resolve({ code: 0, stdout: Buffer.from(`sha256:${"7".repeat(64)}\n`), stderr: "", timedOut: false }) : w.docker.run(args, options)));
    await expect(runJob(inputs, { ...w.deps, docker: rebuilt })).rejects.toThrow(/holds another job/);
  });

  it("does not return an observation's old baseline refusal once the kit-check baseline exists", async () => {
    const w = await world();
    // On Docker: the simulated kit writes real records there, so the kit check completes and is a baseline.
    const observe = jobInputs(w, { kind: "observe", name: "observe", backend: "docker", sandboxImage: null });
    const early = await runJob(observe, w.deps);
    expect(early.summary).toMatchObject({ status: "refused", reason: "cannot_build" });
    expect(early.summary.detail).toMatch(/baseline_missing/);
    await runJob({ ...observe, kind: "kit_check", name: "kit-check", trials: null }, w.deps);
    await expect(runJob(observe, w.deps)).rejects.toThrow(/holds another job/);
    const fresh = await runJob({ ...observe, name: "observe-2" }, w.deps);
    expect(fresh.replay).toBe(false);
    expect(fresh.summary.job.baseline?.key).toBe("jobs/kit-check/evidence.json");
  });
});

describe("an observation's kit-check baseline", () => {
  const docker = { backend: "docker" as const, sandboxImage: null };

  it("refuses to build an observation on a kit check with an invalid trial: no slot, no reservation and no copy", async () => {
    const w = await world({ kit: { stack: { "clean-02": { resetFailsAt: 1 } } } });
    const kit = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: null, ...docker }), w.deps);
    expect(kit.summary.import.trials.find((trial) => trial.trial_id === "clean-02")).toMatchObject({ status: "invalid", reason: "seed_failed" });
    const before = w.ledgerCalls.length;
    const observe = await runJob(jobInputs(w, { kind: "observe", name: "observe", ...docker }), w.deps);
    expect(observe.summary).toMatchObject({ status: "refused", reason: "cannot_build", detail: "kit_check_incomplete: 1 of 5 kit-check trials did not complete: clean-02 invalid (seed_failed)" });
    expect(observe.summary.copies).toEqual([]);
    expect(w.ledgerCalls.slice(before)).toEqual([]);
    expect(w.kit.created.some((name) => name.includes("-observe-"))).toBe(false);
  });

  it("refuses an observation on a kit check that ran only some of its trials", async () => {
    const w = await world();
    await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"], ...docker }), w.deps);
    const observe = await runJob(jobInputs(w, { kind: "observe", name: "observe", ...docker }), w.deps);
    expect(observe.summary).toMatchObject({ status: "refused", reason: "cannot_build" });
    expect(observe.summary.detail).toMatch(/^kit_check_incomplete: 4 of 5 kit-check trials did not complete: clean-02 incomplete/);
  });

  it("builds and runs the observation on a kit check whose every trial completed", async () => {
    const w = await world();
    await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: null, ...docker }), w.deps);
    const observe = await runJob(jobInputs(w, { kind: "observe", name: "observe", ...docker }), w.deps);
    expect(observe.summary).toMatchObject({ status: "complete", job: { baseline: { key: "jobs/kit-check/evidence.json" } } });
  });
});

describe("a copy that fails after its container was made", () => {
  it("counts the launch as uncertain when run-copy throws after the container was removed", async () => {
    const w = await world({
      docker: (inner) =>
        new FakeDocker((args, options) => {
          if (args[0] === "cp" && String(args[1]).endsWith("-kit-check-clean-01:/var/lib/rbw/results/rbw-runner")) throw new Error("synthetic: the collection failed");
          return inner.run(args, options);
        }),
    });
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", trials: ["clean-01"], backend: "docker", sandboxImage: null }), w.deps);
    expect(outcome.summary).toMatchObject({ status: "needs_reconciliation", reason: "uncertain_launch" });
    expect(outcome.summary.copies[0]).toMatchObject({ status: "not_run", reason: "copy_error", launch: "uncertain", ledger_state: "uncertain" });
    expect((await slot(w)).holder).toBe(outcome.summary.job.root_execution_id);
  });
});

describe("serial-run checks (spec §6.1) on PGlite", () => {
  for (const [name, check] of Object.entries(SERIAL_CHECKS)) it(name, () => check(world));
});

describe("the race family", () => {
  const race = (w: World, overrides: Partial<JobInputs> = {}): JobInputs =>
    jobInputs(w, { family: "race", raceLatencyMs: 75, probesDir: writeRaceProbeDir(), alternativeDir: undefined, backend: "docker", sandboxImage: null, ...overrides });

  it("runs an 11-copy admission on the race image, with ADM-06 not applicable and the latency in every copy", async () => {
    const w = await world({ kit: { family: "race" } });
    const kit = await runJob(race(w, { kind: "kit_check", name: "kit-check" }), w.deps);
    expect(kit.status).toBe("complete");
    const outcome = await runJob(race(w, { kind: "admission", name: "admission", originalSuite: join(kit.jobDir, "freeze", "collected", "original-suite.json") }), w.deps);
    expect(outcome.status).toBe("complete");
    expect(outcome.summary.copies.map((copy) => copy.trial_id)).toEqual([
      "clean-01",
      "fixed-01",
      "fixed-02",
      "fixed-03",
      "fixed-04",
      "fixed-05",
      "planted-01",
      "planted-02",
      "planted-03",
      "planted-04",
      "planted-05",
    ]);
    const decision = parseCanonical(readFileSync(join(outcome.jobDir, "decision.json"))) as { decisions: Record<string, { decision: string }>; outcome_verdict: string };
    expect(decision.decisions["ADM-06"]?.decision).toBe("not_applicable");
    expect(decision.outcome_verdict).toBe("pass");
    expect([...w.kit.containers.values()].every((container) => container.latency === "75")).toBe(true);
  });

  it("records the family, ADM-06's reason, the copy count and the latency in summary.json, so two latencies give different published records", async () => {
    const w = await world({ kit: { family: "race" } });
    const at50 = await runJob(race(w, { kind: "kit_check", name: "kit-check", raceLatencyMs: 50, work: join(w.dir, "run-50") }), w.deps);
    const at75 = await runJob(race(w, { kind: "kit_check", name: "kit-check", raceLatencyMs: 75, work: join(w.dir, "run-75") }), w.deps);
    const imageDefault = await runJob(race(w, { kind: "kit_check", name: "kit-check", raceLatencyMs: null, work: join(w.dir, "run-default") }), w.deps);
    for (const outcome of [at50, at75, imageDefault]) expect(outcome.status).toBe("complete");
    const written = (outcome: { jobDir: string }) => parseCanonical(readFileSync(join(outcome.jobDir, "summary.json"))) as { family?: unknown; copies: { copy: { proxy?: unknown } | null }[] };
    const reason = "Synthetic: a partial or stub fix of this race has no natural form.";
    expect(written(at50).family).toEqual({ id: "race", adm06: { status: "not_applicable", reason }, admission_copies: 11, race_latency_ms: 50 });
    expect(written(at75).family).toEqual({ id: "race", adm06: { status: "not_applicable", reason }, admission_copies: 11, race_latency_ms: 75 });
    expect(written(imageDefault).family).toEqual({ id: "race", adm06: { status: "not_applicable", reason }, admission_copies: 11, race_latency_ms: null });
    expect(written(at50).copies.map((copy) => copy.copy?.proxy)).toEqual(Array.from({ length: 5 }, () => ({ exit: 0, latency_ms: 50, source: "override" })));
    expect(written(at75).copies.map((copy) => copy.copy?.proxy)).toEqual(Array.from({ length: 5 }, () => ({ exit: 0, latency_ms: 75, source: "override" })));
    expect(written(imageDefault).copies.every((copy) => copy.copy?.proxy === undefined)).toBe(true);
    expect(new Set([at50, at75, imageDefault].map((outcome) => outcome.summary.job.task_revision)).size).toBe(3);
  });

  it("records the family in the summary of a retried job whose earlier run stopped before its summary", async () => {
    const w = await world({ kit: { family: "race" } });
    const inputs = race(w, { kind: "kit_check", name: "kit-check", raceLatencyMs: 50 });
    const first = await runJob(inputs, w.deps);
    expect(first.status).toBe("complete");
    unlinkSync(join(first.jobDir, "summary.json"));
    const retried = await runJob(inputs, w.deps);
    expect(retried).toMatchObject({ replay: true, status: "needs_reconciliation", summary: { reason: "interrupted" } });
    expect(retried.summary.family).toEqual({ id: "race", adm06: { status: "not_applicable", reason: "Synthetic: a partial or stub fix of this race has no natural form." }, admission_copies: 11, race_latency_ms: 50 });
  });

  it("writes no family record for a time-zone job", async () => {
    const w = await world();
    const outcome = await runJob(jobInputs(w, { kind: "kit_check", name: "kit-check", backend: "docker", sandboxImage: null, trials: ["clean-01"] }), w.deps);
    expect(outcome.status).toBe("complete");
    expect("family" in (parseCanonical(readFileSync(join(outcome.jobDir, "summary.json"))) as object)).toBe(false);
  });

  it("runs a race judge replay that grades the reference fix as fixed-01, since the family has no alternative fix", async () => {
    // A clock that moves only when released: three simulated copies would otherwise use up the judge job's deadline.
    const w = await world({ kit: { family: "race" }, clock: new FakeClock({ manual: true }) });
    const probesDir = writeRaceProbeDir();
    const outcome = await runJob(race(w, { kind: "judge_verify", name: "judge", ledger: JUDGE, probesDir }), w.deps);
    expect(outcome.status).toBe("complete");
    expect(outcome.summary.copies.map((copy) => [copy.trial_id, copy.status])).toEqual([
      ["clean-01", "complete"],
      ["planted-01", "complete"],
      ["fixed-01", "complete"],
    ]);
    const request = parseCanonical(readFileSync(join(outcome.jobDir, "job", "request.json"))) as { expected_trials_key: string };
    const expected = parseCanonical(readFileSync(join(outcome.jobDir, "job", ...request.expected_trials_key.split("/")))) as { trials: { trial_id: string; patch_sha256: string | null }[] };
    const reference = deriveCodeStates(Buffer.from(CLEAN), loadProbeSet(probesDir), null).get("fixed")?.patch_sha256;
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
    expect(expected.trials.find((trial) => trial.trial_id === "fixed-01")?.patch_sha256).toBe(reference);
  });

  it("refuses a race job on a kit stage that holds the time-zone fixture, before the export or any copy", async () => {
    const w = await world({ kit: { family: "time-zone", imageFamily: "race" } });
    const outcome = await runJob(race(w, { kind: "kit_check", name: "kit-check" }), w.deps);
    expect(outcome.summary).toMatchObject({ status: "refused", reason: "cannot_build" });
    expect(outcome.summary.detail).toContain("kit stage holds no rc-1-backup-code-001.v1.json");
    expect(outcome.summary.copies).toEqual([]);
    expect(w.kit.created).toEqual([]);
  });

  it("refuses a race job given the time-zone probe set, before the export or any copy", async () => {
    const w = await world({ kit: { family: "race" } });
    const outcome = await runJob(race(w, { kind: "kit_check", name: "kit-check", probesDir: writeProbeDir() }), w.deps);
    expect(outcome.summary).toMatchObject({ status: "refused", reason: "cannot_build" });
    expect(outcome.summary.detail).toContain("but its probe set needs clean,fixed,partial,planted,stub");
    expect(outcome.summary.copies).toEqual([]);
    expect(w.kit.created).toEqual([]);
  });

  it("refuses, rather than replays, a race job rerun under the same name with another latency", async () => {
    const w = await world({ kit: { family: "race" } });
    const inputs = race(w, { kind: "kit_check", name: "kit-check", raceLatencyMs: 50 });
    expect((await runJob(inputs, w.deps)).status).toBe("complete");
    expect((await runJob(inputs, w.deps)).replay).toBe(true);
    await expect(runJob({ ...inputs, raceLatencyMs: 75 }, w.deps)).rejects.toThrow(/holds another job/);
    await expect(runJob({ ...inputs, raceLatencyMs: null }, w.deps)).rejects.toThrow(/holds another job/);
  });

  it("refuses a race job on a time-zone kit image before any copy", async () => {
    const w = await world({ kit: { family: "race", imageFamily: "time-zone" } });
    const outcome = await runJob(race(w, { kind: "kit_check", name: "kit-check" }), w.deps);
    expect(outcome.status).not.toBe("complete");
    expect(outcome.summary.detail).toContain("rbw-umami-race-kit-image-manifest/1");
    expect(outcome.summary.copies).toEqual([]);
  });
});
