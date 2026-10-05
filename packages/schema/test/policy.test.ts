import { describe, expect, it } from "vitest";
import { encodeCanonical } from "../src/canonical.ts";
import { buildPolicy, policySuccessionErrors } from "../src/policy.ts";
import { RecordError, validateRecord } from "../src/validate.ts";
import type { ProjectPolicy } from "../src/generated.ts";
import { fixtureBytes, fixtureText } from "./support.ts";

const PLACEHOLDER = {
  projectId: "00000000-0000-4000-8000-000000000001",
  outputRepository: "https://example.invalid/synthetic-owner/synthetic-results",
  publicArtifactBaseUri: "https://example.invalid/synthetic-store/test-prefix/",
  policyVersion: 1,
};

describe("buildPolicy", () => {
  it("reproduces the committed placeholder policy bytes and hash", () => {
    const built = buildPolicy(PLACEHOLDER);
    expect(Buffer.from(built.bytes).equals(fixtureBytes("records", "policy-placeholder.canonical"))).toBe(true);
    expect(built.sha256).toBe(fixtureText("records", "policy-placeholder.sha256"));
    expect(built.policy.purpose).toBe("public_demo");
    expect(built.policy.visibility).toBe("public");
  });

  it("builds an evaluation policy when both destinations are null", () => {
    const built = buildPolicy({ ...PLACEHOLDER, outputRepository: null, publicArtifactBaseUri: null });
    expect(Buffer.from(built.bytes).equals(fixtureBytes("records", "policy-evaluation.canonical"))).toBe(true);
  });

  it.each([
    ["one destination missing", { publicArtifactBaseUri: null }],
    ["a .git suffix", { outputRepository: `${PLACEHOLDER.outputRepository}.git` }],
    ["credentials in the base URI", { publicArtifactBaseUri: "https://synthetic-user:synthetic-pass@example.invalid/x/" }],
    ["a query", { outputRepository: `${PLACEHOLDER.outputRepository}?x=1` }],
    ["a base without trailing slash", { publicArtifactBaseUri: "https://example.invalid/synthetic-store" }],
    ["version zero", { policyVersion: 0 }],
    ["an uppercase project id", { projectId: "00000000-0000-4000-8000-00000000000A" }],
  ])("refuses %s", (_label, patch) => {
    expect(() => buildPolicy({ ...PLACEHOLDER, ...patch })).toThrow(RecordError);
  });
});

describe("policy succession", () => {
  const first = buildPolicy(PLACEHOLDER).policy;

  it("accepts a new version of the same project that stays public", () => {
    const next = buildPolicy({ ...PLACEHOLDER, policyVersion: 2, publicArtifactBaseUri: "https://example.invalid/synthetic-store/other/" });
    expect(policySuccessionErrors(first, next.policy)).toEqual([]);
    expect(next.sha256).not.toBe(buildPolicy(PLACEHOLDER).sha256);
  });

  it("refuses the same version with a different configuration", () => {
    const next = buildPolicy({ ...PLACEHOLDER, publicArtifactBaseUri: "https://example.invalid/synthetic-store/other/" }).policy;
    expect(policySuccessionErrors(first, next)).not.toEqual([]);
  });

  it("refuses to reverse exposure that already happened", () => {
    const next = buildPolicy({ ...PLACEHOLDER, policyVersion: 2, outputRepository: null, publicArtifactBaseUri: null }).policy;
    expect(policySuccessionErrors(first, next)).not.toEqual([]);
    expect(validateRecord("ProjectPolicy", next, { previous: first })).not.toEqual([]);
  });

  it("refuses a different project", () => {
    const next: ProjectPolicy = { ...first, policy_version: 2, project_id: "00000000-0000-4000-8000-000000000002" };
    expect(policySuccessionErrors(first, next)).not.toEqual([]);
  });

  it("hashes the canonical policy bytes", () => {
    expect(buildPolicy(PLACEHOLDER).sha256).toBe(fixtureText("records", "policy-placeholder.sha256"));
    expect(Buffer.from(encodeCanonical(first)).equals(fixtureBytes("records", "policy-placeholder.canonical"))).toBe(true);
  });
});
