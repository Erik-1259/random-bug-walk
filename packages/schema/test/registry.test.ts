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

const UMAMI_FIX = { upstream: "umami", commit: "e6f3f3b4b40a490d5cb050471baa0999366dab2a" };
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

  it("validates and registers umami-tz-arg-001 as specified", () => {
    expect(validateRecord("FamilyRegistry", registry)).toEqual([]);
    expect(registry.families).toEqual([
      { family_id: "umami-tz-arg-001", exposure: "public", held_out_eligible: false, source_fixes: [UMAMI_FIX], mutation_ids: [] },
    ]);
  });

  it("reports no held-out eligibility for any registered identity", () => {
    expect(isHeldOutEligible(registry, { kind: "family", family_id: "umami-tz-arg-001" })).toBe(false);
    expect(isHeldOutEligible(registry, { kind: "source_fix", ...UMAMI_FIX })).toBe(false);
  });
});

describe("registry operations", () => {
  const base = (): FamilyRegistry => loadRegistry(COMMITTED_REGISTRY_PATH);

  it("registers a public family", () => {
    const next = registerFamily(base(), family(), HELD_OUT);
    expect(next.families.map((item) => item.family_id)).toEqual(["umami-tz-arg-001", "synthetic-family-002"]);
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
    expect(umami?.mutation_ids).toEqual(["e".repeat(64)]);
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

  it("refuses an invalid held-out list", () => {
    const broken = { ...EMPTY_HELD_OUT, schema_version: 2 } as unknown as HeldOutIdentityList;
    expect(refusal(() => { checkPublicDemoInput(base(), { kind: "family", family_id: "umami-tz-arg-001" }, broken); })).toBe("invalid");
  });
});
