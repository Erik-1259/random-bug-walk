// Local mode, for free proofs on one machine: a stand-in for the worker sandboxes that runs each
// worker command as a child process of this one on the docker backend, and the bootstrap of a
// disposable local factory ledger (the migrations, the factory pool and the factory slot key) that
// the web service and the workers then share through DATABASE_URL.
//
//   node tools/controller/src/cli.ts factory-local-bootstrap
//
// The bootstrap refuses on Vercel (VERCEL_ENV set) and for a database that is not at a loopback
// address, so it never touches a hosted ledger, where the pool and the slot key are owner actions.
// The local sandbox keeps its sandboxes in this process: get() knows only the ones it created.
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import pg from "pg";
import { createSpend, fromPg, migrate } from "@rbw/spend";
import type { Result, SqlClient } from "@rbw/spend";
import { CONNECT_TIMEOUT_MS, LedgerError } from "./database-ledger.ts";
import type { FactoryLog, WorkerSandboxCreateParams, WorkerSandboxInstance, WorkerSandboxSdk, WorkerSandboxStatus } from "./factory-ports.ts";
import { FACTORY_PROFILE } from "./factory-profile.ts";
import { UsageError } from "./run-options.ts";

export { FACTORY_PACKAGES_DIR, PACKAGES_DIR_VARIABLE } from "./factory-wiring.ts";

/** The factory pool's cap in a local ledger: $40, as the hosted pool's. */
export const LOCAL_POOL_CAP_MICROUSD = 40_000_000;

/**
 * A worker image reference for local launches: startFactoryWorker requires one pinned by digest,
 * and the local sandbox runs none (it runs this repository's worker command).
 */
export const LOCAL_WORKER_IMAGE = `local/rbw-factory-worker@sha256:${"0".repeat(64)}`;

/** Refused because local mode would not be local: on Vercel, or a database at another host. */
export class LocalModeRefused extends UsageError {
  override name = "LocalModeRefused";
}

// The local worker sandbox -----------------------------------------------------------------------

export interface LocalSandboxInput {
  /** The repository root whose tools/controller/src/cli.ts the workers run. */
  repoRoot: string;
  /** Laid over each sandbox's create-time environment, such as PATH, HOME and RBW_FACTORY_PACKAGES_DIR. */
  env: Record<string, string>;
  log: FactoryLog;
}

/** A create under a name already taken, as the provider answers it (409), so a start adopts the running one. */
class NameTaken extends Error {
  override name = "NameTaken";
  readonly status = 409;
}

class LocalWorkerSandbox implements WorkerSandboxInstance {
  readonly name: string;
  private state: WorkerSandboxStatus = "running";
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private readonly env: Record<string, string>;
  private readonly input: LocalSandboxInput;
  private readonly timer: NodeJS.Timeout;

  constructor(params: WorkerSandboxCreateParams, input: LocalSandboxInput) {
    this.name = params.name;
    this.env = { ...params.env, ...input.env };
    this.input = input;
    // The provider timeout: the sandbox, and so its worker, ends then.
    this.timer = setTimeout(() => {
      this.stopNow();
    }, params.timeout);
    this.timer.unref();
  }

  get status(): WorkerSandboxStatus {
    return this.state;
  }

  /**
   * Runs the factory-worker command the launch sends (under its run-once guard) as a detached child
   * on the docker backend, with the sandbox's environment. As the guard does, a second start of the
   * command runs nothing more.
   */
  runCommand(params: { cmd: string; args: string[]; cwd: string; detached: true }): Promise<unknown> {
    if (this.child !== null) return Promise.resolve({ detached: true, started: false });
    if (this.state !== "running") return Promise.reject(new Error(`the local worker sandbox ${this.name} is ${this.state}`));
    const at = params.args.indexOf("factory-worker");
    if (at < 0) return Promise.reject(new Error("a local worker sandbox runs only the factory-worker command"));
    const args = [join(this.input.repoRoot, "tools/controller/src/cli.ts"), "factory-worker", ...params.args.slice(at + 1), "--backend", "docker"];
    const child = spawn(process.execPath, args, { cwd: this.input.repoRoot, env: this.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        this.input.log(`${this.name}: ${line}`);
      });
    }
    child.on("error", (error) => {
      this.input.log(`${this.name}: the worker command could not run (${error.message})`);
      this.end("failed");
    });
    // `close`, not `exit`: every line of its output has been logged by then.
    child.on("close", (code, signal) => {
      this.input.log(`${this.name}: the worker command exited (${code === null ? `signal ${String(signal)}` : `code ${String(code)}`})`);
      this.end("stopped");
    });
    return Promise.resolve({ detached: true, started: true });
  }

  stop(): Promise<unknown> {
    this.stopNow();
    return Promise.resolve(undefined);
  }

  /** Ends the worker's process group; the sandbox is stopped once the worker exited. */
  private stopNow(): void {
    const pid = this.livePid();
    if (pid === null) {
      this.end("stopped");
      return;
    }
    if (this.state !== "running") return;
    this.state = "stopping";
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      this.input.log(`${this.name}: the worker could not be stopped (${error instanceof Error ? error.message : "non-error"})`);
    }
  }

  /** The worker's process ID while it runs; null before it started and once it exited. */
  private livePid(): number | null {
    const child = this.child;
    if (child?.pid === undefined) return null;
    return child.exitCode === null && child.signalCode === null ? child.pid : null;
  }

  private end(state: "stopped" | "failed"): void {
    clearTimeout(this.timer);
    if (this.state !== "failed") this.state = state;
  }
}

