import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRIAL_REASON_VALUES } from "@rbw/schema";
import { RefusedInput, loadJob, readJob } from "../../src/job.ts";
import { statusForReason } from "../../src/status.ts";
import { EXPECTED_TRIALS_KEY, jobFiles, tempDir } from "../helpers.ts";

function read(files: ReturnType<typeof jobFiles>, trialId: string, expected: Uint8Array | null = files.expectedTrialsBytes) {
  return readJob(files.requestBytes, (key) => (key === EXPECTED_TRIALS_KEY ? expected : null), trialId);
}

describe("job input", () => {
  it("reads the request and the expected trials with the shared schema and selects the trial", () => {
    const files = jobFiles();
    const job = read(files, "clean-01");
    expect(job.request.kind).toBe("kit_check");
    expect(job.trial).toMatchObject({ trial_id: "clean-01", code_state: "clean", added_repeat_count: 20 });
    expect(job.expectedTrials.trials.map((trial) => trial.trial_id)).toEqual(["clean-01", "clean-02", "clean-03", "clean-04", "clean-05"]);
    expect(Buffer.from(job.requestBytes).equals(Buffer.from(files.requestBytes))).toBe(true);
  });

  it("loads the job from a directory laid out as a record set", () => {
    const dir = tempDir();
    const files = jobFiles();
    writeFileSync(join(dir, "request.json"), files.requestBytes);
    mkdirSync(dirname(join(dir, EXPECTED_TRIALS_KEY)), { recursive: true });
    writeFileSync(join(dir, EXPECTED_TRIALS_KEY), files.expectedTrialsBytes);
    expect(loadJob(dir, "clean-03").trial.trial_id).toBe("clean-03");
    expect(() => loadJob(tempDir(), "clean-03")).toThrow(/request\.json/);
  });

  it("refuses a trial ID the expected trials do not list", () => {
    expect(() => read(jobFiles(), "clean-09")).toThrow(RefusedInput);
  });

  it("refuses expected trials whose SHA-256 is not the request's", () => {
    const files = jobFiles();
    const other = jobFiles({ addedSuiteSha256: "e".repeat(64) });
    expect(() => read(files, "clean-01", other.expectedTrialsBytes)).toThrow(/expected_trials_sha256/);
  });

  it("refuses a missing expected-trials file", () => {
    expect(() => read(jobFiles(), "clean-01", null)).toThrow(/expected-trials/);
  });

  it("refuses a request that is valid JSON but not canonical bytes", () => {
    const files = jobFiles();
    const spaced = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(files.requestBytes).toString("utf8")), null, 2));
    expect(() => readJob(spaced, () => files.expectedTrialsBytes, "clean-01")).toThrow(RefusedInput);
  });

  it("refuses a request whose payload hash does not match its fields", () => {
    const files = jobFiles();
    const tampered = Buffer.from(Buffer.from(files.requestBytes).toString("utf8").replace('"attempt_ordinal":1', '"attempt_ordinal":2'));
    expect(() => readJob(tampered, () => files.expectedTrialsBytes, "clean-01")).toThrow(/JobRequest/);
  });
});

describe("trial status from the first reason", () => {
  it.each(["build_failed", "startup_failed", "auth_failed", "seed_failed", "unrelated_failure", "scope_violation"] as const)(
    "%s makes the trial invalid",
    (reason) => {
      expect(statusForReason(reason)).toBe("invalid");
    },
  );

  it.each(["timeout", "artifact_missing", "artifact_hash_mismatch", "test_missing", "test_skipped", "limit_exceeded", "provider_uncertain"] as const)(
    "%s makes the trial incomplete",
    (reason) => {
      expect(statusForReason(reason)).toBe("incomplete");
    },
  );

  it("maps every shared reason code, and no reason makes the trial complete", () => {
    expect(TRIAL_REASON_VALUES).toHaveLength(13);
    expect(statusForReason(null)).toBe("complete");
  });
});
