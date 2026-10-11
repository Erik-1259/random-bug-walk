import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importRecordSet } from "@rbw/admission";
import { buildJobRequest, encodeCanonical, parseCanonical, parseRecord, sha256Hex } from "@rbw/schema";
import type { ExpectedTrials, JobRequest, JobRequestFields } from "@rbw/schema";
import { JOB_LIMITS } from "../../src/limits.ts";
import {
  JUDGE_TRIALS,
  KNOWN_CONDITION_MESSAGE,
  controllerSandboxName,
  holdActive,
  judgeDeadlineMs,
  judgeIds,
  judgeOperation,
  judgeRelease,
  newProgress,
  parseProgress,
  progressBytes,
  replayVerdict,
  revenueTestIds,
  startJudgeController,
} from "../../src/judge.ts";
import type { JudgeControllerCreateParams, JudgeSandboxInstance, JudgeSandboxSdk, ReplayProgress } from "../../src/judge.ts";
import * as judgeModule from "../../src/judge.ts";
import * as judgeWeb from "../../src/judge-web.ts";
import type { JudgeModule, JudgeStore } from "../../src/judge-types.ts";
import { overlayJudgeJob } from "../../src/judge-run.ts";
import { LocalPrivateStore } from "@rbw/publisher/private-store";
import { controllerEnvelope } from "../../src/envelope.ts";
import type { CopyEnvelope } from "../../src/envelope.ts";
import { cleanupRecordSets, recordSet, testOutcome, TASK_REVISION, TEST_IDS } from "../../../../packages/admission/test/support/record-set.ts";
import { rates } from "../support/harness.ts";

const FIXTURE = fileURLToPath(new URL("../../../release/fixtures/release/", import.meta.url));
const RELEASE_ID = "00000000-0000-4000-8000-000000000601";
const RELEASE_FILE = join(FIXTURE, "repository", "releases", RELEASE_ID, "release.json");
const JOB_DIR = join(FIXTURE, "private-store", "judge-jobs", RELEASE_ID);
const REQUEST_ID = "00000000-0000-4000-8000-00000000b001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(cleanupRecordSets);

function release() {
  return parseRecord("Release", readFileSync(RELEASE_FILE));
}

describe("judgeIds", () => {
  it("derives one root, batch and execution per request ID, the same every time, as distinct lowercase UUIDs", () => {
    const ids = judgeIds(REQUEST_ID);
    expect(judgeIds(REQUEST_ID)).toEqual(ids);
    for (const id of [ids.root, ids.batch, ids.execution]) expect(id).toMatch(UUID);
    expect(new Set([ids.root, ids.batch, ids.execution, REQUEST_ID]).size).toBe(4);
    expect(judgeIds("00000000-0000-4000-8000-00000000b002").root).not.toBe(ids.root);
  });

  it("refuses a request ID that is not a lowercase UUID", () => {
    expect(() => judgeIds("00000000-0000-4000-8000-00000000B001")).toThrow();
    expect(() => judgeIds("not-a-uuid")).toThrow();
  });
});

describe("overlayJudgeJob", () => {
  const frozen = { request: readFileSync(join(JOB_DIR, "request.json")), expected: readFileSync(join(JOB_DIR, "expected-trials.json")) };
  const deadline = "2026-12-03T10:33:00Z";

  it("sets the replay's IDs and deadline, recomputes operation_id and payload_hash, and leaves every other field byte-equal", () => {
    const before = parseCanonical(frozen.request) as unknown as JobRequest;
    const job = overlayJudgeJob(frozen, { request_id: REQUEST_ID, deadline_at: deadline });
    const ids = judgeIds(REQUEST_ID);
    const after = job.request;
    expect(after.root_execution_id).toBe(ids.root);
    expect(after.parent_execution_id).toBe(ids.root);
    expect(after.batch_id).toBe(ids.batch);
    expect(after.execution_id).toBe(ids.execution);
    expect(after.deadline_at).toBe(deadline);
    expect(after.expected_trials_key).toBe(`jobs/${ids.execution}/expected-trials.json`);
    expect(after.expected_trials_sha256).toBe(job.expectedSha256);
    expect(sha256Hex(job.expectedBytes)).toBe(job.expectedSha256);
    const fields = Object.fromEntries(Object.entries(after).filter(([key]) => key !== "operation_id" && key !== "payload_hash")) as JobRequestFields;
    const rebuilt = buildJobRequest(fields);
    expect(after.operation_id).toBe(rebuilt.request.operation_id);
    expect(after.payload_hash).toBe(rebuilt.request.payload_hash);
    expect(Buffer.from(job.requestBytes).equals(Buffer.from(rebuilt.bytes))).toBe(true);
    expect(after.operation_id).not.toBe(before.operation_id);
    const overlaid = new Set(["batch_id", "execution_id", "root_execution_id", "parent_execution_id", "deadline_at", "expected_trials_key", "expected_trials_sha256", "operation_id", "payload_hash"]);
    for (const [key, value] of Object.entries(before)) {
      if (overlaid.has(key)) continue;
      expect(Buffer.from(encodeCanonical((after as unknown as Record<string, never>)[key])).equals(Buffer.from(encodeCanonical(value as never))), key).toBe(true);
    }
    expect(after.reservation_microusd).toBe(before.reservation_microusd);
    expect(after.release_id).toBe(RELEASE_ID);
  });

  it("changes only the expected trials' execution ID", () => {
    const before = parseCanonical(frozen.expected) as unknown as ExpectedTrials;
    const job = overlayJudgeJob(frozen, { request_id: REQUEST_ID, deadline_at: deadline });
    expect(job.expected).toEqual({ ...before, execution_id: judgeIds(REQUEST_ID).execution });
    expect(job.expected.trials.map((trial) => trial.trial_id)).toEqual([...JUDGE_TRIALS]);
  });
});

