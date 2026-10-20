// The hosted `sandbox` copy runner: the factory contract package's CopyRunner, run(plan, roots)
// resolving a CollectedCopy, on Vercel Sandbox, one sandbox per copy. Before anything is launched
// or created it reads every plan.files entry from roots.app_root and every evaluator file from
// roots.evaluator_root and checks its sha256 (a mismatch or a missing file is setup_failed). Then
// the copy goes through the copy meter, which refuses limits above the host's copy limits and a
// copy that would not end before the deadline, launches the operation its candidate reserved at
// selection and settles it (or, in a validation run, records it under the run's operation).
// Inside: a sandbox from the plan's kit image pinned by digest, named after the copy's execution,
// with no network, the plan's vCPUs (at least enough for its memory at 2 GB each) and the plan's
// timeout plus the shutdown allowance as its provider timeout; the files placed at their
// destinations; the command run once within its timeout, under a run-once guard because the SDK
// may start a command twice; destinations.results packed and read back into a fresh local
// directory; the stop confirmed by status. It resolves for every definite outcome and rejects
// (SandboxCopyUncertain) only when the provider's outcome is uncertain, which the caller turns
// into needs_reconciliation.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { extract } from "tar-stream";
import type { CollectedCopy, CopyPlan, CopyRoots, CopyRunner, FileDigest } from "@rbw/factory-contract";
import type { SandboxInstance, SandboxSdk } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import type { CopyMeter, LaunchHooks, LaunchReport, RefusalReason } from "./factory-meter.ts";
import { FACTORY_PROFILE } from "./factory-profile.ts";
import type { FactoryProfile } from "./factory-profile.ts";
import { runOnceCommand } from "./factory-run-once.ts";

export interface SandboxRunnerDeps {
  sdk: SandboxSdk;
  meter: CopyMeter;
  /** The candidate_id, or the case_id of a validation run, whose copies this runner runs. */
  subject: string;
  /** A local directory; each copy's results get a fresh directory under it. */
  workDir: string;
  /** The sha256 of a deterministic tar of a results directory (the harness's helper). */
  resultsSha256: (dir: string) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Marks this worker's sandboxes, as the local runner's sandbox copies are marked. */
  attempt: string;
  log: (line: string) => void;
  /** An abort signal that fires after `ms` (tests replace it). */
  timer?: (ms: number) => AbortSignal;
  profile?: FactoryProfile;
}

/** The provider's outcome for this copy is uncertain: it may still run. Never retried. */
export class SandboxCopyUncertain extends Error {
  override name = "SandboxCopyUncertain";
}

/** The image a copy's CollectedCopy names when its plan had no digest, so it never ran. */
export const NO_IMAGE_DIGEST = `sha256:${"0".repeat(64)}`;
/** Where the runner packs destinations.results inside the copy. */
export const RESULTS_ARCHIVE = "/tmp/rbw-copy-results.tar";
/** The most bytes of results read back. */
export const RESULTS_LIMIT_BYTES = 64 * 1024 * 1024;
const COPY_ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" };
const STOPPED = new Set(["stopped", "failed", "aborted"]);
const STATUS_CHECKS = 5;
const STATUS_INTERVAL_MS = 2000;
const GB_PER_VCPU_MB = 2048;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * What a copy the meter did not start becomes. Only limits above the profile, or a copy beyond its
 * candidate's reserved protocol, mean the copy could not be prepared (setup_failed, an invalid
 * record). A stop, the deadline and a halted ledger end the copy early without a fault of the copy
 * (timed_out, an incomplete record), never an invalid candidate; the loop reads meter.lastRefusal
 * and the ledger's status for the request's stop code. An earlier uncertain outcome makes every
 * later copy reject as uncertain.
 */
const REFUSED_OUTCOME: Readonly<Record<Exclude<RefusalReason, "uncertain">, "setup_failed" | "timed_out">> = {
  limits_exceed_profile: "setup_failed",
  no_time: "timed_out",
  stopped: "timed_out",
  halted: "timed_out",
};

/** Where the run-once guard keeps its lock and its exit-status marker inside the copy. */
export const RUN_ONCE_DIR = "/tmp/rbw-copy-once";

