// The grader proof (spec §9.2), on real copies through the controller. Its inputs are the small
// committed patches in proof/, each pinned by its hash in proof/inputs.json:
//   - valid fix: the fixed code state passes every added check (and the original suite);
//   - empty fix: the planted code with no change still fails as declared;
//   - attempted forgery: the planted code plus writes of a fake passing report and reward wherever
//     the app might write; its grade comes only from the verifier's records, which it cannot change;
//   - failed protected regrade: the valid fix's record set with its verifier records missing or
//     altered never imports as a pass.
// Two judge_verify jobs run three copies in all: planted-01 (empty fix) and fixed-01 (valid fix),
// then fixed-01 (forgery). The regrade re-imports copies of the first job's record set.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importJob, summaryBytes, trialSummaries } from "@rbw/local-runner";
import type { TrialSummary } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { runJob } from "./controller.ts";
import type { ControllerDeps, JobInputs, JobOutcome, JobStatus } from "./controller.ts";
import { DEVELOPMENT } from "./limits.ts";

export const PROOF_DIR = fileURLToPath(new URL("../proof/", import.meta.url));

export class ProofInputError extends Error {
  override name = "ProofInputError";
}

const CASES = ["valid_fix", "empty_fix", "forgery"] as const;
type InputCase = (typeof CASES)[number];

export interface ProofInput {
  patch: string;
  patch_text: string;
  patch_sha256: string;
  /** The target file after the patch is applied to the planted file. */
  result_sha256: string;
}

export interface ProofInputs {
  target_path: string;
  /** The planted file every patch applies to. */
  base_sha256: string;
  cases: Record<InputCase, ProofInput>;
  forgery_marker: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new ProofInputError(`inputs.json needs ${what}`);
  return value;
}

/** Reads proof/inputs.json and each patch it names, refusing any patch whose bytes differ from its pinned hash. */
export function loadProofInputs(dir: string): ProofInputs {
  const raw = JSON.parse(readFileSync(join(dir, "inputs.json"), "utf8")) as { target_path?: unknown; base_sha256?: unknown; cases?: Record<string, Record<string, unknown> | undefined>; forgery_marker?: unknown };
  const base = text(raw.base_sha256, "base_sha256");
  if (!SHA256.test(base)) throw new ProofInputError("base_sha256 must be a SHA-256");
  const cases = {} as Record<InputCase, ProofInput>;
  for (const name of CASES) {
    const entry = raw.cases?.[name];
    const patch = text(entry?.patch, `cases.${name}.patch`);
    if (patch.includes("/") || patch.startsWith(".")) throw new ProofInputError(`cases.${name}.patch must name a file beside inputs.json`);
    const pinned = text(entry?.patch_sha256, `cases.${name}.patch_sha256`);
    const result = text(entry?.result_sha256, `cases.${name}.result_sha256`);
    if (!SHA256.test(pinned) || !SHA256.test(result)) throw new ProofInputError(`cases.${name} needs SHA-256 hashes`);
    const bytes = readFileSync(join(dir, patch));
    if (sha256Hex(bytes) !== pinned) throw new ProofInputError(`${patch} hashes to ${sha256Hex(bytes)}, not its pinned ${pinned}`);
    cases[name] = { patch, patch_text: bytes.toString("utf8"), patch_sha256: pinned, result_sha256: result };
  }
  if (cases.empty_fix.patch_text !== "" || cases.empty_fix.result_sha256 !== base) throw new ProofInputError("the empty fix must be an empty patch that leaves the planted file");
  return { target_path: text(raw.target_path, "target_path"), base_sha256: base, cases, forgery_marker: text(raw.forgery_marker, "forgery_marker") };
}

export type ProofOptions = Omit<JobInputs, "kind" | "name" | "trials" | "alternativeDir" | "ledger"> & { proofDir: string };

