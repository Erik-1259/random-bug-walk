// The copy entry point inside the task-report copy image, run as root by the image's tini:
//
//   node /opt/rbw/evaluator/pkg/src/copy/main.ts --state clean|buggy|fixed --run-id f3q-... \
//     [--purpose counted|smoke] [--instances N --main-target N --control-target N]   (smoke only)
//
// One copy holds one app source tree in /workspace/app (clean, buggy or fixed). The copy checks
// that the tree's package.json and package-lock.json equal the baseline's (the image holds only
// the baseline's dependencies; otherwise the copy is invalid), typechecks it as the app user, then
// runs the declared number of fresh instances one after another. Each instance gets a new
// database cluster and app process, runs the unchanged original suite once, then the F3 check
// blocks, and is stopped. The record set goes to /var/lib/rbw/results/copy: copy.json, and per
// instance lifecycle.json, original/{result,report}.json, checks/{trials.jsonl,late-reread.json}
// and logs/. Exit 0 the copy ran (its verdicts are data), 1 the copy is invalid, 2 usage.
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dependencyDifferences, loadBaseline } from "../baseline.ts";
import { hashTree } from "../hash.ts";
import { runInstanceChecks } from "../f3/check.ts";
import type { BlockRule } from "../f3/block.ts";
import { KINDS, STATES, loadData } from "../f3/data.ts";
import type { CodeState, KindId } from "../f3/data.ts";
import { blockRule, loadProtocol } from "../protocol.ts";
import type { CopySummary, InstanceSummary } from "../protocol.ts";
import { runOriginalSuite } from "../suite/run-suite.ts";
import { startInstance } from "./instance.ts";
import { APP_DIR, BASE_URL, EVALUATOR_SUITE_DIR, EVALUATOR_WORK_DIR, LAUNCH, LIMITS, PLAYWRIGHT_DIR, RESULTS_DIR, SUPERUSER, DATABASE, socketUrl } from "./layout.ts";
import { runCommand } from "./proc.ts";

export const COPY_FORMAT = "rbw.task-report.copy.v1";
const RUN_ID = /^f3q-[a-z0-9][a-z0-9-]{0,58}$/;

export interface CopyArgs {
  state: CodeState;
  purpose: "counted" | "smoke";
  runId: string;
  instances: number | null;
  mainTarget: number | null;
  controlTarget: number | null;
}

export interface PhaseEntry {
  name: string;
  ok: boolean;
  duration_ms: number;
  detail: string | null;
}

/** copy.json: the summary the protocol evaluation reads, plus the copy's identity and phases. */
export interface CopyRecord extends CopySummary {
  format: typeof COPY_FORMAT;
  run_id: string;
  source_files: Record<string, string>;
  rules: Record<KindId, BlockRule>;
  started_at: string;
  ended_at: string | null;
  phases: PhaseEntry[];
}

export class UsageError extends Error {
  override name = "UsageError";
}

function positive(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]?$/.test(value)) throw new UsageError(`${name} must be 1-99`);
  return Number(value);
}

