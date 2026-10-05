import copy
from typing import cast

import pytest
from conftest import REGISTRY
from rbw_schema.generated import Family, HeldOutIdentityList
from rbw_schema.registry import (
    Identity,
    RegistryRefusal,
    check_public_demo_input,
    is_held_out_eligible,
    link_mutation,
    link_source_fix,
    load_registry,
    register_family,
)
from rbw_schema.validate import validate_record

UMAMI_FIX = {"upstream": "umami", "commit": "e6f3f3b4b40a490d5cb050471baa0999366dab2a"}
HELD_OUT: HeldOutIdentityList = {
    "schema_version": 1,
    "family_ids": ["synthetic-held-out-001"],
    "source_fixes": [{"upstream": "synthetic-upstream", "commit": "2" * 40}],
    "mutation_ids": ["d" * 64],
}
EMPTY: HeldOutIdentityList = {
    "schema_version": 1,
    "family_ids": [],
    "source_fixes": [],
    "mutation_ids": [],
}


def family(**patch: object) -> Family:
    base: dict[str, object] = {
        "family_id": "synthetic-family-002",
        "exposure": "public",
        "held_out_eligible": False,
        "source_fixes": [{"upstream": "synthetic-upstream", "commit": "1" * 40}],
        "mutation_ids": [],
    }
    base.update(patch)
    # Tests also build deliberately invalid families, so the dictionary is cast unchecked.
    return cast(Family, base)


def refusal_code(action: object) -> str:
    assert callable(action)
    with pytest.raises(RegistryRefusal) as caught:
        action()
    return caught.value.code


def test_committed_registry_is_valid_and_registers_umami() -> None:
    registry = load_registry(REGISTRY)
    assert validate_record("FamilyRegistry", registry) == []
    assert registry["families"] == [
        {
            "family_id": "umami-tz-arg-001",
            "exposure": "public",
            "held_out_eligible": False,
            "source_fixes": [UMAMI_FIX],
            "mutation_ids": [],
        }
    ]
    umami: Identity = {"kind": "family", "family_id": "umami-tz-arg-001"}
    assert is_held_out_eligible(registry, umami) is False


@pytest.mark.parametrize(
    "candidate",
    [
        family(family_id="synthetic-held-out-001"),
        family(source_fixes=[{"upstream": "synthetic-upstream", "commit": "2" * 40}]),
        family(mutation_ids=["d" * 64]),
    ],
)
def test_held_out_conflict_is_refused(candidate: Family) -> None:
    registry = load_registry(REGISTRY)
    before = copy.deepcopy(registry)
    assert (
        refusal_code(lambda: register_family(registry, candidate, HELD_OUT)) == "held_out_conflict"
    )
    assert registry == before


def test_exposure_and_eligibility_cannot_change() -> None:
    registry = load_registry(REGISTRY)
    assert refusal_code(lambda: register_family(registry, family(exposure="held_out"), EMPTY)) == (
        "invalid"
    )
    assert refusal_code(
        lambda: register_family(registry, family(held_out_eligible=True), EMPTY)
    ) == ("invalid")
    linked = link_mutation(registry, "umami-tz-arg-001", "e" * 64, HELD_OUT)
    linked = link_source_fix(
        linked, "umami-tz-arg-001", {"upstream": "umami", "commit": "3" * 40}, HELD_OUT
    )
    umami = linked["families"][0]
    assert umami["exposure"] == "public"
    assert umami["held_out_eligible"] is False
    assert umami["mutation_ids"] == ["e" * 64]
    assert validate_record("FamilyRegistry", linked) == []


def test_unregistered_input_is_refused() -> None:
    registry = load_registry(REGISTRY)
    unknown: Identity = {"kind": "family", "family_id": "synthetic-unknown"}
    assert refusal_code(lambda: check_public_demo_input(registry, unknown, EMPTY)) == "unregistered"
    fix: Identity = {"kind": "source_fix", "upstream": "umami", "commit": UMAMI_FIX["commit"]}
    check_public_demo_input(registry, fix, HELD_OUT)


def test_held_out_input_is_refused_even_when_registered() -> None:
    registry = load_registry(REGISTRY)
    held: HeldOutIdentityList = {**EMPTY, "family_ids": ["umami-tz-arg-001"]}
    umami: Identity = {"kind": "family", "family_id": "umami-tz-arg-001"}
    assert (
        refusal_code(lambda: check_public_demo_input(registry, umami, held)) == "held_out_conflict"
    )
    assert registry["families"][0]["exposure"] == "public"


def test_family_with_held_out_linked_fix_or_mutation_is_refused() -> None:
    registry = load_registry(REGISTRY)
    umami: Identity = {"kind": "family", "family_id": "umami-tz-arg-001"}
    fix_held: HeldOutIdentityList = {
        **EMPTY,
        "source_fixes": [{"upstream": "umami", "commit": UMAMI_FIX["commit"]}],
    }
    assert (
        refusal_code(lambda: check_public_demo_input(registry, umami, fix_held))
        == "held_out_conflict"
    )
    linked = link_mutation(registry, "umami-tz-arg-001", "e" * 64, EMPTY)
    mutation_held: HeldOutIdentityList = {**EMPTY, "mutation_ids": ["e" * 64]}
    assert (
        refusal_code(lambda: check_public_demo_input(linked, umami, mutation_held))
        == "held_out_conflict"
    )


def test_registered_input_whose_family_is_held_out_is_refused() -> None:
    registry = load_registry(REGISTRY)
    held: HeldOutIdentityList = {**EMPTY, "family_ids": ["umami-tz-arg-001"]}
    fix: Identity = {"kind": "source_fix", "upstream": "umami", "commit": UMAMI_FIX["commit"]}
    assert refusal_code(lambda: check_public_demo_input(registry, fix, held)) == "held_out_conflict"


def test_held_out_source_fixes_compare_by_commit() -> None:
    registry = load_registry(REGISTRY)
    umami: Identity = {"kind": "family", "family_id": "umami-tz-arg-001"}
    relabelled: HeldOutIdentityList = {
        **EMPTY,
        "source_fixes": [{"upstream": "synthetic-other-label", "commit": UMAMI_FIX["commit"]}],
    }
    assert (
        refusal_code(lambda: check_public_demo_input(registry, umami, relabelled))
        == "held_out_conflict"
    )
