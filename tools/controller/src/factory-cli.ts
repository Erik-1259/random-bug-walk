// The factory-worker command: what a worker sandbox runs, and what
// the conductor runs locally with --backend docker for free proofs.
//
//   factory-worker --request-id <uuid> --deadline-at <UTC time> [--backend sandbox|docker]
//   factory-worker --validation-id <uuid> [--backend sandbox|docker]
//
// It reads DATABASE_URL, and on the sandbox backend VERCEL_TOKEN, VERCEL_TEAM_ID and
// VERCEL_PROJECT_ID, from the environment, here and nowhere else, and never prints them. The
// credentials bind both the worker's own sandbox (stopped last) and the copies' sandboxes. On the
// sandbox backend it also reads RBW_FACTORY_WORKER_IMAGE, the worker's own image reference
// (`<namespace>/<repository>@sha256:<digest>`), whose namespace holds the copies' runtime images;
// without it every copy is refused. The
// prepared packages are the image's (/opt/rbw/factory-packages); on the docker backend
// RBW_FACTORY_PACKAGES_DIR may name another prepared directory. A validation run's deadline is its
// accepted time plus 1,800 s, read from its record.
//
// Exit codes: 0 the request or run finished and the slot was released; 1 it finished with the slot
// held (reconciliation needed), was fenced, or the request loop ended without finishing the request
// (the lost-worker routine finishes it); 2 a usage or input error, or no wiring in this build, with
// nothing run.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadRateSheet } from "@rbw/envelope";
import { createSandboxSdk } from "@rbw/local-runner";
import type { SandboxSdk } from "@rbw/local-runner";
import { stopQuietly, validationSandboxName, workerSandboxName } from "./factory-ledger.ts";
import { copyRegistryFrom } from "./factory-sandbox-runner.ts";
import { WORKER_IMAGE_VARIABLE, createWorkerSandboxSdk } from "./factory-web.ts";
import type { WorkerSandboxSdk } from "./factory-ports.ts";
import { FACTORY_PACKAGES_DIR, PACKAGES_DIR_VARIABLE, loadFactoryWiring } from "./factory-wiring.ts";
import type { WiringContext, WiringResult } from "./factory-wiring.ts";
import { WorkerInputError, runFactoryValidation, runFactoryWorker } from "./factory-worker.ts";
import { RATE_SHEET_PATH } from "./rate-sheet.ts";
import { UsageError } from "./run-options.ts";

export const FACTORY_WORKER_USAGE = `  node src/cli.ts factory-worker --request-id <uuid> --deadline-at <UTC time> [--backend sandbox|docker]
  node src/cli.ts factory-worker --validation-id <uuid> [--backend sandbox|docker]
  node src/cli.ts factory-local-bootstrap
`;

export interface FactoryCommandIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  log: (line: string) => void;
  now: () => Date;
  load?: () => Promise<WiringResult>;
  /** Replaces the real worker SDK (tests). */
  sandbox?: WorkerSandboxSdk;
  /** Replaces the real copies' SDK on the sandbox backend (tests). */
  copySandbox?: SandboxSdk;
}

function variable(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name] ?? "";
  if (value === "") throw new UsageError(`${name} is not set`);
  return value;
}

export async function factoryWorkerCommand(args: string[], io: FactoryCommandIo): Promise<number> {
  try {
    return await command(args, io);
  } catch (error) {
    // A request or run that is not recorded is an input error: nothing ran.
    if (error instanceof WorkerInputError) throw new UsageError(error.message);
    throw error;
  }
}

