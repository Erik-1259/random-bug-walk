// stage: a terminal root's run directory as a publisher staging directory (design note section 7).
// It uses the web's paths and flattens each controller job directory below results/<execution>/,
// because the publisher refuses a UUID-shaped segment deeper than <category>/<execution>/. The
// issue, its check report, the phrase records and the writer and search recordings are never
// read: a factory root declares them withheld_private. Provider resource IDs go to a private
// redaction file outside the staging directory, for the publisher to replace.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRecord, encodeCanonical, parseCanonical, parseRecord, RecordError, CanonicalError } from "@rbw/schema";
import type { JobRequest, OmissionReason, RootRun, StagingOmissions } from "@rbw/schema";
import { ReleaseInputError } from "./errors.ts";

export const SYMPTOM_PATH = "generated/symptom.json";
export const CARD_PATH = "generated/card.json";
export const NOVELTY_PATH = "generated/novelty.json";
/** What a factory root holds privately until a release; none of it is ever read here. */
const WITHHELD = ["issue", "issue check report", "phrase records", "writer recordings", "search recordings"] as const;
const JOB_OUTPUTS = ["evidence.json", "decision.json", "summary.json"] as const;

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface StageOptions {
  /** The controller run directory: jobs/<name>/ per job. */
  run: string;
  rootRun: string;
  /** A new staging directory. */
  out: string;
  /** A new private file for the provider resource IDs, outside the staging directory and this repository. */
  redactionsOut: string;
  symptom?: string;
  card?: string;
  novelty?: string;
}

export type StageOutcome = { ok: true; files: number; redactions: number; omissions: StagingOmissions } | { ok: false; code: "root_not_terminal" };

interface JobSummary {
  job?: { name?: unknown; kind?: unknown; execution_id?: unknown; status?: unknown };
  status?: unknown;
  copies?: { child_resource_id?: unknown; copy?: { container?: unknown; sandbox?: { name?: unknown } } | null }[];
}

function read(path: string, code: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ReleaseInputError(code);
  }
}

function readJson(path: string, code: string): unknown {
  try {
    return JSON.parse(read(path, code).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ReleaseInputError(code);
    throw error;
  }
}

function canonicalFile(path: string, code: string): Uint8Array {
  try {
    return encodeCanonical(readJson(path, code));
  } catch (error) {
    if (error instanceof CanonicalError) throw new ReleaseInputError(code);
    throw error;
  }
}

function isInside(inner: string, outer: string): boolean {
  const a = resolve(inner);
  const b = resolve(outer);
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

/** Every regular file below a directory, as relative POSIX paths in sorted order. */
function walk(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const stats = lstatSync(join(dir, path));
    if (stats.isDirectory()) found.push(...walk(dir, path));
    else if (stats.isFile()) found.push(path);
    else throw new ReleaseInputError("run_special_file", path);
  }
  return found;
}

function requestOf(path: string): JobRequest | null {
  if (!existsSync(path)) return null;
  try {
    return parseRecord("JobRequest", read(path, "request_unreadable"));
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) throw new ReleaseInputError("request_invalid", path);
    throw error;
  }
}