export interface Regrade {
  tamper: "records_missing" | "records_altered";
  status: string | null;
  reason: string | null;
  code: string | null;
  passes: boolean;
}

export interface ProofCase {
  case: InputCase | "protected_regrade";
  patch_sha256: string;
  job: string;
  trial_id: string;
  expected: string;
  placed_sha256: string | null;
  observed: { status: string | null; added_verdict: string | null; original_executed: number | null; original_failed: number | null; marker_found?: boolean };
  regrades: Regrade[];
  ok: boolean;
}

export interface ProofResult {
  exitCode: number;
  cases: ProofCase[];
  jobs: { name: string; status: JobStatus }[];
  proofPath: string;
}

/** Writes a fix in the local runner's alternative-fix layout, so a judge_verify job grades it as fixed-01. */
function alternativeDir(dir: string, inputs: ProofInputs, input: ProofInput, description: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "alternative-fix.patch"), input.patch_text);
  const record = { base_sha256: inputs.base_sha256, description, patch: "alternative-fix.patch", result_sha256: input.result_sha256, target_path: inputs.target_path };
  writeFileSync(join(dir, "alternative-fix.json"), `${JSON.stringify(record, null, 2)}\n`);
  return dir;
}

function passes(trial: TrialSummary | undefined): boolean {
  return trial?.status === "complete" && trial.added_verdict === "match" && trial.original_executed > 0 && trial.original_failed === 0;
}

function trialOf(job: JobOutcome, trialId: string): TrialSummary | undefined {
  return job.summary.import.trials.find((trial) => trial.trial_id === trialId);
}

function placed(job: JobOutcome, trialId: string): string | null {
  return job.summary.copies.find((copy) => copy.trial_id === trialId)?.copy?.placed_sha256 ?? null;
}

function observed(trial: TrialSummary | undefined): ProofCase["observed"] {
  return { status: trial?.status ?? null, added_verdict: trial?.added_verdict ?? null, original_executed: trial?.original_executed ?? null, original_failed: trial?.original_failed ?? null };
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile());
}

/** Directories named `collected` under `dir`: what each copy brought back. */
function collectedDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.split("/").at(-1) === "collected")
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isDirectory());
}

/** Whether the forgery's marker appears in anything graded: the job's record set or what its copies brought back. */
function markerFound(job: JobOutcome, marker: string): boolean {
  const scanned = [...files(join(job.jobDir, "records")), ...collectedDirs(join(job.jobDir, "copies")).flatMap(files)];
  return scanned.some((path) => readFileSync(path).includes(marker));
}

/** Re-imports a copy of the valid fix's record set with fixed-01's verifier records removed or altered. */
function regrade(records: string, dir: string, tamper: Regrade["tamper"]): Regrade {
  const copy = join(dir, "records");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(records, copy, { recursive: true, verbatimSymlinks: true });
  const result = join(copy, "results", "fixed-01", "trial-result.json");
  if (tamper === "records_missing") {
    rmSync(result, { force: true });
  } else if (existsSync(result)) {
    const key = (JSON.parse(readFileSync(result, "utf8")) as { observations_key?: unknown }).observations_key;
    const target = typeof key === "string" && existsSync(join(copy, ...key.split("/"))) ? join(copy, ...key.split("/")) : result;
    writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from(" ")]));
  }
  const imported = importJob(copy, dir);
  const trial = trialSummaries(imported.evidence).find((item) => item.trial_id === "fixed-01");
  return { tamper, status: trial?.status ?? null, reason: trial?.reason ?? null, code: trial?.code ?? imported.refusal, passes: passes(trial) };
}

