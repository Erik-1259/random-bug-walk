// The types of the judge path (design note section 6) and its known-condition message, apart
// from the judge modules so the web app's handlers and pages can import them without the
// controller's sources. JudgeModule is what the judge routes call; a controller test checks that
// judge-web.ts provides it.
import type { Envelope, Rates } from "@rbw/envelope";
import type { Release, RootRun } from "@rbw/schema";
import type { ReserveRequest, Spend, UsageSettlement } from "@rbw/spend";

/** The private store's methods the judge routes use: PrivateStore in @rbw/publisher/private-store, which a controller test checks this against. */
export interface JudgeStore {
  putNew(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string, maxBytes: number): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
}

/** The known condition on the 2nd to 5th of each month, as the page states it. */
export const KNOWN_CONDITION_MESSAGE =
  "Two upstream revenue tests fail on the 2nd to the 5th of each month, a known date-dependent condition in Umami's own test data, not in this example. They are shown as failures and are not counted against this replay.";

export type OkEnvelope = Extract<Envelope, { ok: true }>;

export interface JudgeIds {
  root: string;
  batch: string;
  execution: string;
}

/** The release fields the judge path reads. */
export interface JudgeRelease {
  release_id: string;
  created_at: string;
  project_id: string;
  project_policy_sha256: string;
  task_revision: string;
  controller_image: string;
  kit_image: string;
  judge_job: { index_key: string; index_sha256: string };
}

export interface JudgeOperation {
  call_name: string;
  operation_id: string;
  payload_hash: string;
  sandbox_name: string;
  /** The reservation of the controller's envelope on judge-demo/judge. */
  request: ReserveRequest;
}

export type ReplayOutcome = "verified" | "not_reproduced" | "incomplete" | "needs_reconciliation";
export type ProgressState = "starting" | "running" | ReplayOutcome;
export type CopyProgress = "not_started" | "running" | "done";

export interface ReplayProgress {
  schema_version: 1;
  root_execution_id: string;
  /** When the route created the controller sandbox. */
  created_at: string;
  deadline_at: string;
  state: ProgressState;
  /** Set with the final state: whether the known condition (2nd to 5th of the month) explains the only unexpected cells. */
  known_condition: boolean | null;
  copies: { trial_id: string; status: CopyProgress; started_at: string | null }[];
  ended_at: string | null;
}

export interface JudgeControllerCreateParams {
  image: string;
  name: string;
  persistent: false;
  networkPolicy: "allow-all";
  resources: { vcpus: number };
  /** Milliseconds. */
  timeout: number;
  env: Record<string, string>;
}

export interface JudgeSandboxInstance {
  readonly name: string;
  writeFiles(files: { path: string; content: Uint8Array }[]): Promise<void>;
  runCommand(params: { cmd: string; args: string[]; cwd: string; detached: true }): Promise<unknown>;
}

/** `Sandbox.create` with the credentials already bound. */
export interface JudgeSandboxSdk {
  create(params: JudgeControllerCreateParams): Promise<JudgeSandboxInstance>;
}

export interface JudgeLaunch {
  requestId: string;
  release: Release;
  /** release.json's bytes, written into the sandbox as public data. */
  releaseBytes: Uint8Array;
  deadlineAtMs: number;
  /** The credentials the controller reads: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, DATABASE_URL, BLOB_PRIVATE_STORE_ID, VERCEL_OIDC_TOKEN. */
  env: Record<string, string>;
}

export type JudgeStart = { ok: true; sandbox: string } | { ok: false; created: string | null; detail: string };

/** What the judge routes call in @rbw/controller/judge-web. */
export interface JudgeModule {
  CONTROLLER_TIMEOUT_MS: number;
  JUDGE_JOB_NAME: string;
  JUDGE_POOL: { pool_key: string; allocation_key: string | null; slot_key: string };
  KNOWN_CONDITION_MESSAGE: string;
  parseRateSheet(text: string): Rates;
  controllerEnvelope(rates: Rates): Envelope;
  judgeReservation(rates: Rates): { ok: true; reserved_microusd: bigint } | { ok: false };
  controllerSettlement(envelope: OkEnvelope, operationId: string): UsageSettlement;
  tokenExpiresMs(token: string): number | null;
  judgeIds(requestId: string): JudgeIds;
  judgeKeys(root: string): { prefix: string; rootRun: string; progress: string; run: string };
  judgeDeadlineMs(createdMs: number): number;
  judgeRelease(release: Release): JudgeRelease;
  judgeOperation(requestId: string, release: JudgeRelease, envelope: OkEnvelope): JudgeOperation;
  replayRootRun(release: Pick<JudgeRelease, "project_id" | "project_policy_sha256">, requestId: string, status: RootRun["status"], outcome: RootRun["outcome"]): RootRun;
  encodeRecord(record: RootRun): Uint8Array;
  newProgress(root: string, createdMs: number, deadlineMs: number): ReplayProgress;
  progressBytes(progress: ReplayProgress): Uint8Array;
  parseProgress(bytes: Uint8Array): ReplayProgress;
  holdActive(replays: readonly ReplayProgress[], clearedAt: string | null): boolean;
  startJudgeController(sdk: JudgeSandboxSdk, launch: JudgeLaunch): Promise<JudgeStart>;
  createJudgeSandboxSdk(credentials: { token: string; teamId: string; projectId: string }): JudgeSandboxSdk;
  databaseLedger(databaseUrl: string, now: () => Date): Promise<{ spend: Spend; close: () => Promise<void> }>;
}
