"""Record validation: canonical JSON v1, the shared JSON Schema, then the code rules."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator, Mapping
from functools import cache
from importlib import resources
from typing import Protocol, cast

import jsonschema.validators
from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012, Schema

from rbw_schema.canonical import (
    CanonicalError,
    JsonValue,
    canonical_digest,
    encode_canonical,
    parse_canonical,
)
from rbw_schema.generated import DEF_NAMES, ProjectPolicy
from rbw_schema.rules import RecordContext, check_rules

__all__ = [
    "RecordContext",
    "RecordError",
    "assert_record",
    "is_utc_time",
    "parse_record",
    "policy_sha256",
    "validate_record",
]

# Offsets of year, month, day, hour, minute and second in a UtcTime string.
_UTC_TIME_FIELDS = ((0, 4), (5, 7), (8, 10), (11, 13), (14, 16), (17, 19))
_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def is_utc_time(value: str) -> bool:
    """Calendar check for UtcTime. The schema pattern alone checks the shape; this reads the
    fields at their fixed offsets and returns False when one is not a number."""
    fields = [value[start:end] for start, end in _UTC_TIME_FIELDS]
    if not all(field and all("0" <= char <= "9" for char in field) for field in fields):
        return False
    year, month, day, hour, minute, second = (int(field) for field in fields)
    if not 1 <= month <= 12 or day < 1 or hour > 23 or minute > 59 or second > 59:
        return False
    leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
    days = 29 if month == 2 and leap else _MONTH_DAYS[month - 1]
    return day <= days


class _Validator(Protocol):
    """The part of a jsonschema validator used here."""

    def iter_errors(self, instance: object) -> Iterator[ValidationError]: ...


type _KeywordFunction = Callable[
    [object, str, object, Mapping[str, object]], Iterator[ValidationError]
]


def _full_match_pattern(
    _validator: object, pattern: str, instance: object, _schema: Mapping[str, object]
) -> Iterator[ValidationError]:
    # Every schema pattern is anchored with ^ and $; a full match keeps Python's $ from accepting
    # a trailing newline, so both languages agree.
    if isinstance(instance, str) and re.fullmatch(pattern, instance) is None:
        yield ValidationError("does not match the pattern")


def _format_checker() -> FormatChecker:
    checker = FormatChecker(formats=())

    def check_utc_time(instance: object) -> bool:
        return not isinstance(instance, str) or is_utc_time(instance)

    checker.checks("rbw-utc-time")(check_utc_time)
    return checker


def _load_schema() -> dict[str, JsonValue]:
    data = resources.files("rbw_schema").joinpath("records.schema.json").read_bytes()
    schema = parse_canonical(data)
    if not isinstance(schema, dict) or not isinstance(schema.get("$id"), str):
        raise TypeError("records.schema.json is malformed")
    return schema


_SCHEMA = _load_schema()
_SCHEMA_ID = cast(str, _SCHEMA["$id"])
_REGISTRY = Registry[Schema]().with_resource(
    _SCHEMA_ID, Resource[Schema].from_contents(_SCHEMA, default_specification=DRAFT202012)
)


class _ValidatorClass(Protocol):
    """The constructor of a jsonschema validator class, as used here."""

    def __call__(
        self,
        schema: Mapping[str, object],
        *,
        registry: Registry[Schema],
        format_checker: FormatChecker,
    ) -> _Validator: ...


# jsonschema ships without type annotations for extend; the cast states the shape used here.
_extend = cast(
    Callable[[object, Mapping[str, _KeywordFunction]], _ValidatorClass],
    jsonschema.validators.extend,  # pyright: ignore[reportUnknownMemberType] - unannotated upstream
)
_RecordValidator = _extend(Draft202012Validator, {"pattern": _full_match_pattern})
_FORMAT_CHECKER = _format_checker()


@cache
def _validator_for(type_name: str) -> _Validator:
    if type_name not in DEF_NAMES:
        raise ValueError(f"no schema definition {type_name}")
    reference = {"$ref": f"{_SCHEMA_ID}#/$defs/{type_name}"}
    return _RecordValidator(reference, registry=_REGISTRY, format_checker=_FORMAT_CHECKER)


def _path(error: ValidationError) -> str:
    return "".join(f"/{part}" for part in error.absolute_path) or "/"


def validate_record(
    type_name: str, value: object, context: RecordContext | None = None
) -> list[str]:
    """Returns error codes; an empty list means the value is valid."""
    try:
        encode_canonical(value)
    except CanonicalError:
        return ["canonical"]
    errors = list(_validator_for(type_name).iter_errors(value))
    if errors:
        return [f"schema:{_path(error)}:{error.validator}" for error in errors]
    return check_rules(type_name, cast(JsonValue, value), context or {})


class RecordError(Exception):
    """Raised when a value is not a valid record; `errors` holds the error codes."""

    def __init__(self, type_name: str, errors: list[str]) -> None:
        super().__init__(f"invalid {type_name}: {', '.join(errors)}")
        self.errors = errors


def assert_record(type_name: str, value: object, context: RecordContext | None = None) -> JsonValue:
    """Validates a value and returns it as JSON; raises RecordError when invalid. Callers narrow
    the result to the record's generated type with cast."""
    errors = validate_record(type_name, value, context)
    if errors:
        raise RecordError(type_name, errors)
    return cast(JsonValue, value)


def parse_record(type_name: str, data: bytes, context: RecordContext | None = None) -> JsonValue:
    """Strictly parses bytes as canonical JSON input and validates the record."""
    try:
        value = parse_canonical(data)
    except CanonicalError as error:
        raise RecordError(type_name, ["canonical"]) from error
    return assert_record(type_name, value, context)


def policy_sha256(policy: ProjectPolicy) -> str:
    """SHA-256 of a policy's canonical bytes."""
    return canonical_digest(policy).sha256