export async function runProof(options: ProofOptions, deps: ControllerDeps): Promise<ProofResult> {
  const { proofDir, ...job } = options;
  const inputs = loadProofInputs(proofDir);
  const staged = join(options.work, "proof-inputs");
  const validDir = alternativeDir(join(staged, "valid-fix"), inputs, inputs.cases.valid_fix, "Grader proof: the valid fix.");
  const forgeryDir = alternativeDir(join(staged, "forgery"), inputs, inputs.cases.forgery, "Grader proof: the attempted forgery, which keeps the planted bug.");
  const base = { ...job, kind: "judge_verify" as const, ledger: DEVELOPMENT };
  const fix = await runJob({ ...base, name: "proof-fix", trials: ["planted-01", "fixed-01"], alternativeDir: validDir }, deps);
  const forgery = await runJob({ ...base, name: "proof-forgery", trials: ["fixed-01"], alternativeDir: forgeryDir }, deps);

  const valid = trialOf(fix, "fixed-01");
  const empty = trialOf(fix, "planted-01");
  const forged = trialOf(forgery, "fixed-01");
  const marker = markerFound(forgery, inputs.forgery_marker);
  const validOk = passes(valid) && placed(fix, "fixed-01") === inputs.cases.valid_fix.result_sha256;
  const regrades = (["records_missing", "records_altered"] as const).map((tamper) => regrade(join(fix.jobDir, "records"), join(options.work, "proof", tamper), tamper));
  const cases: ProofCase[] = [
    {
      case: "valid_fix",
      patch_sha256: inputs.cases.valid_fix.patch_sha256,
      job: "proof-fix",
      trial_id: "fixed-01",
      expected: "passes every added check and the original suite",
      placed_sha256: placed(fix, "fixed-01"),
      observed: observed(valid),
      regrades: [],
      ok: validOk,
    },
    {
      case: "empty_fix",
      patch_sha256: inputs.cases.empty_fix.patch_sha256,
      job: "proof-fix",
      trial_id: "planted-01",
      expected: "the planted code fails the added checks exactly as declared (added verdict match against the planted vector)",
      placed_sha256: placed(fix, "planted-01"),
      observed: observed(empty),
      regrades: [],
      ok: empty?.status === "complete" && empty.added_verdict === "match" && placed(fix, "planted-01") === inputs.cases.empty_fix.result_sha256,
    },
    {
      case: "forgery",
      patch_sha256: inputs.cases.forgery.patch_sha256,
      job: "proof-forgery",
      trial_id: "fixed-01",
      expected: "graded only from the verifier's records: the planted failures reject it, and no forged file reaches the records",
      placed_sha256: placed(forgery, "fixed-01"),
      observed: { ...observed(forged), marker_found: marker },
      regrades: [],
      ok: forged?.status === "complete" && forged.added_verdict === "reject" && !passes(forged) && !marker && placed(forgery, "fixed-01") === inputs.cases.forgery.result_sha256,
    },
    {
      case: "protected_regrade",
      patch_sha256: inputs.cases.valid_fix.patch_sha256,
      job: "proof-fix",
      trial_id: "fixed-01",
      expected: "the valid fix's records, with fixed-01's verifier records missing or altered, import as incomplete or invalid, never as a pass",
      placed_sha256: placed(fix, "fixed-01"),
      observed: observed(valid),
      regrades,
      ok: validOk && regrades.every((item) => !item.passes && (item.status === "incomplete" || item.status === "invalid")),
    },
  ];
  const jobs = [fix, forgery].map((outcome) => ({ name: outcome.summary.job.name, status: outcome.status }));
  const proofPath = join(options.work, "proof.json");
  const exitCode = cases.every((item) => item.ok) && jobs.every((item) => item.status === "complete") ? 0 : 1;
  writeFileSync(
    proofPath,
    summaryBytes({
      schema_version: 1,
      label: "development_evidence",
      note: "The grader proof from the trusted controller: development evidence, not published; the planted bug and the forgery are synthetic.",
      inputs: { target_path: inputs.target_path, base_sha256: inputs.base_sha256, forgery_marker: inputs.forgery_marker },
      jobs,
      cases,
      ok: exitCode === 0,
    }),
  );
  return { exitCode, cases, jobs, proofPath };
}
