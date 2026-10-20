// Reading one copy's results (the core of collect): the record set is imported with
// @rbw/admission, only the copy's own trial counts, and the criterion's failure code is reported on
// buggy only when every declared time-zone check failed with local_day_counts_mismatch and the
// UTC control passed.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCopyResults } from "../src/records.ts";
import { cleanupTemp, copyDraft, observe, syntheticWorld, tempDir, writeCopyResults } from "./support.ts";

afterEach(cleanupTemp);

const UTC = "tzarg.utc-day-counts";
const LA = "tzarg.la-day-counts";
const AUCKLAND = "tzarg.auckland-day-counts";
const KOLKATA = "tzarg.kolkata-day-counts";
const CODE = "local_day_counts_mismatch";

describe("the criterion's failure code on the buggy copy", () => {
  it("is reported when every declared check fails with local_day_counts_mismatch and the UTC control passes", () => {
    const world = syntheticWorld();
    const results = writeCopyResults(world.job, copyDraft(world.job, "buggy"));
    const read = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: results });
    expect(read.status).toBe("complete");
    expect(read.verification).toMatchObject({ observed: "fail", runs_valid: 1, runs_total: 1, failure_codes: [CODE] });
    expect(read.original_suite).toMatchObject({ observed: "pass", runs_valid: 1, runs_total: 1, executed: 3, expected: 3, failing_test_ids: [], suite_sha256: world.pins.original_suite.sha256 });
  });

  it("is not reported when one declared check passes: a valid fail without the code (a partial detection)", () => {
    const world = syntheticWorld();
    const draft = copyDraft(world.job, "buggy");
    observe(draft, AUCKLAND, "pass", null);
    const read = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
    expect(read.status).toBe("complete");
    expect(read.verification).toMatchObject({ observed: "fail", runs_valid: 1, failure_codes: [] });
  });

  it("is never reported when the UTC control fails, whatever its code: the copy is invalid (unrelated failure), never a fail", () => {
    const world = syntheticWorld();
    for (const code of [CODE, "bucket_labels_mismatch"] as const) {
      const draft = copyDraft(world.job, "buggy");
      observe(draft, UTC, "assertion_fail", code);
      const read = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
      expect(read.status).toBe("invalid");
      expect(read.verification).toMatchObject({ observed: "error", runs_valid: 0, runs_total: 1, failure_codes: [] });
      expect(read.verification.detail).toContain(`unrelated_failure: the control ${UTC} failed`);
      expect(read.original_suite.observed).toBe("pass");
    }
  });

  it("is never reported for another assertion code on a declared check while another check rejects: the copy is invalid, never a fail", () => {
    // Admission reports a rejection (Auckland passing) before an invalid observation (LA's other
    // code), so its trial is complete; the copy is still invalid.
    const world = syntheticWorld();
    const draft = copyDraft(world.job, "buggy");
    observe(draft, LA, "assertion_fail", "bucket_labels_mismatch");
    observe(draft, AUCKLAND, "pass", null);
    const read = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
    expect(read.status).toBe("invalid");
    expect(read.verification).toMatchObject({ observed: "error", runs_valid: 0, runs_total: 1, failure_codes: [] });
    expect(read.verification.detail).toContain(`unrelated_failure: ${LA} failed with bucket_labels_mismatch`);
    expect(read.original_suite.observed).toBe("pass");
  });

  it("is never reported for another assertion code on a declared check: the copy is invalid (unrelated failure)", () => {
    const world = syntheticWorld();
    const draft = copyDraft(world.job, "buggy");
    observe(draft, LA, "assertion_fail", "bucket_labels_mismatch");
    const read = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
    expect(read.status).toBe("invalid");
    expect(read.verification).toMatchObject({ observed: "error", runs_valid: 0, failure_codes: [] });
    expect(read.verification.detail).toContain("unrelated_failure");
    // The original suite ran and passed; its cell keeps that.
    expect(read.original_suite.observed).toBe("pass");
  });

  it("is never reported when every check passes (the bug is not detected) or for a setup failure in a check", () => {
    const world = syntheticWorld();
    const passing = copyDraft(world.job, "buggy");
    for (const check of [LA, AUCKLAND, KOLKATA]) observe(passing, check, "pass", null);
    const read = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: writeCopyResults(world.job, passing) });
    expect(read).toMatchObject({ status: "complete", verification: { observed: "pass", failure_codes: [] } });
    const setup = copyDraft(world.job, "buggy");
    observe(setup, KOLKATA, "setup_fail", "seed_failed");
    const broken = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: writeCopyResults(world.job, setup) });
    expect(broken).toMatchObject({ status: "invalid", verification: { observed: "error", failure_codes: [] } });
  });

  it("is never reported on the clean or fixed copy, even when their checks fail with it", () => {
    const world = syntheticWorld();
    for (const state of ["clean", "fixed"] as const) {
      const draft = copyDraft(world.job, state);
      observe(draft, LA, "assertion_fail", CODE);
      const read = readCopyResults(world.pins, { state, outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
      expect(read).toMatchObject({ status: "complete", verification: { observed: "fail", failure_codes: [] } });
      const clean = readCopyResults(world.pins, { state, outcome: "ran", resultsDir: writeCopyResults(world.job, copyDraft(world.job, state)) });
      expect(clean).toMatchObject({ status: "complete", verification: { observed: "pass", failure_codes: [] }, original_suite: { observed: "pass" } });
    }
  });
});

