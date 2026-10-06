import { describe, expect, it } from "vitest";
import { PERMITTED_LICENCES, licenceDecision } from "../../src/licence.ts";

describe("licence filter", () => {
  it.each(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"])("permits %s", (spdx) => {
    expect(licenceDecision({ spdx_id: spdx })).toEqual({ permitted: true, spdx });
  });

  it("permits exactly the MIT, Apache-2.0, BSD and ISC identifiers", () => {
    expect([...PERMITTED_LICENCES].sort()).toEqual(["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]);
  });

  it.each(["GPL-3.0", "AGPL-3.0", "LGPL-2.1", "MPL-2.0", "CC-BY-NC-4.0", "CC-BY-SA-4.0", "Unlicense", "0BSD", "mit"])(
    "refuses %s as not permitted",
    (spdx) => {
      expect(licenceDecision({ spdx_id: spdx })).toEqual({ permitted: false, reason: "licence_not_permitted", detail: `licence ${spdx} is not permitted` });
    },
  );

  it("drops a repository with no licence as licence_missing", () => {
    expect(licenceDecision(null)).toMatchObject({ permitted: false, reason: "licence_missing" });
    expect(licenceDecision({ spdx_id: null })).toMatchObject({ permitted: false, reason: "licence_missing" });
  });

  it("drops a licence GitHub could not identify as licence_unrecognised", () => {
    expect(licenceDecision({ spdx_id: "NOASSERTION" })).toMatchObject({ permitted: false, reason: "licence_unrecognised" });
  });
});
