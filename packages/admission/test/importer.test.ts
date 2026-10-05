import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalDigest } from "@rbw/schema";
import { ImportRefusal, evidenceErrors, importRecordSet, readOriginalSuiteOutcomes, type Evidence, type TrialEvidence } from "../src/index.ts";
import { RecordSetDir } from "../src/paths.ts";
import {
  AKL,
  KOL,
  LA,
  OTHER_TASK_REVISION,
  TEST_IDS,
  UTC,
  baselineDraft,
  cleanupRecordSets,
  dropObservation,
  observe,
  parseWrittenRecords,
  rebuildRequest,
  recordSet,
  responseKey,
  resultPath,
  tempDir,
  trial,
  trialKey,
  writeRecordSet,
} from "./support/record-set.ts";

afterAll(cleanupRecordSets);

function trialOf(evidence: Evidence, trialId: string): TrialEvidence {
  const found = evidence.trials.find((item) => item.trial_id === trialId);
  if (found === undefined) throw new Error(`no trial ${trialId} in the evidence`);
  return found;
}

function refusal(dir: string): string {
  try {
    importRecordSet(dir);
  } catch (error) {
    if (error instanceof ImportRefusal) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

const stageOf = (trialEvidence: TrialEvidence): unknown => ({ status: trialEvidence.status, stage: trialEvidence.stage, code: trialEvidence.code, reason: trialEvidence.reason });

describe("synthetic record sets", () => {
  it.each(["admission", "kit_check", "judge_verify"] as const)("writes a %s baseline whose every record passes parseRecord", (kind) => {
    const draft = baselineDraft(kind);
    const dir = writeRecordSet(draft);
    expect(() => {
      parseWrittenRecords(draft, (key) => readFileSync(join(dir, key)));
    }).not.toThrow();
  });
});

describe("baseline import", () => {
  let evidence: Evidence;
  beforeAll(() => {
    evidence = importRecordSet(recordSet());
  });

  it("imports all 13 admission trials in manifest order as complete at the outcomes stage", () => {
    expect(evidence.trials.map((item) => item.trial_id)).toEqual(baselineDraft().manifest.trials.map((item) => item.trial_id));
    for (const item of evidence.trials) expect(stageOf(item)).toEqual({ status: "complete", stage: "outcomes", code: null, reason: null });
    expect(evidence.unexpected_results).toEqual([]);
  });

  it("conforms to the evidence shape and carries the request identity", () => {
    expect(evidenceErrors(evidence)).toEqual([]);
    expect(evidence.request.kind).toBe("admission");
    expect(evidence.request.task_revision).toBe(baselineDraft().request.task_revision);
  });

  it("keeps every repetition's classification, with negative-control evidence on planted copies", () => {
    const planted = trialOf(evidence, "planted-01");
    expect(planted.added?.verdict).toBe("match");
    expect(planted.added?.observations).toHaveLength(80);
    const la = planted.added?.observations.filter((item) => item.check_id === LA) ?? [];
    expect(la.map((item) => item.classification)).toEqual(Array<string>(20).fill("negative_control"));
    const utc = planted.added?.observations.filter((item) => item.check_id === UTC) ?? [];
    expect(new Set(utc.map((item) => item.classification))).toEqual(new Set(["positive"]));
  });

  it("records every original test outcome and the listed artifacts", () => {
    const clean = trialOf(evidence, "clean-01");
    expect(clean.original).toEqual({ tests: TEST_IDS.map((id) => ({ test_id: id, outcome: "passed" })), failed_test_ids: [] });
    expect(clean.original_suite_key).toBe(trialKey("clean-01", "original-suite-outcomes.json"));
    expect(clean.artifact_keys).toContain(responseKey("clean-01", KOL, 1));
  });
});

describe("added-check classification", () => {
  it("gives incomplete for a missing repetition", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      dropObservation(draft, "fixed-01", AKL, 17);
    }));
    expect(stageOf(trialOf(evidence, "fixed-01"))).toEqual({ status: "incomplete", stage: "completeness", code: "import:check_missing", reason: "test_missing" });
  });

  it("gives invalid for an unrelated code on a negative check", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      observe(draft, "planted-02", LA, 1, "assertion_fail", "bucket_labels_mismatch");
    }));
    const planted = trialOf(evidence, "planted-02");
    expect(stageOf(planted)).toEqual({ status: "invalid", stage: "outcomes", code: "import:outcome_unrelated_code", reason: "unrelated_failure" });
    expect(planted.added?.observations.find((item) => item.check_id === LA)?.classification).toBe("invalid");
  });

  it("gives a rejection for a valid unexpected pass, keeping the trial complete", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      observe(draft, "planted-02", LA, 1, "pass", null);
    }));
    const planted = trialOf(evidence, "planted-02");
    expect(stageOf(planted)).toEqual({ status: "complete", stage: "outcomes", code: null, reason: null });
    expect(planted.added?.verdict).toBe("reject");
  });

  it("gives a rejection for a valid failure of a positive check, never an infrastructure failure", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      observe(draft, "fixed-03", LA, 1, "assertion_fail", "local_day_counts_mismatch");
    }));
    const fixed = trialOf(evidence, "fixed-03");
    expect(fixed.status).toBe("complete");
    expect(fixed.added?.verdict).toBe("reject");
    expect(fixed.added?.observations.find((item) => item.check_id === LA)?.classification).toBe("reject");
  });

  it("gives invalid with the observation's code for a setup failure", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      observe(draft, "planted-03", LA, 1, "setup_fail", "auth_failed");
    }));
    expect(stageOf(trialOf(evidence, "planted-03"))).toEqual({ status: "invalid", stage: "outcomes", code: "import:outcome_setup_fail", reason: "auth_failed" });
  });

  it("lets a rejection win over an invalid observation in the same trial", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      observe(draft, "planted-02", LA, 1, "pass", null);
      observe(draft, "planted-02", AKL, 1, "setup_fail", "seed_failed");
    }));
    expect(trialOf(evidence, "planted-02").added?.verdict).toBe("reject");
  });
});

