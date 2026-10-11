// What the judge route and the judge controller share (design note section 6): the replay's IDs,
// derived from the browser's request ID; the controller's operation, which the route reserves and
// the controller closes; the private store's judge/<root>/ layout and progress.json; the
// controller sandbox's launch; and the hold. The judge web routes import this module, so it
// imports only small modules: no runner, no driver, no PGlite. judge.ts adds the replay's verdict.
import { createHash } from "node:crypto";
import { parseRateSheet, toReserveRequest } from "@rbw/envelope";
import { runTag, utcSeconds } from "@rbw/local-runner/shared";
import { TRIAL_PROFILES, callName, canonicalDigest, encodeCanonical, operationId, parseCanonical, providerCallIdentity } from "@rbw/schema";
import type { Release, RootRun } from "@rbw/schema";
import type { UsageSettlement } from "@rbw/spend";
import { controllerEnvelope, judgeReservation } from "./envelope.ts";
import type { CopyEnvelope } from "./envelope.ts";
import type { JudgeControllerCreateParams, JudgeIds, JudgeLaunch, JudgeOperation, JudgeRelease, JudgeSandboxInstance, JudgeSandboxSdk, JudgeStart, ProgressState, ReplayProgress } from "./judge-types.ts";
import { JOB_LIMITS, JUDGE, PARENT_MARGIN_MS } from "./limits.ts";

export { controllerEnvelope, judgeReservation, parseRateSheet };
export type * from "./judge-types.ts";
export { KNOWN_CONDITION_MESSAGE } from "./judge-types.ts";
export { databaseLedger } from "./database-ledger.ts";
export { JUDGE as JUDGE_POOL } from "./limits.ts";
export type { Ledger } from "./database-ledger.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The fixed namespace of the replay's UUIDv5 IDs. */
export const JUDGE_NAMESPACE = "6b3c1f0e-2a4d-5c8e-9f71-0d2e4a6c8b1f";
/** The controller's job directory name: run/jobs/judge/. */
export const JUDGE_JOB_NAME = "judge";
export const CONTROLLER_KIND = "sandbox.controller";
/** The controller sandbox's provider timeout: the judge job's whole controller deadline. */
export const CONTROLLER_TIMEOUT_MS = JOB_LIMITS.judge_verify.controller_ms;
export const JUDGE_TRIALS: readonly string[] = TRIAL_PROFILES.judge_verify.trials.map((trial) => trial.trial_id);

