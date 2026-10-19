import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticPair, syntheticAdapter } from "@rbw/case-package/synthetic";
import type { CopyPlan, CopyRecord, CopyState, HostAdapter, InterpretedCells } from "@rbw/factory-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePair, type ValidatePairInput } from "../src/validate.ts";
import { localProcessRunner, scriptedRunner, type ScriptedCopy } from "./support.ts";

let parent: string;
let copies: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "case-validate-loop-"));
  copies = await mkdtemp(join(tmpdir(), "case-validate-copies-"));
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
  await rm(copies, { recursive: true, force: true });
});

const NOW = new Date("2026-10-19T12:00:00.000Z");
const pair = buildSyntheticPair({ host_id: "task-report", seed: "01" });

function input(runner: ValidatePairInput["runner"], extra: Partial<ValidatePairInput> = {}): ValidatePairInput {
  return {
    bug_case: pair.bug_case.bytes,
    validator: pair.validator.bytes,
    adapters: { "task-report": syntheticAdapter({ seeds: ["01"], workdir: parent }) },
    runner,
    now: () => NOW,
    workdir: parent,
    ...extra,
  };
}

/** The qualification table, as a script: the original suite passes everywhere, the check detects only on buggy. */
const qualifying = (plan: CopyPlan): ScriptedCopy => ({ outcome: "ran", detected: plan.state === "buggy" });

