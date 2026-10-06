// One copy on Vercel Sandbox: one microVM created from the kit image in Vercel Container Registry,
// with no persistence, no network and the copy's outer limit as its timeout. The code state's file
// and the job are written into it as data; one command runs the Docker backend's copy script as
// root under the image's tini, at most once per sandbox, and packs the runner directory; the copy
// is judged from its completion marker and exit files; the archive is read back; and the
// sandbox is stopped and its stop confirmed by status. The SDK is injected, so tests use a fake.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { extract } from "tar-stream";
import type { Clock } from "./clock.ts";
import { APP_DIR, COPY_OUTER_LIMIT_MS, COPY_SCRIPT, JOB_DIR, KILL_GRACE_MS, RUNNER_DIR, interpret, placedFile, readExit } from "./copy.ts";
import type { CopyPlan, CopyResult, Interpreted } from "./copy.ts";
import { ARTIFACT_LIMIT_BYTES } from "./records.ts";

export type SandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";

export interface SandboxCreateParams {
  image: string;
  name: string;
  persistent: false;
  networkPolicy: "deny-all";
  resources: { vcpus: number };
  /** Milliseconds. */
  timeout: number;
  /** `attempt` marks the sandbox as this call's own, so recovery by name never takes over another attempt's. */
  tags: { attempt: string };
}

export interface SandboxFile {
  path: string;
  content: Uint8Array;
  mode?: number;
}

export interface SandboxCommandParams {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached: true;
  /** Cancels the command-start request, and the SDK's retries of it, at the copy's deadline. */
  signal?: AbortSignal;
}

