import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeEvidence, OBSERVATION_FIELDS, writeObservation, type DoubleSpendEvidence } from "../src/index.ts";

let outputDir = "";

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), "rbw-umami-fixture-rc1-output-"));
});

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

const evidence: DoubleSpendEvidence = {
  check_id: "rc1.backup-code-concurrent-double-spend",
  kind: "concurrent_double_spend",
  attempts: [
    { sent_ms: 0, settled_ms: 612.5, status: 200, error_code: null, token_issued: true, failure: null },
    { sent_ms: 0.3, settled_ms: 640.1, status: 200, error_code: null, token_issued: true, failure: null },
  ],
  overlap_ms: 612.2,
};

describe("writeObservation", () => {
  it("writes the evidence as the response artifact, so the overlap timing reaches the driver's trial records", () => {
    const body = encodeEvidence(evidence);
    const observation = writeObservation(outputDir, {
      check_id: evidence.check_id,
      repeat_index: 4,
      observed: "assertion_fail",
      failure_code: "double_spend",
      duration_ms: 1201.4,
      response_body: body,
    });
    expect(JSON.parse(readFileSync(join(outputDir, "responses", `${evidence.check_id}.json`), "utf8"))).toEqual(evidence);
    const written = JSON.parse(readFileSync(join(outputDir, "observations", `${evidence.check_id}.json`), "utf8")) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([...OBSERVATION_FIELDS]);
    expect(written).toEqual(observation);
    expect(written).toEqual({
      check_id: evidence.check_id,
      repeat_index: 4,
      observed: "assertion_fail",
      failure_code: "double_spend",
      duration_ms: 1201,
      response_artifact_key: `responses/${evidence.check_id}.json`,
      response_artifact_sha256: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("writes no response file when no verify request was sent", () => {
    writeObservation(outputDir, { check_id: "rc1.backup-code-serial-reuse", repeat_index: 1, observed: "setup_fail", failure_code: "auth_failed", duration_ms: 3, response_body: null });
    expect(readdirSync(outputDir)).toEqual(["observations"]);
  });

  it("refuses a second write for the same check in a round", () => {
    const input = { check_id: "rc1.backup-code-serial-reuse", repeat_index: 1, observed: "pass", failure_code: null, duration_ms: 3, response_body: null } as const;
    writeObservation(outputDir, input);
    expect(() => writeObservation(outputDir, input)).toThrow();
  });
});
