// The local qualification of the task-report entry under evaluator v2, in five steps:
//
//   node adapter/qualify.ts build --tag rbw-task-report:<name>      build the version 2 kit image for linux/amd64
//   node adapter/qualify.ts pin --tag rbw-task-report:<name>        pin that image in catalog/kit-image.v2.json
//   node adapter/qualify.ts prepare --out <new dir>                 adapter inputs, the three states, the copy plans
//   node adapter/qualify.ts run --dir <dir> [--smoke <copy ID>]     every copy plan through local Docker
//   node adapter/qualify.ts evaluate --dir <dir>                    collect, interpret and the verdict per state
//
// and the pin of a pushed build, for runners that pull the image by its repository digest:
//
//   node adapter/qualify.ts pin --registry <repository>@sha256:<digest>
//
// pin --tag records the local image ID, which the local runner checks; pin --registry records the
// manifest digest the registry serves, which the shared Docker runner and the Sandbox runner pull
// as <repository>@<digest>, and it pins only an amd64 image that Docker has under that digest.
//
// The qualification is of the pinned image, the one the catalog entry's environment and case ID
// name: prepare and evaluate read the kit image from the pin, and the runner refuses an image with
// another ID, so the image a qualification records is the image its copies ran. Without pin, the
// copies run the image pinned before, or fail setup where it is absent. prepare, run and evaluate
// need this package's dependencies (run hashes each copy's results with the shared results archive);
// build and pin use Node's built-ins only, so they run on a host where Docker is and the package is
// not installed.
//
// prepare builds the states the way the package harness will (see local-harness.ts) and asks the
// adapter for the copy plans; run passes each plan with its roots to the local Docker runner
// (buggy, then fixed, then clean); evaluate turns each collected copy into a copy record with the
// adapter's collect, combines each state's records with interpret, and records the cells, the
// verdict per state and, as a cross-check, the evaluation of the copies' record sets.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CollectedCopy, CopyPlan, CopyRecord, CopyState, UnpackedPair } from "./contract.ts";
import { IMAGE_INSPECT_FORMAT, KIT_IMAGE_FILE, KIT_IMAGE_FORMAT, parseKitImage } from "./kit.ts";
import type { KitImagePin } from "./kit.ts";

export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = resolve(PACKAGE_DIR, "../..");
const TAG = /^rbw-task-report:[a-z0-9][a-z0-9._-]{0,63}$/;
/** Docker's grammar for one path component of a repository name, and for a registry host with an optional port. */
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const REGISTRY_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]+)?$/;
const SMOKE_ID = /^f3q2-smoke-[a-z0-9][a-z0-9-]{0,40}$/;
const RUN_ORDER: readonly CopyState[] = ["buggy", "fixed", "clean"];

/** The platform every kit image build targets: the hosted copies run linux/amd64 only. */
export const BUILD_PLATFORM = "linux/amd64";

/** How pin --registry reads an image: its ID, architecture and repository digests (`json`, as the shared Docker runner reads them). */
export const REGISTRY_INSPECT_FORMAT = "{{.Id}} {{.Architecture}} {{json .RepoDigests}}";

export class QualifyError extends Error {
  override name = "QualifyError";
}

/** Where qualify.ts finds Docker and the kit image pin; tests replace both. */
export interface QualifyOptions {
  docker?: string;
  kitImageFile?: string;
}

