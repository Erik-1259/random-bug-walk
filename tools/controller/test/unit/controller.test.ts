import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCanonical, sha256Hex } from "@rbw/schema";
import type { Docker } from "@rbw/local-runner";
import { runJob } from "../../src/controller.ts";
import { JUDGE } from "../../src/limits.ts";
import { FakeDocker } from "../../../local-runner/test/support/fakes.ts";
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
    const observe = jobInputs(w, { kind: "observe", name: "observe" });
    const early = await runJob(observe, w.deps);
    expect(early.summary).toMatchObject({ status: "refused", reason: "cannot_build" });
    expect(early.summary.detail).toMatch(/baseline_missing/);
    await runJob({ ...observe, kind: "kit_check", name: "kit-check", trials: ["clean-01"] }, w.deps);
    await expect(runJob(observe, w.deps)).rejects.toThrow(/holds another job/);
    const fresh = await runJob({ ...observe, name: "observe-2" }, w.deps);
    expect(fresh.replay).toBe(false);
    expect(fresh.summary.job.baseline?.key).toBe("jobs/kit-check/evidence.json");
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
