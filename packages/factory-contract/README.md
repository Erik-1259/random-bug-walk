# @rbw/factory-contract

The machine-readable form of the bug request contract `bug-request/1` ([`docs/product/bug-request-v1.md`](../../docs/product/bug-request-v1.md), revision 1) and of the factory's internal data shapes: a JSON Schema, TypeScript types generated from it, type-only interfaces for host adapters and copy runners, and a validator. It defines shapes only; it has no endpoint, handler or other behavior.

## Schema source

`schema/bug-request-v1.schema.json` is the one machine-readable source. It is JSON Schema 2020-12 and follows the conventions of `@rbw/schema`: every object forbids unknown fields and requires every field, a nullable field holds `null`, and every pattern starts with `^` and ends with `$`. Under `$defs` it defines:

- the common types: `Uuid`, `Sha256`, `UtcTime` (milliseconds and `Z`, with the calendar check of the format `rbw-utc-time`), `ItemKey`, `Description` (a trimmed, non-empty request description), `MicroUsd` (never negative) and `SignedMicroUsd` (only for `remaining_microusd`, which an overrun makes negative), `GitCommitId`, `ImageDigest`, `RelativePath`, `Identifier` and `Version`;
- every enumeration of the contract, each listed once, such as `HostId`, `BugTypeId`, `ProblemCode`, `RequestState`, `RequestOutcome`, `StopCode`, `CandidateStage`, `CandidateReason`, `EventType`, `ValidationResult` and `ErrorCode`;
- the response and request bodies: `Capabilities`, `RequestInput`, `Interpretation`, `StartRequest`, `RequestStatus`, `ValidationRun`, `ValidationStartRequest`, `StopRequest`, `ErrorResponse`, `SessionRequest`, `SessionStatus` and `ExampleResponse`, with their item types such as `Candidate`, `Case`, `Cell`, `Packages` and `PackagePart`;
- `Event`, a union discriminated by `type`. Each variant fixes the shape of its `data`; `EmptyDataEvent` covers the types whose data is `{}`, and `HostEvent`, `CandidateEndedEvent` and `AttentionEvent` cover the types that share one data shape;
- the internal data shapes, which never reach a client: `BaselineIdentity`, `CatalogEntry` (with `CatalogPresentation`, the only client-safe text of an entry), `Protocol`, `FileSet`, `BugCaseInputs`, `ValidatorInputs`, `UnpackedPair`, `CopyPlan`, `CellObservation`, `CopyRecord` and `QualificationRecord`.

The contract's cross-field rules that JSON Schema can express are conditional subschemas. Each condition requires the fields it tests, so a missing field is reported once, as missing, and triggers no rule:

- `RequestStatus`: `outcome` and `stop_reason` are set exactly in state `finished`, the stop code belongs to the outcome (section 8.1), and `fulfilled` has `delivery: "complete"`. `cases` is empty exactly when `delivery` is `none` and holds only live cases, the frozen interpretation is startable, and a response holds at most 200 events. `RequestFinishedData` applies the same outcome table.
- `Candidate`: `reason` is set exactly for the stages `rejected`, `invalid`, `incomplete` and `skipped`, with a reason of that stage (section 8.3); `item_key` is `null` before `requested_criteria_passed` and set from that stage through `qualified`; a `qualified` candidate has a case. `CandidateEndedEvent` and `QualificationRecord` apply the same reason table to their type and verdict.
- `Combination`: a supported pair has a source with at least one entry and no reason; an unsupported pair has a reason (its source may be declared or `null`).
- `Problem`: the severity follows the code (section 6.2), and `budget_below_minimum` has no item. `InterpretedItem`: unsupported exactly when it has a blocking problem. `Interpretation`: startable exactly when no request-level problem is blocking and every item is supported. `ItemDifficulty`: source-only difficulty is `unsupported`, the default is `not_required`.
- `Cell` and `QualificationCell`: `matches_expectation` is true exactly when `observed` equals `expected`. Every cell's `expected` follows the qualification table (original suite: pass, pass, pass; verification checks: pass, fail, pass), and every cell of a `Case` and of an `accepted` `QualificationRecord` matches.
- `Packages`: the bug case and validator slots hold parts of their kind, each kind has its format, and both parts are ready together. `Provenance`: a live case names its request; a `Case` has an item exactly when it comes from a live request; `ExampleResponse` carries a published example.
- `ValidationRun`: `result` is set exactly in state `finished`, and a run that has not finished has no matrix. `passed` has a matrix whose six cells all match; `failed` has a matrix whose cells all observed `pass` or `fail` with at least one mismatch; `error` has no matrix or a cell that observed `error` or `incomplete` (section 11).
- `ErrorBody`: `busy` carries `BusyErrorDetails` (`active` is retryable, `needs_reconciliation` is not), `interpretation_stale` and `unsupported_request` carry the interpretation (not startable for `unsupported_request`), every other code has `null` details, and `unavailable` is retryable.

