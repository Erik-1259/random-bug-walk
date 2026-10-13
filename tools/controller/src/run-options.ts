// The command line's job options, turned into JobInputs without running anything, so the tests can
// check what a `run` command would do. cli.ts parses the arguments and runs the job.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FamilyError, familyFor, newRunIds, raceLatency, runTag } from "@rbw/local-runner";
import type { FamilyId, RunIds } from "@rbw/local-runner";
import { CanonicalError, JOB_KIND_VALUES, RecordError, parseRecord, sha256Hex } from "@rbw/schema";
import type { JobKind } from "@rbw/schema";
import { GRADING_POLICY_ID } from "./attempt.ts";
import type { Backend, JobInputs } from "./controller.ts";
import { DEVELOPMENT, JUDGE } from "./limits.ts";
import type { LedgerTarget } from "./limits.ts";

export class UsageError extends Error {}

export type Values = Record<string, string | undefined>;

export function required(values: Values, name: string): string {
  const value = values[name];
  if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
  return value;
}

export function path(values: Values, name: string): string | null {
  const value = values[name];
  return value === undefined || value === "" ? null : resolve(value);
}

export const JOB_OPTIONS = {
  work: { type: "string" },
  image: { type: "string" },
  manifest: { type: "string" },
  terms: { type: "string" },
  "kit-stage": { type: "string" },
  "original-suite": { type: "string" },
  policy: { type: "string" },
  backend: { type: "string" },
  "sandbox-image": { type: "string" },
} as const;

/** The family options of run and attempt; proof has none, because its grader cases are the time-zone family's. */
export const FAMILY_OPTIONS = { family: { type: "string" }, "race-latency-ms": { type: "string" } } as const;

/** The bug family and its latency from the command line: none given is the time-zone family, as before. */
export function familyOptions(values: Values): { family?: FamilyId; raceLatencyMs?: number } {
  try {
    const family = familyFor(values.family);
    const latency = raceLatency(family, values["race-latency-ms"]);
    return { ...(values.family === undefined ? {} : { family: family.id }), ...(latency === null ? {} : { raceLatencyMs: latency }) };
  } catch (error) {
    if (error instanceof FamilyError) throw new UsageError(error.message);
    throw error;
  }
}

/** The `run` command's own options beyond JOB_OPTIONS, including the judge controller's. */
export const RUN_OPTIONS = {
  ...JOB_OPTIONS,
  ...FAMILY_OPTIONS,
  "job-kind": { type: "string" },
  fix: { type: "string" },
  name: { type: "string" },
  trials: { type: "string" },
  ledger: { type: "string" },
  ids: { type: "string" },
  "project-policy": { type: "string" },
  "judge-fixed": { type: "string" },
  "request-id": { type: "string" },
  prebuilt: { type: "string" },
  release: { type: "string" },
  "deadline-at": { type: "string" },
} as const;

/** The run options that only a factory or grade job takes; the judge controller refuses them. */
export const NOT_FOR_PREBUILT = ["trials", "ledger", "ids", "project-policy", "judge-fixed", "fix", "family", "race-latency-ms"] as const;

export type CommonInputs = Omit<JobInputs, "kind" | "name" | "trials" | "alternativeDir" | "ledger">;

export function common(values: Values): CommonInputs {
  const backend = values.backend ?? "sandbox";
  if (backend !== "sandbox" && backend !== "docker") throw new UsageError("--backend must be sandbox or docker");
  const sandboxImage = values["sandbox-image"] ?? null;
  if ((backend === "sandbox") !== (sandboxImage !== null)) throw new UsageError("--sandbox-image is required with --backend sandbox, and only with it");
  return {
    work: resolve(required(values, "work")),
    image: required(values, "image"),
    manifest: resolve(required(values, "manifest")),
    terms: resolve(required(values, "terms")),
    policy: path(values, "policy"),
    kitStage: resolve(required(values, "kit-stage")),
    originalSuite: path(values, "original-suite"),
    backend: backend satisfies Backend,
    sandboxImage,
  };
}

const TRIAL_ID = /^[a-z][a-z0-9-]*$/;

/** `--trials a,b`: a subset of the kind's trials (the controller refuses an unknown one); absent, every trial. */
export function parseTrials(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const ids = value.split(",");
  if (ids.some((id) => !TRIAL_ID.test(id))) throw new UsageError("--trials must be trial IDs separated by commas, such as fixed-01");
  if (new Set(ids).size !== ids.length) throw new UsageError("--trials names a trial twice");
  return ids;
}

/**
 * `--ledger development|judge`. Absent, a judge replay charges the judge allocation under the judge
 * slot and every other job the development pool and slot, as before. `development` is how solver
 * grades run judge_verify without taking the judge slot that live judges wait on.
 */
