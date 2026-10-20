import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCase } from "@rbw/case-package";
import { syntheticAdapter, syntheticIdentity } from "@rbw/case-package/synthetic";
import { caseId, criteriaCatalogV1, defectId } from "@rbw/factory";
import { createTaskReportAdapter } from "@rbw/host-task-report/adapter";
import type { BaselineIdentity, CatalogEntry } from "@rbw/factory-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CASE_IDENTITY, HOST_REGISTRY } from "../src/factory-prepare.ts";
import { HOST_REGISTRY as REGISTRY } from "../src/registry.ts";

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "case-validate-prepare-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** The factory core's own case ID for an entry, as the request loop computes it. */
function coreCaseId(baseline: BaselineIdentity, entry: CatalogEntry): string {
  return caseId({ defect_id: defectId(baseline, entry), entry, criteria_catalog_version: criteriaCatalogV1().criteria_catalog_version });
}

describe("factory-prepare module", () => {
  it("re-exports the host registry", () => {
    expect(HOST_REGISTRY).toBe(REGISTRY);
  });

  it("gives the factory core's defect and case IDs for the task-report catalog entry", () => {
    const adapter = HOST_REGISTRY.get("task-report")?.adapter;
    if (adapter === undefined) throw new Error("task-report is not registered");
    const baseline = adapter.baseline();
    const entries = adapter.catalog();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const defect = CASE_IDENTITY.defectId(baseline, entry);
      expect(defect).toBe(defectId(baseline, entry));
      expect(CASE_IDENTITY.caseId(defect, entry)).toBe(coreCaseId(baseline, entry));
      // The synthetic stand-in gives another ID, so a prepare run with it would not match the core.
      expect(syntheticIdentity.caseId(syntheticIdentity.defectId(baseline, entry), entry)).not.toBe(coreCaseId(baseline, entry));
    }
  });

  it("exports the task-report entry under the factory core's case ID", async () => {
    const adapter = createTaskReportAdapter({ workDir: join(workdir, "inputs") });
    const entry = adapter.catalog()[0];
    if (entry === undefined) throw new Error("empty task-report catalog");
    const prepared = await exportCase({ adapter, entry, identity: CASE_IDENTITY, license: "MIT", scan: null });
    expect(prepared.case_id).toBe(coreCaseId(adapter.baseline(), entry));
    expect(prepared.defect_id).toBe(defectId(adapter.baseline(), entry));
    expect(prepared.validator_core.manifest.case_id).toBe(prepared.case_id);
    expect(prepared.bug_case.manifest.case_id).toBe(prepared.case_id);
  });

  it("exports a synthetic entry under the factory core's case ID", async () => {
    const adapter = syntheticAdapter({ seeds: ["01"], workdir });
    const entry = adapter.catalog()[0];
    if (entry === undefined) throw new Error("empty synthetic catalog");
    const prepared = await exportCase({ adapter, entry, identity: CASE_IDENTITY, license: "MIT", scan: null });
    expect(prepared.case_id).toBe(coreCaseId(adapter.baseline(), entry));
  });
});
