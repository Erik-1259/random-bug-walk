# Request API acceptance coverage

Status: unavailable. No request-API acceptance runner is implemented here yet.
The published API contract and an isolated deterministic backend are prerequisites.
`readiness.json` records this dependency result; it is not a successful test run.

## Source and existing coverage

The inspected backend source is revision
`575c1074de588449f72dcebcae4d24900d0015e4`.
`docs/product/bug-request-v1.md` is absent at that revision. The expected
`feat/rbw-product-contracts` branch and a matching published pull request were
not found during the dependency check. No contract revision can yet be pinned.

Existing coverage useful as reference:

| Source | Existing proof | Boundary |
| --- | --- | --- |
| `packages/web/test/judge/judge.test.ts` | Concurrent and repeated judge starts create and reserve once; status, budget refusals, and hidden-field checks | Calls judge handlers with injected dependencies; does not exercise a bug-request HTTP service |
| `packages/web/test/build.test.ts` | HTTP requests against the built web application | Existing judge routes, not the unpublished request contract |
| `tools/controller/test/support/harness.ts` | PGlite ledger, fake sandbox and local-runner controls | Internal fixture infrastructure, not an approved external request-API test control |
| `packages/search/test/unit/errors.test.ts` | Provider failures remain incomplete rather than becoming successful negative results | Search component semantics, not qualified request delivery |
| `tools/release/test/unit/replays.test.ts` | Release replay coverage | Separate from request API acceptance; do not duplicate the replay harness |

A bounded environment check ran these two existing judge tests:

```sh
pnpm --filter @rbw/web exec vitest run test/judge/judge.test.ts -t 'makes one create for two POSTs with one request ID|answers a repeated POST with one request ID'
```

Both selected tests passed. The other 41 tests in that file were intentionally
excluded by the name filter. This result does not count as request-API acceptance.

## Scenario matrix

These are coverage goals awaiting mapping to the published contract. They do not
define routes, payload fields, response codes, or new backend behavior.

| ID | Coverage goal | Evidence needed from the approved isolated instance | State |
| --- | --- | --- | --- |
| identity | Repeated and concurrent identical starts; conflicting key reuse | Contract-defined responses plus durable request, job, reservation and provider-call evidence keyed to the request | Unavailable |
| quantities | Multiple descriptions with different quantities | Per-item requested, qualified-delivered and missing counts, with candidate attribution | Unavailable |
| shared-budget | Both host selections under one request allowance | Read-only reservation and spend evidence across both hosts, plus defined exhaustion behavior | Unavailable |
| qualification | Duplicate, rejected, incomplete and invalid candidates | Controlled candidate outcomes and resulting qualified counts; default-mode screening semantics from the contract | Unavailable |
| unsupported | Unsupported host, type, specification and optional difficulty | Published unsupported outcomes and evidence that requested requirements were not silently substituted | Unavailable |
| stops | Partial and empty results after cancellation, exhaustion and failure | Deterministic stop controls, retained qualified results and distinct contract-defined reasons | Unavailable |
| continuity | Repeated status reads and client reconnect | Durable identity and terminal-state evidence; only recovery behavior actually promised by the contract | Unavailable |
| downloads | Readiness, validation state and package separation | Controlled pending, failed and ready validation; advertised case/validator artifacts; ordinary payloads without validator contents or reference fixes | Unavailable |

## Prerequisites for implementation

1. Publish the contract and supply its exact commit. Pin the backend revision
   separately, even if it is the same commit.
2. Supply the approved local test-instance startup invocation and isolation
   verification. The runner must not infer a target from production URLs or
   inherited provider configuration.
3. Identify existing deterministic controls for candidates, stops and validation,
   plus read-only evidence for durable requests, jobs, reservations and provider
   calls. A returned count alone does not prove absence of duplicate side effects.
4. Map the matrix to the contract's public operations. If an observation is not
   available, record that scenario as unavailable and identify the smallest
   missing observation; do not replace it with private helper calls.

The eventual runner must return machine-readable passed, failed and unavailable
outcomes and a non-success exit when a required scenario is unavailable. No
invocation against the new API is documented until its contract and test controls
exist. Runner fixture tests will not count as product acceptance.

Request-API acceptance with deterministic providers is distinct from end-to-end
product acceptance. It does not establish real host generation, qualification,
or package replay.
