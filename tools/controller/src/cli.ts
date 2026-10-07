// The trusted controller's command line. See README.md for the conductor's commands.
//
//   run   --job-kind <kit_check|observe|admission|judge_verify> --work <run dir> --image <tag|digest>
//         --manifest <file> --terms <file> --kit-stage <dir> [--original-suite <file>] [--policy <file>]
//         [--fix <dir>] [--name <job name>] [--backend sandbox|docker] [--sandbox-image <repository>@sha256:<digest>]
//   proof --work <run dir> --image ... --manifest ... --terms ... --kit-stage ... [--original-suite <file>]
//         [--policy <file>] [--backend sandbox|docker] [--sandbox-image ...]
//   create-slot-key --slot-key <development|judge>
//
// With --backend sandbox (the default) it reads DATABASE_URL, VERCEL_TOKEN, VERCEL_TEAM_ID and
// VERCEL_PROJECT_ID from the environment, here and nowhere else, and never prints them. With
// --backend docker it uses an in-memory ledger and no credentials.
//
// Exit codes: 0 the job (or every proof case) is complete; 1 the summary was written but the job
// is incomplete, refused or needs reconciliation; 2 a usage or input error, with nothing run.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRateSheet } from "@rbw/envelope";
import { CodeStateRefusal, InputsError, createDocker, createSandboxSdk, realClock } from "@rbw/local-runner";
import { JOB_KIND_VALUES } from "@rbw/schema";
import type { JobKind } from "@rbw/schema";
import { runJob } from "./controller.ts";
import type { Backend, ControllerDeps, JobInputs } from "./controller.ts";
import { RATE_SHEET_PATH } from "./envelope.ts";
import { LedgerError, databaseLedger, inMemoryLedger } from "./ledger.ts";
import type { Ledger } from "./ledger.ts";
import { DEVELOPMENT, JUDGE } from "./limits.ts";
import { PROOF_DIR, ProofInputError, runProof } from "./proof.ts";

const USAGE = `usage:
  node src/cli.ts run --job-kind <kit_check|observe|admission|judge_verify> --work <run dir> --image <tag|digest> --manifest <file> --terms <file> --kit-stage <dir>
                      [--original-suite <file>] [--policy <file>] [--fix <dir>] [--name <job name>] [--backend sandbox|docker] [--sandbox-image <repository>@sha256:<digest>]
  node src/cli.ts proof --work <run dir> --image <tag|digest> --manifest <file> --terms <file> --kit-stage <dir>
                        [--original-suite <file>] [--policy <file>] [--backend sandbox|docker] [--sandbox-image <repository>@sha256:<digest>]
  node src/cli.ts create-slot-key --slot-key <key>
`;

class UsageError extends Error {}

function log(line: string): void {
  process.stderr.write(`controller: ${line}\n`);
}

type Values = Record<string, string | undefined>;

function required(values: Values, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
  return value;
}

function path(values: Values, name: string): string | null {
  const value = values[name];
  return value === undefined || value === "" ? null : resolve(value);
}

function env(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") throw new UsageError(`${name} is not set`);
  return value;
}

const JOB_OPTIONS = {
  work: { type: "string" },
  image: { type: "string" },
  manifest: { type: "string" },
  terms: { type: "string" },
  "kit-stage": { type: "string" },
  "original-suite": { type: "string" },
  policy: { type: "string" },
  backend: { type: "string" },
  "sandbox-image": { type: "string" },
} as const;

type CommonInputs = Omit<JobInputs, "kind" | "name" | "trials" | "alternativeDir" | "ledger">;

function common(values: Values): CommonInputs {
  const backend = values.backend ?? "sandbox";
  if (backend !== "sandbox" && backend !== "docker") throw new UsageError("--backend must be sandbox or docker");
  const sandboxImage = values["sandbox-image"] ?? null;
  if ((backend === "sandbox") !== (sandboxImage !== null)) throw new UsageError("--sandbox-image is required with --backend sandbox, and only with it");
  return {
    work: resolve(required(values, "work")),
    image: required(values, "image"),
    manifest: resolve(required(values, "manifest")),
    terms: resolve(required(values, "terms")),
    policy: path(values, "policy"),
    kitStage: resolve(required(values, "kit-stage")),
    originalSuite: path(values, "original-suite"),
    backend: backend satisfies Backend,
    sandboxImage,
  };
}

