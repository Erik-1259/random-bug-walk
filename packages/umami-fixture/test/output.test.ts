import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OBSERVATION_FIELDS, writeObservation } from "../src/index.ts";

let outputDir = "";

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), "rbw-umami-fixture-output-"));
});

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(outputDir, path), "utf8")) as Record<string, unknown>;
}

describe("writeObservation", () => {
  it("writes the exact response bytes and an observation whose hash matches them", () => {
    const body = Buffer.from('{"pageviews":[],"sessions":[]} \n');
    const observation = writeObservation(outputDir, {
      check_id: "tzarg.la-day-counts",
      repeat_index: 3,
      observed: "assertion_fail",
      failure_code: "bucket_labels_mismatch",
      duration_ms: 41.6,
      response_body: body,
    });
    expect(readFileSync(join(outputDir, "responses/tzarg.la-day-counts.json")).equals(body)).toBe(true);
    const written = readJson("observations/tzarg.la-day-counts.json");
    expect(written).toEqual(observation);
    expect(Object.keys(written)).toEqual([...OBSERVATION_FIELDS]);
    expect(written).toEqual({
      check_id: "tzarg.la-day-counts",
      repeat_index: 3,
      observed: "assertion_fail",
      failure_code: "bucket_labels_mismatch",
      duration_ms: 42,
      response_artifact_key: "responses/tzarg.la-day-counts.json",
      response_artifact_sha256: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("sets both artifact fields to null and writes no response when there was none", () => {
    const observation = writeObservation(outputDir, {
      check_id: "tzarg.utc-day-counts",
      repeat_index: 1,
      observed: "setup_fail",
      failure_code: "seed_failed",
      duration_ms: 0,
      response_body: null,
    });
    expect(observation.response_artifact_key).toBeNull();
    expect(observation.response_artifact_sha256).toBeNull();
    expect(readdirSync(join(outputDir, "observations"))).toEqual(["tzarg.utc-day-counts.json"]);
    expect(readdirSync(outputDir)).toEqual(["observations"]);
    expect(Object.keys(readJson("observations/tzarg.utc-day-counts.json"))).toEqual([...OBSERVATION_FIELDS]);
  });

  it("refuses to overwrite an observation already written in the round", () => {
    const input = {
      check_id: "tzarg.utc-day-counts",
      repeat_index: 1,
      observed: "pass",
      failure_code: null,
      duration_ms: 5,
      response_body: Buffer.from("{}"),
    } as const;
    writeObservation(outputDir, input);
    expect(() => writeObservation(outputDir, input)).toThrow();
  });

  it("refuses a pass with a failure code", () => {
    expect(() =>
      writeObservation(outputDir, {
        check_id: "tzarg.utc-day-counts",
        repeat_index: 1,
        observed: "pass",
        failure_code: "local_day_counts_mismatch",
        duration_ms: 5,
        response_body: null,
      }),
    ).toThrow();
  });
});
