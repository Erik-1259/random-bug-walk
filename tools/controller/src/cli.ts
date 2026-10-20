// The trusted controller's command line. See README.md for the conductor's commands.
//
//   run   --job-kind <kit_check|observe|admission|judge_verify> --work <run dir> --image <tag|digest>
//         --manifest <file> --terms <file> --kit-stage <dir> [--original-suite <file>] [--policy <file>]
//         [--fix <dir>] [--name <job name>] [--backend sandbox|docker] [--sandbox-image <repository>@sha256:<digest>]
//         [--trials <id,...>] [--ledger development|judge] [--ids <RunIds JSON>] [--project-policy <ProjectPolicy>]
//         [--judge-fixed fixed|alternative_fix] [--family time-zone|race] [--race-latency-ms <0-10000>] [--probes-dir <dir>]
//   proof --work <run dir> --image ... --manifest ... --terms ... --kit-stage ... [--original-suite <file>]
//         [--policy <file>] [--backend sandbox|docker] [--sandbox-image ...]
//   create-slot-key --slot-key <development|judge>
//   attempt --work <new run dir> --policy <ProjectPolicy> --candidate <private input> --writer-rates <file>
//         --search-rates <file> --image <local kit image> --manifest <file> --terms <file> --audit-policy <file>
//         --kit-stage <dir> --sandbox-image <repository>@sha256:<digest> [--original-suite <file>]
//         [--family time-zone|race] [--race-latency-ms <0-10000>]
//   run   --job-kind judge_verify --request-id <uuid> --prebuilt <local store dir | judge job index key>
//         --release <release.json> --deadline-at <UTC time> [--backend sandbox] [--sandbox-image <kit image>] [--work <dir>]
//   factory-worker (--request-id <uuid> --deadline-at <UTC time> | --validation-id <uuid>) [--backend sandbox|docker]
//         (src/factory-cli.ts)
//
// --ledger defaults to the judge allocation and slot for judge_verify and the development pool and
// slot otherwise; solver grades pass --ledger development so they never take the judge slot.
// --ids shares a root's IDs across its jobs; --project-policy needs --ids naming the policy's project.
//
// The prebuilt form is the judge controller, started by the judge route in its own sandbox. It
// also reads BLOB_PRIVATE_STORE_ID and VERCEL_OIDC_TOKEN for the private store, unless --prebuilt
// names a local store directory.
//
// With --backend sandbox (the default) it reads DATABASE_URL, VERCEL_TOKEN, VERCEL_TEAM_ID and
// VERCEL_PROJECT_ID from the environment, here and nowhere else, and never prints them. With
// --backend docker it uses an in-memory ledger and no credentials. attempt runs on Sandbox only,
// and also reads TOKEN_FACTORY_WRITER_KEY and TAVILY_API_KEY, once, removing them from the
// environment before any child process starts.
//
// Exit codes: 0 the job (or every proof case) is complete, or the attempt's root ended terminal and
// completed; 1 the summary (or root-run.json) was written with any other state; 2 a usage or input
// error, with nothing run.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRateSheet } from "@rbw/envelope";
import { CodeStateRefusal, FamilyError, InputsError, createDocker, createSandboxSdk, realClock } from "@rbw/local-runner";
import { InvalidInput, LocalPrivateStore, privateStoreFromEnv } from "@rbw/publisher/private-store";
import { CanonicalError, RecordError, parseRecord } from "@rbw/schema";
import { createTavilyClient } from "@rbw/search";
import { KEY_VARIABLES, prepareAttempt, runAttempt } from "./attempt.ts";
import { runJob } from "./controller.ts";
import { FACTORY_WORKER_USAGE, factoryWorkerCommand } from "./factory-cli.ts";
import type { Backend, ControllerDeps } from "./controller.ts";
import { isRequestId } from "./judge.ts";
import { NO_DOCKER, runJudgeReplay } from "./judge-run.ts";
import { LedgerError, databaseLedger, inMemoryLedger } from "./ledger.ts";
import type { Ledger } from "./ledger.ts";
import { PROOF_DIR, ProofInputError, runProof } from "./proof.ts";
import { RATE_SHEET_PATH } from "./rate-sheet.ts";
import { FAMILY_OPTIONS, JOB_OPTIONS, NOT_FOR_PREBUILT, RUN_OPTIONS, UsageError, common, familyOptions, path, required, runJobInputs } from "./run-options.ts";
import type { Values } from "./run-options.ts";

const USAGE = `usage:
  node src/cli.ts run --job-kind <kit_check|observe|admission|judge_verify> --work <run dir> --image <tag|digest> --manifest <file> --terms <file> --kit-stage <dir>
                      [--original-suite <file>] [--policy <file>] [--fix <dir>] [--name <job name>] [--backend sandbox|docker] [--sandbox-image <repository>@sha256:<digest>]
                      [--trials <id,...>] [--ledger development|judge] [--ids <file>] [--project-policy <file>] [--judge-fixed fixed|alternative_fix]
                      [--family time-zone|race] [--race-latency-ms <0-10000>] [--probes-dir <dir>]
  node src/cli.ts proof --work <run dir> --image <tag|digest> --manifest <file> --terms <file> --kit-stage <dir>
                        [--original-suite <file>] [--policy <file>] [--backend sandbox|docker] [--sandbox-image <repository>@sha256:<digest>]
  node src/cli.ts create-slot-key --slot-key <key>
  node src/cli.ts attempt --work <new run dir> --policy <ProjectPolicy> --candidate <private input> --writer-rates <file> --search-rates <file>
                          --image <local kit image> --manifest <file> --terms <file> --audit-policy <file> --kit-stage <dir>
                          --sandbox-image <repository>@sha256:<digest> [--original-suite <file>] [--family time-zone|race] [--race-latency-ms <0-10000>]
  node src/cli.ts run --job-kind judge_verify --request-id <uuid> --prebuilt <local store dir|index key> --release <file> --deadline-at <UTC time>
                      [--backend sandbox] [--sandbox-image <kit image>] [--work <dir>]
${FACTORY_WORKER_USAGE}`;