describe("judgeOperation", () => {
  it("names the controller's operation from the request ID and the release, the same for the route and the controller", async () => {
    const envelope = controllerEnvelope(await rates()) as CopyEnvelope;
    const r = judgeRelease(release());
    const first = judgeOperation(REQUEST_ID, r, envelope);
    expect(judgeOperation(REQUEST_ID, r, envelope)).toEqual(first);
    const ids = judgeIds(REQUEST_ID);
    expect(first.request.root_execution_id).toBe(ids.root);
    expect(first.request.pool_key).toBe("judge-demo");
    expect(first.request.allocation_key).toBe("judge");
    expect(first.request.task_revision).toBe(release().revisions[0]?.sha256);
    expect(first.request.provider_replay_key).toBe(controllerSandboxName(ids.root));
    expect(first.request.operation_id).toBe(first.operation_id);
    expect(judgeOperation("00000000-0000-4000-8000-00000000b002", r, envelope).operation_id).not.toBe(first.operation_id);
  });
});

describe("the controller's deadline", () => {
  it("is the create time plus the 2,100 s timeout minus 120 s, so a controller starting 300 s after the create has 1,680 s", () => {
    const created = Date.parse("2026-12-03T10:00:00Z");
    expect(JOB_LIMITS.judge_verify.controller_ms).toBe(2_100_000);
    expect(judgeDeadlineMs(created)).toBe(created + 1_980_000);
    expect(judgeDeadlineMs(created) - (created + 300_000)).toBe(1_680_000);
  });
});

/** The frozen suite's shape: the two revenue tests named as the driver's known limit, plus another test. */
const SUITE = {
  tests: [
    { file: "tests/api/revenue.spec.ts", id: TEST_IDS[0] ?? "", title_path: ["Revenue", "GET /api/websites/{websiteId}/revenue/sessions lists sessions with revenue"] },
    { file: "tests/api/revenue.spec.ts", id: TEST_IDS[1] ?? "", title_path: ["Revenue", "GET /api/websites/{websiteId}/revenue/stats returns revenue totals"] },
    { file: "tests/api/alpha.spec.ts", id: TEST_IDS[2] ?? "", title_path: ["Alpha", "returns rows"] },
  ],
};
const DEC_3 = Date.parse("2026-12-03T10:00:00Z");
const DEC_6 = Date.parse("2026-12-06T10:00:00Z");
const RELEASE = { task_revision: TASK_REVISION };

function evidence(failing: readonly string[]) {
  return importRecordSet(
    recordSet(
      (draft) => {
        for (const trialId of ["clean-01", "planted-01", "fixed-01"]) for (const id of failing) testOutcome(draft, trialId, id, "failed");
      },
      () => undefined,
      "judge_verify",
    ),
  );
}