function uuidV5(name: string): string {
  const namespace = Buffer.from(JUDGE_NAMESPACE.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(namespace).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The replay's root, batch and judge_verify execution: UUIDv5s of the request ID under a fixed namespace. */
export function judgeIds(requestId: string): JudgeIds {
  if (!UUID.test(requestId)) throw new Error("the request ID is not a lowercase UUID");
  return { root: uuidV5(`root:${requestId}`), batch: uuidV5(`batch:${requestId}`), execution: uuidV5(`execution:${requestId}`) };
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The replay's objects in the private store. */
export function judgeKeys(root: string): { prefix: string; rootRun: string; progress: string; run: string } {
  const prefix = `judge/${root}/`;
  return { prefix, rootRun: `${prefix}root-run.json`, progress: `${prefix}progress.json`, run: `${prefix}run/` };
}

export function controllerSandboxName(root: string): string {
  return `rbw-${runTag(root)}-judge-controller`;
}

/** The deadline the controller is given: the create time plus the sandbox's timeout, less the time for the summary and upload. */
export function judgeDeadlineMs(createdMs: number): number {
  return createdMs + CONTROLLER_TIMEOUT_MS - PARENT_MARGIN_MS;
}

export function judgeRelease(release: Release): JudgeRelease {
  const [revision] = release.revisions;
  if (revision === undefined) throw new Error("the release names no task revision");
  return {
    release_id: release.release_id,
    created_at: release.created_at,
    project_id: release.project_id,
    project_policy_sha256: release.project_policy_sha256,
    task_revision: revision.sha256,
    controller_image: release.images.controller_image,
    kit_image: release.images.kit_image,
    judge_job: release.judge_job,
  };
}

/** The controller sandbox's operation. The route reserves and launches it; the controller ends and settles it. */
export function judgeOperation(requestId: string, release: JudgeRelease, envelope: CopyEnvelope): JudgeOperation {
  const ids = judgeIds(requestId);
  const call = callName(CONTROLLER_KIND, JUDGE_JOB_NAME, ids.root);
  const identity = providerCallIdentity({
    project_id: release.project_id,
    project_policy_sha256: release.project_policy_sha256,
    root_execution_id: ids.root,
    batch_id: ids.batch,
    task_revision: release.task_revision,
    kind: CONTROLLER_KIND,
    runtime_profile_sha256: envelope.runtime_profile_sha256,
    attempt_ordinal: 1,
    call_name: call,
  });
  const id = operationId(identity).sha256;
  const payload = canonicalDigest({ release_id: release.release_id, image: release.controller_image, judge_job: release.judge_job, envelope: envelope.lines }).sha256;
  const sandbox = controllerSandboxName(ids.root);
  const request = toReserveRequest(envelope, {
    operation_id: id,
    payload_hash: payload,
    attempt_ordinal: 1,
    previous_operation_id: null,
    project_id: release.project_id,
    project_policy_sha256: release.project_policy_sha256,
    batch_id: ids.batch,
    task_revision: release.task_revision,
    root_execution_id: ids.root,
    execution_id: ids.root,
    parent_execution_id: null,
    kind: CONTROLLER_KIND,
    call_name: call,
    provider: "vercel-sandbox",
    provider_replay_key: sandbox,
    pool_key: JUDGE.pool_key,
    allocation_key: JUDGE.allocation_key,
  });
  return { call_name: call, operation_id: id, payload_hash: payload, sandbox_name: sandbox, request };
}

/** The controller's settlement in full: every line at its whole limit. The controller cannot measure its own sandbox's end. */
export function controllerSettlement(envelope: CopyEnvelope, operationId: string): UsageSettlement {
  return {
    schema_version: 1,
    operation_id: operationId,
    runtime_profile_sha256: envelope.runtime_profile_sha256,
    rate_sheet_sha256: envelope.rate_sheet_sha256,
    reserved_microusd: Number(envelope.reserved_microusd),
    service_lines: envelope.lines.map((line) => {
      if (line.price === null) throw new Error("a checked price is missing");
      const actual = (BigInt(line.limit) * BigInt(line.price.microusd) + BigInt(line.price.per_units) - 1n) / BigInt(line.price.per_units);
      return { service: line.service, unit: line.unit, actual_quantity: line.limit, actual_microusd: Number(actual), retained_microusd: 0 };
    }),
    usage_state: "known",
    terminal_evidence_key: null,
    terminal_evidence_sha256: null,
  };
}

/** The root of a replay, as root-run.json holds it. */
export function replayRootRun(release: Pick<JudgeRelease, "project_id" | "project_policy_sha256">, requestId: string, status: RootRun["status"], outcome: RootRun["outcome"]): RootRun {
  const ids = judgeIds(requestId);
  return {
    schema_version: 1,
    project_id: release.project_id,
    root_execution_id: ids.root,
    project_policy_sha256: release.project_policy_sha256,
    kind: "judge_replay",
    declared_stages: ["judge_verify"],
    child_execution_ids: [ids.execution],
    status,
    outcome,
  };
}

/** A root-run.json's canonical bytes. */
export function encodeRecord(record: RootRun): Uint8Array {
  return encodeCanonical(record);
}

const PROGRESS_STATES: readonly ProgressState[] = ["starting", "running", "verified", "not_reproduced", "incomplete", "needs_reconciliation"];
export function newProgress(root: string, createdMs: number, deadlineMs: number): ReplayProgress {
  return {
    schema_version: 1,
    root_execution_id: root,
    created_at: utcSeconds(createdMs),
    deadline_at: utcSeconds(deadlineMs),
    state: "starting",
    known_condition: null,
    copies: JUDGE_TRIALS.map((trial_id) => ({ trial_id, status: "not_started", started_at: null })),
    ended_at: null,
  };
}

export function progressBytes(progress: ReplayProgress): Uint8Array {
  return encodeCanonical(progress);
}

const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** Reads progress.json; throws on anything that is not one. */
export function parseProgress(bytes: Uint8Array): ReplayProgress {
  const value = parseCanonical(bytes) as Partial<Record<keyof ReplayProgress, unknown>>;
  const copies = value.copies;
  const ok =
    value.schema_version === 1 &&
    typeof value.root_execution_id === "string" &&
    UUID.test(value.root_execution_id) &&
    isTime(value.created_at) &&
    isTime(value.deadline_at) &&
    PROGRESS_STATES.includes(value.state as ProgressState) &&
    (value.known_condition === null || typeof value.known_condition === "boolean") &&
    (value.ended_at === null || isTime(value.ended_at)) &&
    Array.isArray(copies) &&
    copies.every(
      (copy: { trial_id?: unknown; status?: unknown; started_at?: unknown }) =>
        typeof copy.trial_id === "string" && ["not_started", "running", "done"].includes(String(copy.status)) && (copy.started_at === null || isTime(copy.started_at)),
    );
  if (!ok) throw new Error("progress.json is not a replay's progress");
  return value as ReplayProgress;
}

/**
 * The hold: over the replays created after `clearedAt`, in created_at order, ignoring incomplete,
 * needs_reconciliation and unfinished ones, the last two are not_reproduced.
 */
export function holdActive(replays: readonly ReplayProgress[], clearedAt: string | null): boolean {
  const after = clearedAt === null ? -Infinity : Date.parse(clearedAt);
  const counted = replays
    .filter((replay) => Date.parse(replay.created_at) > after && (replay.state === "verified" || replay.state === "not_reproduced"))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const last = counted.slice(-2);
  return last.length === 2 && last.every((replay) => replay.state === "not_reproduced");
}

/** When a JWT expires, in milliseconds, or null when it names no expiry. The token is not verified: it is the platform's own. */
export function tokenExpiresMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

// The controller sandbox. SandboxCreateParams in the local runner is a copy's (no network, no
// environment), so the controller has its own: network allowed, and the credentials as
// create-time environment values (`env` in @vercel/sandbox 3.5.1's BaseCreateSandboxParams).

/** Where the controller image holds this repository (tools/controller/Dockerfile). */
export const CONTROLLER_REPOSITORY = "/opt/rbw/repo";
const NODE = "/usr/local/bin/node";
/** The image's PATH, which the sandbox does not apply by itself; git (for the planted copy's audit) is found through it. */
const BASE_ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" };
export const RELEASE_PATH = "/tmp/rbw-judge/release.json";

export function judgeControllerParams(launch: JudgeLaunch): JudgeControllerCreateParams {
  return {
    image: launch.release.images.controller_image,
    name: controllerSandboxName(judgeIds(launch.requestId).root),
    persistent: false,
    networkPolicy: "allow-all",
    resources: { vcpus: JUDGE_CONTROLLER_VCPUS },
    timeout: CONTROLLER_TIMEOUT_MS,
    env: { ...BASE_ENV, ...launch.env },
  };
}

const JUDGE_CONTROLLER_VCPUS = 2;

/** Creates the controller sandbox, writes the release into it and starts one detached controller run; it does not wait for the run. Nothing is retried. */
export async function startJudgeController(sdk: JudgeSandboxSdk, launch: JudgeLaunch): Promise<JudgeStart> {
  const params = judgeControllerParams(launch);
  let sandbox: JudgeSandboxInstance;
  try {
    sandbox = await sdk.create(params);
  } catch (error) {
    return { ok: false, created: null, detail: error instanceof Error ? error.name : "create_failed" };
  }
  try {
    await sandbox.writeFiles([{ path: RELEASE_PATH, content: launch.releaseBytes }]);
    await sandbox.runCommand({
      cmd: NODE,
      args: [
        `${CONTROLLER_REPOSITORY}/tools/controller/src/cli.ts`,
        "run",
        "--job-kind",
        "judge_verify",
        "--request-id",
        launch.requestId,
        "--prebuilt",
        launch.release.judge_job.index_key,
        "--release",
        RELEASE_PATH,
        "--deadline-at",
        utcSeconds(launch.deadlineAtMs),
        "--backend",
        "sandbox",
        "--sandbox-image",
        launch.release.images.kit_image,
      ],
      cwd: CONTROLLER_REPOSITORY,
      detached: true,
    });
  } catch (error) {
    return { ok: false, created: sandbox.name, detail: error instanceof Error ? error.name : "start_failed" };
  }
  return { ok: true, sandbox: sandbox.name };
}

/** The real SDK for the controller sandbox, with the credentials bound as SDK options; loaded on first use. */
export function createJudgeSandboxSdk(credentials: { token: string; teamId: string; projectId: string }): JudgeSandboxSdk {
  return {
    async create(params) {
      const { Sandbox } = await import("@vercel/sandbox");
      const sandbox = await Sandbox.create({ ...params, ...credentials });
      return {
        name: sandbox.name,
        writeFiles: (files) => sandbox.writeFiles(files.map((file) => ({ path: file.path, content: file.content }))),
        runCommand: (command) => sandbox.runCommand(command),
      };
    },
  };
}