describe("importer order", () => {
  it("reports non-canonical result bytes at shape", () => {
    const dir = recordSet(undefined, (root) => {
      const path = join(root, resultPath("fixed-02"));
      writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, "utf8")), null, 2));
    });
    expect(stageOf(trialOf(importRecordSet(dir), "fixed-02"))).toEqual({ status: "invalid", stage: "shape", code: "import:shape_result", reason: null });
  });

  it("reports an unknown result field at shape", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-02").resultPatch = { synthetic_extra: "x" };
    }));
    expect(stageOf(trialOf(evidence, "fixed-02"))).toEqual({ status: "invalid", stage: "shape", code: "import:shape_result", reason: null });
  });

  it("reports an unknown field in the original-suite outcomes at shape", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "clean-01").outcomesPatch = { synthetic_extra: "x" };
    }));
    expect(stageOf(trialOf(evidence, "clean-01"))).toEqual({ status: "invalid", stage: "shape", code: "import:shape_original_suite", reason: null });
  });

  it("reports a result with a different task revision at identity", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-02").resultPatch = { task_revision: OTHER_TASK_REVISION };
    }));
    expect(stageOf(trialOf(evidence, "fixed-02"))).toEqual({ status: "invalid", stage: "identity", code: "import:identity_request", reason: null });
  });

  it("reports a code state that differs from the manifest at identity", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-02").resultPatch = { code_state: "planted" };
    }));
    expect(stageOf(trialOf(evidence, "fixed-02"))).toEqual({ status: "invalid", stage: "identity", code: "import:identity_code_state", reason: null });
  });

  it("refuses a result under results/ for a trial the manifest does not list, at identity", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      draft.extraResults.set("fixed-06", Buffer.from("{}"));
    }));
    expect(evidence.unexpected_results).toEqual([{ name: "fixed-06", status: "invalid", stage: "identity", code: "import:identity_unexpected_trial" }]);
    expect(evidence.trials).toHaveLength(13);
  });

  it("never merges a result filed under another trial's directory", () => {
    const dir = recordSet(undefined, (root) => {
      writeFileSync(join(root, resultPath("fixed-03")), readFileSync(join(root, resultPath("fixed-02"))));
    });
    const evidence = importRecordSet(dir);
    expect(stageOf(trialOf(evidence, "fixed-03"))).toEqual({ status: "invalid", stage: "identity", code: "import:identity_trial_id", reason: null });
    expect(trialOf(evidence, "fixed-02").status).toBe("complete");
  });

  it("reports an artifact manifest for another trial at identity", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-02").manifestPatch = { trial_id: "fixed-03" };
    }));
    expect(stageOf(trialOf(evidence, "fixed-02"))).toEqual({ status: "invalid", stage: "identity", code: "import:identity_artifacts", reason: null });
  });

  it("reports original-suite outcomes for another suite at identity", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "clean-01").outcomesPatch = { original_suite_sha256: "9".repeat(64) };
    }));
    expect(stageOf(trialOf(evidence, "clean-01"))).toEqual({ status: "invalid", stage: "identity", code: "import:identity_original_suite", reason: null });
  });

  it("reports changed response bytes at provenance", () => {
    const dir = recordSet(undefined, (root) => {
      writeFileSync(join(root, responseKey("fixed-02", LA, 1)), '{"synthetic":"changed"}');
    });
    expect(stageOf(trialOf(importRecordSet(dir), "fixed-02"))).toEqual({ status: "incomplete", stage: "provenance", code: "import:artifact_hash_mismatch", reason: "artifact_hash_mismatch" });
  });

  it("reports a deleted artifact at provenance", () => {
    const dir = recordSet(undefined, (root) => {
      rmSync(join(root, responseKey("fixed-02", LA, 1)));
    });
    expect(stageOf(trialOf(importRecordSet(dir), "fixed-02"))).toEqual({ status: "incomplete", stage: "provenance", code: "import:artifact_missing", reason: "artifact_missing" });
  });

  it("reports a response key that the artifact manifest does not list at provenance", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-02").unlisted.add(responseKey("fixed-02", LA, 1));
    }));
    expect(stageOf(trialOf(evidence, "fixed-02"))).toEqual({ status: "incomplete", stage: "provenance", code: "import:response_unlisted", reason: "artifact_missing" });
  });

  it("reports a placeholder hash with no matching bytes at provenance", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-02").entryPatch.set(responseKey("fixed-02", LA, 1), { sha256: "a".repeat(64) });
    }));
    expect(stageOf(trialOf(evidence, "fixed-02"))).toEqual({ status: "incomplete", stage: "provenance", code: "import:artifact_hash_mismatch", reason: "artifact_hash_mismatch" });
  });

  it("reports a changed observations file at provenance", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-02").resultPatch = { observations_sha256: "b".repeat(64) };
    }));
    expect(stageOf(trialOf(evidence, "fixed-02"))).toEqual({ status: "incomplete", stage: "provenance", code: "import:observations_hash_mismatch", reason: "artifact_hash_mismatch" });
  });

  it("reports a trial with a shape error and a rejecting outcome at shape only", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      observe(draft, "planted-02", LA, 1, "pass", null);
      trial(draft, "planted-02").resultPatch = { synthetic_extra: "x" };
    }));
    const planted = trialOf(evidence, "planted-02");
    expect(stageOf(planted)).toEqual({ status: "invalid", stage: "shape", code: "import:shape_result", reason: null });
    expect(planted.added).toBeNull();
  });

  it("reports a trial with a missing repetition and an unexpected pass at completeness", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      dropObservation(draft, "planted-01", LA, 5);
      observe(draft, "planted-01", AKL, 6, "pass", null);
    }));
    const planted = trialOf(evidence, "planted-01");
    expect(stageOf(planted)).toEqual({ status: "incomplete", stage: "completeness", code: "import:check_missing", reason: "test_missing" });
    expect(planted.added).toBeNull();
  });

  it("reports an observation above the repeat count as invalid at completeness", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-02").observations.push({ check_id: UTC, repeat_index: 2, observed: "pass", failure_code: null, duration_ms: 40, response_artifact_key: null, response_artifact_sha256: null });
    }));
    expect(stageOf(trialOf(evidence, "fixed-02"))).toEqual({ status: "invalid", stage: "completeness", code: "import:repeat_unexpected", reason: null });
  });

  it("reports an original test that is not expected as invalid at completeness", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "clean-01").tests?.push({ test_id: "synthetic-spec-9999", outcome: "passed" });
    }));
    expect(stageOf(trialOf(evidence, "clean-01"))).toEqual({ status: "invalid", stage: "completeness", code: "import:test_unexpected", reason: null });
  });

  it("reports a trial with no original-suite outcomes entry as incomplete at completeness", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "clean-01").tests = null;
    }));
    expect(stageOf(trialOf(evidence, "clean-01"))).toEqual({ status: "incomplete", stage: "completeness", code: "import:test_missing", reason: "test_missing" });
  });
});

