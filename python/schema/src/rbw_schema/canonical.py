"""Canonical JSON v1: strict parsing, canonical encoding and SHA-256 digests."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import cast

type JsonValue = bool | int | str | list[JsonValue] | dict[str, JsonValue] | None

MAX_SAFE_INTEGER = 9007199254740991
_MAX_DEPTH = 256
_WHITESPACE = frozenset(" \t\n\r")
_SHORT_ESCAPES = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
}
_INTEGER = re.compile(r"-?(?:0|[1-9][0-9]*)")
_HEX4 = re.compile(r"[0-9a-fA-F]{4}")
_DIGITS = frozenset("0123456789")
_LITERALS: tuple[tuple[str, JsonValue], ...] = (("true", True), ("false", False), ("null", None))


class CanonicalError(Exception):
    """Raised for any input or value outside canonical JSON v1.

    The message never quotes the input.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(f"canonical JSON: {reason}")


def _well_formed(parts: list[str]) -> str:
    """Joins string parts, pairing escaped surrogates; a lone surrogate is refused."""
    text = "".join(parts)
    try:
        return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le")
    except UnicodeDecodeError as error:
        raise CanonicalError("lone surrogate") from error


class _Parser:
    def __init__(self, text: str) -> None:
        self._text = text
        self._position = 0

    def parse_document(self) -> JsonValue:
        value = self._parse_value(0)
        self._skip_whitespace()
        if self._position != len(self._text):
            raise CanonicalError("trailing content")
        return value

    def _peek(self) -> str:
        return self._text[self._position] if self._position < len(self._text) else ""

    def _next(self) -> str:
        char = self._peek()
        self._position += 1
        return char

    def _skip_whitespace(self) -> None:
        while self._peek() in _WHITESPACE:
            self._position += 1

    def _parse_value(self, depth: int) -> JsonValue:
        if depth > _MAX_DEPTH:
            raise CanonicalError("nesting too deep")
        self._skip_whitespace()
        char = self._peek()
        if char == "{":
            return self._parse_object(depth)
        if char == "[":
            return self._parse_array(depth)
        if char == '"':
            return self._parse_string()
        if char == "-" or char in _DIGITS:
            return self._parse_number()
        for word, value in _LITERALS:
            if self._text.startswith(word, self._position):
                self._position += len(word)
                return value
        raise CanonicalError("unexpected token")

    def _parse_object(self, depth: int) -> JsonValue:
        self._position += 1
        result: dict[str, JsonValue] = {}
        self._skip_whitespace()
        if self._peek() == "}":
            self._position += 1
            return result
        while True:
            self._skip_whitespace()
            if self._peek() != '"':
                raise CanonicalError("expected a key")
            key = self._parse_string()
            if not key.isascii():
                raise CanonicalError("non-ASCII key")
            if key in result:
                raise CanonicalError("duplicate key")
            self._skip_whitespace()
            if self._next() != ":":
                raise CanonicalError("expected a colon")
            result[key] = self._parse_value(depth + 1)
            self._skip_whitespace()
            following = self._next()
            if following == "}":
                return result
            if following != ",":
                raise CanonicalError("expected a comma")

    def _parse_array(self, depth: int) -> JsonValue:
        self._position += 1
        result: list[JsonValue] = []
        self._skip_whitespace()
        if self._peek() == "]":
            self._position += 1
            return result
        while True:
            result.append(self._parse_value(depth + 1))
            self._skip_whitespace()
            following = self._next()
            if following == "]":
                return result
            if following != ",":
                raise CanonicalError("expected a comma")

    def _parse_string(self) -> str:
        self._position += 1
        parts: list[str] = []
        while True:
            char = self._next()
            if char == "":
                raise CanonicalError("unterminated string")
            if char == '"':
                break
            if ord(char) < 0x20:
                raise CanonicalError("control character in string")
            if char != "\\":
                parts.append(char)
                continue
            escape = self._next()
            if escape == "u":
                digits = self._text[self._position : self._position + 4]
                if _HEX4.fullmatch(digits) is None:
                    raise CanonicalError("invalid unicode escape")
                parts.append(chr(int(digits, 16)))
                self._position += 4
            elif escape in _SHORT_ESCAPES:
                parts.append(_SHORT_ESCAPES[escape])
            else:
                raise CanonicalError("invalid escape")
        return _well_formed(parts)

    def _parse_number(self) -> int:
        match = _INTEGER.match(self._text, self._position)
        if match is None:
            raise CanonicalError("invalid number")
        self._position = match.end()
        following = self._peek()
        if following in {".", "e", "E"}:
            raise CanonicalError("only integers are allowed")
        if following in _DIGITS:
            raise CanonicalError("leading zero")
        digits = match.group()
        # Reject before converting: int() refuses very long literals with ValueError.
        if len(digits.removeprefix("-")) > len(str(MAX_SAFE_INTEGER)):
            raise CanonicalError("integer out of range")
        value = int(digits)
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalError("integer out of range")
        return value


def parse_canonical(data: bytes) -> JsonValue:
    """Parses bytes strictly: UTF-8 without BOM, no duplicate or non-ASCII keys, integers only,
    nothing trailing."""
    if data.startswith(b"\xef\xbb\xbf"):
        raise CanonicalError("byte-order mark")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise CanonicalError("invalid UTF-8") from error
    return _Parser(text).parse_document()


def _encode_string(value: str) -> str:
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise CanonicalError("lone surrogate") from error
    # For well-formed strings json.dumps without ensure_ascii escapes exactly ", \, \b, \t, \n,
    # \f, \r and other code points below U+0020 (as lowercase \u00xx); everything else is literal.
    return json.dumps(value, ensure_ascii=False)


def _serialize(value: object, depth: int) -> str:
    if depth > _MAX_DEPTH:
        raise CanonicalError("nesting too deep")
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if type(value) is int:
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalError("only safe integers are allowed")
        return str(value)
    if isinstance(value, str):
        return _encode_string(value)
    if type(value) is list:
        items = cast(list[object], value)
        return "[" + ",".join(_serialize(item, depth + 1) for item in items) + "]"
    if type(value) is dict:
        record = cast(dict[object, object], value)
        keys: list[str] = []
        for key in record:
            if not isinstance(key, str):
                raise CanonicalError("non-string key")
            if not key.isascii():
                raise CanonicalError("non-ASCII key")
            keys.append(key)
        # Keys are ASCII, so code point order equals byte order.
        keys.sort()
        members = (f"{_encode_string(key)}:{_serialize(record[key], depth + 1)}" for key in keys)
        return "{" + ",".join(members) + "}"
    raise CanonicalError("unsupported value")


def encode_canonical(value: object) -> bytes:
    """Canonical JSON v1 bytes of a value. Raises CanonicalError for anything outside v1."""
    return _serialize(value, 0).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class CanonicalDigest:
    data: bytes
    sha256: str


def canonical_digest(value: object) -> CanonicalDigest:
    """Canonical bytes and their SHA-256; store both wherever the hash is stored."""
    data = encode_canonical(value)
    return CanonicalDigest(data=data, sha256=sha256_hex(data))