describe("replayVerdict", () => {
  it("takes the two revenue test IDs from the frozen suite", () => {
    expect(revenueTestIds(SUITE)).toEqual([TEST_IDS[0], TEST_IDS[1]].sort());
  });

  it("is verified with no known condition when all six cells match", () => {
    expect(replayVerdict(evidence([]), RELEASE, DEC_6, SUITE)).toEqual({ state: "verified", known_condition: false });
  });

  it("is verified with the known condition when only the two revenue tests fail, on Dec 3", () => {
    const verdict = replayVerdict(evidence([TEST_IDS[0] ?? "", TEST_IDS[1] ?? ""]), RELEASE, DEC_3, SUITE);
    expect(verdict).toEqual({ state: "verified", known_condition: true });
    expect(KNOWN_CONDITION_MESSAGE).toBe(
      "Two upstream revenue tests fail on the 2nd to the 5th of each month, a known date-dependent condition in Umami's own test data, not in this example. They are shown as failures and are not counted against this replay.",
    );
  });

  it("is not_reproduced for the same two failures on Dec 6", () => {
    expect(replayVerdict(evidence([TEST_IDS[0] ?? "", TEST_IDS[1] ?? ""]), RELEASE, DEC_6, SUITE)).toEqual({ state: "not_reproduced", known_condition: false });
  });

  it("is not_reproduced for a third failure on Dec 3", () => {
    expect(replayVerdict(evidence([TEST_IDS[0] ?? "", TEST_IDS[1] ?? "", TEST_IDS[2] ?? ""]), RELEASE, DEC_3, SUITE).state).toBe("not_reproduced");
  });

  it("is not_reproduced when the evidence is of another task revision", () => {
    expect(replayVerdict(evidence([]), { task_revision: "9".repeat(64) }, DEC_6, SUITE).state).toBe("not_reproduced");
  });
});

function final(createdAt: string, state: ReplayProgress["state"]): ReplayProgress {
  return { ...newProgress("00000000-0000-4000-8000-00000000c001", Date.parse(createdAt), Date.parse(createdAt) + 1_980_000), state, ended_at: createdAt };
}

describe("the hold", () => {
  const nr = "not_reproduced" as const;
  it("does not hold after one not_reproduced", () => {
    expect(holdActive([final("2026-12-03T10:00:00Z", nr)], null)).toBe(false);
  });
  it("holds after two not_reproduced in a row, in created_at order", () => {
    expect(holdActive([final("2026-12-03T11:00:00Z", nr), final("2026-12-03T10:00:00Z", "verified"), final("2026-12-03T12:00:00Z", nr)], null)).toBe(true);
  });
  it("is reset by a verified replay between them", () => {
    expect(holdActive([final("2026-12-03T10:00:00Z", nr), final("2026-12-03T12:00:00Z", nr), final("2026-12-03T11:00:00Z", "verified")], null)).toBe(false);
  });
  it("never counts incomplete, needs_reconciliation or unfinished replays", () => {
    const runs = [final("2026-12-03T10:00:00Z", nr), final("2026-12-03T11:00:00Z", "incomplete"), final("2026-12-03T11:30:00Z", "needs_reconciliation"), final("2026-12-03T11:45:00Z", "running"), final("2026-12-03T12:00:00Z", nr)];
    expect(holdActive(runs, null)).toBe(true);
    expect(holdActive([final("2026-12-03T10:00:00Z", "incomplete"), final("2026-12-03T11:00:00Z", "incomplete")], null)).toBe(false);
  });
  it("is cleared by a later RBW_JUDGE_HOLD_CLEARED_AT", () => {
    const runs = [final("2026-12-03T10:00:00Z", nr), final("2026-12-03T12:00:00Z", nr)];
    expect(holdActive(runs, "2026-12-03T09:00:00Z")).toBe(true);
    expect(holdActive(runs, "2026-12-03T12:30:00Z")).toBe(false);
    expect(holdActive([...runs, final("2026-12-03T13:00:00Z", nr)], "2026-12-03T11:00:00Z")).toBe(true);
  });
});

describe("progress.json", () => {
  it("round-trips as canonical bytes with every copy not started", () => {
    const progress = newProgress(judgeIds(REQUEST_ID).root, DEC_3, judgeDeadlineMs(DEC_3));
    expect(progress.copies).toEqual(JUDGE_TRIALS.map((trial_id) => ({ trial_id, status: "not_started", started_at: null })));
    expect(progress.created_at).toBe("2026-12-03T10:00:00Z");
    expect(progress.deadline_at).toBe("2026-12-03T10:33:00Z");
    expect(parseProgress(progressBytes(progress))).toEqual(progress);
    expect(() => parseProgress(new TextEncoder().encode("{}"))).toThrow();
  });
});

class FakeJudgeSdk implements JudgeSandboxSdk {
  readonly calls: { op: string; value: unknown }[] = [];
  fail: "create" | "command" | null = null;

