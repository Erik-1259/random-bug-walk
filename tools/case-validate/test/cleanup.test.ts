// Removing the fresh workspace, and the CLI's temporary results, is cleanup only: a failure to remove them
// never replaces the run's outcome, neither a definite result nor a runner's rejection. Removal is made to
// fail by a stand-in `rm` that refuses the harness's own directories while `removal.fail` is set; its
// message names no path, so what the harness reports must name the directory itself. The same holds for a
// docker copy's fresh results directory that brought back no usable results.
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticPair, syntheticAdapter } from "@rbw/case-package/synthetic";
import type { CopyPlan } from "@rbw/factory-contract";
import { dockerRunner, type DockerCommand } from "../src/docker.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES, runValidateCli } from "../src/run-cli.ts";
import { validatePair, type ValidatePairInput } from "../src/validate.ts";
import { scriptedRunner, type ScriptedCopy } from "./support.ts";

const removal = vi.hoisted(() => ({ fail: false, refused: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>();
  const rm = (...args: Parameters<typeof original.rm>): Promise<void> => {
    const [path] = args;
    if (removal.fail && typeof path === "string" && path.includes("rbw-validate-")) {
      removal.refused.push(path);
      return Promise.reject(Object.assign(new Error("EBUSY: synthetic removal failure"), { code: "EBUSY" }));
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
  vi.restoreAllMocks();
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
  it("keeps a passed result and names the leftover workspace in the diagnostic", async () => {
    removal.fail = true;
    const runner = scriptedRunner(copies, qualifying);
    const outcome = await validatePair(input(runner));
    expect(removal.refused).toHaveLength(1);
    expect(outcome.result).toBe("passed");
    expect(outcome.error_code).toBeNull();
    expect(outcome.message).toBeNull();
    expect(outcome.records).toHaveLength(3);
    const left = await readdir(parent);
    expect(left).toHaveLength(1);
    expect(outcome.diagnostic).toBe(`the workspace ${join(parent, left[0] ?? "")} could not be removed: EBUSY: synthetic removal failure`);
  });

  it("keeps an error result and its own diagnostic, and adds the leftover workspace to it", async () => {
    removal.fail = true;
    const inner = scriptedRunner(copies, qualifying);
    const wrong: ValidatePairInput["runner"] = { run: async (plan, roots) => ({ ...(await inner.run(plan, roots)), copy_id: "synthetic-other" }) };
    const outcome = await validatePair(input(wrong));
    expect(outcome.result).toBe("error");
    expect(outcome.error_code).toBe("runner_error");
    expect(outcome.diagnostic).toContain("the runner returned an invalid collected copy");
    expect(outcome.diagnostic).toContain("could not be removed");
  });

  it("passes a runner's rejection through unchanged and reports the leftover workspace as a process warning", async () => {
    removal.fail = true;
    const warnings: string[] = [];
    vi.spyOn(process, "emitWarning").mockImplementation((warning: string | Error) => {
      warnings.push(String(warning));
    });
    const uncertain = new Error("synthetic uncertain provider outcome");
    const runner = scriptedRunner(copies, (plan) => (plan.state === "buggy" ? { outcome: "reject", error: uncertain } : qualifying(plan)));
    await expect(validatePair(input(runner))).rejects.toBe(uncertain);
    expect(removal.refused).toHaveLength(1);
    expect(warnings).toEqual([`the workspace ${removal.refused[0] ?? ""} could not be removed: EBUSY: synthetic removal failure`]);
  });

  it("removes the workspace and reports nothing when removal works", async () => {
    const runner = scriptedRunner(copies, qualifying);
    const outcome = await validatePair(input(runner));
    expect(outcome.result).toBe("passed");
    expect(outcome.diagnostic).toBeNull();
    expect(await readdir(parent)).toEqual([]);
  });
});

describe("rbw-validate when its temporary results cannot be removed", () => {
  it("still prints the matrix and the result and exits with the result's code", async () => {
    removal.fail = true;
    const bugCase = join(copies, pair.bug_case.filename);
    const validator = join(copies, pair.validator.filename);
    await writeFile(bugCase, pair.bug_case.bytes);
    await writeFile(validator, pair.validator.bytes);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runValidateCli([bugCase, validator], { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, {
      adapters: input(scriptedRunner(copies, qualifying)).adapters,
      runner: () => scriptedRunner(copies, qualifying),
      now: () => NOW,
      workdir: parent,
    });
    expect(code).toBe(EXIT_CODES.passed);
    expect(out.join("")).toMatch(/^result: passed$/m);
    const results = removal.refused.find((path) => path.includes("rbw-validate-copies-"));
    expect(results).toBeDefined();
    expect(err.join("")).toContain(`rbw-validate: could not remove ${results ?? ""}: EBUSY: synthetic removal failure`);
  });
});

describe("dockerRunner when a copy's unused results directory cannot be removed", () => {
  it("keeps the copy's setup failure and reports the leftover directory as a process warning", async () => {
    removal.fail = true;
    const warnings: string[] = [];
    vi.spyOn(process, "emitWarning").mockImplementation((warning: string | Error) => {
      warnings.push(String(warning));
    });
    const image = `sha256:${"b".repeat(64)}`;
    const docker: DockerCommand = (args) =>
      Promise.resolve(
        args[0] === "image" ? { code: 0, stdout: `${image} amd64 []\n`, stderr: "" } : args[0] === "create" ? { code: 125, stdout: "", stderr: "create failed" } : { code: 0, stdout: "", stderr: "" },
      );
    const plan: CopyPlan = {
      copy_id: "synthetic-buggy-1",
      host_id: "task-report",
      state: "buggy",
      image: { reference: "registry.invalid/synthetic/task-report-kit:1", digest: null },
      files: [],
      evaluator_files: [],
      destinations: { app: "/rbw/app", evaluator: "/rbw/evaluator", results: "/rbw/results" },
      command: ["node", "/rbw/evaluator/run-copy.js"],
      limits: { timeout_s: 30, vcpus: 1, memory_mb: 512, network: "none" },
    };
    const resultsDir = join(parent, "rbw-validate-copies");
    await mkdir(resultsDir);
    const collected = await dockerRunner({ command: docker, resultsDir }).run(plan, { app_root: copies, evaluator_root: copies });
    expect(collected.outcome).toBe("setup_failed");
    expect(removal.refused).toHaveLength(1);
    expect(removal.refused[0]).toMatch(/rbw-copy-results-/);
    expect(warnings).toEqual([`the copy results directory ${removal.refused[0] ?? ""} could not be removed: EBUSY: synthetic removal failure`]);
  });
});
