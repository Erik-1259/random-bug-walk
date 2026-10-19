// The copy driver of evaluator v2, run as root inside the version 2 kit image by rbw-copy-v2:
//
//   node /opt/rbw/evaluator/pkg/v2/copy.ts --state clean|buggy|fixed --copy-id f3q2-... --entry <entry ID> \
//     [--purpose counted|smoke] [--instances N --main-target N --control-target N]   (smoke only)
//
// The runner places the app tree in /workspace/app and the validator's evaluator files in
// /opt/rbw/evaluator/pkg before the start. The driver records which catalog entry and catalog it
// runs, the tree the catalog fixes for its state and the tree it found, and stops before any
// instance when they differ. Otherwise it runs version 1's phases unchanged: the dependency
// manifests must equal the baseline's, the tree is typechecked as the app user, and each declared
// instance (fresh database cluster and app) runs the unchanged original suite once and then the F3
// blocks under the protocol file's rules. Each block's trial outcomes are kept in the order they ran.
// The record set goes to /var/lib/rbw/results/copy: copy.json (format rbw.task-report.copy.v2) and
// per instance lifecycle.json, original/, checks/ and logs/. Exit 0 the copy ran or refused its
// tree (its record is data), 1 the copy is invalid, 2 usage.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dependencyDifferences, loadBaseline } from "../src/baseline.ts";
import { runInstanceChecks } from "../src/f3/check.ts";
import type { BlockRule } from "../src/f3/block.ts";
import { FAILURE_CODE, KINDS, loadData } from "../src/f3/data.ts";
import type { KindId, Outcome } from "../src/f3/data.ts";
import { hashTree, isRecord } from "../src/hash.ts";
import { runOriginalSuite } from "../src/suite/run-suite.ts";
import { startInstance } from "../src/copy/instance.ts";
import { APP_DIR, BASE_URL, DATABASE, EVALUATOR_SUITE_DIR, EVALUATOR_WORK_DIR, LAUNCH, LIMITS, PLAYWRIGHT_DIR, RESULTS_DIR, SUPERUSER, socketUrl } from "../src/copy/layout.ts";
import { runCommand } from "../src/copy/proc.ts";
import { UsageError, parseCopyArgsV2 } from "./args.ts";
import type { CopyArgsV2 } from "./args.ts";
import { entryPins, loadCatalogPins } from "./entry.ts";
import { stateExpectation } from "./expected.ts";
import { blockRuleV2, loadProtocolV2 } from "./protocol.ts";
import { COPY_V2_FILE, COPY_V2_FORMAT } from "./record.ts";
import type { CopySummaryV2, InstanceRecordV2, PhaseEntryV2 } from "./record.ts";

const OUTCOMES: readonly string[] = ["pass", FAILURE_CODE, "invalid"];

