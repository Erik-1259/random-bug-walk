# Request API acceptance runner

This partial black-box runner follows the merged `bug-request/1` revision 2
contract at `66651d67fcb09c402b25d9688ea492c0e69e1c2b`. It extends the runner in
PR #124, which remains a separate dependency. The follow-up base combines that
PR's unchanged head `04e926b9b2ff89078be124d905ad73dd57c24d90` with main
`f803962dcaf3b51b8881a7c4db99aeded33c7e1d`.

The runner uses `@rbw/factory-contract` for types and response shape
validation. Every Start, replay, status and post-completion response is checked
at its boundary. Expected outcomes, quantities, routing, retention, qualification
and accounting assertions remain independent of the service's validators. Fixtures
are exact copies from the pinned contract, not evidence that the backend passes.

## Invocation

From the repository root, with the locked Node 24 and pnpm dependencies installed:

```sh
pnpm --filter @rbw/product-acceptance test
pnpm --filter @rbw/product-acceptance typecheck
pnpm --filter @rbw/product-acceptance lint
pnpm --filter @rbw/product-acceptance build
node tools/product-acceptance/src/cli.ts
```

The first four commands check the runner itself. Without a selected backend, the
CLI makes no network calls, prints the report in `readiness.json`, and exits 2
with all groups unavailable. It never substitutes scripted fixtures for HTTP.
Exit codes are 0 for all required groups passed, 1 for an assertion or transport
failure, and 2 for unavailable coverage without a failure. A failed group takes
precedence over unavailable coverage, and the JSON retains both counts.

To exercise the existing service's explicit isolated test mode, create a separate
clean checkout at the exact pinned backend revision, install its locked
dependencies, then pass that checkout's directory. For example, from this checkout:

```sh
git worktree add --detach ../rbw-api-test-backend f803962dcaf3b51b8881a7c4db99aeded33c7e1d
pnpm --dir ../rbw-api-test-backend install --frozen-lockfile
node tools/product-acceptance/src/cli.ts --local-backend ../rbw-api-test-backend
```

`--local-backend` is a filesystem checkout, never a URL. The adapter refuses a
wrong revision, dirty checkout, or dotenv files at the repository or web package
root. It launches the installed Next service on an allocated loopback port with
an explicit synthetic environment and test mode enabled. It does not inherit
provider credentials. Before probing, it verifies the owned process, test reset,
and signed-in session. Later isolation checks preserve request state. Reconnect
uses a new HTTP connection and retains the session cookie. Requests have timeouts;
redirects and paths outside `/api/factory/` are refused. Cleanup stops the owned
process group, discarding the service's in-memory state.

The adapter uses the public test-mode controls described in
`packages/web/README.md` and contract section 15.1. It starts the existing service,
not a replacement backend. The service selects an in-memory ledger and a
fixture-driven worker in this mode. It does **not** exercise the durable database,
factory core, controller worker, live providers, real qualification, or package
replay. Its JSON therefore says `suite: service-test-mode-http`,
`service_http_executed: true`, and `acceptance_executed: false` after verification.
A service HTTP pass is not full request-API or end-to-end product acceptance.

## Coverage and remaining gaps

`evidence/service-http.json` records the actual service HTTP result, including
failures and unavailable coverage. `evidence/verification.json` records runner
self-tests and local checks separately. `readiness.json` is the no-backend report.

| Group | Implemented checks | Remaining coverage dependency |
| --- | --- | --- |
| identity | Overlapping and repeated starts, conflict refusal, stable identity, one worker reservation and no duplicate create call names | Durable request/job identities are not exposed by `TestEvidence` |
| quantities | Separate described items, independent expected delivery/missing counts, case ownership, type totals and pinned interpretation | A startable unequal-quantity scenario with expected per-item counts; durable backend integration |
| shared-budget | One request budget, every observed response within the deterministic limit, original reservation and settlement accounting; candidate execution totals and provider-create bounds | Evidence does not associate copy operations with candidate, copy or host IDs |
| qualification | Pinned candidate stages and reasons with linked rejection/skip/incomplete events; duplicate defect relationships; demonstrated criteria match cases; default difficulty stays unassessed | No named `setup_failed` scenario; real qualification is not run |
| unsupported | Pinned unsupported combinations, description, source and difficulty outcomes; start refusal; unknown host/type errors | Real interpretation beyond the named test scenarios |
| stops | Partial/zero exhaustion, budget stop, cancellation, worker loss and uncertain spend; retained cases and reconciliation | Durable worker integration and actual operational failure recovery |
| continuity | Repeated reads, reconnect, frozen terminal results, contiguous event history and reconciliation | Persistence across a service restart is not exercised |
| downloads | Distinct paths and kinds, ready-only delivered cases, archive digest and byte size, validation failure/error and completion cost semantics | No pending-package window; synthetic archives do not prove real privacy or replay |

