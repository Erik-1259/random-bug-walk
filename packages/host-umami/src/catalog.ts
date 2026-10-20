// The Umami catalog `umami-date-time`, version 1: one entry, the time-zone defect that was
// released, at the pinned baseline. Its IDs are opaque (contract section 10.1) and its
// presentation text is the only part a client may show; the planted change, the reference repair,
// the checks and the expected vectors are evaluator material.
import { canonicalDigest } from "@rbw/schema";
import type { BaselineIdentity, CatalogEntry, CatalogPresentation } from "@rbw/factory-contract";
import { isClosurePath } from "./closure.ts";
import { UmamiRefusal } from "./errors.ts";
import type { ExpectedVectors, UmamiPins } from "./pins.ts";
import { UMAMI_PROTOCOL } from "./protocol.ts";

export const HOST_ID = "umami";
export const SOURCE_ID = "umami-date-time";
export const CATALOG_VERSION = "1";
export const ENTRY_ID = "umami-date-time-01";
export const CHECK_SET_ID = "umami-date-time-checks";
export const CHECK_SET_VERSION = "1";
export const CRITERION = { criterion_id: "date_time.time-zone-grouping", version: "1" } as const;
/**
 * The assertion code the time-zone checks report on the buggy copy, which is the published
 * failure code of criterion date_time.time-zone-grouping v1 in the criteria catalog.
 */
export const TIME_ZONE_FAILURE_CODE = "local_day_counts_mismatch";

/** Client-safe text (contract section 10.1): the symptom and the method, with no answer material. */
export const PRESENTATION: CatalogPresentation = {
  title: "Daily pageview counts land on the wrong local day outside UTC",
  observed_failure:
    "When a website's report uses a time zone other than UTC, the daily pageview report counts some visits on the wrong local day, so the daily totals do not match the visits.",
  how_checked:
    "Separate HTTP checks send pageviews at fixed times, request the daily pageview report in several time zones, and compare each day's count with the local days those pageviews fall on. A UTC report serves as the control.",
  repetition_summary: "One copy each of the clean, buggy and reference-fixed source. Each copy runs the original suite once and the checks once.",
};

export function baselineIdentity(pins: UmamiPins): BaselineIdentity {
  return {
    host_id: HOST_ID,
    baseline_id: pins.baseline_id,
    app_commit: pins.app_commit,
    original_suite: { ...pins.original_suite },
  };
}

/** The canonical hash of the clean, buggy and fixed vectors, as `expected-vectors.json` in the validator holds them. */
export function expectedVectorsSha256(vectors: ExpectedVectors): string {
  return canonicalDigest(vectors).sha256;
}

/** environment_sha256: the canonical hash of the host and the pinned runtime image digest. */
export function environmentSha256(pins: UmamiPins): string {
  return canonicalDigest({ host_id: HOST_ID, kit_image_digest: pins.runtime.digest }).sha256;
}

/** Refuses an entry whose planted change or repair result touches the original suite's closure. */
export function checkEntryTargets(entry: Pick<CatalogEntry, "plant" | "reference_repair">): void {
  const paths = [...entry.plant.targets.map((target) => target.path), ...entry.reference_repair.result_sha256.map((file) => file.path)];
  const closure = paths.filter(isClosurePath);
  if (closure.length > 0) throw new UmamiRefusal("closure_target", `the original suite runs ${closure.join(", ")} from its pristine copy`);
}

export function buildCatalogEntry(pins: UmamiPins): CatalogEntry {
  const entry: CatalogEntry = {
    entry_id: ENTRY_ID,
    source_id: SOURCE_ID,
    catalog_version: CATALOG_VERSION,
    host_id: HOST_ID,
    bug_type_id: "date_time",
    criteria: [{ ...CRITERION }],
    plant: { patch: pins.plant.patch, patch_sha256: pins.plant.patch_sha256, targets: [{ ...pins.target }] },
    reference_repair: {
      patch: pins.repair.patch,
      patch_sha256: pins.repair.patch_sha256,
      result_sha256: [{ path: pins.target.path, sha256: pins.target.before_sha256 }],
      kind: "revert",
    },
    incident: { path: pins.incident.path, sha256: pins.incident.sha256 },
    presentation: { ...PRESENTATION },
    verification: {
      check_set_id: CHECK_SET_ID,
      version: CHECK_SET_VERSION,
      check_set_sha256: pins.kit.added_suite_sha256,
      expected_vectors_sha256: expectedVectorsSha256(pins.vectors),
      protocol_id: UMAMI_PROTOCOL.protocol_id,
      protocol_sha256: UMAMI_PROTOCOL.sha256,
    },
    // The runtime image, never the kit image: the kit holds the clean source and the fixture.
    environment: { kit_image: pins.runtime.image, kit_image_digest: pins.runtime.digest, environment_sha256: environmentSha256(pins) },
    difficulty: { status: "not_assessed" },
  };
  checkEntryTargets(entry);
  return entry;
}
