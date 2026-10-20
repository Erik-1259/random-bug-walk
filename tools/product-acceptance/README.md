# Request API acceptance runner

This partial black-box runner follows the merged `bug-request/1` revision 2
contract at `66651d67fcb09c402b25d9688ea492c0e69e1c2b`. It extends the runner in
PR #124, which remains a separate dependency. The follow-up base combines that
PR's unchanged head `04e926b9b2ff89078be124d905ad73dd57c24d90` with main
`f803962dcaf3b51b8881a7c4db99aeded33c7e1d`.

The runner uses `@rbw/factory-contract` for types and evidence-envelope shape
validation. Expected outcomes, quantities, routing, retention, qualification and
accounting assertions remain independent of the service's validators. Fixtures
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
| shared-budget | One request budget, every observed response within the deterministic limit, original reservation and settlement accounting | Evidence does not associate copy operations with hosts |
| qualification | Pinned candidate stages and reasons with linked rejection/skip/incomplete events; duplicate defect relationships; demonstrated criteria match cases; default difficulty stays unassessed | No named `setup_failed` scenario; real qualification is not run |
| unsupported | Pinned unsupported combinations, description, source and difficulty outcomes; start refusal; unknown host/type errors | Real interpretation beyond the named test scenarios |
| stops | Partial/zero exhaustion, budget stop, cancellation, worker loss and uncertain spend; retained cases and reconciliation | Durable worker integration and actual operational failure recovery |
| continuity | Repeated reads, reconnect, frozen terminal results, contiguous event history and reconciliation | Persistence across a service restart is not exercised |
| downloads | Distinct paths and kinds, ready-only delivered cases, archive digest, validation failure/error and completion cost semantics | No pending-package window; synthetic archives do not prove real privacy or replay |

The named probes are `two-host-fulfilled`, `partial-budget`, `sources-exhausted`,
`duplicate-defect`, `zero-result`, `cancel-midway`, `worker-lost`,
`uncertain-provider`, `wrong-failure`, `validation-failed` and `validation-error`.
Each obtains a fresh interpretation hash from the service. Synthetic fixture
hashes are not sent as live interpretations. The runner honors polling hints and
status backoff; reaching its observation limit reports unavailable.

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
does not borrow the worker-lost scenario's candidate expectations. Every named
terminal checks its expected attention; ordinary completed requests must show
no held spend and both slot holders cleared before any subsequent action or reset.

Reconciliation must return a `200 RequestStatus`. Both that response and later
status reads must retain terminal data and event history and settle the previously
held amount. New budget events must account for that settlement before the new
attention-cleared event, including when they fall beyond the first history page.
The probe then reads ledger evidence and requires both slot holders to be clear
before any subsequent scenario reset. Before an intentional reconciliation or
validation, every terminal observation retains its budget and attention as well
as its completed results, starting with the concurrent Start responses.

The named failed/error validation probes also read request status and ledger
evidence after completion. They check the pinned host cost, cleared reservations
and slot, matching validation and budget events, and retention of earlier results
and evidence. These named controls have known costs; the general validation
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
create cannot justify duplicate charges. A finished validation error may retain a null completion cost; that
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
