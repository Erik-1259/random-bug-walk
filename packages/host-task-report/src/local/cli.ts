// Host-side runner for the task-report copy image on local Docker.
//
//   node src/local/cli.ts build --tag rbw-task-report:<name>
//   node src/local/cli.ts derive --state clean|buggy|fixed --out <new dir> [--entry <catalog entry>]
//   node src/local/cli.ts copy --image rbw-task-report:<name> --run-id f3q-<...> --dir <derived dir> \
//     [--purpose smoke --instances N --main-target N --control-target N]
//   node src/local/cli.ts run  (the options of derive and copy; --out is the new directory)
//   node src/local/cli.ts evaluate <dir>...
//
// `build` builds kit/task-report with the vendored app, this package and the Umami kit's launcher
// as named build contexts. `derive` makes the state's app tree on this side from the vendored
// baseline and the catalog entry, every hash checked, in <out>/tree, and writes
// <out>/derive.json. `copy` creates one container with no network, 4 CPUs and 8 GB, copies
// <dir>/tree in, starts the copy and waits at most 720 s (then TERM, and KILL 10 s later),
// copies the record set out to <dir>/records, removes the container and writes <dir>/run.json.
// `run` is derive then copy. `evaluate` reads each <dir>/records/copy.json and prints the
// protocol evaluation. Only derive needs the diff library, which it loads when it runs; the other
// commands use Node's built-ins only, so they also run where the package is not installed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadBaseline } from "../baseline.ts";
import { loadData } from "../f3/data.ts";
import { evaluateProtocol, loadProtocol } from "../protocol.ts";
import type { CopySummary } from "../protocol.ts";

export const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const REPO_ROOT = resolve(PACKAGE_DIR, "../..");
export const COPY_RESOURCES = ["--network", "none", "--cpus", "4", "--memory", "8g", "--security-opt", "no-new-privileges"] as const;
export const COPY_OUTER_LIMIT_MS = 720_000;
export const KILL_GRACE_S = 10;
const TAG = /^rbw-task-report:[a-z0-9][a-z0-9._-]{0,63}$/;
const RUN_ID = /^f3q-[a-z0-9][a-z0-9-]{0,58}$/;
const STATES = ["clean", "buggy", "fixed"] as const;
type State = (typeof STATES)[number];

export class CliError extends Error {
  override name = "CliError";
}

interface Exec {
  code: number | null;
  stdout: string;
  timed_out: boolean;
}

function exec(command: string, args: readonly string[], options: { timeoutMs: number; inherit?: boolean }): Promise<Exec> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: options.inherit === true ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout: "", timed_out: false });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(chunks).toString("utf8"), timed_out: timedOut });
    });
  });
}

export function buildArgs(tag: string, repoRoot: string): string[] {
  return [
    "build",
    "--build-arg",
    "REGISTRY=docker.io",
    "--build-context",
    `app=${join(repoRoot, "hosts/task-report/app")}`,
    "--build-context",
    `evaluator=${join(repoRoot, "packages/host-task-report")}`,
    "--build-context",
    `launcher=${join(repoRoot, "kit/umami/bin")}`,
    "-t",
    tag,
    join(repoRoot, "kit/task-report"),
  ];
}

/** The copy's command inside the container, after the image's tini. */
export function copyCommand(options: { state: State; runId: string; purpose: "counted" | "smoke"; overrides: readonly string[] }): string[] {
  return ["/opt/rbw/bin/rbw-copy", "--state", options.state, "--run-id", options.runId, "--purpose", options.purpose, ...options.overrides];
}

function stateOf(value: string | undefined): State {
  const found = STATES.find((state) => state === value);
  if (found === undefined) throw new CliError("--state must be clean, buggy or fixed");
  return found;
}

async function build(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, strict: true, options: { tag: { type: "string" } } });
  const tag = values.tag ?? "";
  if (!TAG.test(tag)) throw new CliError("--tag must be rbw-task-report:<name>");
  const result = await exec("docker", buildArgs(tag, REPO_ROOT), { timeoutMs: 3_600_000, inherit: true });
  return result.code === 0 ? 0 : 1;
}

interface Derived {
  format: "rbw.task-report.derived-source.v1";
  state: State;
  entry_id: string;
  catalog_sha256: string;
  baseline_id: string;
  target_path: string;
  target_sha256: string;
}

