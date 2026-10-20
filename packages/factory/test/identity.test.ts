import { createHash } from "node:crypto";
import { canonicalDigest } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import {
  FACTORY_REQUEST_NAMESPACE,
  FACTORY_VALIDATION_NAMESPACE,
  budgetKey,
  candidateId,
  caseId,
  copyExecutionId,
  defectId,
  environmentSha256,
  factoryProjectId,
  mutationSha256,
  requestRoot,
  uuidV5,
  validationRoot,
} from "../src/identity.ts";
import { SYNTHETIC_BASELINES, syntheticEntry } from "../src/testing/catalog.ts";

const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const entry = syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n: 1, criteria: ["concurrency.lost-acknowledged-change"] });
const baseline = SYNTHETIC_BASELINES["task-report"];

describe("namespaces and roots", () => {
  it("derives both namespaces as UUIDv5 of the URL namespace and their URNs", () => {
    expect(uuidV5(URL_NAMESPACE, "urn:rbw:factory:request:v1")).toBe(FACTORY_REQUEST_NAMESPACE);
    expect(uuidV5(URL_NAMESPACE, "urn:rbw:factory:validation:v1")).toBe(FACTORY_VALIDATION_NAMESPACE);
  });

  it("matches the RFC 4122 example of a version 5 UUID", () => {
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("derives a request root and a validation root under their own namespaces", () => {
    const id = "00000000-0000-4000-8000-000000000101";
    expect(requestRoot(id)).toBe(uuidV5(FACTORY_REQUEST_NAMESPACE, id));
    expect(validationRoot(id)).toBe(uuidV5(FACTORY_VALIDATION_NAMESPACE, id));
    expect(requestRoot(id)).not.toBe(validationRoot(id));
    expect(factoryProjectId("factory")).toBe(uuidV5(FACTORY_REQUEST_NAMESPACE, "factory"));
  });

  it("refuses IDs that are not lowercase UUIDs", () => {
    expect(() => requestRoot("00000000-0000-4000-8000-00000000010A")).toThrow(/lowercase UUID/);
    expect(() => validationRoot("x")).toThrow(/lowercase UUID/);
  });

  it("keys a request's budget by the canonical digest of its kind and request ID", () => {
    const id = "00000000-0000-4000-8000-000000000101";
    const key = budgetKey(id);
    expect(key).toBe(canonicalDigest({ schema_version: 1, kind: "factory.request_budget", request_id: id }).sha256);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Pinned: the spend ledger stores budgets under these keys, so the formula must not change.
    expect(key).toBe("e8bd9cbf3c7fbc3ea27bde0afca3f6932712e06e1755c397ef4ab7ae99d5aca6");
    expect(budgetKey(id)).toBe(key);
    expect(budgetKey("00000000-0000-4000-8000-000000000102")).not.toBe(key);
  });

  it("refuses a budget key for a request ID that is not a lowercase UUID", () => {
    expect(() => budgetKey("00000000-0000-4000-8000-00000000010A")).toThrow(/lowercase UUID/);
    expect(() => budgetKey("")).toThrow(/lowercase UUID/);
  });

  it("names each copy's execution under its root's namespace", () => {
    const root = requestRoot("00000000-0000-4000-8000-000000000101");
    const candidate = candidateId(entry);
    expect(copyExecutionId({ kind: "request", root, subject_id: candidate, state: "buggy", n: 1 })).toBe(uuidV5(FACTORY_REQUEST_NAMESPACE, `${root}:${candidate}:buggy-1`));
    expect(copyExecutionId({ kind: "validation", root, subject_id: candidate, state: "buggy", n: 1 })).toBe(uuidV5(FACTORY_VALIDATION_NAMESPACE, `${root}:${candidate}:buggy-1`));
    expect(() => copyExecutionId({ kind: "request", root, subject_id: candidate, state: "buggy", n: 0 })).toThrow(/positive integer/);
  });
});

describe("defect, case and candidate IDs", () => {
  it("computes the defect from the host, the baseline and the sorted plant targets only", () => {
    const expected = canonicalDigest({
      schema_version: 1,
      host_id: "task-report",
      baseline: { baseline_id: baseline.baseline_id, app_commit: baseline.app_commit, original_suite_sha256: baseline.original_suite.sha256 },
      mutation_sha256: canonicalDigest(entry.plant.targets).sha256,
    }).sha256;
    expect(defectId(baseline, entry)).toBe(expected);
    const reworded = { ...entry, presentation: { ...entry.presentation, title: "Other words" }, entry_id: "synthetic-other", plant: { ...entry.plant, patch: "other patch text\n" } };
    expect(defectId(baseline, reworded)).toBe(expected);
  });

  it("orders plant targets by path, so their listed order does not change the defect", () => {
    const a = { path: "b.ts", before_sha256: "1".repeat(64), after_sha256: "2".repeat(64) };
    const b = { path: "a.ts", before_sha256: "3".repeat(64), after_sha256: "4".repeat(64) };
    expect(mutationSha256({ plant: { ...entry.plant, targets: [a, b] } })).toBe(mutationSha256({ plant: { ...entry.plant, targets: [b, a] } }));
  });

  it("gives equal changes on different baselines different defects", () => {
    const other = { ...baseline, app_commit: "c9".repeat(20) };
    expect(defectId(other, entry)).not.toBe(defectId(baseline, entry));
    expect(() => defectId(SYNTHETIC_BASELINES.umami, entry)).toThrow(/host/);
  });

  it("computes the case from the defect, bug type, catalog version, checks, expectations, repair and runtime", () => {
    const defect = defectId(baseline, entry);
    const id = caseId({ defect_id: defect, entry, criteria_catalog_version: "1" });
    expect(id).toBe(
      canonicalDigest({
        schema_version: 1,
        defect_id: defect,
        bug_type_id: "concurrency",
        criteria_catalog_version: "1",
        check_set_sha256: entry.verification.check_set_sha256,
        expected_vectors_sha256: entry.verification.expected_vectors_sha256,
        reference_repair_sha256: entry.reference_repair.patch_sha256,
        environment_sha256: entry.environment.environment_sha256,
      }).sha256,
    );
    expect(caseId({ defect_id: defect, entry, criteria_catalog_version: "2" })).not.toBe(id);
  });

  it("computes the candidate from the source, catalog version and entry", () => {
    expect(candidateId(entry)).toBe(canonicalDigest({ schema_version: 1, source_id: entry.source_id, catalog_version: "1", entry_id: entry.entry_id }).sha256);
    expect(candidateId({ ...entry, entry_id: "synthetic-task-report-concurrency-02" })).not.toBe(candidateId(entry));
  });

  it("computes the environment from the host and the kit image digest", () => {
    const digest = `sha256:${createHash("sha256").update("x").digest("hex")}`;
    expect(environmentSha256("umami", digest)).toBe(canonicalDigest({ host_id: "umami", kit_image_digest: digest }).sha256);
  });
});
