# @rbw/schema and rbw-schema

The shared record schema, canonical JSON v1, the project policy builder and the family registry. `@rbw/schema` is the TypeScript package in this directory; `rbw-schema` (import name `rbw_schema`) is the Python package in `python/schema/`. Both read the same schema source and the same fixtures.

## Schema source

`schema/records.schema.json` is the one machine-readable source. It is JSON Schema 2020-12 and defines, under `$defs`:

- the common types: `Uuid`, `Sha256`, `ImageDigest`, `GitCommitId`, `UtcTime`, `DurationMs`, `ByteCount`, `TokenCount`, `MicroUsd` and the path, URL and slug types;
- every status, outcome, reason and category list;
- the records `ProjectPolicy`, `FamilyRegistry`, `HeldOutIdentityList`, `RootRun`, `ArtifactManifest`, `PublicationRecord`, `RunManifest`, `PublicRunStatus` and `StagingOmissions`, with their item types.

Every object forbids unknown fields and requires every field; a nullable field holds `null`. `schema_version` is the constant `1`. Cross-field rules are conditional subschemas (`if`/`then`/`else`, `oneOf`) wherever the format allows.

### Derived files

```
pnpm --filter @rbw/schema run generate
```

writes three committed files from the source:

| File | Content |
|---|---|
| `packages/schema/src/generated.ts` | TypeScript types, the value list of every enum, `DEF_NAMES` and `DefTypes` |
| `python/schema/src/rbw_schema/generated.py` | Python `Literal` aliases, `TypedDict` classes and value tuples |
| `python/schema/src/rbw_schema/records.schema.json` | A byte copy of the source for the Python package |

The drift check in `test/drift.test.ts` (part of `pnpm test`) renders the files again and fails when a committed file differs. The generated files start with a neutral `Derived from ...` header and hold no timestamp.

### Rules outside the schema

JSON Schema cannot compare one field with another, so these rules live in `src/rules.ts` and `python/schema/src/rbw_schema/rules.py`, and the shared invalid fixtures cover each one:

- `FamilyRegistry`: family IDs, source fixes and mutation IDs are each unique across the registry.
- `RootRun`: `child_execution_ids` never contains the root's own ID.
- `ArtifactManifest`: entry keys are unique.
- `PublicationRecord`: `execution_id` is the root's own ID, and `artifacts` are sorted by path, with unique paths.
- `RunManifest`: the root comes first in `executions` with a `null` parent, every child has the root as parent, execution IDs are unique, entries are sorted by path with unique paths, each entry's execution is listed, `redactions` are sorted by category with one item per category, withheld entries are numbered `withheld/1` to `withheld/<k>` without gaps, and a `public_uri` ends in `sha256/<the entry's sha256>`. Checked against its policy, a `public_uri` must equal the policy's `public_artifact_base_uri` plus `sha256/<sha256>`.
- `StagingOmissions`: declared paths are unique, and each `(path, category)` pair appears once in `redactions`.
- `UtcTime`: the custom format `rbw-utc-time` rejects impossible dates and times, such as `2026-02-30T00:00:00Z`, hour 24 and second 60.
- Context: a record checked against its policy or root must carry the same `project_id`, `project_policy_sha256` and `root_execution_id`, for each of those fields the record has (`PublicationRecord`, `PublicRunStatus` and `ArtifactManifest` have no `project_id`); a policy checked against the one it succeeds must keep the project, raise the version and never go from public to private.

Every pattern starts with `^` and ends with `$`. TypeScript compiles patterns with the `u` flag; Python applies them with `re.fullmatch`, so a valid value followed by `\n` is invalid in both.

## Canonical JSON v1

`src/canonical.ts` and `rbw_schema/canonical.py`:

- `encodeCanonical` / `encode_canonical` accept objects, arrays, strings, `true`, `false`, `null` and integers with an absolute value of at most 9,007,199,254,740,991. A Python `bool` is never an integer. Keys must be ASCII and are sorted by code point. Output is UTF-8 without whitespace, trailing newline or BOM. Only `"`, `\`, the five short escapes and other code points below U+0020 (as lowercase `\u00xx`) are escaped. Strings with a lone surrogate are rejected.
- `parseCanonical` / `parse_canonical` reject invalid UTF-8, a leading BOM, duplicate keys at any depth, non-ASCII keys, fractions, exponents, NaN, Infinity, out-of-range integers, lone-surrogate escapes and trailing content. `-0` is the integer 0.
- `canonicalDigest` / `canonical_digest` return the canonical bytes and their SHA-256 in lowercase hex.

