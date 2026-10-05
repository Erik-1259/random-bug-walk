"""The public family registry and its refusals."""

from __future__ import annotations

import copy
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Literal, TypedDict, cast

from rbw_schema.generated import Family, FamilyRegistry, HeldOutIdentityList, SourceFix
from rbw_schema.validate import parse_record, validate_record


class FamilyIdentity(TypedDict):
    kind: Literal["family"]
    family_id: str


class SourceFixIdentity(TypedDict):
    kind: Literal["source_fix"]
    upstream: str
    commit: str


class MutationIdentity(TypedDict):
    kind: Literal["mutation"]
    mutation_id: str


type Identity = FamilyIdentity | SourceFixIdentity | MutationIdentity

type RefusalCode = Literal[
    "held_out_conflict", "unregistered", "duplicate", "invalid", "unknown_family"
]


class RegistryRefusal(Exception):
    """Raised when the registry refuses an identity; `code` names the reason."""

    def __init__(self, code: RefusalCode) -> None:
        super().__init__(f"registry refused: {code}")
        self.code: RefusalCode = code


def load_registry(path: Path | str) -> FamilyRegistry:
    return cast(FamilyRegistry, parse_record("FamilyRegistry", Path(path).read_bytes()))


def _same_fix(fix: SourceFix, identity: SourceFixIdentity) -> bool:
    return fix["upstream"] == identity["upstream"] and fix["commit"] == identity["commit"]


def _family_identities(family: Family) -> list[Identity]:
    identities: list[Identity] = [{"kind": "family", "family_id": family["family_id"]}]
    identities.extend(
        SourceFixIdentity(kind="source_fix", upstream=fix["upstream"], commit=fix["commit"])
        for fix in family["source_fixes"]
    )
    identities.extend(
        MutationIdentity(kind="mutation", mutation_id=mutation_id)
        for mutation_id in family["mutation_ids"]
    )
    return identities


def _in_list(held_out: HeldOutIdentityList, identity: Identity) -> bool:
    match identity["kind"]:
        case "family":
            return identity["family_id"] in held_out["family_ids"]
        case "source_fix":
            # The commit ID is the identity; the upstream label may differ between lists.
            return any(fix["commit"] == identity["commit"] for fix in held_out["source_fixes"])
        case "mutation":
            return identity["mutation_id"] in held_out["mutation_ids"]


def _family_has(family: Family, identity: Identity) -> bool:
    match identity["kind"]:
        case "family":
            return family["family_id"] == identity["family_id"]
        case "source_fix":
            return any(_same_fix(fix, identity) for fix in family["source_fixes"])
        case "mutation":
            return identity["mutation_id"] in family["mutation_ids"]


def _registered(registry: FamilyRegistry, identity: Identity) -> bool:
    return any(_family_has(family, identity) for family in registry["families"])


def _refuse_held_out(identities: Sequence[Identity], held_out: HeldOutIdentityList) -> None:
    if validate_record("HeldOutIdentityList", held_out):
        raise RegistryRefusal("invalid")
    # A held-out identity is refused as it stands; it is never relabelled public.
    if any(_in_list(held_out, identity) for identity in identities):
        raise RegistryRefusal("held_out_conflict")


def _checked(registry: FamilyRegistry) -> FamilyRegistry:
    if validate_record("FamilyRegistry", registry):
        raise RegistryRefusal("invalid")
    return registry


def is_held_out_eligible(registry: FamilyRegistry, identity: Identity) -> Literal[False]:
    """Every identity registered here is public and never eligible for held-out use."""
    if not _registered(registry, identity):
        raise RegistryRefusal("unregistered")
    return False


def register_family(
    registry: FamilyRegistry, family: Family, held_out: HeldOutIdentityList
) -> FamilyRegistry:
    """Returns a new registry with the family appended. Exposure is public and eligibility false
    by schema."""
    if validate_record("Family", family):
        raise RegistryRefusal("invalid")
    identities = _family_identities(family)
    _refuse_held_out(identities, held_out)
    if any(_registered(registry, identity) for identity in identities):
        raise RegistryRefusal("duplicate")
    result = copy.deepcopy(registry)
    result["families"].append(copy.deepcopy(family))
    return _checked(result)


def _link_to(
    registry: FamilyRegistry,
    family_id: str,
    identity: Identity,
    held_out: HeldOutIdentityList,
    add: Callable[[Family], None],
) -> FamilyRegistry:
    target = next((f for f in registry["families"] if f["family_id"] == family_id), None)
    _refuse_held_out([identity, *(_family_identities(target) if target else [])], held_out)
    if target is None:
        raise RegistryRefusal("unknown_family")
    if _registered(registry, identity):
        raise RegistryRefusal("duplicate")
    families = copy.deepcopy(registry["families"])
    for family in families:
        if family["family_id"] == family_id:
            add(family)
    return _checked({"schema_version": registry["schema_version"], "families": families})


def link_source_fix(
    registry: FamilyRegistry, family_id: str, fix: SourceFix, held_out: HeldOutIdentityList
) -> FamilyRegistry:
    """Links a source fix to a public family; the fix becomes public with it."""
    if validate_record("SourceFix", fix):
        raise RegistryRefusal("invalid")
    identity = SourceFixIdentity(kind="source_fix", upstream=fix["upstream"], commit=fix["commit"])
    linked = SourceFix(upstream=fix["upstream"], commit=fix["commit"])
    return _link_to(
        registry,
        family_id,
        identity,
        held_out,
        lambda family: family["source_fixes"].append(linked),
    )


def link_mutation(
    registry: FamilyRegistry, family_id: str, mutation_id: str, held_out: HeldOutIdentityList
) -> FamilyRegistry:
    """Links a mutation ID to a public family; the ID becomes public with it."""
    if validate_record("Sha256", mutation_id):
        raise RegistryRefusal("invalid")
    identity = MutationIdentity(kind="mutation", mutation_id=mutation_id)
    return _link_to(
        registry,
        family_id,
        identity,
        held_out,
        lambda family: family["mutation_ids"].append(mutation_id),
    )


def check_public_demo_input(
    registry: FamilyRegistry, identity: Identity, held_out: HeldOutIdentityList
) -> None:
    """Refuses a public-demo input that is held out (checked first) or not registered. A
    registered input is refused when any identity of its family (family ID, source fixes,
    mutation IDs) is held out."""
    _refuse_held_out([identity], held_out)
    owner = next((f for f in registry["families"] if _family_has(f, identity)), None)
    if owner is None:
        raise RegistryRefusal("unregistered")
    _refuse_held_out(_family_identities(owner), held_out)