describe("the original suite cell", () => {
  it("is a valid fail with the failing test IDs when an original test fails", () => {
    const world = syntheticWorld();
    const draft = copyDraft(world.job, "buggy");
    const [first] = draft.tests ?? [];
    if (first === undefined) throw new Error("no tests");
    first.outcome = "failed";
    const read = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
    expect(read.status).toBe("complete");
    expect(read.original_suite).toMatchObject({ observed: "fail", runs_valid: 1, executed: 3, failing_test_ids: [first.test_id] });
    expect(read.verification.failure_codes).toEqual([CODE]);
  });

  it("is incomplete, never a pass, when an original test is missing", () => {
    const world = syntheticWorld();
    const draft = copyDraft(world.job, "clean");
    draft.tests = (draft.tests ?? []).slice(1);
    const read = readCopyResults(world.pins, { state: "clean", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
    expect(read.status).toBe("incomplete");
    expect(read.original_suite.observed).toBe("incomplete");
    expect(read.verification.observed).toBe("incomplete");
  });
});

describe("the copy's run and record set", () => {
  it("makes a setup failure invalid with no run counted, and a timed-out copy incomplete", () => {
    const world = syntheticWorld();
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "setup_failed", resultsDir: null })).toMatchObject({
      status: "invalid",
      original_suite: { observed: "error", runs_valid: 0, runs_total: 0 },
      verification: { observed: "error", runs_valid: 0, runs_total: 0, failure_codes: [] },
    });
    const draft = copyDraft(world.job, "buggy");
    draft.runExit = null;
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "timed_out", resultsDir: writeCopyResults(world.job, draft) })).toMatchObject({
      status: "incomplete",
      verification: { observed: "incomplete", runs_valid: 0, runs_total: 1, failure_codes: [] },
    });
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "timed_out", resultsDir: null }).status).toBe("incomplete");
  });

  it("makes a timed-out copy incomplete even when the driver finished and wrote a detection", () => {
    const world = syntheticWorld();
    const read = readCopyResults(world.pins, { state: "buggy", outcome: "timed_out", resultsDir: writeCopyResults(world.job, copyDraft(world.job, "buggy")) });
    expect(read).toMatchObject({ status: "incomplete", original_suite: { observed: "incomplete" }, verification: { observed: "incomplete", failure_codes: [] } });
  });

  it("makes a failed freeze, a refused job, another driver exit or nothing collected invalid", () => {
    const world = syntheticWorld();
    const cases: [number | null, number | null][] = [
      [1, null],
      [0, 2],
      [0, 1],
      [0, null],
    ];
    for (const [freezeExit, runExit] of cases) {
      const draft = copyDraft(world.job, "clean");
      draft.freezeExit = freezeExit;
      draft.runExit = runExit;
      const read = readCopyResults(world.pins, { state: "clean", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
      expect(read.status).toBe("invalid");
      expect(read.verification.observed).toBe("error");
    }
    expect(readCopyResults(world.pins, { state: "clean", outcome: "ran", resultsDir: null }).status).toBe("invalid");
  });

  it("keeps the driver's own incomplete status (its internal error, exit 3)", () => {
    const world = syntheticWorld();
    const draft = copyDraft(world.job, "fixed");
    draft.runExit = 3;
    draft.status = "incomplete";
    draft.invalidReason = "artifact_missing";
    const read = readCopyResults(world.pins, { state: "fixed", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
    expect(read.status).toBe("incomplete");
    expect(read.verification.observed).toBe("incomplete");
  });

  it("reads only the copy's own trial; the job's other trials show as result_missing", () => {
    const world = syntheticWorld();
    const read = readCopyResults(world.pins, { state: "fixed", outcome: "ran", resultsDir: writeCopyResults(world.job, copyDraft(world.job, "fixed")) });
    expect(read.status).toBe("complete");
    expect(read.verification.detail).toContain("fixed-01 complete");
  });

  it("refuses a record set that also holds another copy's trial", () => {
    const world = syntheticWorld();
    const results = writeCopyResults(world.job, copyDraft(world.job, "buggy"), [copyDraft(world.job, "clean")]);
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: results }).status).toBe("invalid");
  });

  it("refuses a record set that also holds results of a trial the job does not declare", () => {
    const world = syntheticWorld();
    const results = writeCopyResults(world.job, copyDraft(world.job, "buggy"));
    mkdirSync(join(results, "out", "results", "synthetic-extra-01"));
    writeFileSync(join(results, "out", "results", "synthetic-extra-01", "trial-result.json"), "{}\n");
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: results })).toMatchObject({
      status: "invalid",
      verification: { observed: "error", failure_codes: [], detail: "the record set holds results of another copy" },
    });
  });

  it("refuses a record set of another job, or one the importer refuses", () => {
    const world = syntheticWorld();
    const results = writeCopyResults(world.job, copyDraft(world.job, "buggy"));
    const other = { ...world.pins, job: { ...world.pins.job, request_sha256: "9".repeat(64) } };
    expect(readCopyResults(other, { state: "buggy", outcome: "ran", resultsDir: results })).toMatchObject({ status: "invalid", verification: { detail: "the record set does not carry the frozen job" } });
    writeFileSync(join(results, "out", world.job.request.expected_trials_key), "{}");
    const refused = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: results });
    expect(refused).toMatchObject({ status: "invalid", verification: { observed: "error" } });
    expect(refused.verification.detail).toMatch(/^the importer refused the record set \(import:expected_trials_/);
  });

  it("makes results the copy shaped wrongly invalid, never an error: out as a file, request.json as a directory, links", () => {
    const world = syntheticWorld();
    const asFile = tempDir();
    writeFileSync(join(asFile, "freeze.exit"), "0\n");
    writeFileSync(join(asFile, "run.exit"), "0\n");
    writeFileSync(join(asFile, "out"), "not a directory\n");
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: asFile }).status).toBe("invalid");
    const requestDir = writeCopyResults(world.job, copyDraft(world.job, "buggy"));
    rmSync(join(requestDir, "out", "request.json"));
    mkdirSync(join(requestDir, "out", "request.json"));
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: requestDir }).status).toBe("invalid");
    const exitDir = writeCopyResults(world.job, copyDraft(world.job, "buggy"));
    rmSync(join(exitDir, "run.exit"));
    mkdirSync(join(exitDir, "run.exit"));
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: exitDir }).status).toBe("invalid");
    // A link is never followed out of the results, even to the right bytes.
    const linked = writeCopyResults(world.job, copyDraft(world.job, "buggy"));
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, "request.json"), world.job.requestBytes);
    rmSync(join(linked, "out", "request.json"));
    symlinkSync(join(elsewhere, "request.json"), join(linked, "out", "request.json"));
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: linked }).status).toBe("invalid");
    const linkedOut = tempDir();
    writeFileSync(join(linkedOut, "freeze.exit"), "0\n");
    writeFileSync(join(linkedOut, "run.exit"), "0\n");
    symlinkSync(join(writeCopyResults(world.job, copyDraft(world.job, "buggy")), "out"), join(linkedOut, "out"));
    expect(readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: linkedOut }).status).toBe("invalid");
  });

  it("throws for no copy outcome: a results directory that does not exist is an invalid copy", () => {
    const world = syntheticWorld();
    expect(() => readCopyResults(world.pins, { state: "clean", outcome: "ran", resultsDir: "/nonexistent/results" })).not.toThrow();
    expect(readCopyResults(world.pins, { state: "clean", outcome: "ran", resultsDir: "/nonexistent/results" }).status).toBe("invalid");
  });
});