export { RUN_ONCE_SCRIPT } from "./factory-run-once.ts";

/**
 * The command the sandbox runs for a plan: its own command under the run-once guard
 * (`sh -c RUN_ONCE_SCRIPT rbw-copy <dir> <command...>`), because the SDK may start a command twice.
 */
export function guardedCommand(command: readonly string[]): { cmd: string; args: string[] } {
  return runOnceCommand("rbw-copy", RUN_ONCE_DIR, command);
}

/** The sandbox image: the plan's repository pinned by its digest. */
export function pinnedImage(plan: Pick<CopyPlan, "image">): string | null {
  const { reference, digest } = plan.image;
  if (digest === null || !/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  const at = reference.indexOf("@");
  if (at >= 0) return reference.slice(at + 1) === digest ? reference : null;
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  const repository = colon > slash ? reference.slice(0, colon) : reference;
  return `${repository}@${digest}`;
}

/** The vCPUs a copy's sandbox gets: the plan's, or more when its memory needs them (2 GB each). */
export function sandboxVcpus(plan: Pick<CopyPlan, "limits">): number {
  return Math.max(plan.limits.vcpus, Math.ceil(plan.limits.memory_mb / GB_PER_VCPU_MB));
}

interface Placed {
  path: string;
  content: Uint8Array;
}

/** Reads and checks each listed file under `root`; null when one is missing, escapes the root or has another sha256. */
function readChecked(root: string, files: readonly FileDigest[], destination: string): Placed[] | null {
  const base = resolve(root);
  const placed: Placed[] = [];
  for (const file of files) {
    const local = resolve(base, ...file.path.split("/"));
    if (!local.startsWith(base + sep)) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(local);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR")) return null;
      throw error;
    }
    if (sha256Hex(bytes) !== file.sha256) return null;
    const target = posix.join(destination, file.path);
    if (!target.startsWith(`${destination}/`)) return null;
    placed.push({ path: target, content: bytes });
  }
  return placed;
}

async function readCapped(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

class ArchiveRefused extends Error {
  override name = "ArchiveRefused";
}

/** Writes the archive's regular files and directories under `dest`; any other entry, or a path outside it, is refused. */
async function extractTo(bytes: Buffer, dest: string): Promise<void> {
  const archive = extract();
  const state: { failure: Error | null } = { failure: null };
  archive.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else state.failure ??= new ArchiveRefused("an archive entry held data of an unknown kind");
    });
    stream.on("end", () => {
      try {
        const name = posix.normalize(header.name.replace(/^\.\//, "")).replace(/\/$/, "");
        if (state.failure === null && name !== "." && name !== "") {
          if (name.startsWith("/") || name === ".." || name.startsWith("../")) throw new ArchiveRefused("an archive entry is outside the results directory");
          const target = join(dest, ...name.split("/"));
          if (header.type === "directory") mkdirSync(target, { recursive: true });
          else if (header.type === "file") {
            mkdirSync(join(target, ".."), { recursive: true });
            writeFileSync(target, Buffer.concat(chunks));
          } else throw new ArchiveRefused(`the archive holds a ${header.type} entry`);
        }
      } catch (error) {
        state.failure = error instanceof Error ? error : new ArchiveRefused("an archive entry could not be written");
      }
      next();
    });
    stream.resume();
  });
  const finished = new Promise<void>((done, fail) => {
    archive.on("finish", done);
    archive.on("error", fail);
  });
  archive.end(bytes);
  try {
    await finished;
  } catch (error) {
    throw new ArchiveRefused(error instanceof Error ? error.message : "the archive could not be read");
  }
  if (state.failure !== null) throw state.failure;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "non-error";
}

