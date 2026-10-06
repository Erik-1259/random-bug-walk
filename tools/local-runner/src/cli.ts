// The local runner's command line. See README.md for the host commands.
//
//   run      --image <tag|digest> --kit-stage <dir> --manifest <file> --terms <file> --work <dir>
//            [--recorded <dir>] [--policy <file>] [--concurrency <n>] [--dry-run]
//   run-copy --job <dir> --trial <trial_id> --image <tag|digest> --manifest <file> --terms <file> --work <dir>
//            [--root <run dir>] [--policy <file>]
//
// Exit codes: 0 every copy completed and every step ran (the summary says what the evidence shows);
// 1 the summary was written, but a copy did not complete or a step was refused; 2 a usage or
// input error, with nothing run.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { realClock } from "./clock.ts";
import { CodeStateRefusal } from "./code-states.ts";
import { createDocker } from "./docker.ts";
import { dryRun } from "./dry-run.ts";
import { InputsError } from "./inputs.ts";
import { JobRefusal } from "./jobs.ts";
import { RECORDED_SYNTHETIC_DIR, RecordedModeError } from "./recorded.ts";
import { runCopyCommand } from "./run-copy.ts";
import { runSequence } from "./sequence.ts";

const USAGE = `usage:
  node src/cli.ts run --image <tag|digest> --kit-stage <dir> --manifest <file> --terms <file> --work <dir> [--recorded <dir>] [--policy <file>] [--concurrency <n>] [--dry-run]
  node src/cli.ts run-copy --job <dir> --trial <trial_id> --image <tag|digest> --manifest <file> --terms <file> --work <dir> [--root <run dir>] [--policy <file>]
`;

class UsageError extends Error {}

/** Progress goes to stderr; the summary files hold the results. */
function log(line: string): void {
  process.stderr.write(`local-runner: ${line}\n`);
}

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw new UsageError(`--${name} is required`);
  return resolve(value);
}

function optional(values: Record<string, string | boolean | undefined>, name: string): string | null {
  const value = values[name];
  return typeof value === "string" && value !== "" ? resolve(value) : null;
}

async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      image: { type: "string" },
      "kit-stage": { type: "string" },
      manifest: { type: "string" },
      terms: { type: "string" },
      work: { type: "string" },
      recorded: { type: "string" },
      policy: { type: "string" },
      concurrency: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const concurrency = values.concurrency ?? "1";
  if (!/^[1-9]\d{0,2}$/.test(concurrency)) throw new UsageError("--concurrency must be a positive integer");
  if (values.image === undefined || values.image === "") throw new UsageError("--image is required");
  const options = {
    image: values.image,
    kitStage: required(values, "kit-stage"),
    manifest: required(values, "manifest"),
    terms: required(values, "terms"),
    work: required(values, "work"),
    recorded: optional(values, "recorded") ?? RECORDED_SYNTHETIC_DIR,
    policy: optional(values, "policy"),
    concurrency: Number(concurrency),
  };
  if (values["dry-run"] === true) {
    process.stdout.write(`${(await dryRun(options, { uuid: randomUUID })).join("\n")}\n`);
    return 0;
  }
  const result = await runSequence(options, { docker: createDocker(), clock: realClock, uuid: randomUUID, log });
  process.stdout.write(`summary=${result.summaryPath} summary_sha256=${result.summarySha256} table=${result.textPath}\n`);
  return result.exitCode;
}

async function runCopyCli(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      job: { type: "string" },
      trial: { type: "string" },
      image: { type: "string" },
      manifest: { type: "string" },
      terms: { type: "string" },
      work: { type: "string" },
      root: { type: "string" },
      policy: { type: "string" },
    },
  });
  if (values.trial === undefined || values.image === undefined) throw new UsageError("--trial and --image are required");
  const outcome = await runCopyCommand(
    {
      job: required(values, "job"),
      trial: values.trial,
      image: values.image,
      manifest: required(values, "manifest"),
      terms: required(values, "terms"),
      work: required(values, "work"),
      root: optional(values, "root"),
      policy: optional(values, "policy"),
    },
    { docker: createDocker(), clock: realClock },
  );
  if (outcome.refusal !== null) log(`refused ${outcome.refusal.reason}: ${outcome.refusal.detail}`);
  if (outcome.copy !== null) process.stdout.write(`trial=${outcome.copy.trial_id} status=${outcome.copy.status} reason=${outcome.copy.reason ?? "-"} records=${outcome.recordsDir ?? "-"}\n`);
  return outcome.exitCode;
}

const KNOWN = [UsageError, InputsError, JobRefusal, CodeStateRefusal, RecordedModeError];

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "run") return await run(rest);
    if (command === "run-copy") return await runCopyCli(rest);
    throw new UsageError("unknown command");
  } catch (error) {
    if (KNOWN.some((kind) => error instanceof kind) || (error instanceof TypeError && "code" in error)) {
      process.stderr.write(`local-runner: ${error instanceof Error ? error.message : "error"}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
