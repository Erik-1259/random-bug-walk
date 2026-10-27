# Factory UI integration status

The `/factory` contract consumer and test fixtures follow **bug-request/1 revision 3**, pinned to merged public commit [`4be0c93f94a8582b998383c70d10837ba49c8014`](https://github.com/Erik-1259/random-bug-walk/blob/4be0c93f94a8582b998383c70d10837ba49c8014/docs/product/bug-request-v1.md). Revision 3 adds test controls. The [public backend handoff](https://github.com/Erik-1259/random-bug-walk/pull/150#issuecomment-6419181966) identifies this merged revision for local synthetic integration; this handoff does not establish hosted or production acceptance. An unavailable service produces an explicit unavailable state; the production page never substitutes fixtures.

The original revision-2 UI integration used commit `66651d67fcb09c402b25d9688ea492c0e69e1c2b`, merged in [PR #121](https://github.com/Erik-1259/random-bug-walk/pull/121) at `6b2c8bae430d565d5df7b94bd77d1846da1bb2bd`. The current fixture pin above supersedes that historical pin.

## Implemented UI behavior

Capabilities supply host choices, bug types, combination explanations, difficulty availability and all numeric limits. Items retain independent keys, descriptions and quantities. The service interpretation is displayed before start, and editing invalidates it. The UI does not implement the interpreter or decide qualification.

Description limits count Unicode code points after trimming surrounding whitespace, including separate combining marks. A browser UTF-16 `maxlength` does not restrict otherwise valid descriptions.

The factory session is separate from the Umami replay session. The client persists the request identity and exact start body before sending a start. Duplicate clicks are locked. Uncertain responses, failed polls and reloads read the saved identity, never launch replacement work. A `busy` refusal is reconciled against status before a new identity is permitted. Explicit same-identity retry is available after an uncertain start is still not found. Definite input/interpretation/budget refusals require another interpretation.

Status renders service events and counts without an invented percentage. Delivered cases remain visible for every outcome. Downloads keep debugging-agent and evaluator packages separate and require readiness. Validation stores its own identity before posting, resumes on reload and distinguishes behavioral failure from operational error. A click is never a completed validation result. No verification code or reference repairs are rendered in the page.

Stop remains available during status polling. A click queues one Stop behind the in-flight read, then rechecks the same request, authentication and state before posting. A completed or already-stopping request, or an expired session, prevents that queued POST. Pending Stop disables duplicate input; the earlier read cannot overwrite the Stop response. The synthetic browser regression holds a poll between pointer-down and pointer-up and checks retained downloads.

Downloads also require a nonempty path for the specific package; validation requires both package paths. Defensive checks keep the other download available if a response is missing one path, and a corrected response restores validation. These malformed-response tests are separate from the valid shared fixtures.

An accepted start can return a finished operational failure when worker launch failed after the request was recorded. Its identity remains available on reload and is not treated as a refused start. Finished validation cost can remain unknown (`null`) while subsequent request status reconciles the budget; the UI does not convert it to zero or repeat the validation.

## Shared contract handoff

The UI consumes the workspace package `@rbw/factory-contract`, originally integrated from the pinned PR #121 revision above. Client code imports its root entry's types and contract-version constant. The former local transport projections are removed. The package's `/validate` entry reads files and uses Node/Ajv, so it is used by UI tests to parse every pinned UI fixture, never imported into a client component. The browser still checks JSON and contract-version envelopes; full runtime response validation requires a client-safe parser if the contract owner later supplies one.

Revision 2 stores the validation UUID under `rbw-factory-validation-id` before POST, with scoped request/case metadata kept separately. Existing revision-1 scoped metadata is migrated without starting work. Definite validation refusals clear the rejected ID; uncertain responses retain it for the same-ID retry. Stale factory tabs adopt the saved request before Start, and clearing an older request does not delete a newer tab's identity. New warning codes and criterion failure-code fixtures come from the shared contract, while interpretation and qualification remain service decisions.

The shared package also supplies `CopyPlan.destinations`, `CopyRoots`, `CollectedCopy`, `CopyRunner.run(plan, roots)` and `HostAdapter.collect`. These are backend/harness interfaces; the UI does not execute or implement them. Later contract corrections must be integrated explicitly with an updated Git pin and fixtures.

## Runtime and verification dependencies

Request and validation identity mutations use one origin-wide Web Lock, held through Start persistence and reconciliation. A stale tab adopts a newer request or validation before acting; cleanup cannot erase that newer identity. Browsers without Web Locks cannot start this workflow. The synthetic browser proof queues simultaneous Start clicks behind a held lock and checks cleanup while another tab's validation POST is in flight. This verifies UI coordination, not server idempotency or live acceptance.

Backend ownership remains `app/api/factory/**`, `src/factory-server/**` and request execution. The routes support deterministic test-mode sessions, interpretations, requests, status, downloads and validation over in-memory fakes. The test-mode browser proof below exercises those HTTP boundaries and UI behavior. It does not establish real-worker integration, hosted execution, or production acceptance.

The live service, amd64 host pins, Umami registration and traced-package build support are merged in the backend revision [`269a22adb00f9616205a96c285fd5b2051b9bb10`](https://github.com/Erik-1259/random-bug-walk/commit/269a22adb00f9616205a96c285fd5b2051b9bb10). Its [local-stack instructions](https://github.com/Erik-1259/random-bug-walk/blob/269a22adb00f9616205a96c285fd5b2051b9bb10/packages/web/README.md#live-mode-local-stack) configure a disposable loopback Postgres ledger, matching prepared packages, a local worker child and Docker copies. The prepared browser entry exercises task-report with one concurrency item; it does not establish Umami browser acceptance. The service offers hosts from its prepared index, so unconfigured or unreadable dependencies do not enable requests.

Build support and hosted acceptance are distinct. A deployment must supply the matching prepared directory and runtime configuration; this UI work neither deploys it nor verifies hosted execution. Local workers are tracked in server memory: after a server restart, a later lost-worker finish cannot stop an orphaned child. Finish request and validation workers before stopping the server, or explicitly stop the owned worker and copy processes before disposing of the database. Browser reload is not a server restart. Test-mode reset, evidence and reconcile endpoints, synthetic archive contents and the five-second fake packaging window do not apply to live mode.

Local-live browser acceptance remains unverified. It requires the exact amd64 runtime images from the committed host pins, matching prepared packages, and an image store that retains the pinned identity accepted by the existing runner. Neutral image names alone are not retrieval locations, and retagging a loaded image does not establish a matching registry digest or image ID. Changed image pins produce new case IDs; packages from an earlier pin cannot be mixed with this revision. Retain the exact backend revision, image and prepared-index hashes, disposable ledger identity, read-only status/download evidence, and worker cleanup record with any durable browser result. No UI change substitutes images or weakens these requirements.

All synthetic contract fixtures, including revision-3 `test-evidence.json`, are copied byte-for-byte into `packages/web/test/fixtures/factory-v1/` with the pinned source documented. Unit tests and the original browser proof use fake transport responses and explicitly label that evidence as synthetic. The separate test-mode browser proof uses real local HTTP routes with fake execution dependencies. No provider or paid execution is part of either UI proof. Real-worker integration and production acceptance remain separate, unfinished work.

The published Umami example, case anchors, immutable release files and existing replay controls remain unchanged. The historical example is not relabeled as a newly exported revision-1 package.

## Preparing the local-live browser proof

Use the exact merged backend revision above and its local-stack instructions in a disposable checkout. Verify the pinned task-report image before creating the ledger or starting work. Keep `RBW_FACTORY_TEST_MODE` and `VERCEL_ENV` unset, use `RBW_FACTORY_WORKER_BACKEND=local`, a fresh loopback database and package directory, and the documented synthetic passcode. Do not supply hosted credentials. This does not configure a hosted deployment.

After checking the local prerequisites, run from `packages/web`:

```sh
node test/factory-live-browser.mjs <playwright-index.mjs> <chromium-binary> <local-origin> <evidence-output-directory> 269a22adb00f9616205a96c285fd5b2051b9bb10 --local-live
```

This separate entry reuses the synthetic script's ordinary sign-in, Review/Start identity and download checks. It enters the documented task-report/concurrency input, reloads the application-persisted request, waits for fulfillment, checks package sizes and hashes, clears only the browser session and signs in again, then validates and reloads without replacement work. It never seeds request identities, substitutes responses or calls test-mode controls. It saves request and validation IDs even when an assertion fails, for cleanup. The supplied SHA records the operator's revision; the browser cannot attest the server checkout or database configuration. Its output alone is HTTP/UI evidence, not independent proof of durable execution.

Retain read-only request/validation responses and a ledger snapshot using the existing [operator status command](../../packages/spend/README.md), scoped to the recorded request and validation roots. That command does not prove worker exit: confirm owned worker processes and copy containers have stopped before stopping the server and disposable database. Preserve failed-run evidence before removing owned temporary state. Do not restart the server to simulate browser recovery while a worker is active. The live entry does not assume a deterministic cancellation window, reset control, or synthetic failure scenario; those journeys remain covered by the separate test-mode script until a suitable live case is supplied.

The live entry is prepared but has not completed a durable-stack run because its image/package and import prerequisites remain unavailable. A separate earlier Stop/reload diagnostic recorded successful Stop and status responses, then a successful page response without subsequent client initialization calls. Its failing screenshot capture masked the original exception, so no runtime cause is established. This is distinct from the reproduced pointer/poll race above; later synthetic passes do not establish a fix for that reload observation.

## Repeating the mock browser proof

Build the web package with `RBW_RESULTS_DIR` pointing to the assembled public results snapshot, then start it on a local port. With an externally available Playwright installation and Chromium binary, run from `packages/web`:

```sh
node test/factory-browser.mjs <playwright-index.mjs> <chromium-binary> <local-origin> <evidence-output-directory> <public-results-repository>
```

The script refuses a non-local origin, intercepts only factory endpoints in its synthetic scenarios, and checks service unavailability separately. Its missing-endpoint expectation predates the implemented factory routes; it is not evidence that the current routes are absent. It never submits the legacy replay controls. The project adds no browser dependency or deployment configuration.

## Repeating the test-mode HTTP/UI proof

The earlier form-key backend was merged in [PR #144](https://github.com/Erik-1259/random-bug-walk/pull/144) at `092c1526b27a441c43f5fc1694fa44bf3d7cfb96`. Repeat the revision-3 proof against the merged backend [`269a22adb00f9616205a96c285fd5b2051b9bb10`](https://github.com/Erik-1259/random-bug-walk/commit/269a22adb00f9616205a96c285fd5b2051b9bb10) with these UI proof changes applied. This preserves the patched dependencies from [PR #159](https://github.com/Erik-1259/random-bug-walk/pull/159) and the merged worker/service changes; the contract and fixture pin remains `4be0c93f94a8582b998383c70d10837ba49c8014`. Use an isolated checkout. The public handoff is limited to local synthetic integration; durable-service, real-worker, hosted and production acceptance remain unverified.

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
