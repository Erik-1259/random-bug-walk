// Every value the Umami adapter pins: the baseline, the kit image and what it holds, the one
// catalog entry's planted change and reference repair, and the released incident. Each value was
// read once from the pinned image, the repository's probe files or the released case's record;
// the tests check each against its source where the source is in the repository.
import type { Architecture, PatchText, PlantTarget } from "@rbw/factory-contract";
import type { ExpectedCheck } from "@rbw/schema";

/** The expected outcome of every verification check per copy state, in the fixture's check order. */
export interface ExpectedVectors {
  clean: readonly ExpectedCheck[];
  buggy: readonly ExpectedCheck[];
  fixed: readonly ExpectedCheck[];
}

/**
 * What the adapter is built from. The real values are `UMAMI_PINS`; tests build the same adapter
 * from synthetic pins over a synthetic prepared store, because the image's source tree, the frozen
 * suite and the released incident are not in the repository.
 */
export interface UmamiPins {
  app_commit: string;
  baseline_id: string;
  original_suite: {
    suite_id: string;
    /** SHA-256 of the frozen suite manifest that the driver's `freeze` writes and every copy re-checks. */
    sha256: string;
    test_count: number;
    /** canonicalDigest of the sorted test IDs. */
    test_ids_sha256: string;
  };
  kit: {
    /**
     * A neutral reference that names no registry. A runner has to map it to the repository the image
     * was pushed to and run by digest; no runner does that yet (see the README's "Not yet connected").
     */
    image: string;
    digest: string;
    /**
     * The architecture the image is pinned for. A digest can name a multi-architecture index, so
     * the digest alone does not fix it; collect makes a copy that ran on another one invalid.
     */
    architecture: Architecture;
    /** SHA-256 of the image manifest (/opt/rbw/verifier/image-manifest.json). */
    kit_sha256: string;
    /** treeSha256 of the image's app source (/workspace/app without the kit's non-source paths). */
    source_tree_sha256: string;
    source_file_count: number;
    /** The added-suite hash of the fixture the image runs (its staged umami-fixture package). */
    added_suite_sha256: string;
    /** SHA-256 of the fixture's data file inside that package. */
    fixture_sha256: string;
    /** The copy profile's hash (resources, network, limits), the jobs' runtime profile. */
    profile_sha256: string;
  };
  /** The released incident (issue.json), the permitted plain-language description. */
  incident: { path: string; sha256: string };
  /** The planted change's one target file. */
  target: PlantTarget;
  /** The planted change as UTF-8 text, a unified diff of the target file. */
  plant: PatchText;
  /** The reverse of the planted change; it turns the buggy target back into the clean bytes. */
  repair: PatchText;
  /**
   * A second, independent correct repair (the planted file falls back to UTC for a missing time
   * zone). The validator carries it as extra evaluator evidence; it is not the reference repair.
   */
  alternative_repair: PatchText & { result_sha256: string };
  vectors: ExpectedVectors;
  /** The frozen judge_verify job in the validator, as built by `frozenJob` from these pins and the frozen suite. */
  job: { request_sha256: string; expected_trials_sha256: string };
}

export const TARGET_PATH = "src/queries/sql/pageviews/getPageviewStats.ts";

/** packages/shapes/probes/dt-1.tz-arg/mutation.patch, byte for byte. */
export const PLANT_PATCH = [
  `diff --git a/${TARGET_PATH} b/${TARGET_PATH}`,
  `--- a/${TARGET_PATH}`,
  `+++ b/${TARGET_PATH}`,
  "@@ -25,7 +25,7 @@",
  "   return rawQuery(",
  "     `",
  "     select",
  "-      ${getDateSQL('website_event.created_at', unit, timezone)} x,",
  "+      ${getDateSQL('website_event.created_at', unit)} x,",
  "       count(*) y",
  "     from website_event",
  "     ${cohortQuery}",
  "",
].join("\n");

/** The planted-to-fixed diff the local runner derives (the mutation reversed), byte for byte. */
export const REPAIR_PATCH = [
  `diff --git a/${TARGET_PATH} b/${TARGET_PATH}`,
  `--- a/${TARGET_PATH}`,
  `+++ b/${TARGET_PATH}`,
  "@@ -25,7 +25,7 @@",
  "   return rawQuery(",
  "     `",
  "     select",
  "-      ${getDateSQL('website_event.created_at', unit)} x,",
  "+      ${getDateSQL('website_event.created_at', unit, timezone)} x,",
  "       count(*) y",
  "     from website_event",
  "     ${cohortQuery}",
  "",
].join("\n");

