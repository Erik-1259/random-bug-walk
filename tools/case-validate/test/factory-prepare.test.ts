import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCase } from "@rbw/case-package";
import { syntheticAdapter, syntheticIdentity } from "@rbw/case-package/synthetic";
import { caseId, criteriaCatalogV1, defectId } from "@rbw/factory";
import { createTaskReportAdapter } from "@rbw/host-task-report/adapter";
import type { BaselineIdentity, CatalogEntry } from "@rbw/factory-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CASE_IDENTITY, HOST_REGISTRY, prepareRegistry } from "../src/factory-prepare.ts";
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
  it.skipIf(process.env.RBW_UMAMI_STORE !== undefined && process.env.RBW_UMAMI_STORE !== "")("re-exports the host registry when RBW_UMAMI_STORE is not set", () => {
    expect(HOST_REGISTRY).toBe(REGISTRY);
  });

  it("keeps the harness registry without a store, and gives the Umami adapter the store RBW_UMAMI_STORE names", async () => {
    expect(prepareRegistry({})).toBe(REGISTRY);
    expect(prepareRegistry({ RBW_UMAMI_STORE: "" })).toBe(REGISTRY);
    // A store whose index is not a prepared store's: the adapter given it reads it and refuses it as
    // invalid, where the harness's adapter refuses for having no store at all.
    const store = join(workdir, "store");
    await mkdir(store);
    await writeFile(join(store, "index.json"), "{}\n");
    const withStore = prepareRegistry({ RBW_UMAMI_STORE: store });
    expect(withStore).not.toBe(REGISTRY);
    expect(withStore.list().map((item) => [item.host_id, item.label, item.license])).toEqual(REGISTRY.list().map((item) => [item.host_id, item.label, item.license]));
    expect(withStore.get("task-report")?.adapter).toBe(REGISTRY.get("task-report")?.adapter);
    const umami = withStore.get("umami")?.adapter;
    const harness = REGISTRY.get("umami")?.adapter;
    if (umami === undefined || harness === undefined) throw new Error("umami is not registered");
    expect(umami.catalog()).toEqual(harness.catalog());
    const entry = umami.catalog()[0];
    if (entry === undefined) throw new Error("empty umami catalog");
    await expect(harness.bugCaseInputs(entry)).rejects.toMatchObject({ code: "store_missing" });
    await expect(umami.bugCaseInputs(entry)).rejects.toMatchObject({ code: "store_invalid" });
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
