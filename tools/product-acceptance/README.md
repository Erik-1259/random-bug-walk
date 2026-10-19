# Request API acceptance runner

This is a partial black-box runner for draft revision 1 of `bug-request/1`, pinned
to contract commit `7540362198f5940f1add45a65593ac314e8d751e`.
The contract and its response fixtures are published in PR #121. Every service
endpoint and test control in that revision is labeled planned.

The runner has **not run against a backend**. Its current result is eight
unavailable acceptance groups. `readiness.json` is a dependency report, not a
successful acceptance run. Passing runner self-tests does not establish that the
product implements these operations.

The source base is `4e5b5af8dbc7f05a2255e22b9442f2b2b7fae886`. The earlier
preparation is preserved in PR #120. Later contract revisions require an explicit
pin update, fixture comparison and review; this runner rejects an adapter reporting
a different contract revision.

## Invocation

From the repository root, with the locked Node 24 and pnpm dependencies installed:

```sh
pnpm exec vitest run --project product-acceptance
pnpm exec tsc -p tools/product-acceptance
pnpm exec eslint tools/product-acceptance --max-warnings 0
node tools/product-acceptance/src/cli.ts
```

The first three commands check the runner itself. The CLI prints one JSON document
and exits **2** while the isolated backend adapter is unavailable. It accepts no
URL, credentials or inherited provider configuration and makes no network calls.
It does not silently run fixtures as acceptance. Exit codes are 0 for all required
groups passed, 1 for an assertion or transport failure, and 2 for unavailable
coverage without a failure. A failed group takes precedence over unavailable
coverage. The JSON retains both counts.

`src/runner.ts` implements `runAcceptance`, individual protocol probes, and the
local `IsolatedBackend` adapter interface. This interface is a runner integration
boundary, not an additional service contract. No adapter implementation is shipped.
Before any probe can reset or start work, the adapter must verify the actual
isolated instance, its backend revision and the pinned contract revision.
The backend's published startup procedure must establish disposable storage,
deterministic providers and refusal of test mode in production. A caller-supplied
URL or a boolean assertion of safety is not sufficient verification.

The eventual approved adapter must:

- Start or attach only to that verified disposable instance, with no production
  fallback and no inherited live-provider credentials.
- Authenticate through the public session operation and maintain its cookie.
  `reconnect` must create a new client connection while preserving the session.
- Send the declared HTTP methods, paths and JSON bodies without rewriting results.
  JSON replies use `Reply.body`; download replies use raw `Uint8Array` bytes.
  Bound individual network requests and refuse cross-origin redirects.
- Honor `wait` in real time. The runner observes `poll_after_ms` and backs off
  15, 30 and 60 seconds on unavailable status reads. A timeout never starts a
  replacement request. A probe that reaches its 1,000-poll observation limit reports
  unavailable rather than declaring the product failed.

No invocation against the actual API can be supplied until that startup and
verification procedure exists. Do not substitute an implementation mock for it.

## Coverage and remaining gaps

Every row is currently **unavailable against the product**. The implemented
assertions can pass independently without turning an incomplete group green.

| Group | Revision 1 operations and implemented checks | Remaining coverage dependency |
| --- | --- | --- |
| identity | Sections 7 and 15.1: three overlapping starts, one 202 and duplicate 200 responses, repeated start, conflicting payload 409, stable request ID | Exact read-only evidence response shape and durable request/job identifiers, so response identity cannot substitute for proof of one job/reservation |
| quantities | Sections 5, 6.3, 8.2 and 10.5: sources-exhausted input with two separate items and unequal quantities; counts, descriptions, criteria, case ownership and type totals checked | Runnable deterministic backend |
| shared-budget | Sections 7 and 8.5: both-host input, one unchanged request budget, reserved plus spent equals committed, remaining arithmetic, partial-budget stop | Exact ledger/provider-call evidence shape to prove reservation behavior independently of reported budget fields |
| qualification | Sections 8.2, 8.3 and 10: duplicate-defect, zero-result, incomplete worker outcomes; qualified cases only, unique defects, matching matrices and criteria; default difficulty remains not_assessed | A named deterministic setup_failed candidate control; revision 1 names no invalid-candidate scenario |
| unsupported | Sections 5–7 and 12: unsupported combinations, unmatched description, no matching source and difficulty remain explicit; start refused with 422; unknown host/type refused with 400 | Runnable deterministic backend using the published scenario catalog |
| stops | Sections 8.1, 8.5 and 9: partial/zero exhaustion, budget stop, cancel, worker loss, uncertain provider; delivered cases cannot disappear; reconciliation clears held spend without rewriting results | Documented cancel-midway timing or an observable pause after a delivery; otherwise the probe reports unavailable if the request finishes before stop |
| continuity | Sections 7–9: same identity after repeated reads and reconnect, frozen interpretation, contiguous event cursor, terminal result preservation, reconciliation without an automatic retry | Runnable backend and a real reconnect implementation |
| downloads | Sections 10–11: distinct package paths/kinds, ready-only delivered cases, archive SHA-256, failed/error validation semantics, validation identity and package pair | Pending-package access needs a documented window and case ID; archive layout and full payload privacy checks await the package contract |

The test evidence endpoint in section 15.1 lists operation fields but does not
specify the response envelope, slot-holder shape or provider-call fields. Please
publish these shapes, including how durable requests, worker jobs and reservations
are counted and associated with a request. The runner does not guess those fields.

The runner uses the published input examples and obtains a fresh interpretation
hash from the service before every start. Synthetic fixture hashes are never sent
as a replacement for that live interpretation. The named scenarios are
`two-host-fulfilled`, `partial-budget`, `sources-exhausted`, `duplicate-defect`,
`zero-result`, `cancel-midway`, `worker-lost`, `uncertain-provider`,
`validation-failed` and `validation-error`.

The backend must document how its scenarios are started/reset and whether the
fixture catalog inputs apply unchanged. Reset/reconcile success bodies are not
specified in revision 1, so the runner checks a successful HTTP status without
inventing a response shape. It does not call private product helpers.

## Runner verification

The 46 self-tests use copied published fixtures and scripted transport replies.
They check both valid examples and deliberate corruptions; they are not an
alternate backend and are not request-API acceptance evidence. The JSON fixtures
in `fixtures/` are byte-for-byte copies from
`docs/product/fixtures/bug-request-v1/` at the pinned contract commit.

Failing-first runs were recorded locally before implementation: missing invariant
and runner modules; missing status backoff and per-probe isolation verification;
missing unsupported, reconciliation and download probes; and a disappearing
previously delivered case that initially escaped detection. The corrected runner
passes the self-tests, strict typecheck and lint with zero warnings.

A frozen offline install used the existing lockfile without changes. A bounded
existing check uses these judge tests:

```sh
pnpm --filter @rbw/web exec vitest run test/judge/judge.test.ts -t 'makes one create for two POSTs with one request ID|answers a repeated POST with one request ID'
```

Those tests exercise existing judge handlers, not the new HTTP request API. Existing
controller harnesses, search tests and release replay tests remain unchanged. They
do not replace independent request-API acceptance, which is why this directory
adds protocol sequencing and independent response assertions.

Request-API acceptance with deterministic providers is separate from end-to-end
product acceptance. It does not establish real host generation, qualification or
package replay. No live provider runs, deployment, new publication waiver or merge
authorization are part of this follow-up.
