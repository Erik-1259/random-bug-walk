// One copy: one container of the kit image. The code state's file and the job go in before the
// container starts; inside, the copy script runs the driver's freeze and then its run; the
// trial's record set is copied out and the container removed. A hard outer limit (the driver's
// 600 s copy deadline plus 120 s) stops the container with TERM, then KILL 10 s later.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_PHASE_LIMITS } from "@rbw/umami-driver";
import type { StateKey } from "./code-states.ts";
import type { Clock } from "./clock.ts";
import type { CommandResult, Docker } from "./docker.ts";

export const COPY_OUTER_LIMIT_MS = DEFAULT_PHASE_LIMITS.total_ms + 120_000;
export const KILL_GRACE_MS = 10_000;
/** For every docker command except `wait`, which the outer limit bounds. */
export const COMMAND_TIMEOUT_MS = 300_000;

/** The kit's resources per copy (spec §9.4: 4 vCPU, 8 GB), no network, and no privilege gain. */
export const COPY_RESOURCES = ["--network", "none", "--cpus", "4", "--memory", "8g", "--security-opt", "no-new-privileges"] as const;

export const APP_DIR = "/workspace/app";
export const JOB_DIR = "/var/lib/rbw/job";
export const RUNNER_DIR = "/var/lib/rbw/results/rbw-runner";

/**
 * The copy's command, run by the image's tini as root. It runs only the verifier's Node and the
 * protected driver, never anything from the app copy, and writes each exit status beside the
 * output so the host can tell a finished driver from a killed one.
 */
export const COPY_SCRIPT = [
  "set -u",
  `out=${RUNNER_DIR}`,
  "node=/opt/rbw/verifier/node/bin/node",
  "driver=/opt/rbw/verifier/kit/umami-driver/src/cli.ts",
  'mkdir -p "$out" || exit 90',
  'if [ "$1" = freeze ]; then',
  '  "$node" "$driver" freeze --out "$out/original-suite.json" > "$out/freeze.stdout" 2> "$out/freeze.stderr"',
  "  status=$?",
  '  echo "$status" > "$out/freeze.exit"',
  '  exit "$status"',
  "fi",
  '"$node" "$driver" freeze > "$out/freeze.stdout" 2> "$out/freeze.stderr"',
  "status=$?",
  'echo "$status" > "$out/freeze.exit"',
  '[ "$status" -eq 0 ] || exit 90',
  `"$node" "$driver" run --job ${JOB_DIR} --trial "$2" --out "$out/out" > "$out/run.stdout" 2> "$out/run.stderr"`,
  "status=$?",
  'echo "$status" > "$out/run.exit"',
  'exit "$status"',
].join("\n");

export type AuditVerdict = "pass" | "refused" | "unavailable" | "not_applicable";

export interface AuditResult {
  verdict: AuditVerdict;
  /** The findings' distinct reasons (sorted, comma-separated), the unavailable error, or why the audit does not apply. */
  reason: string | null;
  report_sha256: string | null;
  findings: number;
}

export interface Placement {
  /** The repository path inside the app copy. */
  path: string;
  bytes: Buffer;
  sha256: string;
}

export interface CopyPlan {
  /** The job's label, for example `admission`. */
  job: string;
  trial_id: string;
  state: StateKey;
  container: string;
  image: string;
  mode: "trial" | "freeze";
  /** Must not exist yet: it holds only this copy's files. */
  work_dir: string;
  /** Read only: the job's request and expected trials. Null for the freeze copy. */
  job_dir: string | null;
  /** The verified target file, or null when the copy keeps the image's own source. */
  placement: Placement | null;
  /** The projection audit of exactly the bytes in `placement`. */
  audit: () => Promise<AuditResult>;
}

export type CopyStatus = "complete" | "incomplete" | "refused" | "failed";

export interface CopyResult {
  job: string;
  trial_id: string;
  state: StateKey;
  container: string;
  work_dir: string;
  status: CopyStatus;
  reason: string | null;
  audit: AuditResult;
  placed_sha256: string | null;
  freeze_exit: number | null;
  driver_exit: number | null;
  container_exit: number | null;
  timed_out: boolean;
  /** The collected files: the exit statuses, the driver's output and (for freeze) the frozen manifest. */
  collected_dir: string | null;
  /** The driver's record set, only when the driver itself finished (exit 0 or 3). */
  records_dir: string | null;
  phases: { name: string; duration_ms: number }[];
}