export interface SandboxCommand {
  wait(options?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
}

/** The part of the SDK's `Sandbox` that a copy uses. */
export interface SandboxInstance {
  readonly name: string;
  readonly status: SandboxStatus;
  /** The digest-pinned image the platform reports, `<repository>@sha256:<digest>`. */
  readonly image: string | undefined;
  readonly tags: Record<string, string> | undefined;
  writeFiles(files: SandboxFile[], options?: { signal?: AbortSignal }): Promise<void>;
  runCommand(params: SandboxCommandParams): Promise<SandboxCommand>;
  readFile(file: { path: string }, options?: { signal?: AbortSignal }): Promise<NodeJS.ReadableStream | null>;
  stop(options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** `Sandbox.create` and `Sandbox.get`, with the credentials already bound. */
export interface SandboxSdk {
  create(params: SandboxCreateParams, options?: { signal?: AbortSignal }): Promise<SandboxInstance>;
  /** Null when no sandbox has this name. */
  get(name: string, options?: { signal?: AbortSignal }): Promise<SandboxInstance | null>;
}

/** Spec §9.4: 4 vCPU per copy (the platform gives 2 GB per vCPU, so 8 GB). */
export const SANDBOX_VCPUS = 4;
/** Spec §9.4's per-copy ceilings on SDK calls. */
export const SANDBOX_CALL_LIMITS = { mutating: 8, artifact_reads: 12, stops: 1 } as const;
/** Status checks after the stop, spaced so that all of them fit in the kill grace the run leaves. */
export const STATUS_CHECKS = 5;
export const STATUS_INTERVAL_MS = 2000;
/** The environment a Docker container of the image runs with; the sandbox does not apply the image's. */
export const COPY_ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" };

export const COPY_LOCK = "/var/lib/rbw/copy.lock";
/** `<copy status> <pack status>`, written by the instance that ran the copy once it has finished and packed. */
export const COPY_DONE = "/var/lib/rbw/copy.done";
/** The first wait for a missing marker; each later wait doubles, so the reads end at the outer limit well inside the read budget. */
export const MARKER_FIRST_INTERVAL_MS = 1000;
const MARKER_LIMIT_BYTES = 64;

export const COLLECT_ARCHIVE = "/var/lib/rbw/collect.tar";
/** The driver's 64 MiB artifact limit plus room for the exit files, the driver's output and the frozen manifest. */
export const COLLECT_LIMIT_BYTES = ARTIFACT_LIMIT_BYTES + 8 * 1024 * 1024;
const PACK_OVER_LIMIT = 3;

/**
 * The copy script, run at most once per sandbox. The SDK retries a command whose response was
 * lost, which can start this script a second time; `mkdir` of the lock lets only the first
 * instance run the copy and pack the runner directory into one archive (refusing one over the
 * limit before it is read), and any other waits for its marker and exits with the status it records.
 * The pack status is 0, 2 when there is no runner directory, 1 when `tar` failed, or 3 over the limit.
 */
export const SANDBOX_COPY_SCRIPT = [
  "set -u",
  `lock=${COPY_LOCK}`,
  `done=${COPY_DONE}`,
  `archive=${COLLECT_ARCHIVE}`,
  'mkdir -p "${lock%/*}" || exit 90',
  'if ! mkdir "$lock" 2> /dev/null; then',
  '  [ -d "$lock" ] || exit 90',
  '  while [ ! -s "$done" ]; do sleep 1; done',
  '  read -r status pack < "$done"',
  '  exit "$status"',
  "fi",
  "(",
  COPY_SCRIPT,
  ")",
  "status=$?",
  "pack=2",
  `if [ -d ${RUNNER_DIR} ]; then`,
  "  pack=1",
  `  if tar -C ${RUNNER_DIR} -cf "$archive" . && chmod 0644 "$archive"; then`,
  "    pack=0",
  `    [ "$(wc -c < "$archive")" -le ${String(COLLECT_LIMIT_BYTES)} ] || pack=${String(PACK_OVER_LIMIT)}`,
  "  fi",
  "fi",
  'echo "$status $pack" > "$done"',
  'exit "$status"',
].join("\n");

const PINNED = /^[^\s@]+@(sha256:[0-9a-f]{64})$/;
const STOPPED: ReadonlySet<SandboxStatus> = new Set(["stopped", "failed", "aborted"]);

export interface SandboxReport {
  name: string;
  image: string;
  recovered_by_name: boolean;
  stop_confirmed: boolean;
  /** The last status `get` reported after the stop, `not_found` when the sandbox was gone, or null. */
  final_status: string | null;
  calls: { mutating: number; artifact_reads: number; stops: number; status_reads: number };
  limits: typeof SANDBOX_CALL_LIMITS;
  within_limits: boolean;
  /** The provider's error code when a call failed, or null. */
  error_code: string | null;
}

export type SandboxCopyResult = CopyResult & { sandbox: SandboxReport };

export interface SandboxDeps {
  sdk: SandboxSdk;
  clock: Clock;
  /** The kit image in VCR, pinned by digest. */
  image: string;
  /** Unique to this call, for example a random UUID; it tags the sandbox this call creates. */
  attempt: string;
}

/** A step that failed; the copy is recorded `failed` with this reason. */
class SandboxFailure extends Error {
  readonly reason: string;
  /** The provider's bracketed error code, such as `invalid_argument`; never the message text. */
  readonly code: string | null;

  constructor(reason: string, code: string | null = null) {
    super(reason);
    this.reason = reason;
    this.code = code;
  }
}

/** The outer limit was reached; the copy is recorded `incomplete` with reason `timeout`. */
class SandboxTimedOut extends Error {}

class ArchiveError extends Error {}

type Bounded<T> = { kind: "done"; value: T } | { kind: "error"; error: unknown } | { kind: "limit" };

/** Runs one SDK call until it settles or the deadline passes; at the deadline the call is aborted. */
async function until<T>(clock: Clock, deadline: number, run: (signal: AbortSignal) => Promise<T>): Promise<Bounded<T>> {
  const call = new AbortController();
  const timer = new AbortController();
  const settled = Promise.resolve()
    .then(() => run(call.signal))
    .then(
      (value): Bounded<T> => ({ kind: "done", value }),
      (error: unknown): Bounded<T> => ({ kind: "error", error }),
    );
  const outcome = await Promise.race([settled, clock.sleep(Math.max(0, deadline - clock.now()), timer.signal).then((): Bounded<T> => ({ kind: "limit" }))]);
  timer.abort();
  if (outcome.kind === "limit") call.abort();
  return outcome;
}

/** The provider's bracketed error code (`[invalid_argument]`), which carries no secret, or null. */
function providerCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  return /\[([a-z_]{1,64})\]/.exec(message)?.[1] ?? null;
}

function need<T>(outcome: Bounded<T>, reason: string): T {
  if (outcome.kind === "done") return outcome.value;
  if (outcome.kind === "limit") throw new SandboxTimedOut();
  throw new SandboxFailure(reason, providerCode(outcome.error));
}

class Budget {
  readonly calls = { mutating: 0, artifact_reads: 0, stops: 0, status_reads: 0 };

