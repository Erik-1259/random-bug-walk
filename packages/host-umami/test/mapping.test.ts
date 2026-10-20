import { canonicalDigest } from "@rbw/schema";
import type { BaselineIdentity, CatalogEntry } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import { createUmamiAdapter } from "../src/adapter.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { RELEASED_CASE, releasedCaseMapping } from "../src/mapping.ts";
import type { FactoryIdentity } from "../src/mapping.ts";
import { UMAMI_PINS } from "../src/pins.ts";

const adapter = createUmamiAdapter();
const [entry] = adapter.catalog();
if (entry === undefined) throw new Error("the catalog is empty");

interface IdentityCalls {
  defect: { baseline: BaselineIdentity; entry: Pick<CatalogEntry, "host_id" | "plant"> }[];
  case: Parameters<FactoryIdentity["caseId"]>[0][];
}

/**
 * A synthetic stand-in for the factory's identity functions, with their signatures: defectId(baseline,
 * entry) and caseId({ defect_id, entry, criteria_catalog_version }). It records its inputs and returns
 * labeled values.
 */
function fakeIdentity(): { calls: IdentityCalls; identity: FactoryIdentity } {
  const calls: IdentityCalls = { defect: [], case: [] };
  return {
    calls,
    identity: {
      defectId: (baseline, candidate) => {
        calls.defect.push({ baseline, entry: candidate });
        return canonicalDigest({ synthetic: "defect", baseline: baseline.baseline_id }).sha256;
      },
      caseId: (input) => {
        calls.case.push(input);
        return canonicalDigest({ synthetic: "case", defect_id: input.defect_id, criteria_catalog_version: input.criteria_catalog_version }).sha256;
      },
    },
  };
}

const SYNTHETIC_DEFECT = canonicalDigest({ synthetic: "defect", baseline: "umami@ec0ff503" }).sha256;

describe("the released-case mapping record", () => {
  it("maps the released case's ID to the entry and the IDs the factory's defectId and caseId give", () => {
    const fake = fakeIdentity();
    const mapping = releasedCaseMapping(UMAMI_PINS, entry, fake.identity, "1");
    expect(fake.calls.defect).toEqual([{ baseline: adapter.baseline(), entry }]);
    // caseId takes the defect ID that defectId gave, the entry and the criteria catalog version.
    expect(fake.calls.case).toEqual([{ defect_id: SYNTHETIC_DEFECT, entry, criteria_catalog_version: "1" }]);
    expect(mapping).toEqual({
      schema_version: 1,
      released: {
        release_id: "319f3100-9ecf-441d-b7af-a643af9ae4e5",
        release_sha256: "838c51516c9dc2a75490ae81839792a99b6d388fc46f1a23a2d2bc0fa312c8b7",
        family_id: "umami-tz-arg-001",
        mutation_id: "4c2531a343d8250607df3ab84491e2d7e655849c1dbcb477264a5c126b21ccca",
        task_revision: "2db3f06590c33b6f165b9b39f8afea4dad6198de07606f136aef4b255c9b8f02",
        issue_sha256: "1a1d227377b5de18db1be03ddbb8aaf6d77ae7a5746cde37081922c3afc993c5",
        kit_image_digest: "sha256:295433e5a8b0dc81e1492a4d18220f5e1d323a78bc38cbb5eca688efde7863ff",
      },
      factory: {
        host_id: "umami",
        baseline_id: "umami@ec0ff503",
        entry_id: "umami-date-time-01",
        criteria_catalog_version: "1",
        defect_id: SYNTHETIC_DEFECT,
        case_id: canonicalDigest({ synthetic: "case", defect_id: SYNTHETIC_DEFECT, criteria_catalog_version: "1" }).sha256,
      },
    });
  });

  it("refuses an entry that is not the released defect", () => {
    const fake = fakeIdentity();
    const otherTarget = { ...entry, plant: { ...entry.plant, targets: [{ ...UMAMI_PINS.target, after_sha256: "0".repeat(64) }] } };
    const otherIncident = { ...entry, incident: { ...entry.incident, sha256: "1".repeat(64) } };
    for (const candidate of [otherTarget, otherIncident]) {
      expect(() => releasedCaseMapping(UMAMI_PINS, candidate, fake.identity, "1")).toThrow(UmamiRefusal);
    }
    expect(fake.calls).toEqual({ defect: [], case: [] });
  });

  it("keeps the release's own names only on the evaluator side: the entry's IDs carry none of them", () => {
    for (const id of [entry.entry_id, entry.source_id, entry.verification.check_set_id]) {
      expect(id).not.toContain(RELEASED_CASE.family_id);
      expect(id).not.toContain(RELEASED_CASE.release_id);
    }
  });
});