describe("driver status", () => {
  it("never upgrades a driver invalid result, and keeps its observations only as diagnostics", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "stub-01").status = "invalid";
      trial(draft, "stub-01").invalidReason = "build_failed";
    }));
    const stub = trialOf(evidence, "stub-01");
    expect(stageOf(stub)).toEqual({ status: "invalid", stage: "driver", code: "import:driver_status", reason: "build_failed" });
    expect(stub.driver_status).toBe("invalid");
    expect(stub.added).toBeNull();
    expect(stub.diagnostics).toHaveLength(4);
  });

  it("keeps no diagnostics from observations that belong to another trial", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "stub-01").status = "invalid";
      trial(draft, "stub-01").invalidReason = "build_failed";
      trial(draft, "stub-01").observationsPatch = { trial_id: "partial-01" };
    }));
    expect(trialOf(evidence, "stub-01").diagnostics).toBeNull();
  });

  it("never upgrades a driver incomplete result whose observations look complete", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-05").status = "incomplete";
      trial(draft, "fixed-05").invalidReason = "timeout";
    }));
    expect(stageOf(trialOf(evidence, "fixed-05"))).toEqual({ status: "incomplete", stage: "driver", code: "import:driver_status", reason: "timeout" });
  });

  it("downgrades a complete result whose observations show not_run to incomplete", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      observe(draft, "fixed-02", KOL, 1, "not_run", "timeout");
    }));
    const fixed = trialOf(evidence, "fixed-02");
    expect(fixed.driver_status).toBe("complete");
    expect(stageOf(fixed)).toEqual({ status: "incomplete", stage: "outcomes", code: "import:outcome_not_run", reason: "timeout" });
  });

  it("reports a missing result as incomplete with artifact_missing", () => {
    const evidence = importRecordSet(recordSet((draft) => {
      trial(draft, "fixed-04").write = false;
    }));
    expect(stageOf(trialOf(evidence, "fixed-04"))).toEqual({ status: "incomplete", stage: "completeness", code: "import:result_missing", reason: "artifact_missing" });
  });
});