Reset must return the typed `200` response naming the selected scenario, and
refusals use the typed error envelope. Unsupported Start must retain the
interpretation just returned for that input. A fresh `202` may be finished only
with a recorded reservation/launch failure: `operational_error` without worker
heartbeats, candidate/delivery progress or post-launch history. Subsequent
snapshots and history pages preserve that pre-execution state until an intentional
post-completion action. In these deterministic controls, its commitment cannot
exceed the worker worst case. Uncertain launch spend may remain held with
`needs_reconciliation` attention; successful terminal replays remain valid `200`
responses. Downloaded archive bytes must match both advertised hash and size.

Interpretations are compared with the complete pinned semantic profile: versions,
route, item meanings, host use, type quantities, worst-case prices, limits and
request problems. Generated hashes and descriptive wording may differ; the
returned interpretation must then remain frozen in every request response.
Funnel counters obey their stage bounds, retain witnessed progress across
sequential reads, and match named end-state fixtures. Complete history must
account for the distinct candidates that passed behavior and requested criteria.
Concurrent responses need not arrive in state order. Creation time and deadline
remain fixed, with the deadline matching the interpreted execution window.

The named probes are `two-host-fulfilled`, `partial-budget`, `sources-exhausted`,
`duplicate-defect`, `zero-result`, `cancel-midway`, `worker-lost`,
`uncertain-provider`, `wrong-failure`, `validation-failed` and `validation-error`.
Each obtains a fresh interpretation hash from the service. Synthetic fixture
hashes are not sent as live interpretations. The runner honors polling hints and
status backoff; reaching its observation limit reports unavailable.
The cancellation probe waits for the second candidate's first completed check,
as the named control specifies, before sending stop. Stopping at the first
delivery is too early to exercise the fixture's cancellation outcome.

The runnable multi-item fixtures request 1/1. Their separate outcomes exercise
item ownership and count reconciliation, but do not test unequal requested
quantities. The quantities group therefore remains unavailable until a published
startable scenario provides unequal quantities and expected delivered/missing
counts. The service's fixture-only controls do not accept an invented input.

Candidate expectations come from each scenario's pinned end-state fixture and
compare catalog entries, stages, reason codes and linked outcome events without
fixing generated IDs, timestamps or message text. The duplicate scenario also
checks that the skipped entry shares the earlier candidate's defect. The
uncertain-provider scenario has no published candidate end-state fixture, so it
does not borrow the worker-lost scenario's candidate expectations. Instead, its
partial sequence requires one selected candidate from the pinned eligible source,
after worker start, and a matching candidate-copy create that remains uncertain.
The pinned service profile settles the worker, retains all three copy originals,
attempts only the first copy and releases the unused copies at zero. Worker-only
uncertainty cannot satisfy this probe. That candidate must end `incomplete` with
`incomplete_run`, no item or case assignment, and exactly one matching
`candidate_incomplete` event. Every named
terminal checks its expected attention; ordinary completed requests must show
no held spend and both slot holders cleared before any subsequent action or reset.