/** tools/local-runner/probes/alternative-fix.patch, byte for byte. */
export const ALTERNATIVE_REPAIR_PATCH = [
  `diff --git a/${TARGET_PATH} b/${TARGET_PATH}`,
  `--- a/${TARGET_PATH}`,
  `+++ b/${TARGET_PATH}`,
  "@@ -25,7 +25,7 @@",
  "   return rawQuery(",
  "     `",
  "     select",
  "-      ${getDateSQL('website_event.created_at', unit)} x,",
  "+      ${getDateSQL('website_event.created_at', unit, timezone || 'utc')} x,",
  "       count(*) y",
  "     from website_event",
  "     ${cohortQuery}",
  "",
].join("\n");

const UTC = "tzarg.utc-day-counts";
const LA = "tzarg.la-day-counts";
const AUCKLAND = "tzarg.auckland-day-counts";
const KOLKATA = "tzarg.kolkata-day-counts";

const pass = (check_id: string): ExpectedCheck => ({ check_id, expected: "pass", failure_code: null });
const mismatch = (check_id: string): ExpectedCheck => ({ check_id, expected: "assertion_fail", failure_code: "local_day_counts_mismatch" });

/** The fixture data file's outcome vectors for clean, planted (buggy) and fixed, in its check order. */
export const TIME_ZONE_VECTORS: ExpectedVectors = {
  clean: [pass(UTC), pass(LA), pass(AUCKLAND), pass(KOLKATA)],
  buggy: [pass(UTC), mismatch(LA), mismatch(AUCKLAND), mismatch(KOLKATA)],
  fixed: [pass(UTC), pass(LA), pass(AUCKLAND), pass(KOLKATA)],
};

export const UMAMI_PINS: UmamiPins = {
  app_commit: "ec0ff50388c264ed8ce46f00967e92f7e71476ae",
  baseline_id: "umami@ec0ff503",
  original_suite: {
    suite_id: "umami-api@ec0ff503",
    sha256: "8162af64ef63b82717afa6f9420745df3ccc3fb85f81adf4d47352af1b8ecbcd",
    test_count: 271,
    test_ids_sha256: "a0454b85b0efe07272f650b9d70ce8ff1322fbe68becf1fd7dbfc9eb5af171a5",
  },
  kit: {
    image: "random-bug-walk/umami-kit",
    digest: "sha256:295433e5a8b0dc81e1492a4d18220f5e1d323a78bc38cbb5eca688efde7863ff",
    architecture: "amd64",
    kit_sha256: "ef54eab2864b9772900a587b2f3b1bf318f40fbbd5d8b522fd643dca49d191e3",
    source_tree_sha256: "712ebd687ed85386d3c1bea26204f120d18260aa03ad8fc6b15737afadd8fd2d",
    source_file_count: 2026,
    added_suite_sha256: "42c50a8bf10c9d4139584f8f8d7e602293e91e0e9cc1d7abfbd3a13e5694c1ca",
    fixture_sha256: "787bd7722d86d585de86193c145b70884a075b4cc1e2fd6f08ff38c710528bdf",
    profile_sha256: "a22992701032b6ea704fb3165e65ded659fc3006bcfce11366eb088373929f91",
  },
  incident: { path: "issue.json", sha256: "1a1d227377b5de18db1be03ddbb8aaf6d77ae7a5746cde37081922c3afc993c5" },
  target: {
    path: TARGET_PATH,
    before_sha256: "1f679f7a666f2ca7888b9094fb85a69a31b546566f194e27ac6eef2e9aef9b1b",
    after_sha256: "7cb3219367fc73838d6ddc849e5d0b334fc6de4ad7a56bd3c593f35778d84b6c",
  },
  plant: { patch: PLANT_PATCH, patch_sha256: "96832684e987a331329a8e9f3023e93e9d68d06382053c96cfce73cb369c2e1d" },
  repair: { patch: REPAIR_PATCH, patch_sha256: "97c3ddce96442badb0c3b1f6ae6ba8dc24b4d50e161561091b96860dc6853b84" },
  alternative_repair: {
    patch: ALTERNATIVE_REPAIR_PATCH,
    patch_sha256: "eb9f8e138949a36338dfcc99427d560f998f7584b4b2112d152411303dc9f5c3",
    result_sha256: "49a8fba295573cce4577a4667c02781691f72057132f3554094d6a4f8e32e649",
  },
  vectors: TIME_ZONE_VECTORS,
  job: { request_sha256: "89db318ca3898483a419057501992e2c5c9d21bf5b7a1205b0ee4bb65ebfceac", expected_trials_sha256: "f14185dc7dd0c71b59e1ee72a0cc16fa4caf68dfc73505696f09832f5a4cd10c" },
};