/** Provider resource IDs a controller summary names: each copy's child resource, container and sandbox. */
function resourceIds(summary: JobSummary): string[] {
  const ids: unknown[] = [];
  for (const copy of summary.copies ?? []) ids.push(copy.child_resource_id, copy.copy?.container, copy.copy?.sandbox?.name);
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

interface StagedJob {
  name: string;
  executionId: string;
  kind: string;
  status: string;
}

function absentReason(root: RootRun): OmissionReason {
  if (root.outcome === "cancelled") return "run_cancelled";
  return root.outcome === "completed" ? "stage_skipped" : "stage_failed";
}

function report(root: RootRun, jobs: readonly StagedJob[], verdicts: ReadonlyMap<string, { verdict: string; classification: string }>): string {
  const lines = [
    `# Run ${root.root_execution_id}`,
    "",
    `Kind: ${root.kind}. Outcome: ${root.outcome ?? "-"}. The planted bug is synthetic.`,
    "",
    "| Job | Kind | Execution | Status | Outcome verdict | Classification |",
    "|---|---|---|---|---|---|",
    ...jobs.map((job) => {
      const decided = verdicts.get(job.executionId);
      return `| ${job.name} | ${job.kind} | ${job.executionId} | ${job.status} | ${decided?.verdict ?? "-"} | ${decided?.classification ?? "-"} |`;
    }),
    "",
  ];
  if (root.kind === "factory") lines.push("The issue, its check report, the phrase records and the writer and search recordings are private; a release publishes the issue, the check report and the writer's recordings.", "");
  return lines.join("\n");
}

/** Stages a terminal root. A root that is not terminal is refused, and nothing is written. */
export function stage(options: StageOptions): StageOutcome {
  let root: RootRun;
  try {
    root = parseRecord("RootRun", read(options.rootRun, "root_run_unreadable"));
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) throw new ReleaseInputError("root_run_invalid");
    throw error;
  }
  if (root.status !== "terminal") return { ok: false, code: "root_not_terminal" };
  if (existsSync(options.out)) throw new ReleaseInputError("out_exists");
  if (existsSync(options.redactionsOut)) throw new ReleaseInputError("redactions_exists");
  if (isInside(options.redactionsOut, options.out) || isInside(options.redactionsOut, repositoryRoot)) throw new ReleaseInputError("redactions_location");
  const factory = root.kind === "factory";
  const generated = { [SYMPTOM_PATH]: options.symptom, [CARD_PATH]: options.card, [NOVELTY_PATH]: options.novelty };
  if (!factory && Object.values(generated).some((path) => path !== undefined)) throw new ReleaseInputError("generated_for_factory_only");

  const files = new Map<string, Uint8Array>();
  const resources = new Set<string>();
  const jobs: StagedJob[] = [];
  const verdicts = new Map<string, { verdict: string; classification: string }>();
  const jobsDir = join(options.run, "jobs");
  for (const name of existsSync(jobsDir) ? readdirSync(jobsDir).sort() : []) {
    const base = join(jobsDir, name);
    if (!lstatSync(base).isDirectory()) continue;
    const summary = existsSync(join(base, "summary.json")) ? (readJson(join(base, "summary.json"), "summary_invalid") as JobSummary) : null;
    const fromRecords = requestOf(join(base, "records", "request.json"));
    const request = fromRecords ?? requestOf(join(base, "job", "request.json"));
    const executionId = request?.execution_id ?? (typeof summary?.job?.execution_id === "string" ? summary.job.execution_id : null);
    if (executionId === null) throw new ReleaseInputError("job_unidentified", name);
    if (!root.child_execution_ids.includes(executionId) || (request !== null && request.root_execution_id !== root.root_execution_id)) throw new ReleaseInputError("job_not_in_root", name);
    if (jobs.some((job) => job.executionId === executionId)) throw new ReleaseInputError("job_duplicate", name);
    const target = `results/${executionId}`;
    if (request !== null) {
      const jobDir = fromRecords === null ? join(base, "job") : join(base, "records");
      files.set(`${target}/request.json`, read(join(jobDir, "request.json"), "request_unreadable"));
      const expected = join(jobDir, ...request.expected_trials_key.split("/"));
      if (existsSync(expected)) files.set(`${target}/expected-trials.json`, read(expected, "expected_trials_unreadable"));
    }
    const results = join(base, "records", "results");
    if (existsSync(results)) for (const path of walk(results)) files.set(`${target}/${path}`, read(join(results, path), "record_unreadable"));
    for (const output of JOB_OUTPUTS) if (existsSync(join(base, output))) files.set(`${target}/${output}`, read(join(base, output), "job_output_unreadable"));
    if (summary !== null) for (const id of resourceIds(summary)) resources.add(id);
    if (existsSync(join(base, "decision.json"))) {
      const decision = readJson(join(base, "decision.json"), "decision_invalid") as { outcome_verdict?: unknown; comparison?: { classification?: unknown } | null };
      verdicts.set(executionId, { verdict: typeof decision.outcome_verdict === "string" ? decision.outcome_verdict : "-", classification: typeof decision.comparison?.classification === "string" ? decision.comparison.classification : "-" });
    }
    jobs.push({ name, executionId, kind: request?.kind ?? (typeof summary?.job?.kind === "string" ? summary.job.kind : "-"), status: typeof summary?.status === "string" ? summary.status : "-" });
  }

  const reason = absentReason(root);
  const entries: StagingOmissions["entries"] = [];
  if (factory) {
    for (const [path, source] of Object.entries(generated)) {
      if (source === undefined) {
        entries.push({ outcome: "not_produced", path, execution_id: root.root_execution_id, trial_id: null, reason });
        continue;
      }
      const bytes = canonicalFile(source, `${basename(path, ".json")}_invalid`);
      if (path === SYMPTOM_PATH) {
        try {
          assertRecord("ObservedSymptom", parseCanonical(bytes));
        } catch (error) {
          if (error instanceof RecordError) throw new ReleaseInputError("symptom_invalid");
          throw error;
        }
      }
      files.set(path, bytes);
    }
  }
  for (const executionId of root.child_execution_ids) {
    for (const output of JOB_OUTPUTS) {
      const path = `results/${executionId}/${output}`;
      if (!files.has(path)) entries.push({ outcome: "not_produced", path, execution_id: executionId, trial_id: null, reason });
    }
  }
  entries.sort((a, b) => ("path" in a && "path" in b ? (a.path < b.path ? -1 : 1) : 0));
  if (factory) entries.push(...WITHHELD.map(() => ({ outcome: "withheld_private" as const, execution_id: root.root_execution_id, trial_id: null, reason: "private_material" as const })));
  const omissions = assertRecord("StagingOmissions", { schema_version: 1, entries, redactions: [] });
  files.set("report.md", new TextEncoder().encode(report(root, jobs, verdicts)));

  // Written in a temporary directory beside the target and renamed, so a failure leaves nothing.
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  const staging = mkdtempSync(join(dirname(resolve(options.out)), ".rbw-stage-"));
  mkdirSync(dirname(resolve(options.redactionsOut)), { recursive: true, mode: 0o700 });
  const redactionsTemp = join(dirname(resolve(options.redactionsOut)), `.${basename(options.redactionsOut)}.tmp`);
  try {
    for (const [path, bytes] of files) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      writeFileSync(join(staging, path), bytes);
    }
    writeFileSync(join(staging, "omissions.json"), encodeCanonical(omissions));
    const lines = ["# Provider resource IDs for the publisher to replace; private, never published", ...[...resources].sort().map((id) => `provider_identifier\t${id}`), ""];
    writeFileSync(redactionsTemp, lines.join("\n"), { mode: 0o600, flag: "wx" });
    renameSync(staging, options.out);
    renameSync(redactionsTemp, options.redactionsOut);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(redactionsTemp, { force: true });
    throw error;
  }
  return { ok: true, files: files.size, redactions: resources.size, omissions };
}
