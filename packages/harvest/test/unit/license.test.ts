import { describe, expect, it } from "vitest";
import { PERMITTED_LICENSES, licenseDecision } from "../../src/license.ts";

describe("license filter", () => {
  it.each(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"])("permits %s", (spdx) => {
    expect(licenseDecision({ spdx_id: spdx })).toEqual({ permitted: true, spdx });
  });

  it("permits exactly the MIT, Apache-2.0, BSD and ISC identifiers", () => {
    expect([...PERMITTED_LICENSES].sort()).toEqual(["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]);
  });

  it.each(["GPL-3.0", "AGPL-3.0", "LGPL-2.1", "MPL-2.0", "CC-BY-NC-4.0", "CC-BY-SA-4.0", "Unlicense", "0BSD", "mit"])(
    "refuses %s as not permitted",
    (spdx) => {
      expect(licenseDecision({ spdx_id: spdx })).toEqual({ permitted: false, reason: "license_not_permitted", detail: `license ${spdx} is not permitted` });
    },
  );

  it("drops a repository with no license as license_missing", () => {
    expect(licenseDecision(null)).toMatchObject({ permitted: false, reason: "license_missing" });
    expect(licenseDecision({ spdx_id: null })).toMatchObject({ permitted: false, reason: "license_missing" });
  });

  it("drops a license GitHub could not identify as license_unrecognized", () => {
    expect(licenseDecision({ spdx_id: "NOASSERTION" })).toMatchObject({ permitted: false, reason: "license_unrecognized" });
  });
});
