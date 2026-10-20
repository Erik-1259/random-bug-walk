# Factory UI integration status

The `/factory` UI follows **bug-request/1 revision 2**, pinned to code commit [`66651d67fcb09c402b25d9688ea492c0e69e1c2b`](https://github.com/Erik-1259/random-bug-walk/blob/66651d67fcb09c402b25d9688ea492c0e69e1c2b/docs/product/bug-request-v1.md). The factory routes now include a deterministic local test mode. An unavailable service produces an explicit unavailable state; the production page never substitutes fixtures.

That contract revision was merged in [PR #121](https://github.com/Erik-1259/random-bug-walk/pull/121) at `6b2c8bae430d565d5df7b94bd77d1846da1bb2bd`. This records the original UI contract integration; it does not claim that subsequent shared-package changes are byte-identical to that revision.

## Implemented UI behavior

Capabilities supply host choices, bug types, combination explanations, difficulty availability and all numeric limits. Items retain independent keys, descriptions and quantities. The service interpretation is displayed before start, and editing invalidates it. The UI does not implement the interpreter or decide qualification.

Description limits count Unicode code points after trimming surrounding whitespace, including separate combining marks. A browser UTF-16 `maxlength` does not restrict otherwise valid descriptions.

The factory session is separate from the Umami replay session. The client persists the request identity and exact start body before sending a start. Duplicate clicks are locked. Uncertain responses, failed polls and reloads read the saved identity, never launch replacement work. A `busy` refusal is reconciled against status before a new identity is permitted. Explicit same-identity retry is available after an uncertain start is still not found. Definite input/interpretation/budget refusals require another interpretation.

Status renders service events and counts without an invented percentage. Delivered cases remain visible for every outcome. Downloads keep debugging-agent and evaluator packages separate and require readiness. Validation stores its own identity before posting, resumes on reload and distinguishes behavioral failure from operational error. A click is never a completed validation result. No verification code or reference repairs are rendered in the page.

Downloads also require a nonempty path for the specific package; validation requires both package paths. Defensive checks keep the other download available if a response is missing one path, and a corrected response restores validation. These malformed-response tests are separate from the valid shared fixtures.

An accepted start can return a finished operational failure when worker launch failed after the request was recorded. Its identity remains available on reload and is not treated as a refused start. Finished validation cost can remain unknown (`null`) while subsequent request status reconciles the budget; the UI does not convert it to zero or repeat the validation.

## Shared contract handoff

The UI consumes the workspace package `@rbw/factory-contract`, originally integrated from the pinned PR #121 revision above. Client code imports its root entry's types and contract-version constant. The former local transport projections are removed. The package's `/validate` entry reads files and uses Node/Ajv, so it is used only by tests to parse every pinned UI fixture, never imported into a client component. The browser still checks JSON and contract-version envelopes; full runtime response validation requires a client-safe parser if the contract owner later supplies one.

Revision 2 stores the validation UUID under `rbw-factory-validation-id` before POST, with scoped request/case metadata kept separately. Existing revision-1 scoped metadata is migrated without starting work. Definite validation refusals clear the rejected ID; uncertain responses retain it for the same-ID retry. Stale factory tabs adopt the saved request before Start, and clearing an older request does not delete a newer tab's identity. New warning codes and criterion failure-code fixtures come from the shared contract, while interpretation and qualification remain service decisions.

The shared package also supplies `CopyPlan.destinations`, `CopyRoots`, `CollectedCopy`, `CopyRunner.run(plan, roots)` and `HostAdapter.collect`. These are backend/harness interfaces; the UI does not execute or implement them. Later contract corrections must be integrated explicitly with an updated Git pin and fixtures.

## Runtime and verification dependencies

Request and validation identity mutations use one origin-wide Web Lock, held through Start persistence and reconciliation. A stale tab adopts a newer request or validation before acting; cleanup cannot erase that newer identity. Browsers without Web Locks cannot start this workflow. The synthetic browser proof queues simultaneous Start clicks behind a held lock and checks cleanup while another tab's validation POST is in flight. This verifies UI coordination, not server idempotency or live acceptance.

Backend ownership remains `app/api/factory/**`, `src/factory-server/**` and request execution. The implemented routes support deterministic test-mode sessions, interpretations, requests, status, downloads and validation over in-memory fakes. The browser proof below exercises those HTTP boundaries and UI behavior. It does not establish real-worker integration, hosted execution, or production acceptance.

Synthetic contract fixtures are copied byte-for-byte into `packages/web/test/fixtures/factory-v1/` with the pinned source documented. Unit tests and the original browser proof use fake transport responses and explicitly label that evidence as synthetic. The separate test-mode browser proof uses real local HTTP routes with fake execution dependencies. No provider or paid execution is part of either UI proof. Real-worker integration and production acceptance remain separate, unfinished work.

The published Umami example, case anchors, immutable release files and existing replay controls remain unchanged. The historical example is not relabeled as a newly exported revision-1 package.

## Repeating the mock browser proof

Build the web package with `RBW_RESULTS_DIR` pointing to the assembled public results snapshot, then start it on a local port. With an externally available Playwright installation and Chromium binary, run from `packages/web`:

```sh
node test/factory-browser.mjs <playwright-index.mjs> <chromium-binary> <local-origin> <evidence-output-directory> <public-results-repository>
```

The script refuses a non-local origin, intercepts only factory endpoints in its synthetic scenarios, and checks service unavailability separately. Its missing-endpoint expectation predates the implemented factory routes; it is not evidence that the current routes are absent. It never submits the legacy replay controls. The project adds no browser dependency or deployment configuration.

## Repeating the test-mode HTTP/UI proof

Use a dedicated local server with the default committed contract fixtures. From the repository root:

```sh
RBW_FACTORY_TEST_MODE=1 RBW_JUDGE_PASSCODE=synthetic-factory-passcode pnpm --filter @rbw/web dev --port 3033
```

Then, from `packages/web`, using an externally available Playwright installation and Chromium binary:

```sh
node test/factory-test-mode-browser.mjs <playwright-index.mjs> <chromium-binary> http://localhost:3033 <evidence-output-directory>
```

The script requires exclusive use of this server: it calls the test reset endpoint between scenarios, discarding all in-memory test requests, operations and validation runs. Stop the server process after the proof. Do not point it at a shared or hosted service. Test mode is refused when `VERCEL_ENV=production`. No provider, paid run or legacy replay is started.

This proof signs in through the UI, seeds exact fixture inputs through the real interpretation and start endpoints, saves the returned request identity for the browser, and reloads the UI. It does not intercept or rewrite factory responses. Its assertions cover request resumption, partial and error outcomes, reconciliation, package downloads and validation outcomes against actual test-mode responses and operation evidence. Execution dependencies and archive contents remain synthetic; these are API-seeded UI-resumption journeys, not real-worker or full form-to-start proof. A run's output records its results; these instructions alone do not establish a passing run.

### Remaining form-to-start test-mode gap

The form generates opaque item keys such as `item-1` in `src/components/factory-request-form.tsx`. Test mode looks up the hash of the complete normalized input, including item keys, in `src/factory-server/test-mode/fixtures.ts` and `world.ts`. The default fixtures instead use keys such as `concurrency-1` and `date-time-1`. Consequently, entering otherwise matching fixture requirements through the ordinary form receives `invalid_request` with “Test mode interprets only the inputs of the contract fixtures.” The proof records that refusal separately and uses unchanged fixture inputs for its API-seeded journeys. This is a remaining test-mode integration gap, not a demonstrated production defect; it requires a backend-owned test-mode solution before full browser form-to-start coverage is possible.
