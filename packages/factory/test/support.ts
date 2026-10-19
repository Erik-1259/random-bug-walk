import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Capabilities, CellObservation, CopyRecord, CopyState, Event, Interpretation, RequestStatus } from "@rbw/factory-contract";
import { parseCriteriaCatalog } from "../src/criteria.ts";
import type { CriteriaCatalog } from "../src/criteria.ts";
import type { CellMatrix, HarnessResult } from "../src/ports.ts";
import { FAKE_HARNESS } from "../src/testing/harness.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const FIXTURES = join(REPO_ROOT, "docs", "product", "fixtures", "bug-request-v1");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

export function statusFixture(name: string): RequestStatus {
  return fixture(name) as RequestStatus;
}

export function interpretationFixture(name: string): Interpretation {
  return fixture(name) as Interpretation;
}

/** The criteria catalog the contract fixtures publish (capabilities.json), version "1". */
export function fixtureCatalog(): CriteriaCatalog {
  const capabilities = fixture("capabilities.json") as Capabilities;
  return parseCriteriaCatalog({
    criteria_catalog_version: capabilities.interpreter.criteria_catalog_version,
    filler_phrases: capabilities.interpreter.filler_phrases,
    bug_types: capabilities.bug_types,
  });
}

export function cell(observed: CellObservation["observed"], codes: string[] = [], runs = 3): CellObservation {
  return { observed, runs_valid: observed === "error" ? 0 : runs, runs_total: runs, failure_codes: codes, detail: `detail ${observed}` };
}

/** The qualifying matrix with `codes` on the buggy verification cell, changed by `edit`. */
export function matrix(codes: string[] = ["acknowledged_completion_not_counted"], edit?: (m: CellMatrix) => void): CellMatrix {
  const m: CellMatrix = {
    original_suite: { clean: cell("pass"), buggy: cell("pass"), fixed: cell("pass") },
    verification: { clean: cell("pass"), buggy: cell("fail", codes), fixed: cell("pass") },
  };
  edit?.(m);
  return m;
}

export function record(state: CopyState, status: CopyRecord["status"] = "complete"): CopyRecord {
  return {
    copy_id: `copy-${state}`,
    state,
    status,
    original_suite: { ...cell("pass"), executed: 1, expected: 1, failing_test_ids: [], suite_sha256: "5a".repeat(32) },
    verification: cell(state === "buggy" ? "fail" : "pass"),
    image_digest: `sha256:${"e9".repeat(32)}`,
    architecture: "amd64",
    started_at: "2026-10-20T14:00:00.000Z",
    finished_at: "2026-10-20T14:01:00.000Z",
    evidence_sha256: "e8".repeat(32),
  };
}

export function harnessResult(overrides: Partial<HarnessResult> = {}): HarnessResult {
  return {
    result: "passed",
    stopped: false,
    package_sha256: { bug_case: "b1".repeat(32), validator: "f1".repeat(32) },
    harness: FAKE_HARNESS,
    matrix: matrix(),
    records: [record("clean"), record("buggy"), record("fixed")],
    integrity: "verified",
    message: null,
    ...overrides,
  };
}

export function interpretationOf(status: RequestStatus): Interpretation {
  return status.interpretation;
}

export function eventsOf(status: RequestStatus): Event[] {
  return status.events;
}

/** A clock that advances 1 ms per call from a start time. */
export function steppingClock(start: string): () => Date {
  let now = Date.parse(start);
  return () => {
    const value = new Date(now);
    now += 1;
    return value;
  };
}