  take(kind: keyof SandboxReport["calls"]): void {
    if (kind !== "status_reads" && this.calls[kind] >= SANDBOX_CALL_LIMITS[kind]) throw new SandboxFailure("sandbox_call_limit");
    this.calls[kind] += 1;
  }

  within(): boolean {
    return this.calls.mutating <= SANDBOX_CALL_LIMITS.mutating && this.calls.artifact_reads <= SANDBOX_CALL_LIMITS.artifact_reads && this.calls.stops <= SANDBOX_CALL_LIMITS.stops;
  }
}

export function sandboxCreateParams(plan: Pick<CopyPlan, "container">, image: string, attempt: string): SandboxCreateParams {
  return { image, name: plan.container, persistent: false, networkPolicy: "deny-all", resources: { vcpus: SANDBOX_VCPUS }, timeout: COPY_OUTER_LIMIT_MS, tags: { attempt } };
}

/** The single-run copy script, as root under the image's tini as a child subreaper: there is no init to reap the kit's launchers. */
export function sandboxCopyCommand(plan: Pick<CopyPlan, "mode" | "trial_id">): SandboxCommandParams {
  return {
    cmd: "/sbin/tini",
    args: ["-s", "--", "/bin/sh", "-c", SANDBOX_COPY_SCRIPT, "rbw-copy", plan.mode, plan.trial_id],
    cwd: APP_DIR,
    env: COPY_ENV,
    detached: true,
  };
}

interface Run {
  plan: CopyPlan;
  deps: SandboxDeps;
  budget: Budget;
  report: SandboxReport;
  /** When the run must end, leaving the kill grace for the stop and its confirmation. */
  deadline: number;
}

async function createOrRecover(r: Run): Promise<SandboxInstance> {
  const { sdk, clock } = r.deps;
  r.budget.take("mutating");
  const created = await until(clock, r.deadline, (signal) => sdk.create(sandboxCreateParams(r.plan, r.deps.image, r.deps.attempt), { signal }));
  if (created.kind === "done") return created.value;
  // The name is deterministic, so a create whose response was lost is found here rather than made twice;
  // only this call's own sandbox counts, never one an earlier attempt left running under the name.
  r.budget.take("status_reads");
  const found = need(await until(clock, r.deadline, (signal) => sdk.get(r.plan.container, { signal })), "sandbox_create_failed");
  if (found === null) throw new SandboxFailure("sandbox_create_failed");
  if (found.tags?.attempt !== r.deps.attempt || (found.status !== "pending" && found.status !== "running")) throw new SandboxFailure("sandbox_name_in_use");
  r.report.recovered_by_name = true;
  return found;
}

function jobFiles(dir: string): SandboxFile[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split("\\").join("/"))
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .sort()
    .map((entry) => ({ path: `${JOB_DIR}/${entry}`, content: readFileSync(join(dir, entry)), mode: 0o644 }));
}

/** The verified target file (the same bytes the Docker backend places) and the job directory, as data. */
async function place(r: Run, sandbox: SandboxInstance): Promise<void> {
  const files: SandboxFile[] = [];
  const { placement } = r.plan;
  if (placement !== null) {
    const file = placedFile(r.plan, placement);
    mkdirSync(join(r.plan.work_dir, "placed"));
    writeFileSync(file, placement.bytes);
    chmodSync(file, 0o644);
    files.push({ path: `${APP_DIR}/${placement.path}`, content: readFileSync(file), mode: 0o644 });
  }
  if (r.plan.job_dir !== null) files.push(...jobFiles(r.plan.job_dir));
  if (files.length === 0) return;
  r.budget.take("mutating");
  need(await until(r.deps.clock, r.deadline, (signal) => sandbox.writeFiles(files, { signal })), "sandbox_place_failed");
}

interface Marker {
  status: number;
  pack: number;
}

/** The statuses in the completion marker, or null while it is missing or not yet whole. */
async function readMarker(r: Run, sandbox: SandboxInstance): Promise<Marker | null> {
  const { clock } = r.deps;
  r.budget.take("artifact_reads");
  const stream = need(await until(clock, r.deadline, (signal) => sandbox.readFile({ path: COPY_DONE }, { signal })), "sandbox_marker_failed");
  if (stream === null) return null;
  const bytes = need(await until(clock, r.deadline, (signal) => readCapped(stream, MARKER_LIMIT_BYTES, signal)), "sandbox_marker_failed");
  const match = bytes === null ? null : /^(\d{1,3}) (\d)\n$/.exec(bytes.toString("utf8"));
  return match === null ? null : { status: Number(match[1]), pack: Number(match[2]) };
}

/**
 * Runs the copy script and returns what its completion marker records. The handle may be a
 * second launch's, so its own exit status is not used, and a marker still missing when it returns
 * is polled for until the outer limit.
 */
async function runCopy(r: Run, sandbox: SandboxInstance): Promise<Marker> {
  const { clock } = r.deps;
  r.budget.take("mutating");
  const command = need(await until(clock, r.deadline, (signal) => sandbox.runCommand({ ...sandboxCopyCommand(r.plan), signal })), "sandbox_run_failed");
  need(await until(clock, r.deadline, (signal) => command.wait({ signal })), "sandbox_wait_failed");
  for (let interval = MARKER_FIRST_INTERVAL_MS; ; interval *= 2) {
    const marker = await readMarker(r, sandbox);
    if (marker !== null) return marker;
    const left = r.deadline - clock.now();
    if (left <= 0) throw new SandboxTimedOut();
    await clock.sleep(Math.min(interval, left));
  }
}

async function readCapped(stream: NodeJS.ReadableStream, limit: number, signal: AbortSignal): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw new SandboxTimedOut();
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function safeEntry(name: string): string | null {
  const path = posix.normalize(name.replace(/^\.\//, ""));
  if (path === "." || path === "./" || path === "") return null;
  if (path.startsWith("/") || path === ".." || path.startsWith("../")) throw new ArchiveError(`the archive entry ${name} is outside the runner directory`);
  return path.replace(/\/$/, "");
}

/** Writes the archive's files and directories under `dest`, as `docker cp` lays out the runner directory. */
async function extractTo(bytes: Buffer, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const archive = extract();
  const state: { failure: Error | null } = { failure: null };
  archive.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk as Uint8Array));
    });
    stream.on("end", () => {
      try {
        if (state.failure === null) {
          const path = safeEntry(header.name);
          if (path !== null) {
            const target = join(dest, ...path.split("/"));
            if (header.type === "directory") mkdirSync(target, { recursive: true });
            else if (header.type === "file") {
              mkdirSync(join(target, ".."), { recursive: true });
              writeFileSync(target, Buffer.concat(chunks), { mode: (header.mode & 0o111) !== 0 ? 0o755 : 0o644 });
            } else throw new ArchiveError(`the archive holds a ${header.type} entry`);
          }
        }
      } catch (error) {
        state.failure = error instanceof Error ? error : new ArchiveError("an archive entry could not be written");
      }
      next();
    });
    stream.resume();
  });
  const finished = new Promise<void>((resolve, reject) => {
    archive.on("finish", resolve);
    archive.on("error", reject);
  });
  archive.end(bytes);
  try {
    await finished;
  } catch (error) {
    throw new ArchiveError(error instanceof Error ? error.message : "the archive could not be read");
  }
  if (state.failure !== null) throw state.failure;
}

