// The mapping from the released case to the factory's catalog entry and its defect and case IDs.
// It reads the release's recorded identities and changes nothing in the release. The IDs come
// from the factory's identity module, which is injected: this package does
// not compute defect_id or case_id itself.
import type { BaselineIdentity, CatalogEntry } from "@rbw/factory-contract";
import { baselineIdentity } from "./catalog.ts";
import { UmamiRefusal } from "./errors.ts";
import { mutationIdOf } from "./job.ts";
import type { UmamiPins } from "./pins.ts";

/** The released case as its release record names it (releases/<release_id>/release.json in the results repository). */
export const RELEASED_CASE = {
  release_id: "319f3100-9ecf-441d-b7af-a643af9ae4e5",
  release_sha256: "838c51516c9dc2a75490ae81839792a99b6d388fc46f1a23a2d2bc0fa312c8b7",
  family_id: "umami-tz-arg-001",
  mutation_id: "4c2531a343d8250607df3ab84491e2d7e655849c1dbcb477264a5c126b21ccca",
  task_revision: "2db3f06590c33b6f165b9b39f8afea4dad6198de07606f136aef4b255c9b8f02",
  grading_policy_id: "umami-uc3-v1",
  issue_sha256: "1a1d227377b5de18db1be03ddbb8aaf6d77ae7a5746cde37081922c3afc993c5",
  kit_image_digest: "sha256:295433e5a8b0dc81e1492a4d18220f5e1d323a78bc38cbb5eca688efde7863ff",
  /** The release's files, as its record lists them. */
  files: [
    { path: "issue-check.json", sha256: "e05637e56f4be2f5cf88a483450e3b1a90e90ededcbafeb4a53548959de8e839" },
    { path: "issue.json", sha256: "1a1d227377b5de18db1be03ddbb8aaf6d77ae7a5746cde37081922c3afc993c5" },
    { path: "recordings/card-1.recording.json", sha256: "2493b2ff5a349dfe79279af4c884c86d37136c18e790141c7051490b2f1a0976" },
    { path: "recordings/issue-2.recording.json", sha256: "3a8993432d14746b31b268242d60f6bae3b0d8e92a0d551b0dcc9d131d96ef11" },
  ],
} as const;

/**
 * The factory's identity functions, with the signatures of `defectId` and `caseId` in `@rbw/factory`'s
 * identity module, so a caller passes `{ defectId, caseId }` as that module exports them.
 */
export interface FactoryIdentity {
  defectId: (baseline: BaselineIdentity, entry: Pick<CatalogEntry, "host_id" | "plant">) => string;
  caseId: (input: { defect_id: string; entry: Pick<CatalogEntry, "bug_type_id" | "verification" | "reference_repair" | "environment">; criteria_catalog_version: string }) => string;
}

export interface ReleasedCaseMapping {
  schema_version: 1;
  released: {
    release_id: string;
    release_sha256: string;
    family_id: string;
    mutation_id: string;
    task_revision: string;
    issue_sha256: string;
    kit_image_digest: string;
  };
  factory: { host_id: "umami"; baseline_id: string; entry_id: string; criteria_catalog_version: string; defect_id: string; case_id: string };
}

/**
 * The mapping record. The case ID depends on the criteria catalog version, which the record names.
 * Refuses (unknown_entry) an entry that is not the released defect: another planted change (its
 * mutation_id), another incident or another kit image.
 */
export function releasedCaseMapping(pins: UmamiPins, entry: CatalogEntry, identity: FactoryIdentity, criteriaCatalogVersion: string): ReleasedCaseMapping {
  if (mutationIdOf(pins.app_commit, entry.plant.targets) !== RELEASED_CASE.mutation_id) {
    throw new UmamiRefusal("unknown_entry", "the entry's planted change is not the released case's");
  }
  if (entry.incident.sha256 !== RELEASED_CASE.issue_sha256 || entry.environment.kit_image_digest !== RELEASED_CASE.kit_image_digest) {
    throw new UmamiRefusal("unknown_entry", "the entry's incident or kit image is not the released case's");
  }
  const baseline = baselineIdentity(pins);
  const defectId = identity.defectId(baseline, entry);
  const caseId = identity.caseId({ defect_id: defectId, entry, criteria_catalog_version: criteriaCatalogVersion });
  return {
    schema_version: 1,
    released: {
      release_id: RELEASED_CASE.release_id,
      release_sha256: RELEASED_CASE.release_sha256,
      family_id: RELEASED_CASE.family_id,
      mutation_id: RELEASED_CASE.mutation_id,
      task_revision: RELEASED_CASE.task_revision,
      issue_sha256: RELEASED_CASE.issue_sha256,
      kit_image_digest: RELEASED_CASE.kit_image_digest,
    },
    factory: { host_id: "umami", baseline_id: baseline.baseline_id, entry_id: entry.entry_id, criteria_catalog_version: criteriaCatalogVersion, defect_id: defectId, case_id: caseId },
  };
}