/** The Tavily API the attempt's source searches, docs extract and phrase checks call. */
const TAVILY_BASE_URL = "https://api.tavily.com";
const SANDBOX_VARIABLES = ["DATABASE_URL", "VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const;

function log(line: string): void {
  process.stderr.write(`controller: ${line}\n`);
}

function env(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") throw new UsageError(`${name} is not set`);
  return value;
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

/** The judge controller: one replay from the frozen judge job, on Sandbox, with no Docker. */
async function judgeCommand(values: Values): Promise<number> {
  if (values["job-kind"] !== "judge_verify") throw new UsageError("--prebuilt is only for --job-kind judge_verify");
  if ((values.backend ?? "sandbox") !== "sandbox") throw new UsageError("--prebuilt runs on --backend sandbox");
  const requestId = required(values, "request-id");
  if (!isRequestId(requestId)) throw new UsageError("--request-id must be a lowercase UUID");
  const release = parseRecord("Release", readFileSync(resolve(required(values, "release"))));
  const deadlineAtMs = Date.parse(required(values, "deadline-at"));
  if (Number.isNaN(deadlineAtMs)) throw new UsageError("--deadline-at must be a UTC time");
  if (values["sandbox-image"] !== undefined && values["sandbox-image"] !== release.images.kit_image) throw new UsageError("--sandbox-image must be the release's kit image");
  const prebuilt = required(values, "prebuilt");
  let store;
  if (existsSync(prebuilt) && statSync(prebuilt).isDirectory()) store = new LocalPrivateStore(resolve(prebuilt));
  else if (prebuilt === release.judge_job.index_key) store = privateStoreFromEnv(process.env);
  else throw new UsageError("--prebuilt must be a local store directory or the release's judge job index key");
  const work = values.work === undefined ? mkdtempSync(join(tmpdir(), "rbw-judge-")) : resolve(values.work);
  const outcome = await withLedger("sandbox", (deps) => runJudgeReplay({ requestId, release, store, deadlineAtMs, work }, { ...deps, docker: NO_DOCKER }));
  process.stdout.write(`job=${outcome.summary.job.name} status=${outcome.summary.status} reason=${outcome.summary.reason ?? "-"} replay=${outcome.state} known_condition=${String(outcome.known_condition)} closed=${String(outcome.closed)}\n`);
  return outcome.summary.status === "complete" && outcome.closed ? 0 : 1;
}

async function runCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: RUN_OPTIONS });
  if (values.prebuilt !== undefined) {
    const extra = NOT_FOR_PREBUILT.find((name) => values[name] !== undefined);
    if (extra !== undefined) throw new UsageError(`--${extra} is not for the judge controller (--prebuilt)`);
    return judgeCommand(values);
  }
  const job = runJobInputs(values);
  const outcome = await withLedger(job.backend, (deps) => runJob(job, deps));
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

async function attemptCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      ...JOB_OPTIONS,
      ...FAMILY_OPTIONS,
      candidate: { type: "string" },
      "writer-rates": { type: "string" },
      "search-rates": { type: "string" },
      "audit-policy": { type: "string" },
    },
  });
  if (values.backend !== undefined) throw new UsageError("attempt runs on the sandbox backend only");
  const inputs = {
    work: resolve(required(values, "work")),
    policy: resolve(required(values, "policy")),
    candidate: resolve(required(values, "candidate")),
    writerRates: resolve(required(values, "writer-rates")),
    searchRates: resolve(required(values, "search-rates")),
    image: required(values, "image"),
    manifest: resolve(required(values, "manifest")),
    terms: resolve(required(values, "terms")),
    auditPolicy: resolve(required(values, "audit-policy")),
    kitStage: resolve(required(values, "kit-stage")),
    originalSuite: path(values, "original-suite"),
    backend: "sandbox" as const,
    sandboxImage: required(values, "sandbox-image"),
    ...familyOptions(values),
  };
  for (const name of [...SANDBOX_VARIABLES, ...KEY_VARIABLES]) env(name);
  const prepared = prepareAttempt(inputs, process.env);
  const outcome = await withLedger("sandbox", (deps) =>
    runAttempt(prepared, {
      ...deps,
      writerFetch: globalThis.fetch,
      searchClient: (apiKey) => createTavilyClient({ apiKey, apiBaseURL: TAVILY_BASE_URL, allowLive: true }),
      report: (line) => {
        process.stdout.write(`${line}\n`);
      },
    }),
  );
  return outcome.exitCode;
}

const KNOWN = [UsageError, InputsError, FamilyError, CodeStateRefusal, LedgerError, ProofInputError, InvalidInput, RecordError, CanonicalError];

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "run") return await runCommand(rest);
    if (command === "proof") return await proofCommand(rest);
    if (command === "create-slot-key") return await createSlotKeyCommand(rest);
    if (command === "attempt") return await attemptCommand(rest);
    if (command === "factory-worker") return await factoryWorkerCommand(rest, { env: process.env, out: (line) => process.stdout.write(`${line}\n`), log, now: () => new Date() });
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