/** A pushed image: its repository, without a tag, and the manifest digest the registry serves. */
export interface RegistryReference {
  repository: string;
  digest: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildArgsV2(tag: string, repoRoot: string): string[] {
  return [
    "build",
    "--platform",
    BUILD_PLATFORM,
    "-f",
    join(repoRoot, "kit/task-report/v2/Dockerfile"),
    "--build-arg",
    "REGISTRY=docker.io",
    "--build-context",
    `app=${join(repoRoot, "hosts/task-report/app")}`,
    "--build-context",
    `launcher=${join(repoRoot, "kit/umami/bin")}`,
    "-t",
    tag,
    join(repoRoot, "kit/task-report"),
  ];
}

function build(docker: string, tag: string): Promise<number> {
  if (!TAG.test(tag)) throw new QualifyError("--tag must be rbw-task-report:<name>");
  return new Promise((resolvePromise) => {
    const child = spawn(docker, buildArgsV2(tag, REPO_ROOT), { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", () => {
      resolvePromise(1);
    });
    child.once("close", (code) => {
      resolvePromise(code === 0 ? 0 : 1);
    });
  });
}

/**
 * Writes the kit image pin of a local image from its `docker image inspect` line (the image ID and
 * architecture, in the runner's format); refuses, before writing, an image it cannot identify.
 */
export function writeKitImagePin(file: string, reference: string, inspected: string): KitImagePin {
  const [digest, architecture] = inspected.trim().split(/\s+/);
  const kit = parseKitImage({ format: KIT_IMAGE_FORMAT, reference, digest, architecture });
  writeJson(file, {
    format: KIT_IMAGE_FORMAT,
    ...kit,
    built_from: `kit/task-report/v2/Dockerfile, for linux/${kit.architecture} on local Docker`,
    note: "Pinned by qualify.ts pin --tag from the local image's ID and architecture. qualify.ts pin --registry replaces it with the manifest digest of a pushed amd64 build; a new pin changes the environment hash and with it the case ID.",
  });
  return kit;
}

/**
 * Reads `--registry <repository>@sha256:<digest>`: a registry repository (a registry host or a
 * namespace, then the name, in Docker's grammar and lowercase) without a tag, and the manifest digest.
 */
export function parseRegistryReference(value: string): RegistryReference {
  const match = /^([^@]+)@(sha256:[0-9a-f]{64})$/.exec(value);
  const repository = match?.[1];
  const digest = match?.[2];
  if (repository === undefined || digest === undefined) throw new QualifyError("--registry must be <repository>@sha256:<digest>, the pushed image's manifest digest");
  const components = repository.split("/");
  const [first = "", ...rest] = components;
  const name = components[components.length - 1] ?? "";
  if (rest.length > 0 && name.includes(":")) throw new QualifyError("--registry must name the repository without a tag; the digest names the image");
  if (rest.length === 0 || repository.length > 256 || !(PATH_COMPONENT.test(first) || REGISTRY_HOST.test(first)) || !rest.every((component) => PATH_COMPONENT.test(component))) {
    throw new QualifyError("--registry must name a registry repository, <registry or namespace>/<name>, in lowercase");
  }
  return { repository, digest };
}

/** A name as Docker reports it for Docker Hub: without `docker.io/` and, for official images, `library/`. */
function familiarName(name: string): string {
  const hub = /^(?:docker\.io|index\.docker\.io)\/(.*)$/.exec(name)?.[1];
  return hub === undefined ? name : hub.replace(/^library\//, "");
}

/** The repository digests of an inspect answer, where Docker answers `null` for an image with none; null when the answer is not a list of names. */
function parseRepoDigests(text: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An answer that is not the format's shape is no usable image; the caller refuses it.
    return null;
  }
  if (parsed === null) return [];
  return Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string") ? parsed : null;
}

/**
 * Writes the kit image pin of a pushed image from its `docker image inspect` line in
 * REGISTRY_INSPECT_FORMAT: the repository and the manifest digest, with architecture amd64. Refuses,
 * before writing, an answer it cannot read, an image that is not amd64 and an image whose repository
 * digests do not include the pinned one.
 */
export function writeRegistryPin(file: string, registry: RegistryReference, inspected: string): KitImagePin {
  const pushed = `${registry.repository}@${registry.digest}`;
  const [id = "", architecture = "", ...rest] = inspected.trim().split(" ");
  const repoDigests = parseRepoDigests(rest.join(" "));
  if (!/^sha256:[0-9a-f]{64}$/.test(id) || architecture === "" || repoDigests === null) {
    throw new QualifyError(`Docker's answer for ${pushed} is not an image ID, architecture and repository digests`);
  }
  if (architecture !== "amd64") throw new QualifyError(`image ${pushed} is for ${architecture}, not amd64`);
  if (!repoDigests.some((item) => familiarName(item) === familiarName(pushed))) throw new QualifyError(`${pushed} is not one of the image's repository digests`);
  const kit = parseKitImage({ format: KIT_IMAGE_FORMAT, reference: registry.repository, digest: registry.digest, architecture });
  writeJson(file, {
    format: KIT_IMAGE_FORMAT,
    ...kit,
    built_from: "kit/task-report/v2/Dockerfile for linux/amd64, pushed to the reference's registry",
    note: "Pinned by qualify.ts pin --registry from the pushed image's manifest digest; runners run <reference>@<digest>. A new pin changes the environment hash and with it the case ID.",
  });
  return kit;
}

function inspectImage(docker: string, reference: string, format: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(docker, ["image", "inspect", "--format", format, reference], { stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => {
      resolvePromise(null);
    });
    child.once("close", (code) => {
      resolvePromise(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}

async function pin(docker: string, file: string, tag: string): Promise<number> {
  if (!TAG.test(tag)) throw new QualifyError("--tag must be rbw-task-report:<name>");
  const inspected = await inspectImage(docker, tag, IMAGE_INSPECT_FORMAT);
  if (inspected === null) throw new QualifyError(`image ${tag} is not available`);
  process.stdout.write(`${JSON.stringify(writeKitImagePin(file, tag, inspected), null, 2)}\n`);
  return 0;
}

async function pinRegistry(docker: string, file: string, value: string): Promise<number> {
  const registry = parseRegistryReference(value);
  const pushed = `${registry.repository}@${registry.digest}`;
  const inspected = await inspectImage(docker, pushed, REGISTRY_INSPECT_FORMAT);
  if (inspected === null) throw new QualifyError(`image ${pushed} is not available; pull it with docker pull --platform ${BUILD_PLATFORM} ${pushed}`);
  process.stdout.write(`${JSON.stringify(writeRegistryPin(file, registry, inspected), null, 2)}\n`);
  return 0;
}

async function prepare(out: string): Promise<number> {
  if (existsSync(out)) throw new QualifyError("the output directory must not exist yet");
  mkdirSync(out, { recursive: true });
  const { createTaskReportAdapter } = await import("./adapter.ts");
  const { buildLocalPair } = await import("./local-harness.ts");
  const adapter = createTaskReportAdapter({ workDir: join(out, "work") });
  const [entry] = adapter.catalog();
  if (entry === undefined) throw new QualifyError("the catalog has no entry");
  const bug = await adapter.bugCaseInputs(entry);
  const validator = await adapter.validatorInputs(entry);
  const pair = buildLocalPair(join(out, "pair"), bug, validator);
  const protocol = adapter.protocol(entry);
  const plans = RUN_ORDER.flatMap((state) => adapter.copyPlans(state, pair, protocol));
  writeJson(join(out, "inputs.json"), { format: "rbw.task-report.local-inputs.v2", catalog_entry: entry, bug_case: bug, validator, protocol });
  writeJson(join(out, "pair.json"), pair);
  writeJson(join(out, "plans.json"), { plans });
  process.stdout.write(`${JSON.stringify({ entry_id: entry.entry_id, pair_sha256: pair.pair_sha256, copies: plans.map((plan) => ({ copy_id: plan.copy_id, state: plan.state, files: plan.files.length, evaluator_files: plan.evaluator_files.length })) }, null, 2)}\n`);
  return 0;
}

function rootsFor(pair: UnpackedPair, plan: CopyPlan): { app_root: string; evaluator_root: string } {
  return { app_root: pair.states[plan.state].root, evaluator_root: pair.evaluator.root };
}

async function run(dir: string, smoke: string | undefined): Promise<number> {
  const { createLocalDockerRunner } = await import("./local-runner.ts");
  const pair = readJson(join(dir, "pair.json")) as UnpackedPair;
  const { plans } = readJson(join(dir, "plans.json")) as { plans: CopyPlan[] };
  const log = (message: string): void => {
    process.stderr.write(`qualify: ${message}\n`);
  };
  if (smoke !== undefined) {
    if (!SMOKE_ID.test(smoke)) throw new QualifyError("--smoke must be a copy ID f3q2-smoke-<name>");
    const clean = plans.find((plan) => plan.state === "clean");
    if (clean === undefined) throw new QualifyError("no clean plan");
    const entry = clean.command[clean.command.indexOf("--entry") + 1] ?? "";
    const plan: CopyPlan = { ...clean, copy_id: smoke, command: [clean.command[0] ?? "", "--state", "clean", "--copy-id", smoke, "--entry", entry, "--purpose", "smoke", "--instances", "1", "--main-target", "2", "--control-target", "1"] };
    const runner = createLocalDockerRunner({ outDir: join(dir, "smoke"), log });
    const collected = await runner.run(plan, rootsFor(pair, plan));
    writeJson(join(dir, "smoke", `${smoke}.json`), { plan, collected });
    return collected.outcome === "ran" && collected.exit_code === 0 ? 0 : 1;
  }
  if (existsSync(join(dir, "collected.json"))) throw new QualifyError("the directory already holds collected copies");
  const runner = createLocalDockerRunner({ outDir: join(dir, "copies"), log });
  const collected: CollectedCopy[] = [];
  for (const plan of plans) {
    log(`${plan.copy_id}: ${plan.state}`);
    collected.push(await runner.run(plan, rootsFor(pair, plan)));
    writeJson(join(dir, "collected.json"), { collected });
  }
  return collected.every((item) => item.outcome === "ran") ? 0 : 1;
}

async function evaluate(dir: string): Promise<number> {
  const { createTaskReportAdapter, recordFileKind } = await import("./adapter.ts");
  const { validateContract } = await import("@rbw/factory-contract/validate");
  const { evaluateProtocolV2, overallVerdict, stateVerdict, EXPECTED_CELLS } = await import("../v2/evaluate.ts");
  const { loadProtocolV2 } = await import("../v2/protocol.ts");
  const { loadData } = await import("../src/f3/data.ts");
  const { loadBaseline } = await import("../src/baseline.ts");
  const { loadCatalogPins } = await import("../v2/entry.ts");
  const { stateExpectation } = await import("../v2/expected.ts");
  const { parseCopySummaryV2 } = await import("../v2/record.ts");
  const adapter = createTaskReportAdapter({ workDir: join(dir, "work-evaluate") });
  const [entry] = adapter.catalog();
  if (entry === undefined) throw new QualifyError("the catalog has no entry");
  const protocol = adapter.protocol(entry);
  const { plans } = readJson(join(dir, "plans.json")) as { plans: CopyPlan[] };
  const { collected } = readJson(join(dir, "collected.json")) as { collected: CollectedCopy[] };
  const records: CopyRecord[] = [];
  for (const plan of plans) {
    const copy = collected.find((item) => item.copy_id === plan.copy_id);
    if (copy === undefined) throw new QualifyError(`no collected copy ${plan.copy_id}`);
    records.push(await adapter.collect(plan, copy));
  }
  const schemaErrors = records.flatMap((record) => validateContract("CopyRecord", record).map((code) => `${record.copy_id}: ${code}`));
  const v2 = loadProtocolV2();
  const cells = {} as Record<CopyState, ReturnType<typeof adapter.interpret>>;
  const verdicts = {} as Record<CopyState, ReturnType<typeof stateVerdict>>;
  for (const state of ["clean", "buggy", "fixed"] as const) {
    cells[state] = adapter.interpret(records.filter((record) => record.state === state), protocol);
    verdicts[state] = stateVerdict(v2, state, cells[state]);
    schemaErrors.push(...validateContract("CellObservation", cells[state].original_suite), ...validateContract("CellObservation", cells[state].verification));
  }
  const { RecordError } = await import("../v2/record.ts");
  const unreadable: string[] = [];
  const summaries = collected.flatMap((copy) => {
    if (copy.results_dir === null) return [];
    const file = join(copy.results_dir, "copy.json");
    const kind = recordFileKind(file);
    if (kind === "absent") return [];
    if (kind === "other") {
      unreadable.push(copy.copy_id);
      return [];
    }
    try {
      return [parseCopySummaryV2(readJson(file))];
    } catch (error) {
      if (!(error instanceof RecordError) && !(error instanceof SyntaxError)) throw error;
      unreadable.push(copy.copy_id);
      return [];
    }
  });
  const expectation = stateExpectation(loadBaseline(), loadCatalogPins(), entry.entry_id);
  const crossCheck = evaluateProtocolV2(v2, loadData(), expectation, summaries);
  const matrix = (["original_suite", "verification"] as const).map((set) => ({
    check_set: set,
    cells: (["clean", "buggy", "fixed"] as const).map((state) => ({ state, expected: EXPECTED_CELLS[set][state], observed: cells[state][set].observed, failure_codes: cells[state][set].failure_codes, runs_valid: cells[state][set].runs_valid, runs_total: cells[state][set].runs_total })),
  }));
  // The verdict comes from the adapter's collect and interpret alone; the cross-check evaluates the
  // copies' record sets directly and is recorded beside it, with whether the two agree.
  const verdict = overallVerdict([verdicts.clean, verdicts.buggy, verdicts.fixed]);
  const result = {
    format: "rbw.task-report.qualification.v2",
    entry_id: entry.entry_id,
    protocol: { protocol_id: protocol.protocol_id, version: protocol.version, sha256: protocol.sha256 },
    check_set_sha256: entry.verification.check_set_sha256,
    environment: entry.environment,
    verdict,
    verdicts,
    matrix,
    records,
    cross_check: crossCheck,
    cross_check_unreadable: unreadable,
    cross_check_agrees: crossCheck.verdict === verdict && (["clean", "buggy", "fixed"] as const).every((state) => crossCheck.states.find((item) => item.state === state)?.verdict === verdicts[state]),
    schema_errors: schemaErrors,
  };
  writeJson(join(dir, "qualification.json"), result);
  process.stdout.write(`${JSON.stringify({ verdict, verdicts, matrix, cross_check: crossCheck.verdict, cross_check_agrees: result.cross_check_agrees, schema_errors: schemaErrors.length }, null, 2)}\n`);
  return verdict === "qualified" && result.cross_check_agrees && schemaErrors.length === 0 ? 0 : 1;
}

export async function main(argv: string[], options: QualifyOptions = {}): Promise<number> {
  const docker = options.docker ?? "docker";
  const kitImageFile = options.kitImageFile ?? KIT_IMAGE_FILE;
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, strict: true, options: { tag: { type: "string" }, registry: { type: "string" }, out: { type: "string" }, dir: { type: "string" }, smoke: { type: "string" } } });
  if (command === "build") return build(docker, values.tag ?? "");
  if (command === "pin") {
    if (values.tag !== undefined && values.registry !== undefined) throw new QualifyError("pin takes --tag or --registry, not both");
    if (values.registry !== undefined) return pinRegistry(docker, kitImageFile, values.registry);
    if (values.tag === undefined) throw new QualifyError("pin needs --tag rbw-task-report:<name> or --registry <repository>@sha256:<digest>");
    return pin(docker, kitImageFile, values.tag);
  }
  if (command === "prepare") {
    if (values.out === undefined) throw new QualifyError("--out is required");
    return prepare(resolve(values.out));
  }
  if (command === "run") {
    if (values.dir === undefined) throw new QualifyError("--dir is required");
    return run(resolve(values.dir), values.smoke);
  }
  if (command === "evaluate") {
    if (values.dir === undefined) throw new QualifyError("--dir is required");
    return evaluate(resolve(values.dir));
  }
  throw new QualifyError("usage: build | pin | prepare | run | evaluate");
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`qualify: ${error instanceof Error ? `${error.name}: ${error.message}` : "error"}\n`);
    process.exitCode = 2;
  }
}
