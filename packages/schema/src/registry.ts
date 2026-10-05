import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Family, FamilyRegistry, HeldOutIdentityList, SourceFix } from "./generated.ts";
import { parseRecord, validateRecord } from "./validate.ts";

/** The committed family registry. */
export const COMMITTED_REGISTRY_PATH = fileURLToPath(new URL("../registry/families.json", import.meta.url));

export type Identity =
  | { kind: "family"; family_id: string }
  | { kind: "source_fix"; upstream: string; commit: string }
  | { kind: "mutation"; mutation_id: string };

export type RefusalCode = "held_out_conflict" | "unregistered" | "duplicate" | "invalid" | "unknown_family";

export class RegistryRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode) {
    super(`registry refused: ${code}`);
    this.name = "RegistryRefusal";
    this.code = code;
  }
}

export function loadRegistry(path: string): FamilyRegistry {
  return parseRecord("FamilyRegistry", readFileSync(path));
}

function sameFix(a: SourceFix, b: { upstream: string; commit: string }): boolean {
  return a.upstream === b.upstream && a.commit === b.commit;
}

function familyIdentities(family: Family): Identity[] {
  return [
    { kind: "family", family_id: family.family_id },
    ...family.source_fixes.map((fix): Identity => ({ kind: "source_fix", upstream: fix.upstream, commit: fix.commit })),
    ...family.mutation_ids.map((id): Identity => ({ kind: "mutation", mutation_id: id })),
  ];
}

function inList(list: HeldOutIdentityList, identity: Identity): boolean {
  switch (identity.kind) {
    case "family":
      return list.family_ids.includes(identity.family_id);
    case "source_fix":
      // The commit ID is the identity; the upstream label may differ between lists.
      return list.source_fixes.some((fix) => fix.commit === identity.commit);
    case "mutation":
      return list.mutation_ids.includes(identity.mutation_id);
  }
}

function familyHas(family: Family, identity: Identity): boolean {
  switch (identity.kind) {
    case "family":
      return family.family_id === identity.family_id;
    case "source_fix":
      return family.source_fixes.some((fix) => sameFix(fix, identity));
    case "mutation":
      return family.mutation_ids.includes(identity.mutation_id);
  }
}

function registered(registry: FamilyRegistry, identity: Identity): boolean {
  return registry.families.some((family) => familyHas(family, identity));
}

function checkHeldOutList(heldOut: HeldOutIdentityList): void {
  if (validateRecord("HeldOutIdentityList", heldOut).length > 0) throw new RegistryRefusal("invalid");
}

function refuseHeldOut(identities: readonly Identity[], heldOut: HeldOutIdentityList): void {
  checkHeldOutList(heldOut);
  // A held-out identity is refused as it stands; it is never relabelled public.
  if (identities.some((identity) => inList(heldOut, identity))) throw new RegistryRefusal("held_out_conflict");
}

function checked(registry: FamilyRegistry): FamilyRegistry {
  if (validateRecord("FamilyRegistry", registry).length > 0) throw new RegistryRefusal("invalid");
  return registry;
}

/** Every identity registered here is public and never eligible for held-out use. */
export function isHeldOutEligible(registry: FamilyRegistry, identity: Identity): false {
  if (!registered(registry, identity)) throw new RegistryRefusal("unregistered");
  return false;
}

/** Returns a new registry with the family appended. Exposure is public and eligibility false by schema. */
export function registerFamily(registry: FamilyRegistry, family: Family, heldOut: HeldOutIdentityList): FamilyRegistry {
  if (validateRecord("Family", family).length > 0) throw new RegistryRefusal("invalid");
  const identities = familyIdentities(family);
  refuseHeldOut(identities, heldOut);
  if (identities.some((identity) => registered(registry, identity))) throw new RegistryRefusal("duplicate");
  return checked({ ...structuredClone(registry), families: [...structuredClone(registry.families), structuredClone(family)] });
}

function linkTo(registry: FamilyRegistry, familyId: string, identity: Identity, heldOut: HeldOutIdentityList, add: (family: Family) => Family): FamilyRegistry {
  const target = registry.families.find((family) => family.family_id === familyId);
  refuseHeldOut([identity, ...(target === undefined ? [] : familyIdentities(target))], heldOut);
  if (target === undefined) throw new RegistryRefusal("unknown_family");
  if (registered(registry, identity)) throw new RegistryRefusal("duplicate");
  const families = structuredClone(registry.families).map((family) => (family.family_id === familyId ? add(family) : family));
  return checked({ schema_version: registry.schema_version, families });
}

/** Links a source fix to a public family; the fix becomes public with it. */
export function linkSourceFix(registry: FamilyRegistry, familyId: string, fix: SourceFix, heldOut: HeldOutIdentityList): FamilyRegistry {
  if (validateRecord("SourceFix", fix).length > 0) throw new RegistryRefusal("invalid");
  const identity: Identity = { kind: "source_fix", upstream: fix.upstream, commit: fix.commit };
  return linkTo(registry, familyId, identity, heldOut, (family) => ({ ...family, source_fixes: [...family.source_fixes, { ...fix }] }));
}

/** Links a mutation ID to a public family; the ID becomes public with it. */
export function linkMutation(registry: FamilyRegistry, familyId: string, mutationId: string, heldOut: HeldOutIdentityList): FamilyRegistry {
  if (validateRecord("Sha256", mutationId).length > 0) throw new RegistryRefusal("invalid");
  return linkTo(registry, familyId, { kind: "mutation", mutation_id: mutationId }, heldOut, (family) => ({
    ...family,
    mutation_ids: [...family.mutation_ids, mutationId],
  }));
}

/**
 * Refuses a public-demo input that is held out (checked first) or not registered. A registered
 * input is refused when any identity of its family (family ID, source fixes, mutation IDs) is held out.
 */
export function checkPublicDemoInput(registry: FamilyRegistry, identity: Identity, heldOut: HeldOutIdentityList): void {
  refuseHeldOut([identity], heldOut);
  const owner = registry.families.find((family) => familyHas(family, identity));
  if (owner === undefined) throw new RegistryRefusal("unregistered");
  refuseHeldOut(familyIdentities(owner), heldOut);
}
