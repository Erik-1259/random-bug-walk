import { describe, expect, it } from "vitest";
import type { Family, FamilyRegistry, HeldOutIdentityList } from "../src/generated.ts";
import {
  COMMITTED_REGISTRY_PATH,
  RegistryRefusal,
  checkPublicDemoInput,
  isHeldOutEligible,
  linkMutation,
  linkSourceFix,
  loadRegistry,
  registerFamily,
} from "../src/registry.ts";
import { validateRecord } from "../src/validate.ts";
import { mutationId } from "../src/jobs.ts";

const UMAMI_FIX = { upstream: "umami", commit: "e6f3f3b4b40a490d5cb050471baa0999366dab2a" };
// The planted change at the pinned Umami commit, as the candidate attempt computes it.
const UMAMI_MUTATION = "4c2531a343d8250607df3ab84491e2d7e655849c1dbcb477264a5c126b21ccca";
// The race family: the upstream fix that added the compare-and-swap guard, and the mutation id of
// the one-line planted change at the pinned Umami commit, computed as the candidate attempt does.
const RC1_FIX = { upstream: "umami", commit: "3e165a8c6fea303250e626dc952a396e40887c71" };
const RC1_MUTATION = "e58a281fa1ac6029095043858dcefd5b3e123b24c318b9da93d76ee334fb6ce7";
const HELD_OUT: HeldOutIdentityList = {
  schema_version: 1,
  family_ids: ["synthetic-held-out-001"],
  source_fixes: [{ upstream: "synthetic-upstream", commit: "2".repeat(40) }],
  mutation_ids: ["d".repeat(64)],
};
const EMPTY_HELD_OUT: HeldOutIdentityList = { schema_version: 1, family_ids: [], source_fixes: [], mutation_ids: [] };

function family(patch: Partial<Family> = {}): Family {
  return {
    family_id: "synthetic-family-002",
    exposure: "public",
    held_out_eligible: false,
    source_fixes: [{ upstream: "synthetic-upstream", commit: "1".repeat(40) }],
    mutation_ids: [],
    ...patch,
  };
}

function refusal(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof RegistryRefusal) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("committed registry", () => {
  const registry = loadRegistry(COMMITTED_REGISTRY_PATH);

  it("validates and registers the time-zone and race families as specified", () => {
    expect(validateRecord("FamilyRegistry", registry)).toEqual([]);
    expect(registry.families).toEqual([
      { family_id: "umami-tz-arg-001", exposure: "public", held_out_eligible: false, source_fixes: [UMAMI_FIX], mutation_ids: [UMAMI_MUTATION] },
      { family_id: "rc-1-backup-code-001", exposure: "public", held_out_eligible: false, source_fixes: [RC1_FIX], mutation_ids: [RC1_MUTATION] },
    ]);
  });

  it("computes the race family's mutation id over the planted change, as the candidate attempt does", () => {
    // The pinned 2FA verify route at the Umami host commit, clean and planted (one line drops the
    // `used: false` guard). The candidate attempt hashes exactly this MutationIdentity.
    const hostCommit = "ec0ff50388c264ed8ce46f00967e92f7e71476ae";
    const path = "src/app/api/2fa/verify/route.ts";
    const cleanSha = "3e766a0ba16e2547c234442176c04a0f2fd096d033a7079d21938dd9796acb87";
    const plantedSha = "30426f040a2c4ea1730827644b8947feed39dc8f2487fec1372139f5be9d66fb";
    const computed = mutationId(
      { host_commit: hostCommit, changes: [{ path, original_sha256: cleanSha, resulting_sha256: plantedSha, original_mode: "100644", resulting_mode: "100644" }] },
      { allowedPaths: [path] },
    ).sha256;
    expect(computed).toBe(RC1_MUTATION);
  });

  it("accepts the linked mutation for the public demo", () => {
    expect(() => { checkPublicDemoInput(registry, { kind: "mutation", mutation_id: UMAMI_MUTATION }, HELD_OUT); }).not.toThrow();
    expect(() => { checkPublicDemoInput(registry, { kind: "mutation", mutation_id: RC1_MUTATION }, HELD_OUT); }).not.toThrow();
  });

  it("reports no held-out eligibility for any registered identity", () => {
    expect(isHeldOutEligible(registry, { kind: "family", family_id: "umami-tz-arg-001" })).toBe(false);
    expect(isHeldOutEligible(registry, { kind: "source_fix", ...UMAMI_FIX })).toBe(false);
    expect(isHeldOutEligible(registry, { kind: "mutation", mutation_id: UMAMI_MUTATION })).toBe(false);
    expect(isHeldOutEligible(registry, { kind: "family", family_id: "rc-1-backup-code-001" })).toBe(false);
    expect(isHeldOutEligible(registry, { kind: "source_fix", ...RC1_FIX })).toBe(false);
    expect(isHeldOutEligible(registry, { kind: "mutation", mutation_id: RC1_MUTATION })).toBe(false);
  });
});