export interface CopyDeps {
  docker: Docker;
  clock: Clock;
}

class StepFailed extends Error {
  readonly step: string;

  constructor(step: string) {
    super(`docker ${step} failed`);
    this.step = step;
  }
}

async function step(docker: Docker, args: readonly string[]): Promise<CommandResult> {
  const result = await docker.run(args, { timeoutMs: COMMAND_TIMEOUT_MS });
  if (result.code !== 0) throw new StepFailed(String(args[0]));
  return result;
}

export function createArgs(plan: Pick<CopyPlan, "container" | "image" | "mode" | "trial_id">): string[] {
  return ["create", "--name", plan.container, ...COPY_RESOURCES, plan.image, "/bin/sh", "-c", COPY_SCRIPT, "rbw-copy", plan.mode, plan.trial_id];
}

export function placedFile(plan: Pick<CopyPlan, "work_dir">, placement: Placement): string {
  return join(plan.work_dir, "placed", basename(placement.path));
}

/** Every docker command of a copy that runs to its end, in order (the dry run prints these). */
export function copyCommands(plan: Omit<CopyPlan, "audit">): string[][] {
  const commands = [createArgs(plan)];
  if (plan.placement !== null) commands.push(["cp", placedFile(plan, plan.placement), `${plan.container}:${APP_DIR}/${plan.placement.path}`]);
  if (plan.job_dir !== null) commands.push(["cp", plan.job_dir, `${plan.container}:${JOB_DIR}`]);
  commands.push(["start", plan.container], ["wait", plan.container], ["cp", `${plan.container}:${RUNNER_DIR}`, join(plan.work_dir, "collected")], ["rm", "--force", plan.container]);
  return commands;
}

function exitStatus(text: string | null): number | null {
  const trimmed = text?.trim() ?? "";
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null;
}

export function readExit(path: string): number | null {
  return existsSync(path) ? exitStatus(readFileSync(path, "utf8")) : null;
}

type Race = { kind: "exited"; result: CommandResult } | { kind: "limit" };

/** Waits for the container, stopping it at the outer limit: TERM, then KILL after the grace period. */
async function waitWithLimit(plan: CopyPlan, deps: CopyDeps): Promise<{ exit: number | null; timedOut: boolean }> {
  const waited = deps.docker.run(["wait", plan.container]);
  const exited = waited.then((result): Race => ({ kind: "exited", result }));
  const race = async (ms: number): Promise<Race> => {
    const controller = new AbortController();
    const outcome = await Promise.race([exited, deps.clock.sleep(ms, controller.signal).then((): Race => ({ kind: "limit" }))]);
    controller.abort();
    return outcome;
  };
  const first = await race(COPY_OUTER_LIMIT_MS);
  if (first.kind === "exited") return { exit: exitStatus(first.result.stdout.toString("utf8")), timedOut: false };
  await deps.docker.run(["kill", "--signal", "TERM", plan.container], { timeoutMs: COMMAND_TIMEOUT_MS });
  const second = await race(KILL_GRACE_MS);
  if (second.kind === "limit") await deps.docker.run(["kill", "--signal", "KILL", plan.container], { timeoutMs: COMMAND_TIMEOUT_MS });
  const final = await waited;
  return { exit: exitStatus(final.stdout.toString("utf8")), timedOut: true };
}

export interface Interpreted {
  status: CopyStatus;
  reason: string | null;
  records: boolean;
}

/** What a copy's collected files say, the same for every backend. */
export function interpret(mode: CopyPlan["mode"], collected: string | null, freezeExit: number | null, driverExit: number | null, timedOut: boolean): Interpreted {
  if (mode === "freeze") {
    if (freezeExit === 0 && collected !== null && existsSync(join(collected, "original-suite.json"))) return { status: "complete", reason: null, records: false };
    return timedOut ? { status: "incomplete", reason: "timeout", records: false } : { status: "failed", reason: "freeze_failed", records: false };
  }
  // The driver's own result counts whenever the driver finished, even when the outer limit then stopped the container.
  if (driverExit === 0) return { status: "complete", reason: null, records: true };
  if (driverExit === 3) return { status: "incomplete", reason: "driver_internal_error", records: true };
  if (timedOut) return { status: "incomplete", reason: "timeout", records: false };
  if (collected === null) return { status: "failed", reason: "nothing_collected", records: false };
  if (freezeExit !== 0) return { status: "failed", reason: "freeze_failed", records: false };
  if (driverExit === 2) return { status: "refused", reason: "driver_refused", records: false };
  return { status: "failed", reason: driverExit === null ? "driver_did_not_finish" : `driver_exit_${String(driverExit)}`, records: false };
}