/** Stops the sandbox and confirms by status that it stopped. */
async function stopAndConfirm(deps: SandboxRunnerDeps, sandbox: SandboxInstance): Promise<{ confirmed: boolean; at: number }> {
  try {
    await sandbox.stop();
  } catch (error) {
    deps.log(`factory: the stop of ${sandbox.name} failed (${errorName(error)}); checking its status`);
  }
  for (let check = 0; check < STATUS_CHECKS; check += 1) {
    if (check > 0) await deps.sleep(STATUS_INTERVAL_MS);
    try {
      const found = await deps.sdk.get(sandbox.name);
      if (found === null || STOPPED.has(found.status)) return { confirmed: true, at: deps.now() };
    } catch (error) {
      deps.log(`factory: a status read of ${sandbox.name} failed (${errorName(error)})`);
    }
  }
  return { confirmed: false, at: deps.now() };
}

type Inside = { outcome: "ran"; exit_code: number; results_dir: string | null; results_sha256: string | null } | { outcome: "setup_failed" | "timed_out"; exit_code: number | null };

/**
 * Places the files, runs the command once and brings the results back. Every failure here is
 * definite: the sandbox exists and is stopped afterwards. The command's timeout counts from the
 * create, as the provider's does, so setup time comes out of the timeout and the shutdown allowance
 * stays for packing, reading back and stopping.
 */
async function runInside(deps: SandboxRunnerDeps, plan: CopyPlan, files: Placed[], sandbox: SandboxInstance, digest: string, createdAt: number): Promise<Inside> {
  const timer = deps.timer ?? ((ms: number) => AbortSignal.timeout(ms));
  const reported = sandbox.image === undefined ? undefined : /@(sha256:[0-9a-f]{64})$/.exec(sandbox.image)?.[1];
  if (sandbox.image !== undefined && reported !== digest) return { outcome: "setup_failed", exit_code: null };
  const { app, evaluator, results } = plan.destinations;
  try {
    const mkdir = await sandbox.runCommand({ cmd: "mkdir", args: ["-p", app, evaluator, results], env: COPY_ENV, detached: true });
    if ((await mkdir.wait()).exitCode !== 0) return { outcome: "setup_failed", exit_code: null };
    if (files.length > 0) await sandbox.writeFiles(files.map((file) => ({ path: file.path, content: file.content })));
  } catch (error) {
    deps.log(`factory: copy ${plan.copy_id} could not be set up (${errorName(error)})`);
    return { outcome: "setup_failed", exit_code: null };
  }
  if (plan.command.length === 0) return { outcome: "setup_failed", exit_code: null };
  const { cmd, args } = guardedCommand(plan.command);
  let exitCode: number;
  const remainingMs = createdAt + plan.limits.timeout_s * 1000 - deps.now();
  if (remainingMs <= 0) return { outcome: "timed_out", exit_code: null };
  const signal = timer(remainingMs);
  try {
    const command = await sandbox.runCommand({ cmd, args, cwd: app, env: COPY_ENV, detached: true, signal });
    exitCode = (await command.wait({ signal })).exitCode;
  } catch (error) {
    if (signal.aborted) return { outcome: "timed_out", exit_code: null };
    deps.log(`factory: copy ${plan.copy_id}'s command failed to run (${errorName(error)})`);
    return { outcome: "setup_failed", exit_code: null };
  }
  try {
    const pack = await sandbox.runCommand({ cmd: "tar", args: ["-C", results, "-cf", RESULTS_ARCHIVE, "."], env: COPY_ENV, detached: true });
    if ((await pack.wait()).exitCode !== 0) return { outcome: "ran", exit_code: exitCode, results_dir: null, results_sha256: null };
    const stream = await sandbox.readFile({ path: RESULTS_ARCHIVE });
    const bytes = stream === null ? null : await readCapped(stream, RESULTS_LIMIT_BYTES);
    if (bytes === null) return { outcome: "ran", exit_code: exitCode, results_dir: null, results_sha256: null };
    mkdirSync(deps.workDir, { recursive: true });
    const dir = mkdtempSync(join(deps.workDir, `${plan.copy_id}-`));
    await extractTo(bytes, dir);
    return { outcome: "ran", exit_code: exitCode, results_dir: dir, results_sha256: await deps.resultsSha256(dir) };
  } catch (error) {
    deps.log(`factory: copy ${plan.copy_id}'s results could not be brought back (${errorName(error)})`);
    return { outcome: "ran", exit_code: exitCode, results_dir: null, results_sha256: null };
  }
}

