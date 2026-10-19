// The local qualification of the task-report entry under evaluator v2, in four steps:
//
//   node adapter/qualify.ts build --tag rbw-task-report:<name>      build the version 2 kit image
//   node adapter/qualify.ts prepare --out <new dir>                 adapter inputs, the three states, the copy plans
//   node adapter/qualify.ts run --dir <dir> [--smoke <copy ID>]     every copy plan through local Docker
//   node adapter/qualify.ts evaluate --dir <dir>                    collect, interpret and the verdict per state
//
// prepare and evaluate need this package's dependencies; build and run use Node's built-ins only,
// so they run on a host where Docker is and the package is not installed. prepare builds the
// states the way the package harness will (see local-harness.ts) and asks the adapter for the copy
// plans; run passes each plan with its roots to the local Docker runner (buggy, then fixed, then
// clean); evaluate turns each collected copy into a copy record with the adapter's collect, combines
// each state's records with interpret, and records the cells, the verdict per state and, as a
// cross-check, the evaluation of the copies' record sets.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CollectedCopy, CopyPlan, CopyRecord, CopyState, UnpackedPair } from "./contract.ts";
import { createLocalDockerRunner } from "./local-runner.ts";

export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = resolve(PACKAGE_DIR, "../..");
const TAG = /^rbw-task-report:[a-z0-9][a-z0-9._-]{0,63}$/;
const SMOKE_ID = /^f3q2-smoke-[a-z0-9][a-z0-9-]{0,40}$/;
const RUN_ORDER: readonly CopyState[] = ["buggy", "fixed", "clean"];

