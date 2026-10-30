# Roadmap

This file lists planned work beyond the current release. An item here is a plan, not a feature: nothing it describes is available until a release says so, and no figure for it counts as measured until the runs below are done.

## Open behaviors on Umami

**Goal.** Let a customer build an open behavior on Umami: any non-security Umami behavior a customer describes, graded by a rule the customer can edit, as open behaviors work on the task-report service.

**Why it is not in the current release.** Today Umami builds only the proven time-zone grouping behavior. An Umami card about anything else is translated into the closest equivalent failure in the task-report service and built there, or refused as out of scope. The builder's Umami path is built around Umami's date-grouped reports, while the task-report qualification is generic. The full reasoning is in [Why open behaviors are built only on the task-report service](otf/SPEC.md#810-why-open-behaviors-are-built-only-on-the-task-report-service).

**What it takes.**
- An Umami lane runner and lane instructions that accept an arbitrary open rule (family, observable failure and failure code), not only the time-zone behavior.
- An admission and qualification sequence that works for any Umami behavior, not just the date-grouped reports. It must keep the current qualification checks: the original suite passes on clean, buggy and fixed copies, and the added checks fail only on the buggy copy, with the rule's failure code.
- Measured build times and costs from paid runs, since Umami's original suite is much larger and slower than the task-report suite.
- Umami's out-of-scope areas (sign-in, identity, permissions and races) stay excluded.

**How it will be measured.** Paid builder runs on a set of open Umami specs, recording the build time and the model cost for each qualified bug, along with the attempt and qualification counts. Until those runs are done and committed as evidence, Umami open behaviors are labeled "not measured yet", and no time, cost or success rate is shown for them.

**Status.** Planned, after the hackathon.

## Site UI/UX update from the Oct 30 expert review

**Goal.** Make the live site easier to read and use without changing what it does: say what a step costs and how long it takes before it starts, show what state a request or build is in and when that was last checked, let the evidence views explain themselves, and use one set of terms across the site.

**Why.** On Oct 30, 2026 the maintainers ran an information-design, UI/UX and copywriting review of the live site, signed in and signed out, on desktop and phone. The review's findings were merged into the 32 changes below, U01 to U32, ranked P1 (most important) to P3. Phase A, the small display and copy fixes, was deferred on Oct 30 so the remaining deadline work could stay on the model migration. Nothing below is in the current release.

**Ground rules for every change.**
- Labels that the published submission and judge instructions quote stay exactly as they are until judging ends; new helper text may sit next to them. A test will check them. Renames wait for Phase C.
- Times, amounts, caps and limits come from server data, since the per-build spend cap and time limit are set per host in the server configuration. No copy hard-codes them.
- Catalog requests spend from the judging budget; custom builds spend from their own custom-build budget. Copy never mixes the two.
- The certificate is not signed, and copy does not call it signed. No success-rate or novelty claims.
- Text, not color, carries meaning. Status regions announce state changes, not every poll.

### Changes (phase in brackets)

**P1**
- U01 · Show the lane count, the per-build model spend cap and the time limit right above Accept, and say custom builds spend from their own budget. The cap needs a new field in the availability response. [A]
- U02 · Replace raw job states with plain sentences (starting, waiting with a place in line, building with elapsed time, stopping), and add an outcome banner on finish with time, spend and a link to the downloads. [A]
- U03 · Show the classification as a labeled verdict (proven, open, or not built with the reason), and hide the build time and Accept when a card is refused. [A]
- U04 · Make the six-cell grid read as verdicts: words in every cell, Clean / Buggy / Fixed row headers, a "k of 6 cells matched" caption, an optional "what this shows" line, and stacking on phones. [A]
- U05 · Define "proven" and "not measured yet" where they appear: the behavior picker, the open-behavior rule note and the certificate. [A]
- U06 · Rename the run archive (nav "Catalog", page "Diagnostic catalog") so it no longer collides with catalog bugs, and use plainer column names. The /catalog URL stays. [A]
- U07 · Catalog offer: one price and clearer wording now (an existing bug, not the card above, checked again before delivery); later, show it only when it helps (after a refusal, a failed build or an outage, or while waiting) and name the matching bug. [A, B]
- U08 · Show when each live status was last checked, with a "Check again" button and a warning when updates have paused, and move the refresh buttons below the panel. Needs freshness fields in the status clients. [B]
- U09 · Replace the request page's catalog-only intro with three "ways to get a bug" cards that link to their sections, put a "how a bug qualifies" explainer next to them, add a skip-to-content link, and turn "above" and "below" references into in-page links. [B]
- U10 · Present the bug designer's two exits as labeled choices: build this exact bug, or fill the catalog form with the closest existing bug, which is not the designed one. [B]

**P2**
- U11 · Put the certificate in reading order: verdict, what was built, who built it, downloads with one role line each, the grids, provenance and hashes in a collapsed section, then validation, which says "match" only when the cells are equal. [A]
- U12 · Lane board: explain the parallel lanes and how one wins, show spend against the cap in cents, and give each lane card a model name, "round x of y", a stage in words and readable counts; later, a compact layout, a stepper and collapsed queued lanes. [A, B]
- U13 · Use readable numbers in the remaining views (token counts, waits such as "about 18 minutes", holds rounded to cents) through shared format helpers, and collapse the budget mechanics paragraph. [B]
- U14 · Show what is being built: the accepted card's title and behavior at the top of the board, the full card in a collapsed section, and the same line on the certificate; later, a note that reloading reconnects to the same build and does not pay twice. [A, B]
- U15 · Use one host display name, "Task and report service", in the interface and in customer-facing server messages, through a separate display map so the builder's inputs and prompts do not change. [A]
- U16 · Describe the delivered parts by the same roles on both paths (what goes to the debugging agent, what stays away from it); settle on one vocabulary after judging. [A, C]
- U17 · Use consistent budget terms (judging budget, request budget, custom-build budget, model spend cap); "Shared budget" becomes "Request budget". [A, B]
- U18 · Add a session strip with the signed-in state and a sign-out button, say which actions need the passcode, show a wrong passcode inline while keeping focus and the typed value, and keep raw service text under "Technical details". [B]
- U19 · Add a button hierarchy (primary, danger, quiet, each with a visible focus state); later, an inline two-step Stop with "Keep building" as the default. [A, B]
- U20 · Home page: a one-sentence lead on what the project does, a "Try it live" block linking to the request page, and a "Built with" note that covers custom builds. [A]
- U21 · Rate-limit message: say the hourly limit is shared by all judges, when to try again, that the text is kept and that catalog requests still work, next to the button that hit the limit. Needs retry details in the server response. [B]
- U22 · Forms and focus: errors next to their fields, an error summary by a disabled button, a stated reason for every disabled button, and focus moved once per step (card, verdict, progress, outcome). [B]
- U23 · Say when a spec card came from the bug designer, and relabel its regenerate button "Write a new card from this sentence instead". [B]
- U24 · Shorten the record pages: links in place of inline file tables on the run list, key files first and grouped sections with counts on run pages, and tables that stack on phones. [B]
- U25 · Phone layout: lighter nested form sections, 44 px touch targets, text areas that grow with their content and a single-line title field. [A]
- U26 · Interpretation panel: a "ready to start" or "cannot start" verdict and each problem once with an edit link; later, a clearer server message for a description that matches no recognized behavior. [B, C]
- U27 · Replace raw identifiers and labels: "Spec card (you can edit every field)", behavior families in words, field help with examples, the reserved failure code named in its error, "Lane 1" titles and catalog items without internal keys; later, model display names. [A, B]

**P3**
- U28 · Loading states: a spinner that respects reduced motion and an elapsed time while the spec card is written. [B]
- U29 · A picker intro sentence that explains the flow and says security bugs are not built; the refresh placement goes with U08. [A, B]
- U30 · Difficulty control: remove it, or keep it with a line saying only "Any difficulty" can be delivered today. [B]
- U31 · Use one name for the three copies (clean, buggy, fixed) across the site, including the released case and home pages after judging. [C]
- U32 · Bug designer: an intro line under the unchanged heading saying it designs a bug but does not build one; rename the heading after judging. [B, C]

### Phases

- **Phase A: small display and copy fixes.** U01–U06, the first parts of U07, U12, U14, U16, U17, U19, U27 and U29, and all of U11, U15, U20 and U25, plus two small server additions (the per-build cap in the availability response and the host display names). Deferred on Oct 30.
- **Phase B: larger UX changes.** It starts after the in-flight shape-badge, picker, status-polling and designer-limit fixes merge. The work happens on a separate branch with preview-only deploys until judging ends, and merges to main after that.
- **Phase C: renames after judging.** The published submission texts quote current labels, so renames of quoted labels wait until judging ends: the download names, the designer heading, one label for the two validate buttons and the Accept button. Phase C also covers the server message in U26, which ships with the factory worker image and needs a re-prepared image, the released-page vocabulary in U31 and the matching docs.

### Open decisions

- Whether Phase A ships with Phase B on the separate branch or on its own after judging.
- Whether Phase B is built on a separate branch with preview-only deploys and merged after judging (recommended), merged to main without deploying, or treated as allowed now.
- The nav label for the request page: keep "Request bug cases", or use "Request a bug" or "Get a bug".
- The run archive's new name: "Run records" or "Run archive".
- Whether to show remaining budget balances (judging and custom-build) to judges.
- The section order on the request page: custom build first (current, matching the judge instructions), catalog first, or designer first.
- Whether the task-report certificate says it is development evidence from this build, not a published release.
- The delivery vocabulary after judging: "Agent package / Grader package", "Bug case / Grader package", or the current names with role lines.
- Whether to remove the difficulty control or keep it with one line.
- Whether to add the Stop confirmation, an extra click on a path the judge instructions describe.
- Whether the home page, which is also a released case page, gets the "Try it live" block and the custom-build "Built with" line.
- Whether the shape-badge wording "Builds in the task-report service" changes to "Task and report service".

**Facts to check before the copy ships.** Whether the other lanes stop when one wins; whether custom validation makes model calls or spends from any budget; what a catalog Stop does to spend and to cases already delivered; whether the home page replay uses the same passcode and session as the request page; and which lane models production lists, for the "Built with" line.

**How it will be checked.** Component tests with the exact new strings, a test that the quoted labels are unchanged, the test-mode browser journeys and preview checks. Builds that were already delivered are reloaded for free, so no paid runs are needed.

**Status.** Planned. Phase A was deferred on Oct 30, 2026; Phases B and C follow the timing above.

## Small fixes found on Oct 30, 2026

**Goal.** Fix the small issues the maintainers found on Oct 30, 2026, after judging ends.

**Why it is not in the current release.** Each issue is small and none blocks a judge, so all of them were left for after judging, with the code freeze close.

**Fixes.**
- **Submission wording.** The hackathon project page says the custom builds run on a "Nebius Cloud VM"; the product is Nebius AI Cloud. It also says "the first build that passes qualification is delivered", but a task-report candidate must also pass a confirmation round ([SPEC section 2.2](otf/SPEC.md#22-winner-selection)). Fix both sentences when the page can be edited.
- **Sign-out.** Draft PR #206 adds `DELETE /api/factory/session`, which clears the session cookie and answers 204. It passes locally but is held until after judging. The /factory page still has no sign-out button (U18 above), and the route file's header comment lists only POST and GET. Merge the route, add the button and update the comment.
- **Browser proof.** Draft PR #207 updates `packages/web/test/otf-browser.mjs` for the current UI. A local run needed five more test-script fixes: label lookups by role, a duplicate-heading match, lanes always listed, a whole-word check, and waiting for the lanes to start before Stop. Add those fixes to the PR, change the expected credit line from "Nemotron 3 Super" to "Nemotron 3.5 Super", and say in the header that localhost origins work as well as 127.0.0.1.
- **Umami calendar refusal.** When Umami's calendar blocks a custom build, the create route answers the generic "Custom builds on this host are unavailable right now." (`packages/web/src/otf/handlers.ts`). Only the test-mode helper returns the calendar reason, and its test is titled as if production did. The page itself shows the calendar reason. Make the server message name the calendar, or align the test helper and its test title with the server.
- **Classifier blind spot.** A single-request card in which an update clears another field is still sometimes matched to a proven concurrency behavior. A one-line prompt clause helped the previous model but hurt the current one (Nemotron 3.5 Super), so it was not adopted. Nemotron 3 Ultra scored best on the test cards and can be selected with `RBW_OTF_CLASSIFIER_MODEL`. Revisit with more test cards before changing the prompt or the model.
- **Certificate and designer polish.** The custom-build certificate shows raw ISO timestamps and dollar amounts with up to six decimal places; show readable times and cents (U13 above). Designer cards can name technology the task-report service does not have, such as a cache; keep the designer to the parts the service has.

**How it will be checked.** Component and route tests with the new strings, the test-mode browser proof from PR #207, and a classifier comparison on a larger card set. No paid builds are needed; the classifier comparison makes only model calls.

**Status.** Deferred on Oct 30, 2026, until after judging.