### Rules outside the schema

JSON Schema cannot compare one field with another or count across a list, so the schema does not check: unique `item_key` values within a request; the budget arithmetic of section 8.5 (`committed = reserved + spent`, `remaining = budget - committed`, `overrun`); `delivery`, `delivered`, `missing` and the funnel counts against the items (beyond `cases` being empty exactly when `delivery` is `none`); event numbering without gaps and `next_after`; `runs_valid` against `runs_total`; how a qualification verdict follows from its cells, failure codes and criteria; and every limit read from `Capabilities` (item count, quantities, description length, budget range). Those belong to the code that produces the values.

## Derived file

```
pnpm --filter @rbw/factory-contract run generate
```

writes `src/generated.ts` from the schema with `scripts/render.ts`: one type per definition, a `<NAME>_VALUES` list for every enumeration (for example `HOST_ID_VALUES`), `DEF_NAMES` and `DefTypes`. Descriptions become doc comments. The drift check in `test/drift.test.ts` renders the file again and fails when the committed file differs. The file starts with a neutral `Derived from ...` header and holds no timestamp.

## Imports

`@rbw/factory-contract` (`src/index.ts`) exports the generated types and value lists and the type-only interfaces of `src/adapter.ts`. It has no runtime dependency, so client components can import it:

```ts
import type { RequestStatus, Event } from "@rbw/factory-contract";
import { HOST_ID_VALUES } from "@rbw/factory-contract";

function label(event: Event): string {
  if (event.type === "check_finished") return `${event.data.check_set} on ${event.data.copy}: ${event.data.outcome}`;
  return event.message;
}
```

`src/adapter.ts` declares `HostAdapter` (baseline, catalog, protocol, optional availability, bug case and validator inputs, copy plans, interpretation of copy records) and `CopyRunner` (`run(plan)` resolves with a `CopyRecord` and rejects only for an uncertain provider outcome).

`@rbw/factory-contract/validate` (`src/validate.ts`) is for servers and tests. It reads the schema file next to its source when it loads and compiles it with Ajv (draft 2020-12, strict mode, with the `discriminator` keyword so an `Event` is checked against the variant its `type` names):

```ts
import { assertContract, parseContract, validateContract } from "@rbw/factory-contract/validate";

validateContract("StartRequest", body);           // [] when valid, otherwise error codes
const status = assertContract("RequestStatus", value); // narrows, or throws ContractError
const input = parseContract("RequestInput", text);     // JSON text; ContractError(["json"]) when it is not JSON
```

Error codes have the form `schema:<instance path>:<keyword>`, with the field name added for an unknown field (`schema:/:additionalProperties:extra`) or a missing one (`schema:/:required:poll_after_ms`). Because the validator reads a file at load time, a Next.js server that imports it lists the package in `serverExternalPackages`, as the web app does for `@rbw/schema`. `@rbw/factory-contract/schema.json` names the schema file itself.

## Tests

```
pnpm --filter @rbw/factory-contract test
```

- `test/fixtures.test.ts` maps every file in `docs/product/fixtures/bug-request-v1/` to its definition in one table, checks that the table lists exactly the files present, and validates each one; it does the same for the synthetic internal-shape examples in `test/fixtures/`.
- `test/invalid.test.ts` refuses variants of valid fixtures: unknown and missing fields, wrong enumeration values, bad hashes, UUIDs, item keys, descriptions and times, out-of-range numbers, and each cross-field rule above. Each variant must fail with its expected errors, and any other error must be an `if` or `anyOf` report on the path above them. It also accepts variants that the contract allows, so the schema is not stricter than the document.
- `test/rules.test.ts` reads the code tables of the contract document (sections 6.2, 8.1, 8.3, 8.4 and 12), checks that the enumerations list the same codes, and checks that the schema accepts exactly the severity, stop codes and stage the tables give each code.
- `test/drift.test.ts` is the drift check, plus the schema conventions (strict JSON, anchored patterns, closed objects, each enumeration listed once, one `Event` variant per event type) and the client-safety check of `src/index.ts`, `src/adapter.ts` and `src/generated.ts`.
- `test/types.test.ts` checks the generated types at compile time, such as narrowing an `Event` by its `type`.
