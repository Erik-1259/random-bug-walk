import pytest
from rbw_schema.canonical import CanonicalError, canonical_digest, encode_canonical, parse_canonical


def test_sorts_keys_by_code_point() -> None:
    value = {"b": 1, "B": 2, "a": {"z": 1, "Z": 2}, "_": 3, "1": 4}
    assert encode_canonical(value) == b'{"1":4,"B":2,"_":3,"a":{"Z":2,"z":1},"b":1}'


def test_escapes_only_the_required_characters() -> None:
    encoded = encode_canonical(['\u0007\u001f\u007f\u2028/"\\\b\t\n\f\r'])
    assert encoded == '["\\u0007\\u001f\u007f\u2028/\\"\\\\\\b\\t\\n\\f\\r"]'.encode()


def test_parses_negative_zero_as_integer_zero() -> None:
    value = parse_canonical(b"-0")
    assert value == 0
    assert type(value) is int


@pytest.mark.parametrize(
    "value",
    [
        1.5,
        1.0,
        float("nan"),
        float("inf"),
        2**53,
        -(2**53),
        "\ud800",
        {"é": 1},
        {1: "a"},
        (1, 2),
        b"bytes",
        None.__class__,
    ],
)
def test_rejects_values_outside_v1(value: object) -> None:
    with pytest.raises(CanonicalError):
        encode_canonical(value)


def test_python_bool_is_never_an_integer() -> None:
    assert encode_canonical([True, 1]) == b"[true,1]"
    with pytest.raises(CanonicalError):
        parse_canonical(b"[1.0]")


@pytest.mark.parametrize(
    "source",
    [
        b'{"a":1,"\\u0061":2}',
        b'[[{"k":{"x":1,"x":2}}]]',
        b"1E2",
        b"+1",
        b"01",
        b"[1,]",
        b'"\\x41"',
        b'"a\nb"',
        b"[1,\x0b2]",
        b"[1,\xc2\xa02]",
        b'"\\udc00x"',
        b'"\\ud800\\u0041"',
        b"   ",
        b"\xef\xbb\xbf1",
        b'"\xc3"',
        b"[\xd9\xa1]",
    ],
)
def test_rejects_invalid_input(source: bytes) -> None:
    with pytest.raises(CanonicalError):
        parse_canonical(source)


def test_digest_is_over_canonical_bytes() -> None:
    digest = canonical_digest({"b": 1, "a": 2})
    assert digest.data == b'{"a":2,"b":1}'
    assert len(digest.sha256) == 64