describe("request-level refusals", () => {
  it("refuses a manifest whose hash does not match the request", () => {
    expect(refusal(recordSet((draft) => {
      rebuildRequest(draft, { expected_trials_sha256: "9".repeat(64) });
    }))).toBe("import:expected_trials_hash");
  });

  it("refuses a request that fails parse", () => {
    expect(refusal(recordSet(undefined, (root) => {
      writeFileSync(join(root, "request.json"), "{");
    }))).toBe("import:request_invalid");
  });

  it("refuses a directory with no request", () => {
    expect(refusal(tempDir())).toBe("import:request_missing");
  });

  it("refuses an expected-trials key with a .. segment or an absolute path, which the request schema rejects", () => {
    for (const key of ["../outside.json", "/outside.json"]) {
      const dir = recordSet(undefined, (root) => {
        const request = JSON.parse(readFileSync(join(root, "request.json"), "utf8")) as Record<string, unknown>;
        writeFileSync(join(root, "request.json"), canonicalDigest({ ...request, expected_trials_key: key }).bytes);
      });
      expect(refusal(dir)).toBe("import:request_invalid");
    }
  });

  it("refuses an expected-trials key that resolves outside the root through a symlink", () => {
    const outside = tempDir();
    const dir = recordSet(undefined, (root) => {
      renameSync(join(root, "jobs"), join(outside, "jobs"));
      symlinkSync(join(outside, "jobs"), join(root, "jobs"));
    });
    expect(refusal(dir)).toBe("import:key_unsafe");
  });

  it("refuses a manifest that does not follow the kind's profile", () => {
    const draft = baselineDraft();
    draft.manifest.trials.pop();
    rebuildRequest(draft, { expected_trials_sha256: canonicalDigest(draft.manifest).sha256 });
    draft.trials.delete("stub-01");
    expect(refusal(writeRecordSet(draft))).toBe("import:expected_trials_invalid");
  });
});