export function parseCopyArgs(argv: readonly string[]): CopyArgs {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        state: { type: "string" },
        purpose: { type: "string" },
        "run-id": { type: "string" },
        instances: { type: "string" },
        "main-target": { type: "string" },
        "control-target": { type: "string" },
      },
    }));
  } catch {
    throw new UsageError("unknown or malformed argument");
  }
  const state = values.state;
  if (!(STATES as readonly (string | undefined)[]).includes(state)) throw new UsageError("--state must be clean, buggy or fixed");
  const purpose = values.purpose ?? "counted";
  if (purpose !== "counted" && purpose !== "smoke") throw new UsageError("--purpose must be counted or smoke");
  const runId = values["run-id"] ?? "";
  if (!RUN_ID.test(runId)) throw new UsageError("--run-id must start with f3q- and use lowercase letters, digits and dashes");
  const args: CopyArgs = {
    state: state as CodeState,
    purpose,
    runId,
    instances: positive(values.instances, "--instances"),
    mainTarget: positive(values["main-target"], "--main-target"),
    controlTarget: positive(values["control-target"], "--control-target"),
  };
  if (purpose === "counted" && (args.instances !== null || args.mainTarget !== null || args.controlTarget !== null)) {
    throw new UsageError("a counted copy runs the protocol's counts; overrides are for smoke copies only");
  }
  if (purpose === "smoke" && args.state !== "clean") throw new UsageError("smoke copies run the clean state only");
  return args;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function runCopy(args: CopyArgs, log: (message: string) => void): Promise<number> {
  const startedAt = new Date().toISOString();
  const baseline = loadBaseline();
  const data = loadData();
  const protocol = loadProtocol();
  if (protocol.data_sha256 !== data.sha256) throw new UsageError("the protocol pins another data file");
  const out = join(RESULTS_DIR, "copy");
  if (existsSync(out) && readdirSync(out).length > 0) throw new UsageError(`${out} is not empty`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(RESULTS_DIR, 0o700);

  const instancesWanted = args.instances ?? protocol.states[args.state].instances;
  const rules = {} as Record<KindId, BlockRule>;
  for (const kind of KINDS) {
    const base = blockRule(protocol, kind);
    const target = kind === "main" ? args.mainTarget : args.controlTarget;
    rules[kind] = target === null ? base : { ...base, valid_target: target };
  }

  const source = hashTree(APP_DIR);
  const phases: PhaseEntry[] = [];
  const summary: CopyRecord = {
    format: COPY_FORMAT,
    run_id: args.runId,
    state: args.state,
    purpose: args.purpose,
    invalid_reason: null,
    baseline_id: baseline.baseline_id,
    data_sha256: data.sha256,
    protocol_sha256: protocol.sha256,
    source_tree_sha256: source.tree_sha256,
    source_files: source.files,
    rules,
    started_at: startedAt,
    ended_at: null,
    phases,
    instances: [],
  };
  const finish = (code: number): number => {
    summary.ended_at = new Date().toISOString();
    writeJson(join(out, "copy.json"), summary);
    return code;
  };

  const dependencyProblems = dependencyDifferences(APP_DIR, baseline);
  phases.push({ name: "source_check", ok: dependencyProblems.length === 0, duration_ms: 0, detail: dependencyProblems.length === 0 ? null : dependencyProblems.join("; ") });
  if (dependencyProblems.length > 0) {
    summary.invalid_reason = "dependency_manifests_differ";
    log(`copy invalid: ${dependencyProblems.join("; ")}`);
    return finish(1);
  }
  // The app tree is root-owned and read-only to the app user; node_modules came with the image.
  const modes = await runCommand("chmod", ["-R", "u=rwX,go=rX", APP_DIR], { timeoutMs: 60_000 });
  const owner = await runCommand("chown", ["-R", "root:root", APP_DIR], { timeoutMs: 60_000 });
  phases.push({ name: "permissions", ok: modes.code === 0 && owner.code === 0, duration_ms: modes.duration_ms + owner.duration_ms, detail: null });
  const typecheck = await runCommand(LAUNCH, ["--as", "app", "--cwd", APP_DIR, "--timeout-ms", String(LIMITS.typecheck_ms), "--", "node_modules/.bin/tsc", "-p", ".", "--noEmit"], {
    timeoutMs: LIMITS.typecheck_ms + 15_000,
    logFile: join(out, "typecheck.log"),
  });
  phases.push({ name: "typecheck", ok: typecheck.code === 0, duration_ms: typecheck.duration_ms, detail: typecheck.code === 0 ? null : `exit ${String(typecheck.code)}` });
  if (typecheck.code !== 0) {
    summary.invalid_reason = "typecheck_failed";
    return finish(1);
  }

  for (let number = 1; number <= instancesWanted; number += 1) {
    const id = `i${String(number).padStart(2, "0")}`;
    const dir = join(out, id);
    mkdirSync(dir, { mode: 0o700 });
    const record: InstanceSummary = { instance: number, failure: null, suite: null, blocks: {} };
    summary.instances.push(record);
    log(`${id}: starting`);
    const instance = await startInstance(id, dir);
    const lifecycle: Record<string, unknown> = { instance: id, started_at: new Date().toISOString(), phases: instance.phases };
    if (instance.failed !== null) {
      record.failure = `${instance.failed} failed`;
      writeJson(join(dir, "lifecycle.json"), lifecycle);
      log(`${id}: ${instance.failed} failed`);
      continue;
    }
    try {
      const originalDir = join(dir, "original");
      mkdirSync(originalDir);
      // The run's suite copy lives in the root-only evaluator tree, where @playwright/test resolves.
      const suite = await runOriginalSuite({ baseline, suiteDir: EVALUATOR_SUITE_DIR, workDir: join(EVALUATOR_WORK_DIR, `${args.runId}-${id}`), outDir: originalDir, baseUrl: BASE_URL, playwrightDir: PLAYWRIGHT_DIR });
      record.suite = { verdict: suite.verdict, tests_expected: suite.comparison?.tests_expected ?? 0, passed: suite.comparison?.passed ?? 0 };
      log(`${id}: original suite ${suite.verdict} (${String(record.suite.passed)} of ${String(record.suite.tests_expected)})`);
      if (suite.verdict === "refused") {
        record.failure = "original suite refused";
      } else {
        const checksDir = join(dir, "checks");
        mkdirSync(checksDir);
        const checks = await runInstanceChecks({
          data,
          rules,
          baseUrl: BASE_URL,
          gateUrl: socketUrl(data.environment.gate_role, DATABASE),
          monitorUrl: socketUrl(SUPERUSER, DATABASE),
          appLogPath: instance.appLog,
          outDir: checksDir,
          log: (message) => {
            log(`${id}: ${message}`);
          },
        });
        record.blocks = checks.blocks;
      }
    } catch (error) {
      record.failure = `instance error ${error instanceof Error ? error.name : "unknown"}`;
      log(`${id}: ${record.failure}`);
    } finally {
      const stopped = await instance.stop();
      instance.phases.push(stopped);
      lifecycle.ended_at = new Date().toISOString();
      writeJson(join(dir, "lifecycle.json"), lifecycle);
      if (!stopped.ok && record.failure === null) record.failure = "stop failed";
    }
  }
  return finish(0);
}

async function main(): Promise<number> {
  let args: CopyArgs;
  try {
    args = parseCopyArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`copy: usage: ${error instanceof Error ? error.message : "error"}\n`);
    return 2;
  }
  const log = (message: string): void => {
    process.stderr.write(`copy: ${message}\n`);
  };
  try {
    return await runCopy(args, log);
  } catch (error) {
    if (error instanceof UsageError) {
      log(`usage: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
