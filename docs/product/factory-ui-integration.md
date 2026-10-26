# Factory UI integration status

The `/factory` contract consumer and test fixtures follow **bug-request/1 revision 3**, pinned to merged public commit [`4be0c93f94a8582b998383c70d10837ba49c8014`](https://github.com/Erik-1259/random-bug-walk/blob/4be0c93f94a8582b998383c70d10837ba49c8014/docs/product/bug-request-v1.md). Revision 3 adds test controls. The [public backend handoff](https://github.com/Erik-1259/random-bug-walk/pull/150#issuecomment-6419181966) identifies this merged revision for local synthetic integration; this update does not change runtime product UI or establish hosted or production acceptance. An unavailable service produces an explicit unavailable state; the production page never substitutes fixtures.

The original revision-2 UI integration used commit `66651d67fcb09c402b25d9688ea492c0e69e1c2b`, merged in [PR #121](https://github.com/Erik-1259/random-bug-walk/pull/121) at `6b2c8bae430d565d5df7b94bd77d1846da1bb2bd`. The current fixture pin above supersedes that historical pin.

## Implemented UI behavior

Capabilities supply host choices, bug types, combination explanations, difficulty availability and all numeric limits. Items retain independent keys, descriptions and quantities. The service interpretation is displayed before start, and editing invalidates it. The UI does not implement the interpreter or decide qualification.

Description limits count Unicode code points after trimming surrounding whitespace, including separate combining marks. A browser UTF-16 `maxlength` does not restrict otherwise valid descriptions.

The factory session is separate from the Umami replay session. The client persists the request identity and exact start body before sending a start. Duplicate clicks are locked. Uncertain responses, failed polls and reloads read the saved identity, never launch replacement work. A `busy` refusal is reconciled against status before a new identity is permitted. Explicit same-identity retry is available after an uncertain start is still not found. Definite input/interpretation/budget refusals require another interpretation.

Status renders service events and counts without an invented percentage. Delivered cases remain visible for every outcome. Downloads keep debugging-agent and evaluator packages separate and require readiness. Validation stores its own identity before posting, resumes on reload and distinguishes behavioral failure from operational error. A click is never a completed validation result. No verification code or reference repairs are rendered in the page.

Downloads also require a nonempty path for the specific package; validation requires both package paths. Defensive checks keep the other download available if a response is missing one path, and a corrected response restores validation. These malformed-response tests are separate from the valid shared fixtures.

An accepted start can return a finished operational failure when worker launch failed after the request was recorded. Its identity remains available on reload and is not treated as a refused start. Finished validation cost can remain unknown (`null`) while subsequent request status reconciles the budget; the UI does not convert it to zero or repeat the validation.

## Shared contract handoff

The UI consumes the workspace package `@rbw/factory-contract`, originally integrated from the pinned PR #121 revision above. Client code imports its root entry's types and contract-version constant. The former local transport projections are removed. The package's `/validate` entry reads files and uses Node/Ajv, so it is used by UI tests to parse every pinned UI fixture, never imported into a client component. The browser still checks JSON and contract-version envelopes; full runtime response validation requires a client-safe parser if the contract owner later supplies one.

Revision 2 stores the validation UUID under `rbw-factory-validation-id` before POST, with scoped request/case metadata kept separately. Existing revision-1 scoped metadata is migrated without starting work. Definite validation refusals clear the rejected ID; uncertain responses retain it for the same-ID retry. Stale factory tabs adopt the saved request before Start, and clearing an older request does not delete a newer tab's identity. New warning codes and criterion failure-code fixtures come from the shared contract, while interpretation and qualification remain service decisions.

The shared package also supplies `CopyPlan.destinations`, `CopyRoots`, `CollectedCopy`, `CopyRunner.run(plan, roots)` and `HostAdapter.collect`. These are backend/harness interfaces; the UI does not execute or implement them. Later contract corrections must be integrated explicitly with an updated Git pin and fixtures.

## Runtime and verification dependencies

Request and validation identity mutations use one origin-wide Web Lock, held through Start persistence and reconciliation. A stale tab adopts a newer request or validation before acting; cleanup cannot erase that newer identity. Browsers without Web Locks cannot start this workflow. The synthetic browser proof queues simultaneous Start clicks behind a held lock and checks cleanup while another tab's validation POST is in flight. This verifies UI coordination, not server idempotency or live acceptance.

Backend ownership remains `app/api/factory/**`, `src/factory-server/**` and request execution. The implemented routes support deterministic test-mode sessions, interpretations, requests, status, downloads and validation over in-memory fakes. The browser proof below exercises those HTTP boundaries and UI behavior. It does not establish real-worker integration, hosted execution, or production acceptance.

All synthetic contract fixtures, including revision-3 `test-evidence.json`, are copied byte-for-byte into `packages/web/test/fixtures/factory-v1/` with the pinned source documented. Unit tests and the original browser proof use fake transport responses and explicitly label that evidence as synthetic. The separate test-mode browser proof uses real local HTTP routes with fake execution dependencies. No provider or paid execution is part of either UI proof. Real-worker integration and production acceptance remain separate, unfinished work.

The published Umami example, case anchors, immutable release files and existing replay controls remain unchanged. The historical example is not relabeled as a newly exported revision-1 package.

## Repeating the mock browser proof

Build the web package with `RBW_RESULTS_DIR` pointing to the assembled public results snapshot, then start it on a local port. With an externally available Playwright installation and Chromium binary, run from `packages/web`:

```sh
node test/factory-browser.mjs <playwright-index.mjs> <chromium-binary> <local-origin> <evidence-output-directory> <public-results-repository>
```

The script refuses a non-local origin, intercepts only factory endpoints in its synthetic scenarios, and checks service unavailability separately. Its missing-endpoint expectation predates the implemented factory routes; it is not evidence that the current routes are absent. It never submits the legacy replay controls. The project adds no browser dependency or deployment configuration.

## Repeating the test-mode HTTP/UI proof

The earlier form-key backend was merged in [PR #144](https://github.com/Erik-1259/random-bug-walk/pull/144) at `092c1526b27a441c43f5fc1694fa44bf3d7cfb96`. Revision-3 proof uses the exact merged backend [`4be0c93f94a8582b998383c70d10837ba49c8014`](https://github.com/Erik-1259/random-bug-walk/commit/4be0c93f94a8582b998383c70d10837ba49c8014) with these UI proof changes applied. Use an isolated checkout. The public handoff is limited to local synthetic integration; durable-service, real-worker, hosted and production acceptance remain unverified.

Use a dedicated, single-process local server with the default committed contract fixtures. From that checkout's repository root:

```sh
VERCEL_ENV=development RBW_FACTORY_TEST_MODE=1 RBW_JUDGE_PASSCODE=synthetic-factory-passcode pnpm --filter @rbw/web dev --port 3033
```

Then, from its `packages/web` directory, using an externally available Playwright installation and Chromium binary:

```sh
node test/factory-test-mode-browser.mjs <playwright-index.mjs> <chromium-binary> http://localhost:3033 <evidence-output-directory>
```

The script requires exclusive use of this server: it calls the test reset endpoint between scenarios, discarding all in-memory test requests, operations and validation runs. Stop the server process after the proof. Do not point it at a shared or hosted service. At the pinned backend revision, test mode is refused for both `VERCEL_ENV=preview` and `VERCEL_ENV=production`; the local command explicitly selects `development`. No provider, paid run or legacy replay is started.

The form journeys sign in, enter requirements through the ordinary form, review the service interpretation, and start through the UI:

- `two-host-fulfilled` at desktop and narrow widths;
- `cancel-midway` at narrow width;
- `validation-failed` and `validation-error` at desktop width.

These journeys do not seed requests through the API or write identities into localStorage from the test; the application persists its own request and validation identities. Assertions check a single Start, the saved identity and reload without replacement work. The cancellation journey stops through the UI and checks that delivered cases remain available after cancellation and reload. Validation journeys retain the result, budget and reload assertions, distinguishing behavioral failure from operational error.

The remaining `partial-budget`, `worker-lost` and `uncertain-provider` scenarios are explicitly API-seeded UI-resumption journeys: they send unchanged fixture inputs through the real interpretation and start endpoints, save that identity for the browser, and reload the UI. The script does not intercept or rewrite factory responses.

Assertions compare request resumption, partial and error outcomes, reconciliation, package downloads and validation outcomes with actual test-mode responses and operation evidence. Execution dependencies and archive contents remain synthetic. This mixed proof covers four form-started scenarios (fulfilled at two widths) and three API-seeded scenarios, not real-worker execution, durable-service integration or production acceptance. A run's output records its results; these instructions alone do not establish a passing run.

### Backend item-key support

The form generates opaque item keys such as `item-1` in `src/components/factory-request-form.tsx`. The pinned backend's test mode matches fixture requirements without item keys, while preserving item order, descriptions, quantities and the other normalized input fields. It accepts the form's keys and carries them through the interpretation, events, candidates, items, cases and validation events. An interpretation under new keys gets its own hash; a hash for different keys is stale. The original fixture keys retain their fixture interpretation and hash.

This replaces the earlier default-fixture restriction that rejected otherwise matching form inputs solely because their keys differed from `concurrency-1` or `date-time-1`. It does not add a general interpreter: requirements outside the committed fixtures still receive `invalid_request`, and a start must match the selected scenario's requirements. The proof uses that merged behavior without remapping browser requests or modifying shared fixtures.

### Revision-3 evidence and readiness proof

Revision 3 adds `TestEvidence.root_execution_id`, operation `execution_id` and `host_id`, and provider-call `execution_id`. Fixture checks retain every field, compare exact published bytes and parse every fixture with the shared validator; the former revision-2 stripping exception is removed.

The `two-host-fulfilled` browser journey observes the application's status poll reporting a packaging candidate and `package_ready`, with no delivered case. It checks the rendered event, zero case cards and no download or validation controls, then waits for `case_delivered` and the download links. The recorded event timestamps must show the contracted five-service-second window; the test does not sleep for an assumed execution duration. Pending-state screenshots and event records accompany the run output.

This checks visible availability, without sending a pre-delivery validation POST. The service checks a validation request's eligibility only after its two-second hold inside the validation-ID lock; a request sent before delivery may still be checked after delivery. The later, existing validation journey starts only after the request finishes.

The revision-3 `setup-failed` scenario still runs all three copies. The clean copy is created but cannot be prepared, so its two checks report `error`; buggy and fixed copies run their checks. After all six checks, the candidate is `invalid` with `setup_failed`, one candidate was explored, and no case is delivered. This describes the backend scenario, not a new UI browser journey or reproduction. The form and recovery journeys above remain intact; a run's output establishes which checks passed.