describe("validatePair runs the copies (synthetic host)", () => {
  it("passes a synthetic pair end to end with the real synthetic copy driver, in the order clean, buggy, fixed", async () => {
    const runner = localProcessRunner(copies);
    const order: string[] = [];
    const outcome = await validatePair(input(runner, {
      beforeCopy: (plan) => {
        order.push(`before ${plan.state}`);
        return Promise.resolve("continue");
      },
      onCopy: (record) => {
        order.push(`copy ${record.state}`);
        return Promise.resolve();
      },
      onCells: (state) => {
        order.push(`cells ${state}`);
        return Promise.resolve();
      },
    }));
    expect(outcome.diagnostic).toBeNull();
    expect(outcome.result).toBe("passed");
    expect(outcome.error_code).toBeNull();
    expect(order).toEqual(["before clean", "copy clean", "cells clean", "before buggy", "copy buggy", "cells buggy", "before fixed", "copy fixed", "cells fixed"]);
    expect(outcome.matrix?.verification.buggy.observed).toBe("fail");
    expect(outcome.matrix?.verification.buggy.failure_codes).toEqual(["acknowledged_completion_not_counted"]);
    expect(outcome.matrix?.original_suite.buggy.observed).toBe("pass");
    expect(outcome.matrix?.verification.fixed.observed).toBe("pass");
    expect(outcome.records.map((record) => record.status)).toEqual(["complete", "complete", "complete"]);
    expect(outcome.pair_sha256).toBe(pair.pair_sha256);
    expect(await readdir(parent)).toEqual([]);
  });

  it("answers failed when every cell is valid and one differs from its expectation", async () => {
    const runner = scriptedRunner(copies, () => ({ outcome: "ran", detected: false }));
    const outcome = await validatePair(input(runner));
    expect(outcome.result).toBe("failed");
    expect(outcome.matrix?.verification.buggy.observed).toBe("pass");
    expect(outcome.error_code).toBeNull();
  });

  it("answers error, never failed, when a copy could not be set up, and still runs the remaining copies", async () => {
    const runner = scriptedRunner(copies, (plan) => (plan.state === "clean" ? { outcome: "setup_failed" } : { outcome: "ran", detected: false }));
    const outcome = await validatePair(input(runner));
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("cells_invalid");
    expect(outcome.matrix?.verification.clean.observed).toBe("error");
    expect(outcome.records.find((record) => record.state === "clean")?.status).toBe("invalid");
    expect(runner.plans.map((plan) => plan.state)).toEqual(["clean", "buggy", "fixed"]);
  });

  it("answers error when a copy timed out or ran too few valid rounds for the protocol", async () => {
    const timedOut = await validatePair(input(scriptedRunner(copies, (plan) => (plan.state === "fixed" ? { outcome: "timed_out" } : qualifying(plan)))));
    expect(timedOut.result).toBe("error");
    expect(timedOut.matrix?.original_suite.fixed.observed).toBe("incomplete");
    const short = await validatePair(input(scriptedRunner(copies, (plan) => ({ ...qualifying(plan), rounds: plan.state === "buggy" ? 1 : 2 }))));
    expect(short.result).toBe("error");
    expect(short.matrix?.verification.buggy.observed).toBe("incomplete");
  });

  it("propagates a runner rejection unchanged after settling the copies before it, and runs no further copy", async () => {
    const uncertain = new Error("synthetic uncertain provider outcome");
    const runner = scriptedRunner(copies, (plan) => (plan.state === "buggy" ? { outcome: "reject", error: uncertain } : qualifying(plan)));
    const settled: CopyRecord[] = [];
    const run = validatePair(input(runner, {
      onCopy: (record) => {
        settled.push(record);
        return Promise.resolve();
      },
    }));
    await expect(run).rejects.toBe(uncertain);
    expect(settled.map((record) => record.state)).toEqual(["clean"]);
    expect(runner.plans.map((plan) => plan.state)).toEqual(["clean", "buggy"]);
    expect(await readdir(parent)).toEqual([]);
  });

  it("stops between copies when beforeCopy says stop", async () => {
    const runner = scriptedRunner(copies, qualifying);
    const outcome = await validatePair(input(runner, { beforeCopy: (plan) => Promise.resolve(plan.state === "buggy" ? "stop" : "continue") }));
    expect(outcome.stopped).toBe(true);
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("stopped");
    expect(outcome.matrix).toBeNull();
    expect(outcome.records.map((record) => record.state)).toEqual(["clean"]);
    expect(runner.plans).toHaveLength(1);
  });

  it("refuses an adapter whose collect turns a copy that did not run into an observation", async () => {
    const base = syntheticAdapter({ seeds: ["01"], workdir: parent });
    const lying: HostAdapter = {
      ...base,
      collect: async (plan, collected) => {
        const record = await base.collect(plan, { ...collected, outcome: "ran", exit_code: 0 });
        return { ...record, status: "complete" };
      },
    };
    const runner = scriptedRunner(copies, (plan) => (plan.state === "clean" ? { outcome: "setup_failed" } : qualifying(plan)));
    const outcome = await validatePair({ ...input(runner), adapters: { "task-report": lying } });
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("adapter_error");
    expect(runner.plans).toHaveLength(1);
  });

  it("refuses a record whose status does not follow the copy's outcome or whose evidence is not the results hash", async () => {
    const base = syntheticAdapter({ seeds: ["01"], workdir: parent });
    const timedOutAsInvalid: HostAdapter = {
      ...base,
      collect: async (plan, collected) => {
        const record = await base.collect(plan, collected);
        return collected.outcome === "timed_out" ? { ...record, status: "invalid" } : record;
      },
    };
    const late = scriptedRunner(copies, (plan) => (plan.state === "clean" ? { outcome: "timed_out" } : qualifying(plan)));
    const status = await validatePair({ ...input(late), adapters: { "task-report": timedOutAsInvalid } });
    expect(status.error_code).toBe("adapter_error");

    const otherEvidence: HostAdapter = { ...base, collect: async (plan, collected) => ({ ...(await base.collect(plan, collected)), evidence_sha256: "d".repeat(64) }) };
    const evidence = await validatePair({ ...input(scriptedRunner(copies, qualifying)), adapters: { "task-report": otherEvidence } });
    expect(evidence.error_code).toBe("adapter_error");
    expect(evidence.records).toEqual([]);
  });

  it("answers adapter_error, and never rejects, when interpret throws or returns malformed cells", async () => {
    const base = syntheticAdapter({ seeds: ["01"], workdir: parent });
    const throwing: HostAdapter = { ...base, interpret: () => { throw new Error("synthetic interpret failure"); } };
    const thrown = await validatePair({ ...input(scriptedRunner(copies, qualifying)), adapters: { "task-report": throwing } });
    expect(thrown.error_code).toBe("adapter_error");
    expect(thrown.records).toHaveLength(1);
    const malformed: HostAdapter = { ...base, interpret: (records, protocol) => ({ original_suite: base.interpret(records, protocol).original_suite }) as InterpretedCells };
    const partial = await validatePair({ ...input(scriptedRunner(copies, qualifying)), adapters: { "task-report": malformed } });
    expect(partial.error_code).toBe("adapter_error");
  });

  it("answers error when a copy is invalid or incomplete, even when the adapter's interpret ignores the copies' status", async () => {
    const base = syntheticAdapter({ seeds: ["01"], workdir: parent });
    // Reports every cell as its expectation on full runs, whatever the records say.
    const blind: HostAdapter = {
      ...base,
      interpret: (records, protocol) => {
        const state = records[0]?.state ?? "clean";
        const runs = protocol.per_state[state].min_valid_runs;
        const cell = (observed: "pass" | "fail"): InterpretedCells["verification"] => ({ observed, runs_valid: runs, runs_total: runs, failure_codes: [], detail: "synthetic" });
        return { original_suite: cell("pass"), verification: cell(state === "buggy" ? "fail" : "pass") };
      },
    };
    const adapters = { "task-report": blind };
    // The blind adapter alone passes a pair whose copies all completed.
    expect((await validatePair({ ...input(scriptedRunner(copies, qualifying)), adapters })).result).toBe("passed");

    const notSetUp = await validatePair({ ...input(scriptedRunner(copies, (plan) => (plan.state === "clean" ? { outcome: "setup_failed" } : qualifying(plan)))), adapters });
    expect(notSetUp.records.find((record) => record.state === "clean")?.status).toBe("invalid");
    expect(notSetUp.result).toBe("error");
    expect(notSetUp.error_code).toBe("cells_invalid");
    expect(notSetUp.matrix?.original_suite.clean.observed).toBe("error");
    expect(notSetUp.matrix?.verification.clean.observed).toBe("error");
    expect(notSetUp.matrix?.verification.clean.runs_valid).toBe(2);

    const late = await validatePair({ ...input(scriptedRunner(copies, (plan) => (plan.state === "fixed" ? { outcome: "timed_out" } : qualifying(plan)))), adapters });
    expect(late.result).toBe("error");
    expect(late.matrix?.original_suite.fixed.observed).toBe("incomplete");
    expect(late.matrix?.verification.fixed.observed).toBe("incomplete");
  });

  it("holds every pass or fail to the protocol's minimum of valid runs, whatever the adapter says", async () => {
    const base = syntheticAdapter({ seeds: ["01"], workdir: parent });
    const generous: HostAdapter = {
      ...base,
      interpret: (records, protocol) => {
        const cells = base.interpret(records, protocol);
        const thin = (cell: InterpretedCells["verification"]) => ({ ...cell, observed: cell.observed === "incomplete" ? "fail" as const : cell.observed });
        return { original_suite: cells.original_suite, verification: thin(cells.verification) };
      },
    };
    // Buggy runs one round where the protocol requires two; the adapter would still report a detection.
    const runner = scriptedRunner(copies, (plan) => ({ ...qualifying(plan), rounds: plan.state === "buggy" ? 1 : 2 }));
    const outcome = await validatePair({ ...input(runner), adapters: { "task-report": generous } });
    expect(outcome.result).toBe("error");
    expect(outcome.matrix?.verification.buggy.observed).toBe("incomplete");
  });

  it("answers adapter_error when the plans do not match the protocol's copies or the catalog and availability calls throw", async () => {
    const base = syntheticAdapter({ seeds: ["01"], workdir: parent });
    const extra: HostAdapter = { ...base, copyPlans: (state, unpacked, protocol) => [...base.copyPlans(state, unpacked, protocol), ...base.copyPlans(state, unpacked, protocol).map((plan) => ({ ...plan, copy_id: `${plan.copy_id}-extra` }))] };
    const runner = scriptedRunner(copies, qualifying);
    expect((await validatePair({ ...input(runner), adapters: { "task-report": extra } })).error_code).toBe("adapter_error");
    const catalogThrows: HostAdapter = { ...base, catalog: () => { throw new Error("synthetic catalog failure"); }, availability: () => ({ available: true, reason: null }) };
    expect((await validatePair({ ...input(runner), adapters: { "task-report": catalogThrows } })).error_code).toBe("adapter_error");
    const availabilityThrows: HostAdapter = { ...base, availability: () => { throw new Error("synthetic availability failure"); } };
    expect((await validatePair({ ...input(runner), adapters: { "task-report": availabilityThrows } })).error_code).toBe("adapter_error");
    expect(runner.plans).toHaveLength(0);
  });

  it("refuses a runner that returns another copy's result", async () => {
    const inner = scriptedRunner(copies, qualifying);
    const wrong: ValidatePairInput["runner"] = { run: async (plan, roots) => ({ ...(await inner.run(plan, roots)), copy_id: "synthetic-other" }) };
    const outcome = await validatePair(input(wrong));
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("runner_error");
  });

  it("refuses copy plans that place a file the harness did not build for that state", async () => {
    const base = syntheticAdapter({ seeds: ["01"], workdir: parent });
    const patching: HostAdapter = {
      ...base,
      copyPlans: (state: CopyState, unpacked, protocol) =>
        base.copyPlans(state, unpacked, protocol).map((plan) => ({ ...plan, files: plan.files.map((file) => ({ ...file, sha256: "0".repeat(64) })) })),
    };
    const runner = scriptedRunner(copies, qualifying);
    const outcome = await validatePair({ ...input(runner), adapters: { "task-report": patching } });
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("adapter_error");
    expect(runner.plans).toHaveLength(0);
  });
});