/** The ledger and the SDK for the backend: Sandbox needs DATABASE_URL and the Vercel credentials, Docker neither. */
async function open(backend: Backend): Promise<{ ledger: Ledger; deps: Omit<ControllerDeps, "spend" | "ledgerKind"> }> {
  const now = () => new Date(realClock.now());
  const base = { docker: createDocker(), clock: realClock, uuid: randomUUID, rates: await loadRateSheet(RATE_SHEET_PATH), log };
  if (backend === "docker") return { ledger: await inMemoryLedger(now), deps: base };
  const credentials = { token: env("VERCEL_TOKEN"), teamId: env("VERCEL_TEAM_ID"), projectId: env("VERCEL_PROJECT_ID") };
  const ledger = await databaseLedger(env("DATABASE_URL"), now);
  return { ledger, deps: { ...base, sandbox: createSandboxSdk(credentials) } };
}

async function withLedger<T>(backend: Backend, run: (deps: ControllerDeps) => Promise<T>): Promise<T> {
  const { ledger, deps } = await open(backend);
  try {
    return await run({ ...deps, spend: ledger.spend, ledgerKind: ledger.kind });
  } finally {
    await ledger.close();
  }
}

async function runCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { ...JOB_OPTIONS, "job-kind": { type: "string" }, fix: { type: "string" }, name: { type: "string" } } });
  const kind = required(values, "job-kind");
  if (!(JOB_KIND_VALUES as readonly string[]).includes(kind)) throw new UsageError(`--job-kind must be one of ${JOB_KIND_VALUES.join(", ")}`);
  const jobKind = kind as JobKind;
  const inputs = common(values);
  const label = { kit_check: "kit-check", observe: "observe", admission: "admission", judge_verify: "judge" }[jobKind];
  const fix = path(values, "fix");
  if (fix !== null && jobKind !== "judge_verify") throw new UsageError("--fix is only for --job-kind judge_verify");
  const job: JobInputs = {
    ...inputs,
    kind: jobKind,
    name: values.name ?? label,
    trials: null,
    ...(fix === null ? {} : { alternativeDir: fix }),
    ledger: jobKind === "judge_verify" ? JUDGE : DEVELOPMENT,
  };
  const outcome = await withLedger(inputs.backend, (deps) => runJob(job, deps));
  for (const copy of outcome.summary.copies) {
    process.stdout.write(`trial=${copy.trial_id} status=${copy.status} launch=${copy.launch} ledger=${copy.ledger_state ?? "-"} reserved=${String(copy.reserved_microusd ?? "-")} settled=${String(copy.settled_microusd ?? "-")}\n`);
  }
  process.stdout.write(
    `job=${outcome.summary.job.name} status=${outcome.status} reason=${outcome.summary.reason ?? "-"} replay=${String(outcome.replay)} spend_settled=${String(outcome.summary.spend.settled_microusd)} summary=${outcome.jobDir}/summary.json\n`,
  );
  return outcome.exitCode;
}

async function proofCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: JOB_OPTIONS });
  const inputs = common(values);
  const result = await withLedger(inputs.backend, (deps) => runProof({ ...inputs, proofDir: PROOF_DIR }, deps));
  for (const item of result.cases) process.stdout.write(`case=${item.case} ok=${String(item.ok)} trial=${item.trial_id} status=${item.observed.status ?? "-"} added=${item.observed.added_verdict ?? "-"}\n`);
  process.stdout.write(`proof=${result.proofPath} ok=${String(result.exitCode === 0)}\n`);
  return result.exitCode;
}

async function createSlotKeyCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { "slot-key": { type: "string" } } });
  const slotKey = required(values, "slot-key");
  const ledger = await databaseLedger(env("DATABASE_URL"), () => new Date());
  try {
    const created = await ledger.spend.createSlotKey({ slot_key: slotKey, actor_role: "owner", reason: "the trusted controller's slot key" });
    process.stdout.write(created.ok ? `slot_key=${slotKey} created\n` : `slot_key=${slotKey} refused ${created.code}\n`);
    return created.ok ? 0 : 1;
  } finally {
    await ledger.close();
  }
}

const KNOWN = [UsageError, InputsError, CodeStateRefusal, LedgerError, ProofInputError];

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "run") return await runCommand(rest);
    if (command === "proof") return await proofCommand(rest);
    if (command === "create-slot-key") return await createSlotKeyCommand(rest);
    throw new UsageError("unknown command");
  } catch (error) {
    if (KNOWN.some((kind) => error instanceof kind) || (error instanceof TypeError && "code" in error)) {
      process.stderr.write(`controller: ${error instanceof Error ? error.message : "error"}\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