Reconciliation must return a `200 RequestStatus`. Both that response and later
status reads must retain terminal data and event history and settle the previously
held amount. New budget events must account for that settlement before the new
attention-cleared event, including when they fall beyond the first history page.
Before request reconciliation, evidence must show that the request holds the
slot and no validation holds it. This is specific to the request-failure probes;
a separate completed validation with uncertain spend may legitimately retain its
validation holder. The worker-loss and uncertain-provider probes reconstruct the
active attention from the complete history before reconciliation: replacements
are allowed, clears must name the active code, and the result must match status.
An old attention event followed by a clear is insufficient. Attention events may
follow request completion, as the contract permits. The probe compares ledger evidence before and after reconciliation: operation
identities, call metadata, original reservations and existing provider records
remain intact. Each held row reconciles at its original worst case; previously
settled rows stay unchanged, and reconciliation launches no new creates.
Both slot holders must be clear before any subsequent scenario reset.
Before an intentional reconciliation or
validation, every terminal observation retains its budget and attention as well
as its completed results, starting with the concurrent Start responses.
Reconnect must return exactly the witnessed terminal history, including an empty
trailing page; no new event may appear before those intentional operations.
Complete terminal history is drained through an empty page before requiring exactly
one `request_finished` event matching the outcome and stop code. Only the
contract-permitted accounting, attention and validation events may follow it.
Every terminal page retains the first finished snapshot, including `updated_at`.
Repeated stop must also preserve every terminal field, including `updated_at`,
and the complete event tail. Only paging and polling hints may differ; every
returned page is checked against the stored terminal response.

Before any validation, named request probes allow only worker and candidate-copy
ledger operations. The same rule applies before the first validation POST and
before request reconciliation; matching status totals cannot justify an extra
validation reservation. General evidence checks still support real validation
operations, and post-validation checks constrain the newly added rows.

The named failed/error validation probes also read request status and ledger
evidence after completion. They check the pinned host cost, cleared reservations
and slot, matching validation and budget events, and retention of earlier results
and evidence. Their history must contain exactly one reservation, validation
start, validation finish and settlement, in that order, with the pinned amounts
and no additional budget events. These named controls have known costs; the general validation
shape still permits a finished error with uncertain spend to retain a null cost.

The final contract permits zero-count rows for known unrequested types, and a
202 Start response can already contain a recorded terminal failure. The runner
accepts those shapes while still checking each scenario's expected outcome.
Criterion IDs must be nonempty and unique, and complete history must account for
delivered cases. An operation retains its original reservation amount after
settlement. Launched deterministic operations settle at that original worst
case; unused reservations without a recorded create settle at zero. The worker
reservation is pinned to the test-control amount. Operation call names and
provider create call names are unique in the deterministic scenarios, so one
create cannot justify duplicate charges. For finished named scenarios, the
sum of original candidate reservations must match the pinned host worst cases
for every non-skipped candidate. The published service test-mode profile requires
three distinct copy operations per executed candidate: the aggregate row count
must be three times the non-skipped candidate count, before and after
reconciliation. Operation IDs and call names remain unique. The uncertain-provider
exception changes which rows launched, never the required number of originals. Candidate execution requires a worker create
and at least one candidate-copy create per executed candidate in aggregate;
ordinary execution requires creates for all copy reservations. Uncertain-provider
may release never-launched copies at zero, including after reconciliation.
Every provider record must match an operation. These checks reject omissions
that also lower reported budget totals, but cannot prove individual copy-to-host
or copy-to-candidate assignments without structured evidence links. A finished validation error may retain a null completion cost; that
is distinct from zero and need not change during reconciliation. Description
limits count Unicode code points after trimming; the named inputs are already
normalized and impose no conflicting UTF-16 length assertion.

## Runner verification

Self-tests exercise published fixtures, deliberate corruptions and a small
transport test server. The transport server checks HTTP behavior only; it does
not implement product scenarios. Failing-first results and the executed count
are recorded in `evidence/verification.json`. The test floor uses that executed
count. Existing host, controller, ledger, UI and replay tests remain unchanged.

The new local transport is needed because the previous runner had no executable
HTTP adapter; existing service tests call handlers directly. Public HTTP controls
and read-only evidence are used without private implementation calls.

No real provider execution or durable backend acceptance is claimed. The next
integration step needs an approved disposable backend wiring the real core and
worker, with startup/reset/session instructions and observable durable job and
host reservation identities. That work belongs to the backend integration lane.
