// A local Docker runner for this package's own qualification runs, following the runner and collect
// convention: it places every plan file from the copy roots at the plan's destinations (each
// SHA-256 checked first), runs the plan's command with the plan's limits and no network, and copies
// the plan's results directory back into a fresh local directory. It resolves for every definite
// outcome: setup_failed when the image, a file or a Docker step is wrong before the start,
// timed_out after the plan's time limit, otherwise ran with the container's exit code. The shared
// runners are the package harness's docker runner and the hosted sandbox runner; this one exists so
// the package can qualify its own entry locally. Imports only node: built-ins, so it runs on a host
// where the package's dependencies are not installed.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HashError, hashTree, sha256Hex } from "../src/hash.ts";
import type { CollectedCopy, CopyPlan, CopyRoots, CopyRunner } from "./contract.ts";

export const KILL_GRACE_S = 10;
const UNKNOWN_DIGEST = `sha256:${"0".repeat(64)}`;

export interface LocalRunnerOptions {
  /** Each copy writes its staging files, console log, results and collected.json under <outDir>/<copy_id>. */
  outDir: string;
  log?: (message: string) => void;
}

interface Exec {
  code: number | null;
  stdout: string;
  timed_out: boolean;
}

function exec(args: readonly string[], timeoutMs: number, consoleFile?: string): Promise<Exec> {
  return new Promise((resolvePromise) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout: "", timed_out: false });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString("utf8");
      if (consoleFile !== undefined) writeFileSync(consoleFile, stdout);
      resolvePromise({ code, stdout, timed_out: timedOut });
    });
  });
}

/** Copies a plan's files from a root into a staging directory, checking each SHA-256. */
function stage(root: string, files: CopyPlan["files"], into: string): string | null {
  for (const file of files) {
    const from = join(root, file.path);
    if (!existsSync(from)) return `missing ${file.path}`;
    if (sha256Hex(readFileSync(from)) !== file.sha256) return `${file.path} differs from its SHA-256`;
    mkdirSync(dirname(join(into, file.path)), { recursive: true });
    copyFileSync(from, join(into, file.path));
  }
  return null;
}

export function createLocalDockerRunner(options: LocalRunnerOptions): CopyRunner {
  const log = options.log ?? ((): void => undefined);
  return {
    async run(plan: CopyPlan, roots: CopyRoots): Promise<CollectedCopy> {
      const dir = join(options.outDir, plan.copy_id);
      if (existsSync(dir)) throw new Error(`${dir} already exists`);
      mkdirSync(dir, { recursive: true });
      const startedAt = new Date().toISOString();
      let imageDigest = plan.image.digest ?? UNKNOWN_DIGEST;
      // Until the image is inspected, the copy would have run on this Docker host's architecture.
      let architecture: CollectedCopy["architecture"] = process.arch === "arm64" ? "arm64" : "amd64";
      const record: Record<string, unknown> = { format: "rbw.task-report.local-copy.v2", copy_id: plan.copy_id, state: plan.state, image: plan.image, command: plan.command, limits: plan.limits, started_at: startedAt, steps: {} };
      const steps = record.steps as Record<string, number | null>;
      const finish = (collected: CollectedCopy, detail: string | null): CollectedCopy => {
        writeFileSync(join(dir, "collected.json"), `${JSON.stringify({ ...record, detail, collected }, null, 2)}\n`);
        log(`${plan.copy_id}: ${collected.outcome}${detail === null ? "" : ` (${detail})`}`);
        return collected;
      };
      const failed = (detail: string): CollectedCopy =>
        finish({ copy_id: plan.copy_id, outcome: "setup_failed", exit_code: null, results_dir: null, image_digest: imageDigest, architecture, started_at: startedAt, finished_at: new Date().toISOString(), results_sha256: null }, detail);

      const inspect = await exec(["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", plan.image.reference], 60_000);
      const [id, arch] = inspect.stdout.trim().split(/\s+/);
      if (inspect.code !== 0 || id === undefined || !/^sha256:[0-9a-f]{64}$/.test(id)) return failed(`image ${plan.image.reference} is not available`);
      imageDigest = id;
      record.image_id = id;
      if (arch !== "arm64" && arch !== "amd64") return failed(`image ${plan.image.reference} is for ${String(arch)}, not amd64 or arm64`);
      architecture = arch;
      if (plan.image.digest !== null && id !== plan.image.digest) return failed(`image ${plan.image.reference} is ${id}, not the pinned ${plan.image.digest}`);
      const appStage = join(dir, "stage", "app");
      const evaluatorStage = join(dir, "stage", "evaluator");
      mkdirSync(appStage, { recursive: true });
      mkdirSync(evaluatorStage, { recursive: true });
      const staged = stage(roots.app_root, plan.files, appStage) ?? stage(roots.evaluator_root, plan.evaluator_files, evaluatorStage);
      if (staged !== null) return failed(staged);

      const container = plan.copy_id;
      const limits = ["--network", plan.limits.network, "--cpus", String(plan.limits.vcpus), "--memory", `${String(plan.limits.memory_mb)}m`, "--security-opt", "no-new-privileges"];
      let outcome: CollectedCopy["outcome"] = "ran";
      let exitCode: number | null;
      let resultsDir: string | null = null;
      try {
        const created = await exec(["create", "--name", container, ...limits, plan.image.reference, ...plan.command], 120_000);
        steps.create = created.code;
        if (created.code !== 0) return failed("docker create failed");
        const app = await exec(["cp", `${appStage}/.`, `${container}:${plan.destinations.app}`], 300_000);
        steps.copy_app = app.code;
        const evaluator = await exec(["cp", `${evaluatorStage}/.`, `${container}:${plan.destinations.evaluator}`], 300_000);
        steps.copy_evaluator = evaluator.code;
        if (app.code !== 0 || evaluator.code !== 0) return failed("docker cp into the copy failed");
        const began = performance.now();
        const ran = await exec(["start", "--attach", container], plan.limits.timeout_s * 1000, join(dir, "console.log"));
        record.duration_ms = Math.round(performance.now() - began);
        steps.start = ran.code;
        if (ran.timed_out) {
          outcome = "timed_out";
          steps.stop = (await exec(["stop", "--time", String(KILL_GRACE_S), container], 60_000)).code;
        }
        const state = await exec(["inspect", "--format", "{{.State.ExitCode}}", container], 60_000);
        exitCode = outcome === "ran" && state.code === 0 ? Number(state.stdout.trim()) : null;
        const results = join(dir, "results");
        const copied = await exec(["cp", `${container}:${plan.destinations.results}`, results], 300_000);
        steps.copy_out = copied.code;
        if (copied.code === 0 && existsSync(results)) resultsDir = results;
      } finally {
        steps.remove = (await exec(["rm", "--force", container], 120_000)).code;
      }
      let resultsSha: string | null = null;
      let note: string | null = null;
      if (resultsDir !== null) {
        try {
          resultsSha = hashTree(resultsDir).tree_sha256;
          note = "results_sha256 is the tree hash of the results directory";
        } catch (error) {
          if (!(error instanceof HashError)) throw error;
          note = `the results could not be hashed: ${error.message}`;
          resultsDir = null;
        }
      }
      return finish({ copy_id: plan.copy_id, outcome, exit_code: exitCode, results_dir: resultsDir, image_digest: imageDigest, architecture, started_at: startedAt, finished_at: new Date().toISOString(), results_sha256: resultsSha }, note);
    },
  };
}
