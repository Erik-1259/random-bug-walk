import { canonicalDigest } from "@rbw/schema";
import { validateContract } from "@rbw/factory-contract/validate";
import { describe, expect, it } from "vitest";
import { createUmamiAdapter } from "../src/adapter.ts";
import { CRITERION, TIME_ZONE_FAILURE_CODE, buildCatalogEntry, checkEntryTargets } from "../src/catalog.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { UMAMI_PINS } from "../src/pins.ts";
import { UMAMI_PROTOCOL } from "../src/protocol.ts";

const adapter = createUmamiAdapter();
const [entry] = adapter.catalog();
if (entry === undefined) throw new Error("the catalog is empty");

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UmamiRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

describe("the baseline", () => {
  it("is umami@ec0ff503 with the original suite's identity (271 tests, its recorded suite hash)", () => {
    const baseline = adapter.baseline();
    expect(validateContract("BaselineIdentity", baseline)).toEqual([]);
    expect(baseline).toEqual({
      host_id: "umami",
      baseline_id: "umami@ec0ff503",
      app_commit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
      original_suite: UMAMI_PINS.original_suite,
    });
  });
});

describe("the catalog umami-date-time, version 1", () => {
  it("has one schema-valid entry for the date_time type and criterion date_time.time-zone-grouping v1", () => {
    expect(adapter.catalog()).toHaveLength(1);
    expect(validateContract("CatalogEntry", entry)).toEqual([]);
    expect(entry).toMatchObject({
      entry_id: "umami-date-time-01",
      source_id: "umami-date-time",
      catalog_version: "1",
      host_id: "umami",
      bug_type_id: "date_time",
      criteria: [{ criterion_id: "date_time.time-zone-grouping", version: "1" }],
      difficulty: { status: "not_assessed" },
    });
    expect(CRITERION).toEqual({ criterion_id: "date_time.time-zone-grouping", version: "1" });
    expect(TIME_ZONE_FAILURE_CODE).toBe("local_day_counts_mismatch");
  });

  it("plants the released mutation as a patch against the pinned source, with its target and hashes", () => {
    expect(entry.plant).toEqual({
      patch: UMAMI_PINS.plant.patch,
      patch_sha256: "96832684e987a331329a8e9f3023e93e9d68d06382053c96cfce73cb369c2e1d",
      targets: [
        {
          path: "src/queries/sql/pageviews/getPageviewStats.ts",
          before_sha256: "1f679f7a666f2ca7888b9094fb85a69a31b546566f194e27ac6eef2e9aef9b1b",
          after_sha256: "7cb3219367fc73838d6ddc849e5d0b334fc6de4ad7a56bd3c593f35778d84b6c",
        },
      ],
    });
  });

  it("repairs with the reverse patch, kind revert, restoring the clean file; the alternative fix is not the reference repair", () => {
    expect(entry.reference_repair).toEqual({
      patch: UMAMI_PINS.repair.patch,
      patch_sha256: UMAMI_PINS.repair.patch_sha256,
      result_sha256: [{ path: UMAMI_PINS.target.path, sha256: UMAMI_PINS.target.before_sha256 }],
      kind: "revert",
    });
    expect(entry.reference_repair.patch_sha256).not.toBe(UMAMI_PINS.alternative_repair.patch_sha256);
  });

  it("names the released incident by hash and the pinned amd64 runtime image, not the kit image, by a neutral reference and its digest", () => {
    expect(entry.incident).toEqual({ path: "issue.json", sha256: "1a1d227377b5de18db1be03ddbb8aaf6d77ae7a5746cde37081922c3afc993c5" });
    expect(entry.environment).toEqual({
      kit_image: "random-bug-walk/umami-runtime",
      kit_image_digest: UMAMI_PINS.runtime.digest,
      environment_sha256: canonicalDigest({ host_id: "umami", kit_image_digest: UMAMI_PINS.runtime.digest }).sha256,
    });
    expect(entry.environment.kit_image_digest).not.toBe(UMAMI_PINS.kit.digest);
    // No registry host: a runner resolves the registry from its own configuration and runs by digest.
    expect(entry.environment.kit_image.split("/")[0]).not.toMatch(/[.:]/);
  });

  it("identifies the check set by the fixture's added-suite hash and the vectors and protocol by their hashes", () => {
    expect(entry.verification).toEqual({
      check_set_id: "umami-date-time-checks",
      version: "1",
      check_set_sha256: "42c50a8bf10c9d4139584f8f8d7e602293e91e0e9cc1d7abfbd3a13e5694c1ca",
      expected_vectors_sha256: canonicalDigest(UMAMI_PINS.vectors).sha256,
      protocol_id: "umami-time-zone-repeatability",
      protocol_sha256: UMAMI_PROTOCOL.sha256,
    });
  });

  it("keeps the IDs opaque and the presentation free of answer material", () => {
    const ids = [entry.entry_id, entry.source_id, entry.verification.check_set_id];
    const { title, observed_failure: observed, how_checked: how, repetition_summary: repetition } = entry.presentation;
    const presentation = [title, observed, how, repetition];
    const text = [...ids, ...presentation].join("\n").toLowerCase();
    for (const term of ["tz-arg", "tzarg", "getpageviewstats", "getdatesql", "pageviews/", "src/", ".ts", "timezone argument", "dt-1", "umami-tz", "[3", "3, 8", "local_day_counts"]) {
      expect(text).not.toContain(term);
    }
    for (const value of presentation) expect(value.length).toBeGreaterThan(20);
  });

  it("is the same entry on every call and cannot be changed through a returned copy", () => {
    const first = adapter.catalog()[0];
    if (first === undefined) throw new Error("the catalog is empty");
    first.plant.targets.length = 0;
    expect(adapter.catalog()[0]).toEqual(entry);
  });
});

describe("protocol(entry)", () => {
  it("returns the declared protocol from the catalog alone", () => {
    expect(adapter.protocol(entry)).toEqual(UMAMI_PROTOCOL);
    expect(adapter.protocol(entry).sha256).toBe(entry.verification.protocol_sha256);
  });

  it("refuses an entry that is not in the catalog", () => {
    expect(refusal(() => adapter.protocol({ ...entry, entry_id: "umami-date-time-99" }))).toBe("unknown_entry");
    expect(refusal(() => adapter.protocol({ ...entry, plant: { ...entry.plant, patch_sha256: "0".repeat(64) } }))).toBe("unknown_entry");
  });
});

describe("closure-path targets", () => {
  it("refuses a planted change to a file the original suite imports from its pristine copy", () => {
    const pins = { ...UMAMI_PINS, target: { ...UMAMI_PINS.target, path: "src/lib/analytics-query.ts" } };
    expect(refusal(() => buildCatalogEntry(pins))).toBe("closure_target");
    for (const path of ["tests/api/revenue.spec.ts", "playwright.api.config.ts"]) {
      expect(
        refusal(() => {
          checkEntryTargets({ ...entry, plant: { ...entry.plant, targets: [{ ...UMAMI_PINS.target, path }] } });
        }),
      ).toBe("closure_target");
    }
  });

  it("accepts the released target", () => {
    expect(() => {
      checkEntryTargets(entry);
    }).not.toThrow();
  });
});