export function ledgerTarget(value: string | undefined, kind: JobKind): LedgerTarget {
  if (value === undefined) return kind === "judge_verify" ? JUDGE : DEVELOPMENT;
  if (value === "development") return DEVELOPMENT;
  if (value === "judge") {
    if (kind !== "judge_verify") throw new UsageError("--ledger judge is only for --job-kind judge_verify");
    return JUDGE;
  }
  throw new UsageError("--ledger must be development or judge");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXECUTION_LABELS = ["kit-check", "observe", "admission", "alternative-fix", "candidate-text"] as const;
const ID_KEYS = ["batch_id", "executions", "project_id", "release_id", "root_execution_id", "run_tag"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

/** A root's IDs as JSON (the local runner's RunIds), so every job of one root shares them. */
export function parseRunIds(bytes: Buffer): RunIds {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UsageError("--ids is not JSON");
  }
  if (!isRecord(data) || !sameKeys(data, ID_KEYS)) throw new UsageError(`--ids must hold exactly ${ID_KEYS.join(", ")}`);
  const { executions } = data;
  if (!isRecord(executions) || !sameKeys(executions, EXECUTION_LABELS)) throw new UsageError(`--ids executions must name exactly ${EXECUTION_LABELS.join(", ")}`);
  const uuids = [data.project_id, data.batch_id, data.root_execution_id, data.release_id, ...Object.values(executions)];
  if (!uuids.every((id) => typeof id === "string" && UUID.test(id))) throw new UsageError("--ids must hold lowercase UUIDs");
  if (data.run_tag !== runTag(data.root_execution_id as string)) throw new UsageError("--ids run_tag must be the root execution's run tag");
  return data as unknown as RunIds;
}

/** The placeholder project newRunIds names; a project policy never names it. */
const PLACEHOLDER_PROJECT_ID = newRunIds(() => "00000000-0000-4000-8000-000000000000").project_id;

/** `--project-policy`: a canonical ProjectPolicy record, recorded by its hash under the grading policy ID. */
export function projectPolicy(bytes: Buffer, ids: RunIds | null): { sha256: string; policy_id: string } {
  let policy;
  try {
    policy = parseRecord("ProjectPolicy", bytes);
  } catch (error) {
    if (error instanceof RecordError || error instanceof CanonicalError) throw new UsageError("--project-policy is not a canonical ProjectPolicy record");
    throw error;
  }
  if (policy.project_id === PLACEHOLDER_PROJECT_ID) throw new UsageError("--project-policy names the development placeholder project");
  if (ids?.project_id !== policy.project_id) throw new UsageError("--project-policy needs --ids naming the policy's project");
  return { sha256: sha256Hex(bytes), policy_id: GRADING_POLICY_ID };
}

/**
 * `--judge-fixed fixed|alternative_fix`: the code state judge_verify's fixed-01 grades. `fixed` grades
 * the reference fix, the clean file's bytes, which the alternative-fix layout cannot carry (the local
 * runner refuses an alternative fix equal to the clean file). Absent, the alternative fix, as before.
 */
export function judgeFixed(value: string | undefined, kind: JobKind): "fixed" | "alternative_fix" | null {
  if (value === undefined) return null;
  if (kind !== "judge_verify") throw new UsageError("--judge-fixed is only for --job-kind judge_verify");
  if (value !== "fixed" && value !== "alternative_fix") throw new UsageError("--judge-fixed must be fixed or alternative_fix");
  return value;
}

/** The job a `run` command (not the judge controller's prebuilt form) runs, from its parsed options. */
export function runJobInputs(values: Values): JobInputs {
  const kind = required(values, "job-kind");
  if (!(JOB_KIND_VALUES as readonly string[]).includes(kind)) throw new UsageError(`--job-kind must be one of ${JOB_KIND_VALUES.join(", ")}`);
  const jobKind = kind as JobKind;
  const inputs = common(values);
  const label = { kit_check: "kit-check", observe: "observe", admission: "admission", judge_verify: "judge" }[jobKind];
  const fix = path(values, "fix");
  if (fix !== null && jobKind !== "judge_verify") throw new UsageError("--fix is only for --job-kind judge_verify");
  const idsFile = path(values, "ids");
  const ids = idsFile === null ? null : parseRunIds(readFileSync(idsFile));
  const policyFile = path(values, "project-policy");
  const policy = policyFile === null ? null : projectPolicy(readFileSync(policyFile), ids);
  const graded = judgeFixed(values["judge-fixed"], jobKind);
  return {
    ...inputs,
    ...familyOptions(values),
    kind: jobKind,
    name: values.name ?? label,
    trials: parseTrials(values.trials),
    ...(fix === null ? {} : { alternativeDir: fix }),
    ledger: ledgerTarget(values.ledger, jobKind),
    ...(ids === null ? {} : { ids }),
    ...(policy === null ? {} : { projectPolicy: policy }),
    ...(graded === null ? {} : { judgeFixed: graded }),
  };
}