For the permitted values the output equals RFC 8785 (JCS); the TypeScript tests use the `canonicalize` package as an oracle for every canonical fixture.

## Validation

```ts
import { validateRecord, parseRecord, assertRecord } from "@rbw/schema";

validateRecord("RootRun", value, { policy });    // [] when valid, otherwise error codes
const root = parseRecord("RootRun", bytes, { policy }); // strict parse, then validate; throws RecordError
```

```python
from rbw_schema.validate import validate_record, parse_record

validate_record("RootRun", value, {"policy": policy})
```

TypeScript validates with Ajv (draft 2020-12, strict mode); Python with `jsonschema`. Both first check that the value is canonical JSON v1, then the schema, then the code rules.

## Project policy

`buildPolicy({ projectId, outputRepository, publicArtifactBaseUri, policyVersion })` (Python: `build_policy(...)`) returns the policy, its canonical bytes and `project_policy_sha256`. Both destinations set gives `public_demo`/`public`; both `null` gives `evaluation`/`private`; anything else is refused. `policySuccessionErrors(previous, next)` checks a new policy version against the frozen one. The publisher's `policy` command writes frozen policy files (see `packages/publisher/README.md`).

## Family registry

`registry/families.json` is the committed registry. It holds `umami-tz-arg-001`: public, not eligible for held-out use, with the source fix `umami` at `e6f3f3b4b40a490d5cb050471baa0999366dab2a` and no mutation IDs yet.

The functions in `src/registry.ts` and `rbw_schema/registry.py` never change an entry's `exposure` or `held_out_eligible`; the schema only allows `public` and `false`.

| Function | Effect |
|---|---|
| `isHeldOutEligible(registry, identity)` | `false` for every registered family, source fix and mutation ID; refuses an unregistered identity |
| `registerFamily(registry, family, heldOut)` | Returns a new registry with the family appended |
| `linkSourceFix(registry, familyId, fix, heldOut)` | Adds a source fix to a public family; it stays public |
| `linkMutation(registry, familyId, mutationId, heldOut)` | Adds a mutation ID to a public family; it stays public |
| `checkPublicDemoInput(registry, identity, heldOut)` | Accepts a registered identity for the public demo when neither it nor any identity of its family (family ID, source fixes, mutation IDs) is held out |

Refusals raise `RegistryRefusal` with a code: `held_out_conflict` (checked first, and the identity is never relabelled), `unregistered`, `duplicate`, `unknown_family` or `invalid`. An identity is `{kind: "family", family_id}`, `{kind: "source_fix", upstream, commit}` or `{kind: "mutation", mutation_id}`. A held-out source fix matches by its commit ID alone, whatever its `upstream` label.

### Held-out identity list

The held-out list is supplied at run time; it is private in real use and synthetic in tests. It is a `HeldOutIdentityList` record:

```json
{
  "schema_version": 1,
  "family_ids": ["<slug>"],
  "source_fixes": [{ "upstream": "<slug>", "commit": "<40 lowercase hex>" }],
  "mutation_ids": ["<64 lowercase hex>"]
}
```

## Shared fixtures

`fixtures/` holds every fixture; both test suites read it in place. `fixtures/.gitattributes` marks every file `-text`.

- `manifest.json` lists the canonical cases (`name`, `expect`) and the record cases (`name`, `type`, `expect`, `rule`, optional `context` naming the policy, root or previous-policy fixture, and, for an invalid fixture that a code rule rejects, the one `error` code it must produce). Both suites assert that an invalid fixture produces exactly its `error`, or only schema errors when it names none, so a fixture never passes on a second, unrelated fault.
- `canonical/<name>.input` holds input bytes; valid cases add `<name>.canonical` and `<name>.sha256`.
- `records/<name>.json` holds a record (or a common-type value); valid cases add `<name>.canonical` and `<name>.sha256`.

### Report commands

Each prints one line per fixture, `<name> <verdict> <sha256 or ->`, canonical cases first, in manifest order:

```
node packages/schema/scripts/report.ts packages/schema/fixtures
uv run --frozen python -m rbw_schema.report packages/schema/fixtures
diff <(node packages/schema/scripts/report.ts packages/schema/fixtures) \
     <(uv run --frozen python -m rbw_schema.report packages/schema/fixtures)
```

`test/report.test.ts` runs the same comparison.

## Tests

```
pnpm --filter @rbw/schema test
uv run --frozen pytest python/schema
```