export class QualifyError extends Error {
  override name = "QualifyError";
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildArgsV2(tag: string, repoRoot: string): string[] {
  return [
    "build",
    "-f",
    join(repoRoot, "kit/task-report/v2/Dockerfile"),
    "--build-arg",
    "REGISTRY=docker.io",
    "--build-context",
    `app=${join(repoRoot, "hosts/task-report/app")}`,
    "--build-context",
    `launcher=${join(repoRoot, "kit/umami/bin")}`,
    "-t",
    tag,
    join(repoRoot, "kit/task-report"),
  ];
}

function build(tag: string): Promise<number> {
  if (!TAG.test(tag)) throw new QualifyError("--tag must be rbw-task-report:<name>");
  return new Promise((resolvePromise) => {
    const child = spawn("docker", buildArgsV2(tag, REPO_ROOT), { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", () => {
      resolvePromise(1);
    });
    child.once("close", (code) => {
      resolvePromise(code === 0 ? 0 : 1);
    });
  });
}

async function prepare(out: string): Promise<number> {
  if (existsSync(out)) throw new QualifyError("the output directory must not exist yet");
  mkdirSync(out, { recursive: true });
  const { createTaskReportAdapter } = await import("./adapter.ts");
  const { buildLocalPair } = await import("./local-harness.ts");
  const adapter = createTaskReportAdapter({ workDir: join(out, "work") });
  const [entry] = adapter.catalog();
  if (entry === undefined) throw new QualifyError("the catalog has no entry");
  const bug = await adapter.bugCaseInputs(entry);
  const validator = await adapter.validatorInputs(entry);
  const pair = buildLocalPair(join(out, "pair"), bug, validator);
  const protocol = adapter.protocol(entry);
  const plans = RUN_ORDER.flatMap((state) => adapter.copyPlans(state, pair, protocol));
  writeJson(join(out, "inputs.json"), { format: "rbw.task-report.local-inputs.v2", catalog_entry: entry, bug_case: bug, validator, protocol });
  writeJson(join(out, "pair.json"), pair);
  writeJson(join(out, "plans.json"), { plans });
  process.stdout.write(`${JSON.stringify({ entry_id: entry.entry_id, pair_sha256: pair.pair_sha256, copies: plans.map((plan) => ({ copy_id: plan.copy_id, state: plan.state, files: plan.files.length, evaluator_files: plan.evaluator_files.length })) }, null, 2)}\n`);
  return 0;
}

function rootsFor(pair: UnpackedPair, plan: CopyPlan): { app_root: string; evaluator_root: string } {
  return { app_root: pair.states[plan.state].root, evaluator_root: pair.evaluator.root };
}

async function run(dir: string, smoke: string | undefined): Promise<number> {
  const pair = readJson(join(dir, "pair.json")) as UnpackedPair;
  const { plans } = readJson(join(dir, "plans.json")) as { plans: CopyPlan[] };
  const log = (message: string): void => {
    process.stderr.write(`qualify: ${message}\n`);
  };
  if (smoke !== undefined) {
    if (!SMOKE_ID.test(smoke)) throw new QualifyError("--smoke must be a copy ID f3q2-smoke-<name>");
    const clean = plans.find((plan) => plan.state === "clean");
    if (clean === undefined) throw new QualifyError("no clean plan");
    const entry = clean.command[clean.command.indexOf("--entry") + 1] ?? "";
    const plan: CopyPlan = { ...clean, copy_id: smoke, command: [clean.command[0] ?? "", "--state", "clean", "--copy-id", smoke, "--entry", entry, "--purpose", "smoke", "--instances", "1", "--main-target", "2", "--control-target", "1"] };
    const runner = createLocalDockerRunner({ outDir: join(dir, "smoke"), log });
    const collected = await runner.run(plan, rootsFor(pair, plan));
    writeJson(join(dir, "smoke", `${smoke}.json`), { plan, collected });
    return collected.outcome === "ran" && collected.exit_code === 0 ? 0 : 1;
  }
  if (existsSync(join(dir, "collected.json"))) throw new QualifyError("the directory already holds collected copies");
  const runner = createLocalDockerRunner({ outDir: join(dir, "copies"), log });
  const collected: CollectedCopy[] = [];
  for (const plan of plans) {
    log(`${plan.copy_id}: ${plan.state}`);
    collected.push(await runner.run(plan, rootsFor(pair, plan)));
    writeJson(join(dir, "collected.json"), { collected });
  }
  return collected.every((item) => item.outcome === "ran") ? 0 : 1;
}

async function evaluate(dir: string): Promise<number> {
  const { createTaskReportAdapter } = await import("./adapter.ts");
  const { validateContract } = await import("@rbw/factory-contract/validate");
  const { evaluateProtocolV2, stateVerdict, EXPECTED_CELLS } = await import("../v2/evaluate.ts");
  const { loadProtocolV2 } = await import("../v2/protocol.ts");
  const { loadData } = await import("../src/f3/data.ts");
  const { loadBaseline } = await import("../src/baseline.ts");
  const { loadCatalogPins } = await import("../v2/entry.ts");
  const { stateExpectation } = await import("../v2/expected.ts");
  const { parseCopySummaryV2 } = await import("../v2/record.ts");
  const adapter = createTaskReportAdapter({ workDir: join(dir, "work-evaluate") });
  const [entry] = adapter.catalog();
  if (entry === undefined) throw new QualifyError("the catalog has no entry");
  const protocol = adapter.protocol(entry);
  const { plans } = readJson(join(dir, "plans.json")) as { plans: CopyPlan[] };
  const { collected } = readJson(join(dir, "collected.json")) as { collected: CollectedCopy[] };
  const records: CopyRecord[] = [];
  for (const plan of plans) {
    const copy = collected.find((item) => item.copy_id === plan.copy_id);
    if (copy === undefined) throw new QualifyError(`no collected copy ${plan.copy_id}`);
    records.push(await adapter.collect(plan, copy));
  }
  const schemaErrors = records.flatMap((record) => validateContract("CopyRecord", record).map((code) => `${record.copy_id}: ${code}`));
  const v2 = loadProtocolV2();
  const cells = {} as Record<CopyState, ReturnType<typeof adapter.interpret>>;
  const verdicts = {} as Record<CopyState, string>;
  for (const state of ["clean", "buggy", "fixed"] as const) {
    cells[state] = adapter.interpret(records.filter((record) => record.state === state), protocol);
    verdicts[state] = stateVerdict(v2, state, cells[state]);
    schemaErrors.push(...validateContract("CellObservation", cells[state].original_suite), ...validateContract("CellObservation", cells[state].verification));
  }
  const summaries = collected.flatMap((copy) => (copy.results_dir !== null && existsSync(join(copy.results_dir, "copy.json")) ? [parseCopySummaryV2(readJson(join(copy.results_dir, "copy.json")))] : []));
  const expectation = stateExpectation(loadBaseline(), loadCatalogPins(), entry.entry_id);
  const crossCheck = evaluateProtocolV2(v2, loadData(), expectation, summaries);
  const matrix = (["original_suite", "verification"] as const).map((set) => ({
    check_set: set,
    cells: (["clean", "buggy", "fixed"] as const).map((state) => ({ state, expected: EXPECTED_CELLS[set][state], observed: cells[state][set].observed, failure_codes: cells[state][set].failure_codes, runs_valid: cells[state][set].runs_valid, runs_total: cells[state][set].runs_total })),
  }));
  const qualified = Object.values(verdicts).every((verdict) => verdict === "met");
  const result = {
    format: "rbw.task-report.qualification.v2",
    entry_id: entry.entry_id,
    protocol: { protocol_id: protocol.protocol_id, version: protocol.version, sha256: protocol.sha256 },
    check_set_sha256: entry.verification.check_set_sha256,
    environment: entry.environment,
    verdict: qualified ? "qualified" : crossCheck.verdict,
    verdicts,
    matrix,
    records,
    cross_check: crossCheck,
    schema_errors: schemaErrors,
  };
  writeJson(join(dir, "qualification.json"), result);
  process.stdout.write(`${JSON.stringify({ verdict: result.verdict, verdicts, matrix, cross_check: crossCheck.verdict, schema_errors: schemaErrors.length }, null, 2)}\n`);
  return qualified && crossCheck.verdict === "qualified" && schemaErrors.length === 0 ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, strict: true, options: { tag: { type: "string" }, out: { type: "string" }, dir: { type: "string" }, smoke: { type: "string" } } });
  if (command === "build") return build(values.tag ?? "");
  if (command === "prepare") {
    if (values.out === undefined) throw new QualifyError("--out is required");
    return prepare(resolve(values.out));
  }
  if (command === "run") {
    if (values.dir === undefined) throw new QualifyError("--dir is required");
    return run(resolve(values.dir), values.smoke);
  }
  if (command === "evaluate") {
    if (values.dir === undefined) throw new QualifyError("--dir is required");
    return evaluate(resolve(values.dir));
  }
  throw new QualifyError("usage: build | prepare | run | evaluate");
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`qualify: ${error instanceof Error ? `${error.name}: ${error.message}` : "error"}\n`);
    process.exitCode = 2;
  }
}