/** Each block's outcomes from trials.jsonl, in the order the trials ran; refuses a gap or repeat in the indices. */
export function outcomesFromTrials(text: string): Partial<Record<KindId, Outcome[]>> {
  const out: Partial<Record<KindId, Outcome[]>> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new UsageError("trials.jsonl has a line that is not JSON");
    }
    const observation = isRecord(value) ? value.observation : undefined;
    const classification = isRecord(value) ? value.classification : undefined;
    if (!isRecord(observation) || !isRecord(classification)) throw new UsageError("trials.jsonl has a line that is not a trial");
    const kind = KINDS.find((item) => item === observation.kind);
    if (kind === undefined) throw new UsageError("trials.jsonl names an unknown kind");
    const outcome = classification.outcome;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) throw new UsageError("trials.jsonl has an unknown outcome");
    const list = out[kind] ?? [];
    if (observation.index !== list.length + 1) throw new UsageError(`trials.jsonl has a gap or repeat in the ${kind} indices`);
    list.push(outcome as Outcome);
    out[kind] = list;
  }
  return out;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function runCopyV2(args: CopyArgsV2, log: (message: string) => void): Promise<number> {
  const startedAt = new Date().toISOString();
  const baseline = loadBaseline();
  const data = loadData();
  const protocol = loadProtocolV2();
  const catalog = loadCatalogPins();
  const pins = entryPins(catalog, args.entryId);
  if (protocol.data_sha256 !== data.sha256 || pins.data_sha256 !== data.sha256) throw new UsageError("the protocol or the catalog pins another data file");
  if (pins.protocol_sha256 !== protocol.sha256) throw new UsageError("the catalog pins another protocol");
  const expectation = stateExpectation(baseline, catalog, args.entryId);
  const out = join(RESULTS_DIR, "copy");
  if (existsSync(out) && readdirSync(out).length > 0) throw new UsageError(`${out} is not empty`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(RESULTS_DIR, 0o700);

  const instancesWanted = args.instances ?? protocol.states[args.state].instances;
  const rules = {} as Record<KindId, BlockRule>;
  for (const kind of KINDS) {
    const base = blockRuleV2(protocol, kind);
    const target = kind === "main" ? args.mainTarget : args.controlTarget;
    rules[kind] = target === null ? { ...base } : { ...base, valid_target: target };
  }

  const source = hashTree(APP_DIR);
  const phases: PhaseEntryV2[] = [];
  const summary: CopySummaryV2 = {
    format: COPY_V2_FORMAT,
    copy_id: args.copyId,
    state: args.state,
    purpose: args.purpose,
    entry_id: pins.entry_id,
    catalog_sha256: catalog.sha256,
    expected_source_tree_sha256: expectation.trees[args.state],
    baseline_id: baseline.baseline_id,
    data_sha256: data.sha256,
    protocol_sha256: protocol.sha256,
    source_tree_sha256: source.tree_sha256,
    source_files: source.files,
    rules,
    invalid_reason: null,
    instances: [],
    started_at: startedAt,
    ended_at: null,
    phases,
  };
  const finish = (code: number): number => {
    summary.ended_at = new Date().toISOString();
    writeJson(join(out, COPY_V2_FILE), summary);
    return code;
  };

  const treeOk = source.tree_sha256 === expectation.trees[args.state];
  phases.push({ name: "source_tree", ok: treeOk, duration_ms: 0, detail: treeOk ? null : `found ${source.tree_sha256}, the ${args.state} state is ${expectation.trees[args.state]}` });
  if (!treeOk) {
    log("copy refused: the app tree is not the state's tree");
    return finish(0);
  }
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
  if (modes.code !== 0 || owner.code !== 0) {
    summary.invalid_reason = "permissions_failed";
    return finish(1);
  }
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
    const record: InstanceRecordV2 = { instance: number, failure: null, suite: null, trials: {}, blocks: {} };
    summary.instances.push(record);
    log(`${id}: starting`);
    const instance = await startInstance(id, dir);
    const lifecycle: Record<string, unknown> = { instance: id, started_at: new Date().toISOString(), phases: instance.phases };
    if (instance.failed !== null) {
      record.failure = { kind: "setup", detail: `${instance.failed} failed` };
      writeJson(join(dir, "lifecycle.json"), lifecycle);
      log(`${id}: ${instance.failed} failed`);
      continue;
    }
    try {
      const originalDir = join(dir, "original");
      mkdirSync(originalDir);
      // The run's suite copy lives in the root-only evaluator tree, where @playwright/test resolves.
      const suite = await runOriginalSuite({ baseline, suiteDir: EVALUATOR_SUITE_DIR, workDir: join(EVALUATOR_WORK_DIR, `${args.copyId}-${id}`), outDir: originalDir, baseUrl: BASE_URL, playwrightDir: PLAYWRIGHT_DIR });
      record.suite = { verdict: suite.verdict, tests_expected: suite.comparison?.tests_expected ?? 0, passed: suite.comparison?.passed ?? 0, failed: [...(suite.comparison?.failed ?? [])] };
      log(`${id}: original suite ${suite.verdict} (${String(record.suite.passed)} of ${String(record.suite.tests_expected)})`);
      if (suite.verdict === "refused") {
        record.failure = { kind: "setup", detail: "original suite refused" };
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
        record.trials = outcomesFromTrials(readFileSync(join(checksDir, "trials.jsonl"), "utf8"));
      }
    } catch (error) {
      record.failure = { kind: "run", detail: `instance error ${error instanceof Error ? error.name : "unknown"}` };
      log(`${id}: ${record.failure.detail}`);
    } finally {
      const stopped = await instance.stop();
      instance.phases.push(stopped);
      lifecycle.ended_at = new Date().toISOString();
      writeJson(join(dir, "lifecycle.json"), lifecycle);
      if (!stopped.ok && record.failure === null) record.failure = { kind: "run", detail: "stop failed" };
    }
  }
  return finish(0);
}

async function main(): Promise<number> {
  let args: CopyArgsV2;
  try {
    args = parseCopyArgsV2(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`copy: usage: ${error instanceof Error ? error.message : "error"}\n`);
    return 2;
  }
  const log = (message: string): void => {
    process.stderr.write(`copy: ${message}\n`);
  };
  try {
    return await runCopyV2(args, log);
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
