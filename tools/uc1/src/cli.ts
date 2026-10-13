// The UC1 run orchestrator's command line. See README.md.
//
//   pilot    --runs-dir <dir> --name <name> --case <file> --policy <file> [--model super|kimi] [--concurrency <1-3>]
//   run      --runs-dir <dir> --name <name> --case <file> --policy <file> [--model super|kimi] [--concurrency <1-3>]
//   grade2   --run <dir>
//   finalize --run <dir>
//   dry-run  --work <dir>
//
// Exit codes: 0 the step finished with nothing left to do; 1 the step stopped or left work (a spend
// stop, a ledger uncertainty, an infrastructure error after its reruns, an incomplete root); 2 a
// usage error, a refusal before anything started, or a missing environment variable.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { SolverModelName } from "@rbw/solver";
import { dryRunWorld } from "./fakes.ts";
import { EnvironmentError, liveDeps } from "./live.ts";
import { RunRefusal, finalize, runGrade2, runSessions } from "./orchestrator.ts";
import type { RunMode } from "./plan.ts";

const USAGE = `usage:
  node tools/uc1/src/cli.ts pilot    --runs-dir <dir> --name <name> --case <file> --policy <file> [--model super|kimi] [--concurrency <1-3>]
  node tools/uc1/src/cli.ts run      --runs-dir <dir> --name <name> --case <file> --policy <file> [--model super|kimi] [--concurrency <1-3>]
  node tools/uc1/src/cli.ts grade2   --run <dir>
  node tools/uc1/src/cli.ts finalize --run <dir>
  node tools/uc1/src/cli.ts dry-run  --work <dir>
`;

class UsageError extends Error {}

function report(line: string): void {
  process.stdout.write(`uc1 ${line}\n`);
}

function required(values: Record<string, string | undefined>, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
  return value;
}

async function sessions(mode: RunMode, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: { "runs-dir": { type: "string" }, name: { type: "string" }, case: { type: "string" }, policy: { type: "string" }, model: { type: "string" }, concurrency: { type: "string" } },
  });
  const model = values.model ?? "super";
  if (model !== "super" && model !== "kimi") throw new UsageError("--model must be super or kimi");
  const concurrency = Number(values.concurrency ?? "1");
  const { deps, close } = await liveDeps({ model: true }, report);
  try {
    const outcome = await runSessions(
      { mode, runsDir: resolve(required(values, "runs-dir")), name: required(values, "name"), caseFile: resolve(required(values, "case")), policyFile: resolve(required(values, "policy")), model: model satisfies SolverModelName, concurrency },
      deps,
    );
    report(`done run=${outcome.runDir} exit=${String(outcome.exitCode)}${outcome.stop === null ? "" : ` stop=${outcome.stop.reason}`}`);
    return outcome.exitCode;
  } finally {
    await close();
  }
}

async function grade2(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { run: { type: "string" } } });
  const { deps, close } = await liveDeps({ model: false }, report);
  try {
    return (await runGrade2({ runDir: resolve(required(values, "run")) }, deps)).exitCode;
  } finally {
    await close();
  }
}

async function finish(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { run: { type: "string" } } });
  const { deps, close } = await liveDeps({ model: false }, report);
  try {
    return (await finalize({ runDir: resolve(required(values, "run")) }, deps)).exitCode;
  } finally {
    await close();
  }
}

/** The whole pilot (sessions, grade 2, finalize) in the dry-run world: no live call of any kind. */
async function dryRun(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { work: { type: "string" } } });
  const root = resolve(required(values, "work"));
  mkdirSync(root, { recursive: true });
  const world = await dryRunWorld({ root });
  world.deps.report = report;
  try {
    const outcome = await runSessions({ mode: "pilot", runsDir: world.runsDir, name: "dry-run-pilot", caseFile: world.pilotCase, policyFile: world.policy, model: "super", concurrency: 1 }, world.deps);
    const graded = await runGrade2({ runDir: outcome.runDir }, world.deps);
    const done = await finalize({ runDir: outcome.runDir }, world.deps);
    report(`dry-run run=${outcome.runDir} sessions_exit=${String(outcome.exitCode)} grade2_exit=${String(graded.exitCode)} finalize_exit=${String(done.exitCode)} model_requests=${String(world.model.bodies.length)}`);
    return Math.max(outcome.exitCode, graded.exitCode, done.exitCode);
  } finally {
    await world.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "pilot" || command === "run") return await sessions(command, rest);
    if (command === "grade2") return await grade2(rest);
    if (command === "finalize") return await finish(rest);
    if (command === "dry-run") return await dryRun(rest);
    throw new UsageError(`unknown command ${command ?? "(none)"}`);
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"))) {
      process.stderr.write(`uc1: ${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof RunRefusal || error instanceof EnvironmentError) {
      process.stderr.write(`uc1: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