describe("registry operations", () => {
  const base = (): FamilyRegistry => loadRegistry(COMMITTED_REGISTRY_PATH);

  it("registers a public family", () => {
    const next = registerFamily(base(), family(), HELD_OUT);
    expect(next.families.map((item) => item.family_id)).toEqual(["umami-tz-arg-001", "rc-1-backup-code-001", "synthetic-family-002"]);
    expect(validateRecord("FamilyRegistry", next)).toEqual([]);
  });

  it.each([
    ["family id", family({ family_id: "synthetic-held-out-001" })],
    ["source fix", family({ source_fixes: [{ upstream: "synthetic-upstream", commit: "2".repeat(40) }] })],
    ["mutation id", family({ mutation_ids: ["d".repeat(64)] })],
  ])("refuses a family whose %s is held out", (_label, candidate) => {
    const registry = base();
    expect(refusal(() => registerFamily(registry, candidate, HELD_OUT))).toBe("held_out_conflict");
    expect(registry).toEqual(base());
  });

  it("refuses a family that asks for another exposure or eligibility", () => {
    const relabelled = { ...family(), exposure: "held_out" } as unknown as Family;
    expect(refusal(() => registerFamily(base(), relabelled, EMPTY_HELD_OUT))).toBe("invalid");
    const eligible = { ...family(), held_out_eligible: true } as unknown as Family;
    expect(refusal(() => registerFamily(base(), eligible, EMPTY_HELD_OUT))).toBe("invalid");
  });

  it("refuses a duplicate family or a source fix that is already registered", () => {
    expect(refusal(() => registerFamily(base(), family({ family_id: "umami-tz-arg-001" }), EMPTY_HELD_OUT))).toBe("duplicate");
    expect(refusal(() => registerFamily(base(), family({ source_fixes: [UMAMI_FIX] }), EMPTY_HELD_OUT))).toBe("duplicate");
  });

  it("keeps linked source fixes and mutation ids public", () => {
    let registry = linkSourceFix(base(), "umami-tz-arg-001", { upstream: "umami", commit: "3".repeat(40) }, HELD_OUT);
    registry = linkMutation(registry, "umami-tz-arg-001", "e".repeat(64), HELD_OUT);
    const [umami] = registry.families;
    expect(umami?.exposure).toBe("public");
    expect(umami?.held_out_eligible).toBe(false);
    expect(umami?.source_fixes).toEqual([UMAMI_FIX, { upstream: "umami", commit: "3".repeat(40) }]);
    expect(umami?.mutation_ids).toEqual([UMAMI_MUTATION, "e".repeat(64)]);
    expect(isHeldOutEligible(registry, { kind: "mutation", mutation_id: "e".repeat(64) })).toBe(false);
    expect(validateRecord("FamilyRegistry", registry)).toEqual([]);
  });

  it("refuses to link a held-out identity", () => {
    expect(refusal(() => linkMutation(base(), "umami-tz-arg-001", "d".repeat(64), HELD_OUT))).toBe("held_out_conflict");
    expect(refusal(() => linkSourceFix(base(), "umami-tz-arg-001", HELD_OUT.source_fixes[0] ?? UMAMI_FIX, HELD_OUT))).toBe("held_out_conflict");
    expect(refusal(() => linkMutation(base(), "synthetic-missing", "e".repeat(64), HELD_OUT))).toBe("unknown_family");
  });

  it("accepts a registered public input for the public demo", () => {
    expect(() => { checkPublicDemoInput(base(), { kind: "family", family_id: "umami-tz-arg-001" }, HELD_OUT); }).not.toThrow();
    expect(() => { checkPublicDemoInput(base(), { kind: "source_fix", ...UMAMI_FIX }, HELD_OUT); }).not.toThrow();
  });

  it("refuses an unregistered input for the public demo", () => {
    expect(refusal(() => { checkPublicDemoInput(base(), { kind: "family", family_id: "synthetic-unknown" }, EMPTY_HELD_OUT); })).toBe("unregistered");
    expect(refusal(() => { checkPublicDemoInput(base(), { kind: "mutation", mutation_id: "f".repeat(64) }, EMPTY_HELD_OUT); })).toBe("unregistered");
  });

  it("refuses a held-out input even when it is also registered, and never relabels it", () => {
    const held: HeldOutIdentityList = { ...EMPTY_HELD_OUT, family_ids: ["umami-tz-arg-001"] };
    const registry = base();
    expect(refusal(() => { checkPublicDemoInput(registry, { kind: "family", family_id: "umami-tz-arg-001" }, held); })).toBe("held_out_conflict");
    expect(registry).toEqual(base());
  });

  it("refuses a family whose linked source fix or mutation is held out", () => {
    const umami = { kind: "family", family_id: "umami-tz-arg-001" } as const;
    const fixHeld: HeldOutIdentityList = { ...EMPTY_HELD_OUT, source_fixes: [UMAMI_FIX] };
    expect(refusal(() => { checkPublicDemoInput(base(), umami, fixHeld); })).toBe("held_out_conflict");
    const linked = linkMutation(base(), "umami-tz-arg-001", "e".repeat(64), EMPTY_HELD_OUT);
    const mutationHeld: HeldOutIdentityList = { ...EMPTY_HELD_OUT, mutation_ids: ["e".repeat(64)] };
    expect(refusal(() => { checkPublicDemoInput(linked, umami, mutationHeld); })).toBe("held_out_conflict");
  });

  it("refuses a registered input whose family is held out", () => {
    const held: HeldOutIdentityList = { ...EMPTY_HELD_OUT, family_ids: ["umami-tz-arg-001"] };
    expect(refusal(() => { checkPublicDemoInput(base(), { kind: "source_fix", ...UMAMI_FIX }, held); })).toBe("held_out_conflict");
  });

  it("compares held-out source fixes by commit ID, not by the upstream label", () => {
    const relabelled: HeldOutIdentityList = { ...EMPTY_HELD_OUT, source_fixes: [{ upstream: "synthetic-other-label", commit: UMAMI_FIX.commit }] };
    expect(refusal(() => { checkPublicDemoInput(base(), { kind: "family", family_id: "umami-tz-arg-001" }, relabelled); })).toBe("held_out_conflict");
    expect(refusal(() => registerFamily(base(), family({ source_fixes: [{ upstream: "synthetic-upstream", commit: "2".repeat(40) }] }), { ...EMPTY_HELD_OUT, source_fixes: [{ upstream: "other", commit: "2".repeat(40) }] }))).toBe("held_out_conflict");
  });

  it("refuses a source fix linked to a held-out family whichever upstream label it is called with", () => {
    const held: HeldOutIdentityList = { ...EMPTY_HELD_OUT, family_ids: ["umami-tz-arg-001"] };
    for (const upstream of ["umami", "synthetic-other-label"]) {
      expect(refusal(() => { checkPublicDemoInput(base(), { kind: "source_fix", upstream, commit: UMAMI_FIX.commit }, held); })).toBe("held_out_conflict");
    }
  });

  it("refuses a registry that lists one commit under two labels", () => {
    const split: FamilyRegistry = {
      ...base(),
      families: [...base().families, family({ source_fixes: [{ upstream: "synthetic-other-label", commit: UMAMI_FIX.commit }] })],
    };
    const held: HeldOutIdentityList = { ...EMPTY_HELD_OUT, family_ids: ["umami-tz-arg-001"] };
    expect(refusal(() => { checkPublicDemoInput(split, { kind: "source_fix", upstream: "synthetic-other-label", commit: UMAMI_FIX.commit }, held); })).toBe("invalid");
    expect(refusal(() => registerFamily(base(), family({ source_fixes: [{ upstream: "synthetic-other-label", commit: UMAMI_FIX.commit }] }), EMPTY_HELD_OUT))).toBe("duplicate");
  });

  it("refuses an invalid held-out list", () => {
    const broken = { ...EMPTY_HELD_OUT, schema_version: 2 } as unknown as HeldOutIdentityList;
    expect(refusal(() => { checkPublicDemoInput(base(), { kind: "family", family_id: "umami-tz-arg-001" }, broken); })).toBe("invalid");
  });
});
