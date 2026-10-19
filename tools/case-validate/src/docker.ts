// The `docker` CopyRunner (the CopyRunner of @rbw/factory-contract) for the CLI and the worker's local
// mode. Files reach the copy as a tar stream (`docker cp -`) and results come back with `docker cp`, so the
// runner needs no bind mount and works wherever a docker CLI can reach a daemon. Every outcome is definite:
// a local docker run has no uncertain provider state, so this runner never rejects for a copy's failure.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packTar, ResultsTreeError, resultsSha256, type TarEntry } from "@rbw/case-package";
import type { Architecture, CollectedCopy, CopyPlan, CopyRoots, CopyRunner, FileDigest } from "@rbw/factory-contract";
import { sha256Hex } from "@rbw/schema";

export interface CommandResult {
  /** The exit code, or null when the command could not start, was killed or passed its time limit. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  input?: Uint8Array;
  /** The CLI process is killed after this long and answers code null. */
  timeoutMs: number;
}

/** Runs one docker CLI command. Never rejects: a failure to start, a kill or a time-out is code null. */
export type DockerCommand = (args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export interface DockerRunnerOptions {
  /** The docker CLI; defaults to "docker". */
  docker?: string;
  /** Replaces the docker CLI (tests). */
  command?: DockerCommand;
  /** The directory each copy's fresh results directory is created in; defaults to the system temporary directory. */
  resultsDir?: string;
  /**
   * The local image to run for a plan. By default the pinned `reference@digest` runs when the daemon has it,
   * otherwise the reference (a locally built kit); the collected image_digest is the image ID that ran.
   */
  image?: (plan: CopyPlan) => string;
  now?: () => Date;
}

/** Reported only for a copy that failed before its image was resolved and whose plan pins no digest. */
export const UNRESOLVED_IMAGE_DIGEST = `sha256:${"0".repeat(64)}`;

/** The time limit of every docker command except `wait`, which follows the plan's own limit. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** How long `wait` may outlast the plan's limit before its CLI process is killed (the kill comes first). */
const WAIT_MARGIN_MS = 60 * 1000;
/** The most stdout or stderr kept from one command. */
const OUTPUT_LIMIT = 1024 * 1024;

function capped(): { add(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    add(chunk) {
      if (size >= OUTPUT_LIMIT) return;
      const kept = chunk.subarray(0, OUTPUT_LIMIT - size);
      chunks.push(kept);
      size += kept.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function spawnDocker(docker: string): DockerCommand {
  return (args, options) =>
    new Promise((resolve) => {
      const child = spawn(docker, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      const stdout = capped();
      const stderr = capped();
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.add(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.add(chunk);
      });
      // A command that exits before reading its input closes the pipe; the exit code reports the failure.
      child.stdin.on("error", (error) => {
        stderr.add(Buffer.from(`stdin: ${error.message}\n`));
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout: "", stderr: `cannot run ${docker}: ${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: killed ? null : code, stdout: stdout.text(), stderr: killed ? `${stderr.text()}\ncommand timed out` : stderr.text() });
      });
      child.stdin.end(options.input === undefined ? undefined : Buffer.from(options.input));
    });
}

function hostArchitecture(): Architecture {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

function inside(destination: string): string {
  return destination.replace(/^\/+/, "");
}

function isFileSystemError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/** Reads the plan's files from a root, refusing links and any file whose bytes differ from its hash. */
async function placed(root: string, files: readonly FileDigest[], destination: string): Promise<TarEntry[] | null> {
  const entries: TarEntry[] = [];
  for (const file of files) {
    const path = join(root, file.path);
    try {
      if (!(await lstat(path)).isFile()) return null;
      const bytes = new Uint8Array(await readFile(path));
      if (sha256Hex(bytes) !== file.sha256) return null;
      entries.push({ kind: "file", path: `${inside(destination)}/${file.path}`, bytes });
    } catch (error) {
      // A missing or unreadable file is a setup failure of this copy, not a runner fault.
      if (!isFileSystemError(error)) throw error;
      return null;
    }
  }
  return entries;
}

interface ResolvedImage {
  name: string;
  digest: string;
  architecture: Architecture;
}

async function resolveImage(docker: DockerCommand, plan: CopyPlan, choose: DockerRunnerOptions["image"]): Promise<ResolvedImage | null> {
  const candidates = choose !== undefined
    ? [choose(plan)]
    : plan.image.digest !== null && !plan.image.reference.includes("@")
      ? [`${plan.image.reference}@${plan.image.digest}`, plan.image.reference]
      : [plan.image.reference];
  for (const name of candidates) {
    const inspected = await docker(["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", name], { timeoutMs: COMMAND_TIMEOUT_MS });
    if (inspected.code !== 0) continue;
    const [id = "", architecture = ""] = inspected.stdout.trim().split(" ");
    if (!/^sha256:[0-9a-f]{64}$/.test(id) || (architecture !== "amd64" && architecture !== "arm64")) return null;
    return { name, digest: id, architecture };
  }
  return null;
}

/** Copies the results directory back and hashes it; null when the copy left none or it cannot be read. */
async function bringBack(docker: DockerCommand, name: string, plan: CopyPlan, parent: string): Promise<{ dir: string; sha256: string } | null> {
  try {
    await mkdir(parent, { recursive: true });
    const resultsDir = join(await mkdtemp(join(parent, "rbw-copy-results-")), "results");
    const copied = await docker(["cp", `${name}:${plan.destinations.results}`, resultsDir], { timeoutMs: COMMAND_TIMEOUT_MS });
    return copied.code === 0 ? { dir: resultsDir, sha256: await resultsSha256(resultsDir) } : null;
  } catch (error) {
    // A results tree with a pipe, a socket or an unreadable file is no usable result, not a runner fault.
    if (error instanceof ResultsTreeError || isFileSystemError(error)) return null;
    throw error;
  }
}

async function runCopy(plan: CopyPlan, roots: CopyRoots, docker: DockerCommand, options: DockerRunnerOptions): Promise<CollectedCopy> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const setupFailed = (image: ResolvedImage | null): CollectedCopy => ({
    copy_id: plan.copy_id,
    outcome: "setup_failed",
    exit_code: null,
    results_dir: null,
    image_digest: image?.digest ?? plan.image.digest ?? UNRESOLVED_IMAGE_DIGEST,
    architecture: image?.architecture ?? hostArchitecture(),
    started_at: startedAt,
    finished_at: now().toISOString(),
    results_sha256: null,
  });

  const app = await placed(roots.app_root, plan.files, plan.destinations.app);
  const evaluator = await placed(roots.evaluator_root, plan.evaluator_files, plan.destinations.evaluator);
  if (app === null || evaluator === null) return setupFailed(null);
  const image = await resolveImage(docker, plan, options.image);
  if (image === null) return setupFailed(null);

  const name = `rbw-copy-${plan.copy_id.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40)}-${randomBytes(4).toString("hex")}`;
  const { limits } = plan;
  const command = { timeoutMs: COMMAND_TIMEOUT_MS };
  const created = await docker([
    "create", "--name", name, "--network", "none",
    "--cpus", String(limits.vcpus), "--memory", `${String(limits.memory_mb)}m`, "--memory-swap", `${String(limits.memory_mb)}m`,
    image.name, ...plan.command,
  ], command);
  if (created.code !== 0) return setupFailed(image);
  try {
    // The results directory is created writable for any user, so a kit that runs unprivileged can write it.
    const tar = packTar([{ kind: "directory", path: inside(plan.destinations.results), mode: 0o777 }, ...app, ...evaluator]);
    if ((await docker(["cp", "-", `${name}:/`], { input: tar, timeoutMs: COMMAND_TIMEOUT_MS })).code !== 0) return setupFailed(image);
    if ((await docker(["start", name], command)).code !== 0) return setupFailed(image);
    const deadline: { kill: Promise<CommandResult> | null } = { kill: null };
    const timer = setTimeout(() => {
      deadline.kill = docker(["kill", name], command);
    }, limits.timeout_s * 1000);
    const waited = await docker(["wait", name], { timeoutMs: limits.timeout_s * 1000 + WAIT_MARGIN_MS });
    clearTimeout(timer);
    // A kill that found the copy already stopped means it ended on its own just before the limit.
    const timedOut = deadline.kill !== null && (await deadline.kill).code === 0;
    const exit = /^-?\d+$/.test(waited.stdout.trim()) ? Number(waited.stdout.trim()) : null;
    if (!timedOut && exit === null) return setupFailed(image);
    const results = await bringBack(docker, name, plan, options.resultsDir ?? tmpdir());
    return {
      copy_id: plan.copy_id,
      outcome: timedOut ? "timed_out" : "ran",
      exit_code: timedOut ? null : exit,
      results_dir: results?.dir ?? null,
      image_digest: image.digest,
      architecture: image.architecture,
      started_at: startedAt,
      finished_at: now().toISOString(),
      results_sha256: results?.sha256 ?? null,
    };
  } finally {
    // A container that cannot be removed is left for the operator; the copy's outcome is already definite.
    await docker(["rm", "--force", name], command);
  }
}

/**
 * A CopyRunner on the local docker daemon: checks and places every plan file at its destination, runs the
 * command with no network within the plan's CPU and memory limits, kills it at the time limit, and copies the
 * results directory back into a fresh local directory with its results_sha256.
 */
export function dockerRunner(options: DockerRunnerOptions = {}): CopyRunner {
  const docker = options.command ?? spawnDocker(options.docker ?? "docker");
  return { run: (plan, roots) => runCopy(plan, roots, docker, options) };
}
