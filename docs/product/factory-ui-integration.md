# Factory UI integration status

The additive `/factory` page is presentation scaffolding. Live requests, package downloads and validation are unavailable. It must not be presented as a completed request product.

## Contract dependency

No published revision of `docs/product/bug-request-v1.md` was available on `main` or `feat/rbw-product-contracts` when this scaffolding was prepared. Contract revision: **not yet available**. No request endpoints, authentication scheme, backend status schema, budget limits or package format have been defined by this UI change.

`packages/web/src/factory/client.ts` is a disconnected presentation boundary, not an API specification. Replace it with a client for the exact published contract. The form and progress component types are local view props. Development options and snapshots are used only in tests, visibly labeled, and never loaded into the production page.

## Connections required

- Read the published contract and record its commit here before implementing transport. Use its supported host/type combinations, per-description requirements, quantity rules, shared budget limits and unsupported-input responses. A draft summary is not a backend interpretation.
- Use the factory service's authentication and idempotency rules. The existing judge cookie and `/api/judge` transport are not a factory API. Retain the same backend request identity across repeated clicks, uncertain responses and reloads; do not start a replacement request on a temporary polling error.
- Render actual events and canonical terminal outcomes, including partial results, exhaustion, cancellation and operational failure. Retain each backend-qualified case independently of the request outcome. Do not count retries, rejected candidates or incomplete cases as delivered.
- Use only permitted package metadata. Enable separate debugging and validator downloads only on the service's readiness response. Never include verification tests, reference fixes or answers in agent-facing payloads. Qualification is determined by the service.
- Connect validation to the real replay service and display its actual progress and result. A local click is not evidence of execution. Leave the harder per-description option unavailable until supported calibration is declared.

## Verification boundary

Presentation tests exercise local fixtures and unavailable states. They do not establish backend integration, paid-request idempotency, qualification, package readiness or replay execution. Real-service verification remains required using the published contract and an authorized non-paid test facility; no live paid request is part of these UI checks.

The published Umami example is linked separately from draft requests. Existing case anchors, immutable release files and judge replay controls remain unchanged. Use a build against the public results snapshot for browser regression checks; the default development fixture contains no released case.

## Publication

Publication must use the repository's trusted helper and required scans. The cloud push preflight returned `rbw-publish: rbw.worktreeId is not set in this clone's git config` (exit 2); no publication request was made. Register and use the trusted route for the exact reviewed commit and PR text. No prior publication exception applies to this change.
