// Removing the fresh workspace is cleanup only: a failure to remove it never replaces the run's outcome,
// neither a definite result nor a runner's rejection. Removal is made to fail by a stand-in `rm` that
// refuses the workspace directory while `failRemoval` is set.
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticPair, syntheticAdapter } from "@rbw/case-package/synthetic";
import type { CopyPlan } from "@rbw/factory-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePair, type ValidatePairInput } from "../src/validate.ts";
import { scriptedRunner, type ScriptedCopy } from "./support.ts";

const removal = vi.hoisted(() => ({ fail: false, refused: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>();
  const rm = (...args: Parameters<typeof original.rm>): Promise<void> => {
    const [path] = args;
    if (removal.fail && typeof path === "string" && path.includes("rbw-validate-")) {
      removal.refused.push(path);
      return Promise.reject(Object.assign(new Error(`EBUSY: synthetic removal failure, rm '${path}'`), { code: "EBUSY" }));
    }
    return original.rm(...args);
  };
  return { ...original, default: { ...original, rm }, rm };
});

let parent: string;
let copies: string;
beforeEach(async () => {
  removal.fail = false;
  removal.refused = [];
  parent = await mkdtemp(join(tmpdir(), "case-validate-cleanup-"));
  copies = await mkdtemp(join(tmpdir(), "case-validate-cleanup-copies-"));
});
afterEach(async () => {
  removal.fail = false;
  await rm(parent, { recursive: true, force: true });
  await rm(copies, { recursive: true, force: true });
});

const NOW = new Date("2026-10-19T12:00:00.000Z");
const pair = buildSyntheticPair({ host_id: "task-report", seed: "01" });
const qualifying = (plan: CopyPlan): ScriptedCopy => ({ outcome: "ran", detected: plan.state === "buggy" });

function input(runner: ValidatePairInput["runner"]): ValidatePairInput {
  return {
    bug_case: pair.bug_case.bytes,
    validator: pair.validator.bytes,
    adapters: { "task-report": syntheticAdapter({ seeds: ["01"], workdir: copies }) },
    runner,
    now: () => NOW,
    workdir: parent,
  };
}

describe("validatePair when its workspace cannot be removed", () => {
  it("keeps a passed result and reports the leftover workspace in the diagnostic", async () => {
    removal.fail = true;
    const runner = scriptedRunner(copies, qualifying);
    const outcome = await validatePair(input(runner));
    expect(removal.refused).toHaveLength(1);
    expect(outcome.result).toBe("passed");
    expect(outcome.error_code).toBeNull();
    expect(outcome.message).toBeNull();
    expect(outcome.records).toHaveLength(3);
    expect(outcome.diagnostic).toContain("the workspace could not be removed");
    expect(outcome.diagnostic).toContain("EBUSY");
    expect(await readdir(parent)).toHaveLength(1);
  });

  it("keeps an error result and its own diagnostic, and adds the leftover workspace to it", async () => {
    removal.fail = true;
    const inner = scriptedRunner(copies, qualifying);
    const wrong: ValidatePairInput["runner"] = { run: async (plan, roots) => ({ ...(await inner.run(plan, roots)), copy_id: "synthetic-other" }) };
    const outcome = await validatePair(input(wrong));
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("runner_error");
    expect(outcome.diagnostic).toContain("the runner returned an invalid collected copy");
    expect(outcome.diagnostic).toContain("the workspace could not be removed");
  });

  it("passes a runner's rejection through unchanged", async () => {
    removal.fail = true;
    const uncertain = new Error("synthetic uncertain provider outcome");
    const runner = scriptedRunner(copies, (plan) => (plan.state === "buggy" ? { outcome: "reject", error: uncertain } : qualifying(plan)));
    await expect(validatePair(input(runner))).rejects.toBe(uncertain);
    expect(removal.refused).toHaveLength(1);
  });

  it("removes the workspace and reports nothing when removal works", async () => {
    const runner = scriptedRunner(copies, qualifying);
    const outcome = await validatePair(input(runner));
    expect(outcome.result).toBe("passed");
    expect(outcome.diagnostic).toBeNull();
    expect(await readdir(parent)).toEqual([]);
  });
});