/** Writes <out>/source and <out>/derive.json for one state of a catalog entry. */
export async function derive(state: State, out: string, entryId: string): Promise<Derived> {
  if (existsSync(out)) throw new CliError("the output directory must not exist yet");
  const { deriveState, loadCatalog, readBaselineTree } = await import("../catalog.ts");
  const baseline = loadBaseline();
  const catalog = loadCatalog();
  const entry = catalog.entries.find((candidate) => candidate.entry_id === entryId);
  if (entry === undefined) throw new CliError(`no catalog entry ${entryId}`);
  const tree = deriveState(entry, readBaselineTree(join(REPO_ROOT, baseline.source.path), baseline), state);
  const treeDir = join(out, "tree");
  for (const [path, bytes] of tree.files) {
    mkdirSync(dirname(join(treeDir, path)), { recursive: true });
    writeFileSync(join(treeDir, path), bytes);
  }
  const record: Derived = {
    format: "rbw.task-report.derived-source.v1",
    state,
    entry_id: entry.entry_id,
    catalog_sha256: catalog.sha256,
    baseline_id: baseline.baseline_id,
    target_path: entry.target_path,
    target_sha256: tree.target_sha256,
  };
  writeFileSync(join(out, "derive.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Runs one copy of the derived tree in <dir>/source; returns the container's exit status, or null. */
export async function copy(options: { image: string; runId: string; dir: string; purpose: "counted" | "smoke"; overrides: readonly string[] }): Promise<number | null> {
  const derived = JSON.parse(readFileSync(join(options.dir, "derive.json"), "utf8")) as Derived;
  const state = stateOf(derived.state);
  const treeDir = join(options.dir, "tree");
  if (!existsSync(treeDir)) throw new CliError("the directory has no derived tree");
  if (existsSync(join(options.dir, "records")) || existsSync(join(options.dir, "run.json"))) throw new CliError("the directory already holds a copy's records");
  const inspect = await exec("docker", ["image", "inspect", "--format", "{{.Id}}", options.image], { timeoutMs: 60_000 });
  if (inspect.code !== 0) throw new CliError(`image ${options.image} is not available`);
  const container = `${options.runId}-${state}`;
  const record: Record<string, unknown> = {
    format: "rbw.task-report.local-run.v1",
    run_id: options.runId,
    state,
    purpose: options.purpose,
    derived,
    image: options.image,
    image_id: inspect.stdout.trim(),
    container,
    resources: [...COPY_RESOURCES],
    data_sha256: loadData().sha256,
    protocol_sha256: loadProtocol().sha256,
    started_at: new Date().toISOString(),
  };
  const step = async (name: string, args: string[], timeoutMs: number): Promise<Exec> => {
    const result = await exec("docker", args, { timeoutMs, inherit: name === "start" });
    record[`${name}_exit`] = result.code;
    return result;
  };
  try {
    const created = await step("create", ["create", "--name", container, ...COPY_RESOURCES, options.image, ...copyCommand({ state, runId: options.runId, purpose: options.purpose, overrides: options.overrides })], 120_000);
    if (created.code !== 0) throw new CliError("docker create failed");
    const copied = await step("copy_in", ["cp", `${treeDir}/.`, `${container}:/workspace/app`], 120_000);
    if (copied.code !== 0) throw new CliError("docker cp into the container failed");
    const started = performance.now();
    const ran = await step("start", ["start", "--attach", container], COPY_OUTER_LIMIT_MS);
    record.duration_ms = Math.round(performance.now() - started);
    record.timed_out = ran.timed_out;
    if (ran.timed_out) await step("stop", ["stop", "--time", String(KILL_GRACE_S), container], 60_000);
    const inspected = await exec("docker", ["inspect", "--format", "{{.State.ExitCode}}", container], { timeoutMs: 60_000 });
    record.container_exit = inspected.code === 0 ? Number(inspected.stdout.trim()) : null;
    await step("copy_out", ["cp", `${container}:/var/lib/rbw/results/copy`, join(options.dir, "records")], 120_000);
  } finally {
    await step("remove", ["rm", "--force", container], 120_000);
    record.ended_at = new Date().toISOString();
    writeFileSync(join(options.dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
  }
  return typeof record.container_exit === "number" ? record.container_exit : null;
}

const COPY_OPTIONS = {
  image: { type: "string" },
  "run-id": { type: "string" },
  purpose: { type: "string" },
  instances: { type: "string" },
  "main-target": { type: "string" },
  "control-target": { type: "string" },
} as const;

function copyOptions(values: Partial<Record<keyof typeof COPY_OPTIONS, string>>): { image: string; runId: string; purpose: "counted" | "smoke"; overrides: string[] } {
  const image = values.image ?? "";
  if (!TAG.test(image)) throw new CliError("--image must be rbw-task-report:<name>");
  const runId = values["run-id"] ?? "";
  if (!RUN_ID.test(runId)) throw new CliError("--run-id must start with f3q-");
  const purpose = values.purpose ?? "counted";
  if (purpose !== "counted" && purpose !== "smoke") throw new CliError("--purpose must be counted or smoke");
  const overrides: string[] = [];
  for (const name of ["instances", "main-target", "control-target"] as const) {
    const value = values[name];
    if (value !== undefined) overrides.push(`--${name}`, value);
  }
  return { image, runId, purpose, overrides };
}

function evaluate(dirs: string[]): number {
  const copies = dirs.map((dir) => JSON.parse(readFileSync(join(dir, "records", "copy.json"), "utf8")) as CopySummary);
  const evaluation = evaluateProtocol(loadProtocol(), loadData(), copies);
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  return evaluation.verdict === "qualified" ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "build") return build(rest);
  if (command === "evaluate") return evaluate(rest);
  if (command === "derive") {
    const { values } = parseArgs({ args: rest, strict: true, options: { state: { type: "string" }, out: { type: "string" }, entry: { type: "string" } } });
    if (values.out === undefined) throw new CliError("--out is required");
    await derive(stateOf(values.state), resolve(values.out), values.entry ?? "task-report-f3-001");
    return 0;
  }
  if (command === "copy") {
    const { values } = parseArgs({ args: rest, strict: true, options: { ...COPY_OPTIONS, dir: { type: "string" } } });
    if (values.dir === undefined) throw new CliError("--dir is required");
    return (await copy({ ...copyOptions(values), dir: resolve(values.dir) })) === 0 ? 0 : 1;
  }
  if (command === "run") {
    const { values } = parseArgs({ args: rest, strict: true, options: { ...COPY_OPTIONS, state: { type: "string" }, out: { type: "string" }, entry: { type: "string" } } });
    if (values.out === undefined) throw new CliError("--out is required");
    const options = copyOptions(values);
    const dir = resolve(values.out);
    await derive(stateOf(values.state), dir, values.entry ?? "task-report-f3-001");
    return (await copy({ ...options, dir })) === 0 ? 0 : 1;
  }
  throw new CliError("usage: build | derive | copy | run | evaluate");
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`task-report runner: ${error instanceof Error ? error.message : "error"}\n`);
    process.exitCode = 2;
  }
}