async function launch(deps: SandboxRunnerDeps, plan: CopyPlan, files: Placed[], image: string, digest: string, name: string, hooks: LaunchHooks): Promise<LaunchReport<CollectedCopy>> {
  const profile = deps.profile ?? FACTORY_PROFILE;
  const vcpus = sandboxVcpus(plan);
  const createdAt = deps.now();
  // A failed create rejects: whether a sandbox exists is then unknown.
  const sandbox = await deps.sdk.create({
    image,
    name,
    persistent: false,
    networkPolicy: "deny-all",
    resources: { vcpus },
    timeout: (plan.limits.timeout_s + profile.shutdown_seconds) * 1000,
    tags: { attempt: deps.attempt },
  });
  try {
    await hooks.created(sandbox.name);
  } catch (error) {
    // The ledger could not record the sandbox: stop it, and leave the outcome uncertain for reconciliation.
    const stop = await stopAndConfirm(deps, sandbox);
    throw new SandboxCopyUncertain(`${error instanceof Error ? error.message : "the ledger refused the copy's resource"}; ${sandbox.name} stop ${stop.confirmed ? "confirmed" : "not confirmed"}`);
  }
  let inside: Inside;
  try {
    inside = await runInside(deps, plan, files, sandbox, digest, createdAt);
  } catch (error) {
    deps.log(`factory: copy ${plan.copy_id} failed (${errorName(error)})`);
    inside = { outcome: "setup_failed", exit_code: null };
  }
  const stop = await stopAndConfirm(deps, sandbox);
  const result: CollectedCopy = {
    copy_id: plan.copy_id,
    outcome: inside.outcome,
    exit_code: inside.exit_code,
    results_dir: inside.outcome === "ran" ? inside.results_dir : null,
    image_digest: digest,
    architecture: "amd64",
    started_at: iso(createdAt),
    finished_at: iso(stop.at),
    results_sha256: inside.outcome === "ran" ? inside.results_sha256 : null,
  };
  // The command's own exit code (a failing suite exits non-zero) is a result, not a failure of the copy.
  return { result, created: true, lifetime_ms: stop.at - createdAt, stop_confirmed: stop.confirmed, status: inside.outcome === "ran" ? "completed" : "failed", vcpus };
}

/** The runner for one subject's copies. */
export function createSandboxCopyRunner(deps: SandboxRunnerDeps): CopyRunner {
  return {
    async run(plan: CopyPlan, roots: CopyRoots): Promise<CollectedCopy> {
      const started = deps.now();
      const notRun = (outcome: "setup_failed" | "timed_out"): CollectedCopy => ({
        copy_id: plan.copy_id,
        outcome,
        exit_code: null,
        results_dir: null,
        image_digest: plan.image.digest ?? NO_IMAGE_DIGEST,
        architecture: "amd64",
        started_at: iso(started),
        finished_at: iso(deps.now()),
        results_sha256: null,
      });
      const image = pinnedImage(plan);
      const digest = plan.image.digest;
      const app = readChecked(roots.app_root, plan.files, plan.destinations.app);
      const evaluator = readChecked(roots.evaluator_root, plan.evaluator_files, plan.destinations.evaluator);
      if (image === null || digest === null || app === null || evaluator === null) return notRun("setup_failed");
      const outcome = await deps.meter.run({ subject: deps.subject, host: plan.host_id, state: plan.state, limits: plan.limits }, (name, hooks) => launch(deps, plan, [...app, ...evaluator], image, digest, name, hooks));
      switch (outcome.kind) {
        case "ran":
          return outcome.result;
        case "refused":
          deps.log(`factory: copy ${plan.copy_id} did not start (${outcome.reason}: ${outcome.detail})`);
          // Spend refusals are not copy failures; the loop tells them apart through meter.lastRefusal.
          if (outcome.reason === "uncertain") throw new SandboxCopyUncertain(`copy ${plan.copy_id}: ${outcome.detail}`);
          return notRun(REFUSED_OUTCOME[outcome.reason]);
        case "uncertain":
          throw new SandboxCopyUncertain(`copy ${plan.copy_id}: ${outcome.detail}`);
      }
    },
  };
}