describe("record-set keys", () => {
  const root = tempDir();
  mkdirSync(join(root, "inside"));
  writeFileSync(join(root, "inside", "file.json"), "{}");
  const outside = tempDir();
  writeFileSync(join(outside, "secret.json"), "{}");
  symlinkSync(join(outside, "secret.json"), join(root, "inside", "link.json"));
  const dir = new RecordSetDir(root);

  it("reads a key inside the root", () => {
    expect(dir.read("inside/file.json")).toEqual({ kind: "ok", bytes: Buffer.from("{}") });
  });

  it.each(["../secret.json", "/etc/hostname", "inside/../inside/file.json", "./inside/file.json", "inside//file.json", ""])("refuses the key %j before reading it", (key) => {
    expect(dir.read(key)).toEqual({ kind: "unsafe" });
  });

  it("refuses a key that resolves outside the root through a symlink", () => {
    expect(dir.read("inside/link.json")).toEqual({ kind: "unsafe" });
  });

  it("reports a missing key as missing", () => {
    expect(dir.read("inside/none.json")).toEqual({ kind: "missing" });
  });

  it("refuses a trial key that escapes through a symlink, marking the trial invalid", () => {
    const outsideTrials = tempDir();
    const recordDir = recordSet(undefined, (records) => {
      renameSync(join(records, "trials", "fixed-02"), join(outsideTrials, "fixed-02"));
      symlinkSync(join(outsideTrials, "fixed-02"), join(records, "trials", "fixed-02"));
    });
    expect(stageOf(trialOf(importRecordSet(recordDir), "fixed-02"))).toEqual({ status: "invalid", stage: "shape", code: "import:key_unsafe", reason: null });
  });
});

describe("other job kinds", () => {
  it("imports a kit_check record set with five trials and no cells", () => {
    const evidence = importRecordSet(recordSet(undefined, undefined, "kit_check"));
    expect(evidence.trials.map((item) => item.status)).toEqual(Array<string>(5).fill("complete"));
    expect(evidence.cells).toBeNull();
  });

  it("imports a judge_verify record set with six cells", () => {
    const evidence = importRecordSet(recordSet(undefined, undefined, "judge_verify"));
    expect(evidence.cells?.map((cell) => [cell.trial_id, cell.suite, cell.state, cell.matches_expectation])).toEqual([
      ["clean-01", "original", "pass", true],
      ["clean-01", "added", "pass", true],
      ["planted-01", "original", "pass", true],
      ["planted-01", "added", "fail", true],
      ["fixed-01", "original", "pass", true],
      ["fixed-01", "added", "pass", true],
    ]);
  });
});

describe("original-suite outcomes reader", () => {
  const valid = { schema_version: 1, trial_id: "clean-01", original_suite_sha256: "1".repeat(64), tests: [{ test_id: "a", outcome: "passed" }, { test_id: "b", outcome: "skipped" }] };
  const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));

  it("reads canonical outcomes", () => {
    expect(readOriginalSuiteOutcomes(canonicalDigest(valid).bytes)).toEqual({ ok: true, value: valid });
  });

  it.each([
    ["an unknown field", { ...valid, extra: 1 }],
    ["an unknown test field", { ...valid, tests: [{ test_id: "a", outcome: "passed", extra: 1 }] }],
    ["an outcome outside the list", { ...valid, tests: [{ test_id: "a", outcome: "flaky" }] }],
    ["unsorted tests", { ...valid, tests: [{ test_id: "b", outcome: "passed" }, { test_id: "a", outcome: "passed" }] }],
    ["duplicate tests", { ...valid, tests: [{ test_id: "a", outcome: "passed" }, { test_id: "a", outcome: "failed" }] }],
    ["another schema version", { ...valid, schema_version: 2 }],
    ["a test ID with a space", { ...valid, tests: [{ test_id: "a b", outcome: "passed" }] }],
    ["a malformed suite hash", { ...valid, original_suite_sha256: "1" }],
    ["a missing field", { schema_version: 1, trial_id: "clean-01", tests: [] }],
  ])("refuses %s", (_name, value) => {
    expect(readOriginalSuiteOutcomes(canonicalDigest(value).bytes).ok).toBe(false);
  });

  it("refuses non-canonical bytes", () => {
    expect(readOriginalSuiteOutcomes(Buffer.from(JSON.stringify(valid, null, 1))).ok).toBe(false);
    expect(readOriginalSuiteOutcomes(bytes("{")).ok).toBe(false);
  });
});
