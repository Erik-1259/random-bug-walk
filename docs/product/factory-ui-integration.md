# Factory UI integration status

The `/factory` UI follows **bug-request/1 draft revision 2**, pinned to code commit [`52a7dc9a50a56c07539d100c4eb2f0f95039b0cb`](https://github.com/Erik-1259/random-bug-walk/blob/52a7dc9a50a56c07539d100c4eb2f0f95039b0cb/docs/product/bug-request-v1.md). Endpoints in that revision are planned. An unavailable service produces an explicit unavailable state; the production page never substitutes fixtures.

## Implemented UI behavior

Capabilities supply host choices, bug types, combination explanations, difficulty availability and all numeric limits. Items retain independent keys, descriptions and quantities. The service interpretation is displayed before start, and editing invalidates it. The UI does not implement the interpreter or decide qualification.

The factory session is separate from the Umami replay session. The client persists the request identity and exact start body before sending a start. Duplicate clicks are locked. Uncertain responses, failed polls and reloads read the saved identity, never launch replacement work. A `busy` refusal is reconciled against status before a new identity is permitted. Explicit same-identity retry is available after an uncertain start is still not found. Definite input/interpretation/budget refusals require another interpretation.

Status renders service events and counts without an invented percentage. Delivered cases remain visible for every outcome. Downloads keep debugging-agent and evaluator packages separate and require readiness. Validation stores its own identity before posting, resumes on reload and distinguishes behavioral failure from operational error. A click is never a completed validation result. No verification code or reference repairs are rendered in the page.

## Shared contract handoff

The UI consumes the unchanged Git workspace package `@rbw/factory-contract` from the pinned PR #121 revision above. Client code imports its root entry's types and contract-version constant. The former local transport projections are removed. The package's `/validate` entry reads files and uses Node/Ajv, so it is used only by tests to parse every pinned UI fixture, never imported into a client component. The browser still checks JSON and contract-version envelopes; full runtime response validation requires a client-safe parser if the contract owner later supplies one.

Revision 2 stores the validation UUID under `rbw-factory-validation-id` before POST, with scoped request/case metadata kept separately. Existing revision-1 scoped metadata is migrated without starting work. Definite validation refusals clear the rejected ID; uncertain responses retain it for the same-ID retry. Stale factory tabs adopt the saved request before Start, and clearing an older request does not delete a newer tab's identity. New warning codes and criterion failure-code fixtures come from the shared contract, while interpretation and qualification remain service decisions.

The shared package also supplies `CopyPlan.destinations`, `CopyRoots`, `CollectedCopy`, `CopyRunner.run(plan, roots)` and `HostAdapter.collect`. These are backend/harness interfaces; the UI does not execute or implement them. Later contract corrections must be integrated explicitly with an updated Git pin and fixtures.

## Runtime and verification dependencies

Request and validation identity mutations use one origin-wide Web Lock, held through Start persistence and reconciliation. A stale tab adopts a newer request or validation before acting; cleanup cannot erase that newer identity. Browsers without Web Locks cannot start this workflow. The synthetic browser proof queues simultaneous Start clicks behind a held lock and checks cleanup while another tab's validation POST is in flight. This verifies UI coordination, not server idempotency or live acceptance.

Backend ownership remains `app/api/factory/**`, `src/factory-server/**` and request execution. Required runtime handoff: implemented revision-2 routes, session cookie behavior, capabilities declaring actual supported sources, interpretation/status/event pagination, idempotent starts/stops/validation, ready package paths, and an authorized non-paid test-service startup command with scenarios and disposable storage. UI tests cannot establish those server properties.

Synthetic contract fixtures are copied byte-for-byte into `packages/web/test/fixtures/factory-v1/` with the pinned source documented. Unit and browser tests use fake transport responses and explicitly label that evidence as synthetic. No provider or paid execution is part of UI verification. Real backend integration and API acceptance remain separate, unfinished work.

The published Umami example, case anchors, immutable release files and existing replay controls remain unchanged. The historical example is not relabeled as a newly exported revision-1 package.

## Repeating the browser proof

Build the web package with `RBW_RESULTS_DIR` pointing to the assembled public results snapshot, then start it on a local port. With an externally available Playwright installation and Chromium binary, run from `packages/web`:

```sh
node test/factory-browser.mjs <playwright-index.mjs> <chromium-binary> <local-origin> <evidence-output-directory> <public-results-repository>
```

The script refuses a non-local origin, intercepts only factory endpoints in its synthetic scenarios, and separately checks the real missing-endpoint state. It never submits the legacy replay controls. The project adds no browser dependency or deployment configuration.