  create(params: JudgeControllerCreateParams): Promise<JudgeSandboxInstance> {
    this.calls.push({ op: "create", value: params });
    if (this.fail === "create") return Promise.reject(new Error("synthetic: create failed"));
    return Promise.resolve({
      name: params.name,
      writeFiles: (files) => {
        this.calls.push({ op: "writeFiles", value: files });
        return Promise.resolve();
      },
      runCommand: (command) => {
        this.calls.push({ op: "runCommand", value: command });
        return this.fail === "command" ? Promise.reject(new Error("synthetic: command failed")) : Promise.resolve({});
      },
    });
  }
}

describe("startJudgeController", () => {
  const secrets = {
    VERCEL_TOKEN: "synthetic-vercel-token",
    VERCEL_TEAM_ID: "synthetic-team-id-61",
    VERCEL_PROJECT_ID: "synthetic-project-id-62",
    DATABASE_URL: "postgres://synthetic-user:synthetic-password@db.example.invalid/synthetic",
    BLOB_PRIVATE_STORE_ID: "synthetic-store-id-63",
    VERCEL_OIDC_TOKEN: "synthetic-oidc-token",
  };

  it("creates one sandbox from the release's controller image with the credentials only in its environment, writes the release and starts one detached run", async () => {
    const sdk = new FakeJudgeSdk();
    const releaseBytes = readFileSync(RELEASE_FILE);
    const record = release();
    const root = judgeIds(REQUEST_ID).root;
    const started = await startJudgeController(sdk, { requestId: REQUEST_ID, release: record, releaseBytes, deadlineAtMs: judgeDeadlineMs(DEC_3), env: secrets });
    expect(started).toEqual({ ok: true, sandbox: controllerSandboxName(root) });
    expect(sdk.calls.map((call) => call.op)).toEqual(["create", "writeFiles", "runCommand"]);
    const params = sdk.calls[0]?.value as JudgeControllerCreateParams;
    expect(params).toMatchObject({ image: record.images.controller_image, name: controllerSandboxName(root), persistent: false, networkPolicy: "allow-all", resources: { vcpus: 2 }, timeout: 2_100_000 });
    for (const [name, value] of Object.entries(secrets)) expect(params.env[name]).toBe(value);
    const files = sdk.calls[1]?.value as { path: string; content: Uint8Array }[];
    expect(files).toHaveLength(1);
    expect(Buffer.from(files[0]?.content ?? []).equals(releaseBytes)).toBe(true);
    const command = sdk.calls[2]?.value as { cmd: string; args: string[]; detached: boolean };
    expect(command.detached).toBe(true);
    const args = command.args.join(" ");
    expect(args).toContain(
      `run --job-kind judge_verify --request-id ${REQUEST_ID} --prebuilt ${record.judge_job.index_key} --release ${files[0]?.path ?? ""} --deadline-at 2026-12-03T10:33:00Z --backend sandbox --sandbox-image ${record.images.kit_image}`,
    );
    const outside = JSON.stringify([command, files.map((file) => file.path), params.name, params.image]);
    for (const value of Object.values(secrets)) expect(outside).not.toContain(value);
  });

  it("reports a failed create with no sandbox, and a failure after the create with the sandbox's name", async () => {
    const sdk = new FakeJudgeSdk();
    sdk.fail = "create";
    const launch = { requestId: REQUEST_ID, release: release(), releaseBytes: readFileSync(RELEASE_FILE), deadlineAtMs: judgeDeadlineMs(DEC_3), env: secrets };
    expect(await startJudgeController(sdk, launch)).toMatchObject({ ok: false, created: null });
    const later = new FakeJudgeSdk();
    later.fail = "command";
    expect(await startJudgeController(later, launch)).toMatchObject({ ok: false, created: controllerSandboxName(judgeIds(REQUEST_ID).root) });
    expect(later.calls.filter((call) => call.op === "create")).toHaveLength(1);
  });
});

describe("the judge routes' view of this module", () => {
  it("is provided by judge-web.ts, which judge.ts re-exports, and the private store is a JudgeStore", () => {
    const surface: JudgeModule = judgeWeb;
    for (const [name, value] of Object.entries(judgeWeb)) expect(judgeModule[name as keyof typeof judgeModule]).toBe(value);
    const store: JudgeStore = new LocalPrivateStore(fileURLToPath(new URL(".", import.meta.url)));
    expect(typeof surface.startJudgeController).toBe("function");
    expect(typeof store.putNew).toBe("function");
  });
});
