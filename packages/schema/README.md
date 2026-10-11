# @rbw/schema and rbw-schema

The shared record schema, canonical JSON v1, the project policy builder, the family registry, and the job contracts with their identity computations. `@rbw/schema` is the TypeScript package in this directory; `rbw-schema` (import name `rbw_schema`) is the Python package in `python/schema/`. Both read the same schema source and the same fixtures.

## Schema source

`schema/records.schema.json` is the one machine-readable source. It is JSON Schema 2020-12 and defines, under `$defs`:

- the common types: `Uuid`, `Sha256`, `ImageDigest`, `GitCommitId`, `UtcTime`, `DurationMs`, `ByteCount`, `TokenCount`, `MicroUsd` and the path, URL and slug types;
- the job types: `CheckId`, `TestId`, `OperationKind`, `CallName`, `FileMode`, `TimeZoneName`, `LocaleTag`, `EndpointPath` and `QueryParameters` (the one object whose keys are not fixed);
- every status, outcome, reason and category list, including `JobKind`, `CodeState`, `ExpectedOutcome`, `ObservedOutcome`, `TrialStatus`, `TrialReason`, `AssertionFailureCode` and `TaskRevisionKind`;
- the records `ProjectPolicy`, `FamilyRegistry`, `HeldOutIdentityList`, `RootRun`, `ArtifactManifest`, `PublicationRecord`, `RunManifest`, `PublicRunStatus` and `StagingOmissions`, with their item types;
- the job records `JobRequest`, `ExpectedTrials` (with `ExpectedTrial` and `ExpectedCheck`), `TrialObservations` (with `CheckObservation`), `TrialResult` and `ObservedSymptom` (with `SymptomRequest`, `SymptomEvent`, `BucketCount`, `FollowUpExample` and `DocExcerpt`);
- the identity records `OperationIdentity`, `MutationIdentity` (with `MutationChange`) and `TaskRevisionIdentity`;
- the release record `Release`, with `ReleaseRevision`, `ReleaseImages`, `ReleaseFamily`, `ReleaseRun`, `ReleaseAdmission`, `ReleaseFile`, `ReleaseApproval`, `ReleaseJudgeJob` and the common type `ImageReference`. It has no code rules: `tools/release` checks that its complete revision reduces to the admission's provisional one (see `tools/release/README.md`).

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
- `JobRequest`: `parent_execution_id` is `null` exactly when `execution_id` equals `root_execution_id` (`job:root_parent`) and never equals `execution_id` (`job:own_parent`); `operation_id` (`job:operation_id`) and `payload_hash` (`job:payload_hash`) equal the values computed from the request (see [Job contracts](#job-contracts)).
- `ExpectedTrials`: trial IDs are unique (`trials:duplicate_trial`) and each trial's check IDs are unique (`trials:duplicate_check`). Checked against its request: the manifest's SHA-256 equals `expected_trials_sha256`; the trials follow the request kind's profile in order, with the code state of each trial ID (`trials:trial_list`) and its repeat count (`trials:repeat_count`); every trial of a kind other than `observe` has an original suite (`trials:original_suite_missing`), and an `observe` trial has none (`trials:original_suite_present`).
- `TrialObservations`: observations are sorted by `repeat_index`, then `check_id` in code point order, and unique by that pair (`observations:order`).
- `TrialResult`: `ended_at` is not before `started_at`, compared as instants, so `00.3Z` equals `00.300Z` (`result:ended_before_started`).
- `ObservedSymptom`: each event's `utc_instant` is the UTC time of its `timestamp_seconds` (`symptom:event_instant`).
- `MutationIdentity`: changes are sorted by path with unique paths (`mutation:changes_sorted`), and no change keeps the same hash and mode on both sides (`mutation:unchanged`).
- `UtcTime`: the custom format `rbw-utc-time` rejects impossible dates and times, such as `2026-02-30T00:00:00Z`, hour 24 and second 60.
- Context: a record checked against its policy or root must carry the same `project_id`, `project_policy_sha256` and `root_execution_id`, for each of those fields the record has (`PublicationRecord`, `PublicRunStatus` and `ArtifactManifest` have no `project_id`); a policy checked against the one it succeeds must keep the project, raise the version and never go from public to private; a record checked against its job request (`request`) must carry the request's `project_policy_sha256`, `root_execution_id`, `execution_id`, `task_revision` and `expected_trials_sha256`, for each of those fields the record has (`request:<field>`).

The cross-field rules that JSON Schema can express are conditional subschemas: the baseline pair is set exactly for `observe` and `release_id` exactly for `judge_verify`; a clean trial has no patch hash and every other trial has one; a `null` original suite has no test IDs and a set one has at least one; an expected or observed failure code matches its outcome; key-and-hash pairs are both set or both `null`; a `complete` or `invalid` result has both pairs, and `invalid_reason` is `null` exactly for `complete`; a mutation change has a hash and a mode on the same sides and at least one side; and a task revision's `mutation_id`, `issue_sha256` and `issue_style` follow its `revision_kind`.

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
validateRecord("ExpectedTrials", manifest, { request }); // checked against its job request
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

## Job contracts

`src/jobs.ts` and `rbw_schema/jobs.py` build the job records and compute their identities. Every identity is the SHA-256 of the canonical bytes of one identity record, and each function returns that ID with the bytes (`CanonicalDigest`: `bytes`/`data` and `sha256`), so callers can store both.

| TypeScript | Python | Returns |
|---|---|---|
| `operationId(identity)` | `operation_id(identity)` | `operation_id` of an `OperationIdentity` |
| `jobOperationIdentity(fields)` | `job_operation_identity(fields)` | The `OperationIdentity` of a job request: its own fields, its `kind` and a `null` `call_name` |
| `providerCallIdentity(fields)` | `provider_call_identity(fields)` | The validated `OperationIdentity` of a provider call: `schema_version` 1 and the identity fields of `fields`, whose other keys (such as `execution_id`) are ignored |
| `callName(kind, ...segments)` | `call_name(kind, *segments)` | A provider call's `CallName`: the kind and the segments joined with `:` |
| `jobPayloadHash(fields)` | `job_payload_hash(fields)` | `payload_hash`: the request without its `payload_hash` key, `operation_id` included |
| `mutationId(input, { allowedPaths })` | `mutation_id(input, allowed_paths=...)` | `mutation_id` of `{host_commit, changes}` |
| `taskRevision(identity)` | `task_revision(identity)` | `task_revision` of a `TaskRevisionIdentity` |
| `buildJobRequest(fields)` | `build_job_request(fields)` | The request, its bytes and SHA-256, from every field except `operation_id` and `payload_hash` |
| `buildExpectedTrials(input)` | `build_expected_trials(input)` | The manifest, its bytes and SHA-256 |

- A provider call uses an `OperationIdentity` with its call kind (such as `writer.issue`) and a call name that carries the candidate and the call's ordinal (such as `writer.issue:cand-17:3`). A deliberate new attempt raises `attempt_ordinal`; a redelivery reuses the ID. Provider calls hash their own request bodies in their packages. `@rbw/writer` and `@rbw/search` compute their operation IDs with `providerCallIdentity` and `operationId`, and their call names with `callName`.
- `callName` refuses, with a `RecordError`, a kind that is not an `OperationKind` (`call_name:kind`) and a segment that is not one `CallName` segment, or a number that is not a safe non-negative integer (`call_name:segment`; a Python `bool` is never one), so `callName("x", "a:b")` cannot equal `callName("x", "a", "b")`.
- `mutationId` refuses a mode outside `FileMode` such as a symlink (`mutation:mode`), an absolute path (`mutation:absolute_path`), a `.` or `..` segment (`mutation:traversal`) and a path that is not one of `allowedPaths` (`mutation:outside_allowed`) before anything is hashed, then sorts the changes by path. The hashes are of full file bytes, so a whitespace-only change gives a new ID; nothing about the source card is an input.
- A task revision holds no price, rate sheet or execution profile: a price change changes `runtime_profile_sha256` and so the operation ID, never the task revision. A `kit` revision has no mutation or issue, a `provisional` one has a mutation and no issue, and a `complete` one has all three; the two candidate revisions differ because `revision_kind` differs.
- `buildExpectedTrials` takes the kind, `executionId`, `taskRevision`, a patch hash per non-clean code state the kind uses, the original-suite hash and test IDs (ignored for `observe`), the added-suite hash, and an expected-check vector per code state. The check vectors are inputs; this package holds none. It refuses, with a `RecordError`, a kind that is not a job kind (`build:kind`), a missing patch hash (`build:patch_missing`) or check vector (`build:checks_missing`), and a `null` original suite outside `observe` (`build:original_suite_missing`).
- `TRIAL_PROFILES` lists each kind's trials:

| Kind | Trials, in order | Added-suite repeats | Original suite |
|---|---|---|---|
| `kit_check` | `clean-01` to `clean-05` | 20 for `clean-01`, 1 for the rest | in each |
| `observe` | `planted-01` | 1 | none |
| `admission` | `clean-01`, `fixed-01` to `fixed-05`, `planted-01` to `planted-05`, `partial-01`, `stub-01` | 20 for `fixed-01` and `planted-01`, 1 for the rest | in each |
| `judge_verify` | `clean-01`, `planted-01`, `fixed-01` | 1 | in each |

A `complete` `TrialResult` is evidence that everything ran; it is not a verdict and not an admission. `ObservedSymptom` is the only input the issue writer accepts; it allows no field beyond those listed, at any level.

`TestId` is `^[!-~]+$`. A Playwright 1.63.0 `--list --reporter=json` report gives each spec an `id` such as `d22e25be00584dc0df90-e7379098e8511d6e039f` (one per project), which matches; spec titles with spaces or non-ASCII characters do not.

## Shared fixtures

`fixtures/` holds every fixture; both test suites read it in place. `fixtures/.gitattributes` marks every file `-text`.

- `manifest.json` lists the canonical cases (`name`, `expect`) and the record cases (`name`, `type`, `expect`, `rule`, optional `context` naming the `policy`, `root`, `previous` policy or job `request` fixture, and, for an invalid fixture that a code rule rejects, the one `error` code it must produce). Both suites assert that an invalid fixture produces exactly its `error`, or only schema errors when it names none, so a fixture never passes on a second, unrelated fault.
- `canonical/<name>.input` holds input bytes; valid cases add `<name>.canonical` and `<name>.sha256`.
- `records/<name>.json` holds a record (or a common-type value); valid cases add `<name>.canonical` and `<name>.sha256`.
- `call-names.json` lists `callName` cases (`name`, `kind`, `segments`, and either the `expect`ed name or the one `error` code).

### Report commands

Each prints one line per fixture, `<name> <verdict> <sha256 or ->`, canonical cases first, in manifest order, and then `<name> <id> <value>` for each ID computed from a valid job request (`operation_id`, `payload_hash`) or identity record (`operation_id`, `mutation_id`, `task_revision`), so comparing the two reports compares the IDs too:

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
