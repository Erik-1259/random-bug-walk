// The live dependencies: the spend ledger in DATABASE_URL, Token Factory through the platform
// fetch, a local Docker kit session per attempt (tools/solver-session), the case's code states
// from the pinned image (tools/local-runner), and the controller's command line for both grades.
// Nothing here runs in the tests.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { RATE_SHEET_PATH, copyEnvelope } from "@rbw/controller";
import { loadRateSheet } from "@rbw/envelope";
import { createDocker, deriveCodeStates, exportImage, inspectImage, loadCopyInputs, realClock } from "@rbw/local-runner";
import type { CopyInputOptions } from "@rbw/local-runner";
import { API_KEY_VARIABLE } from "@rbw/solver";
import { Session, SessionRefusal, solverSession } from "@rbw/solver-session";
import { createSpend, fromPg } from "@rbw/spend";
import { ledgerAllowanceSource } from "./allowance.ts";
import type { CaseConfig } from "./case.ts";
import { SessionRefused } from "./deps.ts";
import type { AttemptSession, CaseStates, Uc1Deps } from "./deps.ts";

/** The controller's command line, run with this Node binary. */
export const CONTROLLER_CLI = fileURLToPath(new URL("../../controller/src/cli.ts", import.meta.url));

export class EnvironmentError extends Error {
  override name = "EnvironmentError";
}

function copyInputs(config: CaseConfig): CopyInputOptions {
  return {
    manifest: config.manifest,
    terms: config.terms,
    policy: config.audit_policy,
    ...(config.probes_dir === null ? {} : { probesDir: config.probes_dir }),
    alternativeDir: config.reference_fix,
  };
}

/** The case's clean, planted and alternative-fix files, from the pinned image's export and the probes. */
async function deriveStates(config: CaseConfig, work: string): Promise<CaseStates> {
  const docker = createDocker();
  const inputs = loadCopyInputs(copyInputs(config));
  const digest = await inspectImage(docker, config.image);
  const exported = await exportImage(docker, { image: digest, container: `rbw-uc1-states-${String(Date.now())}`, dest: join(work, "source") });
  const states = deriveCodeStates(readFileSync(join(exported.source_dir, inputs.probes.data.target_path)), inputs.probes, inputs.alternative);
  const bytes = (key: "clean" | "planted" | "alternative_fix") => {
    const state = states.get(key);
    if (state === undefined) throw new EnvironmentError(`the probes give no ${key} file`);
    return state.bytes;
  };
  return { target_path: inputs.probes.data.target_path, digest, clean: bytes("clean"), planted: bytes("planted"), alternative: bytes("alternative_fix") };
}

async function openSession(request: { id: string; work: string; serverLogs: boolean; config: CaseConfig }): Promise<AttemptSession> {
  const { config } = request;
  let opened;
  try {
    opened = await Session.open(
      { id: request.id, image: config.image, expectedDigest: config.image_digest, work: request.work, serverLogs: request.serverLogs, ...copyInputs(config) },
      { docker: createDocker(), clock: realClock },
    );
  } catch (error) {
    if (error instanceof SessionRefusal) throw new SessionRefused(error.message);
    throw error;
  }
  const { session } = opened;
  return {
    solver: solverSession(session),
    planted_sha256: opened.opened.planted_sha256,
    digest: opened.opened.digest,
    async end(reason) {
      const submission = await session.end(reason);
      const path = join(request.work, "submission", "target.bin");
      return { submission, target: existsSync(path) ? readFileSync(path) : null };
    },
    close: () => session.close(),
  };
}

/** Runs the controller's `run` command; its own output goes to this process's stderr. */
function runController(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONTROLLER_CLI, ...args], { stdio: ["ignore", 2, 2], env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new EnvironmentError(`${name} is not set`);
  return value;
}

export interface LiveOptions {
  /** The sessions step calls the model: read the solver key once and remove it from the environment. */
  model: boolean;
}

/** The live dependencies and a close function for the ledger connection. */
export async function liveDeps(options: LiveOptions, report: (line: string) => void): Promise<{ deps: Uc1Deps; close: () => Promise<void> }> {
  const databaseUrl = env("DATABASE_URL");
  let apiKey: string | undefined;
  if (options.model) {
    apiKey = env(API_KEY_VARIABLE);
    // Read once; the controller and every other child process never see it.
    Reflect.deleteProperty(process.env, API_KEY_VARIABLE);
  }
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    throw new EnvironmentError(`cannot connect to DATABASE_URL (${code})`);
  }
  const sql = fromPg(client);
  const spend = createSpend({ client: sql, schema: "public" });
  const envelope = copyEnvelope(await loadRateSheet(RATE_SHEET_PATH));
  if (!envelope.ok) throw new EnvironmentError(`the controller's rate sheet cannot price a Sandbox copy (${envelope.code})`);
  const deps: Uc1Deps = {
    spend,
    allowanceSource: ledgerAllowanceSource(sql, spend),
    fetch: (input, init) => globalThis.fetch(input, init),
    ...(apiKey === undefined ? {} : { apiKey }),
    openSession,
    deriveStates,
    runController,
    grade2WorstCaseMicrousd: envelope.reserved_microusd,
    uuid: () => crypto.randomUUID(),
    now: () => new Date(),
    report,
  };
  return { deps, close: () => client.end() };
}