async function command(args: string[], io: FactoryCommandIo): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: { "request-id": { type: "string" }, "validation-id": { type: "string" }, "deadline-at": { type: "string" }, backend: { type: "string" } },
  });
  const requestId = values["request-id"];
  const validationId = values["validation-id"];
  if ((requestId === undefined) === (validationId === undefined)) throw new UsageError("give exactly one of --request-id and --validation-id");
  const id = requestId ?? validationId ?? "";
  const backend = values.backend ?? "sandbox";
  if (backend !== "sandbox" && backend !== "docker") throw new UsageError("--backend must be sandbox or docker");
  let deadline: Date | null = null;
  if (requestId !== undefined) {
    const ms = Date.parse(values["deadline-at"] ?? "");
    if (Number.isNaN(ms)) throw new UsageError("--deadline-at must be a UTC time");
    deadline = new Date(ms);
  } else if (values["deadline-at"] !== undefined) {
    throw new UsageError("a validation run's deadline comes from its record; --deadline-at is for --request-id");
  }
  const databaseUrl = variable(io.env, "DATABASE_URL");
  const credentials = () => ({ token: variable(io.env, "VERCEL_TOKEN"), teamId: variable(io.env, "VERCEL_TEAM_ID"), projectId: variable(io.env, "VERCEL_PROJECT_ID") });
  const sandbox = backend === "sandbox" ? (io.sandbox ?? createWorkerSandboxSdk(credentials())) : io.sandbox;
  const copySandbox = backend === "sandbox" ? (io.copySandbox ?? createSandboxSdk(credentials())) : null;
  const copyRegistry = backend === "sandbox" ? copyRegistryFrom(io.env[WORKER_IMAGE_VARIABLE]) : null;
  if (backend === "sandbox" && copyRegistry === null) io.log(`factory: ${WORKER_IMAGE_VARIABLE} is not set or names no registry namespace; every copy will be refused`);
  const localPackages = io.env[PACKAGES_DIR_VARIABLE] ?? "";
  const packagesDir = backend === "docker" && localPackages !== "" ? localPackages : FACTORY_PACKAGES_DIR;

  const wiring = await (io.load ?? loadFactoryWiring)();
  if (!wiring.ok) throw new UsageError(`factory-worker is not wired in this build; missing: ${wiring.missing.join("; ")}`);
  const { identity } = wiring.wiring;
  if (!identity.isUuid(id)) throw new UsageError("the ID must be a lowercase UUID");
  const rates = await loadRateSheet(RATE_SHEET_PATH);
  const db = await wiring.wiring.openDatabase(databaseUrl, io.now, io.log);
  try {
    // The harness's workspaces and the copies' results, kept after the run for a local proof to read.
    const workDir = await mkdtemp(join(tmpdir(), "rbw-factory-worker-"));
    const ctx: WiringContext = { db, copySandbox, copyRegistry, packagesDir, workDir, log: io.log };
    const deps = { ledger: db.ledger, records: db.factoryRecords, identity, rates, now: io.now, log: io.log, provider: backend === "sandbox" ? ("vercel-sandbox" as const) : ("docker" as const), ...(sandbox === undefined ? {} : { sandbox }) };
    if (requestId !== undefined && deadline !== null) {
      const outcome = await runFactoryWorker(deps, { request_id: requestId, deadline, orchestrate: wiring.wiring.orchestrate(backend, ctx) });
      io.out(outcome.kind === "finished" ? `request=${requestId} stop_code=${outcome.stop_code} slot_released=${String(outcome.slot_released)}` : `request=${requestId} ${outcome.kind}`);
      // Last: stopping its own sandbox ends this process. The provider timeout ends it otherwise.
      if (sandbox !== undefined && backend === "sandbox") await stopQuietly(sandbox, workerSandboxName(identity.requestRoot(requestId)), io.log);
      return outcome.kind === "finished" && outcome.slot_released ? 0 : 1;
    }
    const outcome = await runFactoryValidation(deps, { validation_id: id, validate: wiring.wiring.validate(backend, ctx) });
    io.out(outcome.kind === "fenced" ? `validation=${id} fenced` : `validation=${id} result=${outcome.result} slot_released=${String(outcome.slot_released)}`);
    if (sandbox !== undefined && backend === "sandbox") await stopQuietly(sandbox, validationSandboxName(identity.validationRoot(id)), io.log);
    return outcome.kind === "finished" && outcome.slot_released ? 0 : 1;
  } finally {
    await db.close();
  }
}