type Collected = { kind: "dir"; dir: string } | { kind: "none" } | { kind: "over_limit" } | { kind: "unreadable" };

/** Reads back the archive the copy script packed, within the size limit. */
async function collect(r: Run, sandbox: SandboxInstance, pack: number): Promise<Collected> {
  const { clock } = r.deps;
  if (pack === PACK_OVER_LIMIT) return { kind: "over_limit" };
  if (pack !== 0) return { kind: "none" };
  r.budget.take("artifact_reads");
  const stream = need(await until(clock, r.deadline, (signal) => sandbox.readFile({ path: COLLECT_ARCHIVE }, { signal })), "sandbox_collect_failed");
  if (stream === null) return { kind: "none" };
  const bytes = need(await until(clock, r.deadline, (signal) => readCapped(stream, COLLECT_LIMIT_BYTES, signal)), "sandbox_collect_failed");
  if (bytes === null) return { kind: "over_limit" };
  const dir = join(r.plan.work_dir, "collected");
  try {
    await extractTo(bytes, dir);
  } catch (error) {
    if (error instanceof ArchiveError) return { kind: "unreadable" };
    throw error;
  }
  return { kind: "dir", dir };
}

/** Stops the sandbox and confirms by status that it stopped, before the outer limit. */
async function stopAndConfirm(r: Run, sandbox: SandboxInstance, hardDeadline: number): Promise<void> {
  const { sdk, clock } = r.deps;
  r.budget.take("stops");
  await until(clock, hardDeadline, (signal) => sandbox.stop({ signal }));
  for (let check = 0; check < STATUS_CHECKS; check += 1) {
    if (check > 0) await clock.sleep(Math.max(0, Math.min(STATUS_INTERVAL_MS, hardDeadline - clock.now())));
    if (clock.now() >= hardDeadline) return;
    r.budget.take("status_reads");
    const got = await until(clock, hardDeadline, (signal) => sdk.get(sandbox.name, { signal }));
    if (got.kind !== "done") continue;
    r.report.final_status = got.value?.status ?? "not_found";
    if (got.value === null || STOPPED.has(got.value.status)) {
      r.report.stop_confirmed = true;
      return;
    }
  }
}

