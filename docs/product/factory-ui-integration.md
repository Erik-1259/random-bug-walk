# Factory UI integration status

The `/factory` UI follows **bug-request/1 draft revision 1**, pinned to code commit [`7540362198f5940f1add45a65593ac314e8d751e`](https://github.com/Erik-1259/random-bug-walk/blob/7540362198f5940f1add45a65593ac314e8d751e/docs/product/bug-request-v1.md). Endpoints in that revision are planned. An unavailable service produces an explicit unavailable state; the production page never substitutes fixtures.

## Implemented UI behavior

Capabilities supply host choices, bug types, combination explanations, difficulty availability and all numeric limits. Items retain independent keys, descriptions and quantities. The service interpretation is displayed before start, and editing invalidates it. The UI does not implement the interpreter or decide qualification.

The factory session is separate from the Umami replay session. The client persists the request identity and exact start body before sending a start. Duplicate clicks are locked. Uncertain responses, failed polls and reloads read the saved identity, never launch replacement work. A `busy` refusal is reconciled against status before a new identity is permitted. Explicit same-identity retry is available after an uncertain start is still not found. Definite input/interpretation/budget refusals require another interpretation.

Status renders service events and counts without an invented percentage. Delivered cases remain visible for every outcome. Downloads keep debugging-agent and evaluator packages separate and require readiness. Validation stores its own identity before posting, resumes on reload and distinguishes behavioral failure from operational error. A click is never a completed validation result. No verification code or reference repairs are rendered in the page.

## Shared contract handoff

`packages/factory-contract/` is owned by the contract lane and was not available at this pinned revision. The UI's narrow response projections are currently in `packages/web/src/factory/client.ts`; they are not an alternative shared package. Replace them with the contract owner's exports before declaring live integration complete. Required exports are `Capabilities`, `RequestInput`, `StartRequest`, `Interpretation`, `RequestStatus`, `Case`, `PackagePart`, `ValidationRun`, `ErrorResponse`, and their runtime response parsers. The adapter currently checks JSON and contract-version envelopes; full shared response validation belongs in that package. Later numbered revisions must be reviewed explicitly, with fixtures and this pin updated together.

## Runtime and verification dependencies

Backend ownership remains `app/api/factory/**`, `src/factory-server/**` and request execution. Required runtime handoff: implemented revision-1 routes, session cookie behavior, capabilities declaring actual supported sources, interpretation/status/event pagination, idempotent starts/stops/validation, ready package paths, and an authorized non-paid test-service startup command with scenarios and disposable storage. UI tests cannot establish those server properties.

Synthetic contract fixtures are copied byte-for-byte into `packages/web/test/fixtures/factory-v1/` with the pinned source documented. Unit and browser tests use fake transport responses and explicitly label that evidence as synthetic. No provider or paid execution is part of UI verification. Real backend integration and API acceptance remain separate, unfinished work.

The published Umami example, case anchors, immutable release files and existing replay controls remain unchanged. The historical example is not relabeled as a newly exported revision-1 package.

## Repeating the browser proof

Build the web package with `RBW_RESULTS_DIR` pointing to the assembled public results snapshot, then start it on a local port. With an externally available Playwright installation and Chromium binary, run from `packages/web`:

```sh
node test/factory-browser.mjs <playwright-index.mjs> <chromium-binary> <local-origin> <evidence-output-directory> <public-results-repository>
```

The script refuses a non-local origin, intercepts only factory endpoints in its synthetic scenarios, and separately checks the real missing-endpoint state. It never submits the legacy replay controls. The project adds no browser dependency or deployment configuration.
