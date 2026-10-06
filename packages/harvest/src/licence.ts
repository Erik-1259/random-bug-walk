// The licence filter: a candidate's repository must carry a licence GitHub identifies as MIT,
// Apache-2.0, BSD (two- or three-clause) or ISC. GitHub reports `NOASSERTION` for a licence file
// it cannot identify, which is not permitted either.

export const PERMITTED_LICENCES: ReadonlySet<string> = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);

export type LicenceDecision =
  | { readonly permitted: true; readonly spdx: string }
  | { readonly permitted: false; readonly reason: "licence_missing" | "licence_unrecognised" | "licence_not_permitted"; readonly detail: string };

export function licenceDecision(licence: { readonly spdx_id: string | null } | null): LicenceDecision {
  const spdx = licence?.spdx_id ?? null;
  if (spdx === null) {
    return { permitted: false, reason: "licence_missing", detail: "the repository has no licence GitHub detects" };
  }
  if (spdx === "NOASSERTION") {
    return { permitted: false, reason: "licence_unrecognised", detail: "GitHub could not identify the repository's licence" };
  }
  if (!PERMITTED_LICENCES.has(spdx)) {
    return { permitted: false, reason: "licence_not_permitted", detail: `licence ${spdx} is not permitted` };
  }
  return { permitted: true, spdx };
}