export async function runSandboxCopy(plan: CopyPlan, deps: SandboxDeps): Promise<SandboxCopyResult> {
  const phases: CopyResult["phases"] = [];
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = deps.clock.now();
    try {
      return await run();
    } finally {
      phases.push({ name, duration_ms: deps.clock.now() - started });
    }
  };
  const budget = new Budget();
  const report: SandboxReport = {
    name: plan.container,
    image: deps.image,
    recovered_by_name: false,
    stop_confirmed: false,
    final_status: null,
    calls: budget.calls,
    limits: SANDBOX_CALL_LIMITS,
    within_limits: true,
    error_code: null,
  };
  const result: SandboxCopyResult = {
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
    sandbox: report,
  };
  const digest = PINNED.exec(deps.image)?.[1];
  if (digest === undefined) return { ...result, status: "refused", reason: "sandbox_image_not_pinned" };
  if (existsSync(plan.work_dir)) return { ...result, reason: "work_dir_exists" };
  result.audit = await timed("audit", plan.audit);
  if (result.audit.verdict === "refused" || result.audit.verdict === "unavailable") {
    return { ...result, status: "refused", reason: `audit_${result.audit.verdict}` };
  }
  mkdirSync(plan.work_dir, { recursive: true });
  const started = deps.clock.now();
  const r: Run = { plan, deps, budget, report, deadline: started + COPY_OUTER_LIMIT_MS - KILL_GRACE_MS };
  let sandbox: SandboxInstance | null = null;
  try {
    sandbox = await timed("create", () => createOrRecover(r));
    const reported = sandbox.image === undefined ? undefined : PINNED.exec(sandbox.image)?.[1];
    if (sandbox.image !== undefined && reported !== digest) throw new SandboxFailure("sandbox_image_mismatch");
    const created = sandbox;
    await timed("place", () => place(r, created));
    const marker = await timed("run", () => runCopy(r, created));
    result.container_exit = marker.status;
    const collected = await timed("collect", () => collect(r, created, marker.pack));
    let outcome: Interpreted;
    if (collected.kind === "over_limit") outcome = { status: "failed", reason: "collected_over_limit", records: false };
    else if (collected.kind === "unreadable") outcome = { status: "failed", reason: "collected_unreadable", records: false };
    else {
      result.collected_dir = collected.kind === "dir" ? collected.dir : null;
      result.freeze_exit = result.collected_dir === null ? null : readExit(join(result.collected_dir, "freeze.exit"));
      result.driver_exit = result.collected_dir === null ? null : readExit(join(result.collected_dir, "run.exit"));
      outcome = interpret(plan.mode, result.collected_dir, result.freeze_exit, result.driver_exit, false);
    }
    result.status = outcome.status;
    result.reason = outcome.reason;
    result.records_dir = outcome.records && result.collected_dir !== null ? join(result.collected_dir, "out") : null;
  } catch (error) {
    if (error instanceof SandboxTimedOut) {
      // A copy stopped at the outer limit is never read back, so none of its partial files is imported.
      result.timed_out = true;
      result.collected_dir = null;
      result.freeze_exit = null;
      result.driver_exit = null;
      result.records_dir = null;
      result.status = "incomplete";
      result.reason = "timeout";
    } else if (error instanceof SandboxFailure) {
      result.status = "failed";
      result.reason = error.reason;
      report.error_code = error.code;
    } else {
      throw error;
    }
  } finally {
    const created = sandbox;
    if (created !== null) await timed("stop", () => stopAndConfirm(r, created, started + COPY_OUTER_LIMIT_MS));
    report.within_limits = budget.within();
  }
  return result;
}
