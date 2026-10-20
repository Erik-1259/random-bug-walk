import type { CellObservation, CopyRecord, CopyState } from "@rbw/factory-contract";
import { validateContract } from "@rbw/factory-contract/validate";
import { afterEach, describe, expect, it } from "vitest";
import { createUmamiAdapter } from "../src/adapter.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { combineCells } from "../src/interpret.ts";
import { UMAMI_PROTOCOL } from "../src/protocol.ts";
import { readCopyResults } from "../src/records.ts";
import { cleanupTemp, copyDraft, observe, syntheticWorld, writeCopyResults } from "./support.ts";

afterEach(cleanupTemp);

const adapter = createUmamiAdapter();

function cell(observed: CellObservation["observed"], codes: string[] = []): CellObservation {
  const valid = observed === "pass" || observed === "fail";
  return { observed, runs_valid: valid ? 1 : 0, runs_total: 1, failure_codes: codes, detail: `synthetic ${observed}` };
}

function record(state: CopyState, suite: CellObservation["observed"], checks: CellObservation["observed"], codes: string[] = [], copyId = `${state}-01`): CopyRecord {
  const status = suite === "error" || checks === "error" ? "invalid" : suite === "incomplete" || checks === "incomplete" ? "incomplete" : "complete";
  return {
    copy_id: copyId,
    state,
    status,
    original_suite: { ...cell(suite), executed: 271, expected: 271, failing_test_ids: [], suite_sha256: "8".repeat(64) },
    verification: cell(checks, codes),
    image_digest: `sha256:${"a".repeat(64)}`,
    architecture: "amd64",
    started_at: "2026-10-19T12:00:00.000Z",
    finished_at: "2026-10-19T12:03:00.000Z",
    evidence_sha256: "9".repeat(64),
  };
}

describe("interpret", () => {
  it("passes a valid record through as the state's two cells", () => {
    const cells = adapter.interpret([record("buggy", "pass", "fail", ["local_day_counts_mismatch"])], UMAMI_PROTOCOL);
    expect(cells.original_suite).toMatchObject({ observed: "pass", runs_valid: 1, runs_total: 1 });
    expect(cells.verification).toMatchObject({ observed: "fail", runs_valid: 1, runs_total: 1, failure_codes: ["local_day_counts_mismatch"] });
    expect(validateContract("CellObservation", cells.verification)).toEqual([]);
  });

  it("keeps invalid (error) and incomplete distinct, and never turns either into a pass or a fail", () => {
    expect(adapter.interpret([record("clean", "pass", "error")], UMAMI_PROTOCOL).verification.observed).toBe("error");
    expect(adapter.interpret([record("clean", "pass", "error")], UMAMI_PROTOCOL).original_suite.observed).toBe("pass");
    expect(adapter.interpret([record("fixed", "incomplete", "incomplete")], UMAMI_PROTOCOL)).toMatchObject({
      original_suite: { observed: "incomplete", runs_valid: 0 },
      verification: { observed: "incomplete", runs_valid: 0 },
    });
  });

  it("is incomplete when a declared copy has no record", () => {
    expect(adapter.interpret([], UMAMI_PROTOCOL)).toMatchObject({ original_suite: { observed: "incomplete" }, verification: { observed: "incomplete" } });
  });

  it("refuses records of several states, a repeated copy, more copies than declared, or another protocol", () => {
    const code = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        if (error instanceof UmamiRefusal) return error.code;
        throw error;
      }
      return "no refusal";
    };
    expect(code(() => adapter.interpret([record("clean", "pass", "pass"), record("buggy", "pass", "fail")], UMAMI_PROTOCOL))).toBe("protocol_mismatch");
    expect(code(() => adapter.interpret([record("clean", "pass", "pass"), record("clean", "pass", "pass")], UMAMI_PROTOCOL))).toBe("protocol_mismatch");
    expect(code(() => adapter.interpret([record("clean", "pass", "pass"), record("clean", "pass", "pass", [], "clean-02")], UMAMI_PROTOCOL))).toBe("protocol_mismatch");
    expect(code(() => adapter.interpret([record("clean", "pass", "pass")], { ...UMAMI_PROTOCOL, version: "2" }))).toBe("protocol_mismatch");
  });

  it("counts a failure code only when every valid run of a cell reported it, and needs the declared valid runs", () => {
    const code = "local_day_counts_mismatch";
    expect(combineCells([cell("fail", [code]), cell("fail", [code])], 2, 0)).toMatchObject({ observed: "fail", runs_valid: 2, runs_total: 2, failure_codes: [code] });
    expect(combineCells([cell("fail", [code]), cell("pass")], 2, 0)).toMatchObject({ observed: "fail", failure_codes: [] });
    expect(combineCells([cell("fail", [code]), cell("fail")], 2, 0).failure_codes).toEqual([]);
    expect(combineCells([cell("fail", [code])], 2, 1)).toMatchObject({ observed: "incomplete", runs_valid: 1, runs_total: 2, failure_codes: [] });
    expect(combineCells([cell("fail", [code]), cell("error")], 2, 0).observed).toBe("error");
    expect(combineCells([cell("pass"), cell("incomplete")], 2, 0).observed).toBe("incomplete");
  });

  it("combines records that readCopyResults made from copy record sets", () => {
    const world = syntheticWorld();
    const states: CopyState[] = ["clean", "buggy", "fixed"];
    const cells = states.map((state) => {
      const draft = copyDraft(world.job, state);
      if (state === "fixed") observe(draft, "tzarg.kolkata-day-counts", "assertion_fail", "local_day_counts_mismatch");
      const read = readCopyResults(world.pins, { state, outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
      const copy: CopyRecord = { ...record(state, "pass", "pass"), status: read.status, original_suite: read.original_suite, verification: read.verification };
      return adapter.interpret([copy], UMAMI_PROTOCOL);
    });
    expect(cells.map((item) => [item.original_suite.observed, item.verification.observed, item.verification.failure_codes])).toEqual([
      ["pass", "pass", []],
      ["pass", "fail", ["local_day_counts_mismatch"]],
      ["pass", "fail", []],
    ]);
  });

  it("makes a buggy copy with an unrelated check failure an error cell, never a fail or a detection", () => {
    const world = syntheticWorld();
    const mixed = copyDraft(world.job, "buggy");
    observe(mixed, "tzarg.la-day-counts", "assertion_fail", "bucket_labels_mismatch");
    observe(mixed, "tzarg.auckland-day-counts", "pass", null);
    const control = copyDraft(world.job, "buggy");
    observe(control, "tzarg.utc-day-counts", "assertion_fail", "local_day_counts_mismatch");
    const detected = copyDraft(world.job, "buggy");
    const cells = [mixed, control, detected].map((draft) => {
      const read = readCopyResults(world.pins, { state: "buggy", outcome: "ran", resultsDir: writeCopyResults(world.job, draft) });
      const copy: CopyRecord = { ...record("buggy", "pass", "pass"), status: read.status, original_suite: read.original_suite, verification: read.verification };
      return [copy.status, adapter.interpret([copy], UMAMI_PROTOCOL)] as const;
    });
    expect(cells.map(([status, item]) => [status, item.verification.observed, item.verification.runs_valid, item.verification.failure_codes])).toEqual([
      ["invalid", "error", 0, []],
      ["invalid", "error", 0, []],
      ["complete", "fail", 1, ["local_day_counts_mismatch"]],
    ]);
  });
});