export async function runCopy(plan: CopyPlan, deps: CopyDeps): Promise<CopyResult> {
  const phases: CopyResult["phases"] = [];
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = deps.clock.now();
    try {
      return await run();
    } finally {
      phases.push({ name, duration_ms: deps.clock.now() - started });
    }
  };
  const result: CopyResult = {
    job: plan.job,
    trial_id: plan.trial_id,
    state: plan.state,
    container: plan.container,
    work_dir: plan.work_dir,
    status: "failed",
    reason: null,
    audit: { verdict: "unavailable", reason: "not_run", report_sha256: null, findings: 0 },
    placed_sha256: plan.placement?.sha256 ?? null,
    freeze_exit: null,
    driver_exit: null,
    container_exit: null,
    timed_out: false,
    collected_dir: null,
    records_dir: null,
    phases,
  };
  if (existsSync(plan.work_dir)) return { ...result, reason: "work_dir_exists" };
  result.audit = await timed("audit", plan.audit);
  if (result.audit.verdict === "refused" || result.audit.verdict === "unavailable") {
    return { ...result, status: "refused", reason: `audit_${result.audit.verdict}` };
  }
  mkdirSync(plan.work_dir, { recursive: true });
  let created = false;
  try {
    await timed("create", () => step(deps.docker, createArgs(plan)));
    created = true;
    await timed("place", async () => {
      if (plan.placement !== null) {
        const file = placedFile(plan, plan.placement);
        mkdirSync(join(plan.work_dir, "placed"));
        writeFileSync(file, plan.placement.bytes);
        chmodSync(file, 0o644);
        await step(deps.docker, ["cp", file, `${plan.container}:${APP_DIR}/${plan.placement.path}`]);
      }
      if (plan.job_dir !== null) await step(deps.docker, ["cp", plan.job_dir, `${plan.container}:${JOB_DIR}`]);
    });
    const ran = await timed("run", async () => {
      await step(deps.docker, ["start", plan.container]);
      return waitWithLimit(plan, deps);
    });
    result.container_exit = ran.exit;
    result.timed_out = ran.timedOut;
    const collectedDir = join(plan.work_dir, "collected");
    const collected = await timed("collect", () => deps.docker.run(["cp", `${plan.container}:${RUNNER_DIR}`, collectedDir], { timeoutMs: COMMAND_TIMEOUT_MS }));
    result.collected_dir = collected.code === 0 && existsSync(collectedDir) ? collectedDir : null;
    result.freeze_exit = result.collected_dir === null ? null : readExit(join(collectedDir, "freeze.exit"));
    result.driver_exit = result.collected_dir === null ? null : readExit(join(collectedDir, "run.exit"));
    const outcome = interpret(plan.mode, result.collected_dir, result.freeze_exit, result.driver_exit, ran.timedOut);
    result.status = outcome.status;
    result.reason = outcome.reason;
    result.records_dir = outcome.records ? join(collectedDir, "out") : null;
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
    result.status = "failed";
    result.reason = `docker_${error.step}_failed`;
  } finally {
    if (created) await timed("remove", () => deps.docker.run(["rm", "--force", plan.container], { timeoutMs: COMMAND_TIMEOUT_MS }));
  }
  return result;
}

/** Runs the copies with at most `concurrency` at a time; results come back in plan order. */
export async function runCopies(plans: readonly CopyPlan[], concurrency: number, deps: CopyDeps): Promise<CopyResult[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const results: CopyResult[] = new Array<CopyResult>(plans.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < plans.length) {
      const index = next;
      next += 1;
      const plan = plans[index];
      if (plan !== undefined) results[index] = await runCopy(plan, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, worker));
  return results;
}