/**
 * Worker sandboxes for local mode: create makes one under its name (a second create under a taken
 * name is refused as the provider refuses it), runCommand starts its factory-worker command with
 * --backend docker as a detached child of this process, and get reports it: running until the
 * worker exits, then stopped.
 */
export function localWorkerSandbox(input: LocalSandboxInput): WorkerSandboxSdk {
  const sandboxes = new Map<string, LocalWorkerSandbox>();
  return {
    create(params) {
      if (sandboxes.has(params.name)) return Promise.reject(new NameTaken(`a local worker sandbox named ${params.name} exists`));
      const sandbox = new LocalWorkerSandbox(params, input);
      sandboxes.set(params.name, sandbox);
      return Promise.resolve(sandbox);
    },
    get: (name) => Promise.resolve(sandboxes.get(name) ?? null),
  };
}

// The local ledger ---------------------------------------------------------------------------------

export interface BootstrapResult {
  /** The migration files this call applied, in order (none when the database was current). */
  applied: string[];
  pool: "created" | "present";
  slot_key: "created" | "present";
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** True when the URL names a Postgres database at a loopback address, and no host parameter points elsewhere. */
export function isLoopbackDatabase(databaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
  if (url.searchParams.has("host") || url.searchParams.has("hostaddr")) return false;
  return url.hostname === "localhost" || url.hostname === "[::1]" || LOOPBACK_V4.test(url.hostname);
}

function driverCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : "unknown";
}

/** Reads something, creates it when the read answers `unknown`, and says which; a concurrent create counts as present. */
async function ensure(what: string, unknown: string, read: () => Promise<Result<object>>, create: () => Promise<Result<object>>): Promise<"created" | "present"> {
  const found = await read();
  if (found.ok) return "present";
  if (found.code !== unknown) throw new LedgerError(`the ${what}'s status was refused (${found.code})`);
  const created = await create();
  if (created.ok) return "created";
  if ((await read()).ok) return "present";
  throw new LedgerError(`the ${what} was refused (${created.code})`);
}

/** The local factory ledger on one connection: every spend migration, the factory pool and the factory slot key, each once. */
export async function prepareFactoryLedger(client: SqlClient, now: () => Date): Promise<BootstrapResult> {
  let applied: string[];
  try {
    ({ applied } = await migrate(client));
  } catch (error) {
    throw new LedgerError(`the spend migrations could not be applied (${error instanceof Error ? error.message : "non-error"})`);
  }
  const spend = createSpend({ client, clock: now });
  const { pool_key, slot_key } = FACTORY_PROFILE;
  const reason = "the local factory ledger for free proofs";
  const pool = await ensure(
    "factory pool",
    "unknown_pool",
    () => spend.poolStatus({ pool_key }),
    () => spend.createPool({ pool_key, cap_microusd: LOCAL_POOL_CAP_MICROUSD, allocations: [], actor_role: "owner", reason }),
  );
  const slot = await ensure(
    "factory slot key",
    "unknown_slot",
    () => spend.slotStatus({ slot_key }),
    () => spend.createSlotKey({ slot_key, actor_role: "owner", reason }),
  );
  return { applied, pool, slot_key: slot };
}

/**
 * Bootstraps the local factory ledger in the database named by `databaseUrl`, idempotently. Refuses
 * on Vercel (VERCEL_ENV set) and for a database that is not at a loopback address. Connection errors
 * name only DATABASE_URL and a driver error code.
 */
export async function bootstrapFactoryLedger(input: { databaseUrl: string; env?: Readonly<Record<string, string | undefined>> }): Promise<BootstrapResult> {
  const env = input.env ?? process.env;
  if ((env.VERCEL_ENV ?? "") !== "") throw new LocalModeRefused("the local factory ledger is never bootstrapped on Vercel (VERCEL_ENV is set)");
  if (!isLoopbackDatabase(input.databaseUrl)) throw new LocalModeRefused("the local factory ledger is bootstrapped only in a Postgres database at a loopback address, which DATABASE_URL does not name");
  const client = new pg.Client({ connectionString: input.databaseUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // A dropped connection fails the next statement; the listener only keeps the error from ending the process.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    throw new LedgerError(`could not connect to the database named by DATABASE_URL (driver error code ${driverCode(error)})`);
  }
  try {
    return await prepareFactoryLedger(fromPg(client), () => new Date());
  } finally {
    await client.end();
  }
}

/** `factory-local-bootstrap`: the bootstrap on DATABASE_URL, one line per applied migration and one for the pool and slot key. */
export async function factoryLocalBootstrapCommand(args: string[], io: { env: NodeJS.ProcessEnv; out: (line: string) => void }): Promise<number> {
  if (args.length > 0) throw new UsageError("factory-local-bootstrap takes no arguments; it reads DATABASE_URL");
  const databaseUrl = io.env.DATABASE_URL ?? "";
  if (databaseUrl === "") throw new UsageError("DATABASE_URL is not set");
  const result = await bootstrapFactoryLedger({ databaseUrl, env: io.env });
  for (const file of result.applied) io.out(`applied ${file}`);
  io.out(`applied ${String(result.applied.length)} migrations; factory pool ${result.pool}; factory slot key ${result.slot_key}`);
  return 0;
}
