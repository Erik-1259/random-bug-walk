// The license filter: a candidate's repository must carry a license GitHub identifies as MIT,
// Apache-2.0, BSD (two- or three-clause) or ISC. GitHub reports `NOASSERTION` for a license file
// it cannot identify, which is not permitted either.

export const PERMITTED_LICENSES: ReadonlySet<string> = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);

export type LicenseDecision =
  | { readonly permitted: true; readonly spdx: string }
  | { readonly permitted: false; readonly reason: "license_missing" | "license_unrecognized" | "license_not_permitted"; readonly detail: string };

export function licenseDecision(license: { readonly spdx_id: string | null } | null): LicenseDecision {
  const spdx = license?.spdx_id ?? null;
  if (spdx === null) {
    return { permitted: false, reason: "license_missing", detail: "the repository has no license GitHub detects" };
  }
  if (spdx === "NOASSERTION") {
    return { permitted: false, reason: "license_unrecognized", detail: "GitHub could not identify the repository's license" };
  }
  if (!PERMITTED_LICENSES.has(spdx)) {
    return { permitted: false, reason: "license_not_permitted", detail: `license ${spdx} is not permitted` };
  }
  return { permitted: true, spdx };
}
