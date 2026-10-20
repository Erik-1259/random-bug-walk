import { pairSha256 } from "@rbw/case-package/format";
import { buildMismatchedSyntheticPair, buildSyntheticPair } from "@rbw/case-package/synthetic";
import { describe, expect, it } from "vitest";
import { PairRefused, verifyPair } from "../src/verify.ts";
import { editManifest, replaceMember, repack, sha, text } from "./support.ts";

function refused(run: () => unknown): PairRefused {
  try {
    run();
  } catch (error) {
    if (error instanceof PairRefused) return error;
    throw error;
  }
  throw new Error("the pair was accepted");
}

describe("verifyPair", () => {
  it("accepts a matching pair with or without the evidence member and computes the pair binding", () => {
    for (const evidence of [null, { synthetic: true }]) {
      const pair = buildSyntheticPair({ evidence });
      const verified = verifyPair(pair.bug_case.bytes, pair.validator.bytes);
      expect(verified.bug_case.sha256).toBe(pair.bug_case.sha256);
      expect(verified.validator.sha256).toBe(pair.validator.sha256);
      expect(verified.validator.evidence).toBe(evidence !== null);
      expect(verified.pair_sha256).toBe(pairSha256({ bug_case_sha256: pair.bug_case.sha256, validator_sha256: pair.validator.sha256, case_id: pair.case_id }));
      expect(verified.bug_case.manifest.case_id).toBe(pair.case_id);
    }
  });

  it("refuses a validator package that belongs to another bug case", () => {
    const mismatched = buildMismatchedSyntheticPair();
    expect(refused(() => verifyPair(mismatched.bug_case.bytes, mismatched.validator.bytes)).code).toBe("export_mismatch");
  });

  it("refuses a bug case changed consistently with its own manifest, which the validator does not name", () => {
    // Same case, defect and version, and every member matches the bug case manifest: only the binding differs.
    const pair = buildSyntheticPair({ evidence: null });
    const changed = replaceMember(pair.bug_case.bytes, "bug-case.json", "source/README.md", text("# Changed\n"));
    const error = refused(() => verifyPair(changed, pair.validator.bytes));
    expect(error.message).toMatch(/another bug case/);
  });

  it("refuses a swapped pair", () => {
    const pair = buildSyntheticPair();
    const error = refused(() => verifyPair(pair.validator.bytes, pair.bug_case.bytes));
    expect(error.message).toMatch(/swapped/);
  });

  it("refuses a validator package of another case or package version, even when it names this bug case", () => {
    const pair = buildSyntheticPair({ evidence: null });
    for (const [key, value] of [["package_version", 2], ["case_id", "f".repeat(64)], ["defect_id", "f".repeat(64)], ["host_id", "umami"]] as const) {
      const edited = editManifest(pair.validator.bytes, "validator.json", (manifest) => {
        manifest[key] = value;
      });
      expect(refused(() => verifyPair(pair.bug_case.bytes, edited)).code, key).toBe("export_mismatch");
    }
  });

  it("refuses a member whose bytes differ from the manifest's hash", () => {
    const pair = buildSyntheticPair({ evidence: null });
    const tamperedValidator = repack(pair.validator.bytes, (members) =>
      members.map((member) => (member.path.startsWith("checks/") ? { path: member.path, bytes: text("tampered") } : member)),
    );
    expect(refused(() => verifyPair(pair.bug_case.bytes, tamperedValidator)).code).toBe("export_mismatch");
    const tamperedBugCase = repack(pair.bug_case.bytes, (members) =>
      members.map((member) => (member.path.startsWith("source/") ? { path: member.path, bytes: text("tampered") } : member)),
    );
    expect(refused(() => verifyPair(tamperedBugCase, pair.validator.bytes)).code).toBe("export_mismatch");
  });

  it("refuses a member that the manifest does not list", () => {
    const pair = buildSyntheticPair({ evidence: null });
    const extra = repack(pair.validator.bytes, (members) => [...members, { path: "checks/unlisted.js", bytes: text("x") }]);
    expect(refused(() => verifyPair(pair.bug_case.bytes, extra)).code).toBe("export_mismatch");
    const missing = repack(pair.validator.bytes, (members) => members.filter((member) => member.path !== "repair/reference.patch"));
    expect(refused(() => verifyPair(pair.bug_case.bytes, missing)).code).toBe("export_mismatch");
  });

  it("refuses an evidence member that is not canonical JSON", () => {
    const pair = buildSyntheticPair({ evidence: null });
    const evidence = repack(pair.validator.bytes, (members) => [...members, { path: "evidence/qualification.json", bytes: text('{ "b": 1, "a": 2 }') }]);
    expect(refused(() => verifyPair(pair.bug_case.bytes, evidence)).code).toBe("export_mismatch");
  });

  it("refuses expected outcomes other than the qualification table", () => {
    const pair = buildSyntheticPair({ evidence: null });
    const edited = editManifest(pair.validator.bytes, "validator.json", (manifest) => {
      manifest.expected = { original_suite: { clean: "pass", buggy: "pass", fixed: "pass" }, verification: { clean: "pass", buggy: "pass", fixed: "pass" } };
    });
    expect(refused(() => verifyPair(pair.bug_case.bytes, edited)).code).toBe("export_mismatch");
  });

  it("refuses a patch member whose text does not match the manifest's patch hash", () => {
    const pair = buildSyntheticPair({ evidence: null });
    const edited = replaceMember(pair.validator.bytes, "validator.json", "repair/reference.patch", text("diff --git a/x b/x\n"));
    expect(refused(() => verifyPair(pair.bug_case.bytes, edited)).code).toBe("export_mismatch");
  });

  it("refuses bytes that are not an archive, and says so without quoting evaluator material", () => {
    const pair = buildSyntheticPair();
    const error = refused(() => verifyPair(text("not an archive"), pair.validator.bytes));
    expect(error.message).not.toMatch(/src\/|checks\//);
    expect(sha(pair.bug_case.bytes)).toBe(pair.bug_case.sha256);
  });
});
