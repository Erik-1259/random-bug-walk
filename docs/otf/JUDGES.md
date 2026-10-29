# Trying a custom build

Use the `/factory` page with a judge-passcode session. This guide follows the [merged UI](../../packages/web/src/components/otf/workspace.tsx), [host copy](../../packages/web/src/components/otf/host-copy.tsx), [OTF specification](SPEC.md) and [customer contract](../../packages/web/src/otf/contract.ts). Availability determines which hosts and behaviors you can use.

1. **Choose a behavior and add a sentence.** The intro is “Build a custom non-security bug. Choose a behavior from an offered host.” Under “Choose a behavior”, the picker groups the options into task-report service and Umami. Where a behavior has example phrases beyond its label, they follow “For example:”. No behavior is selected initially. The task-report service offers concurrency criteria; Umami offers only the time-zone date/time criterion. Fill in “Describe it in one sentence”, then choose “Write my spec card”.

   A host that is not offered has a disabled group with a reason. Umami is unavailable on UTC days 2–5. A request whose planned window touches those days can also be unavailable. A calendar closure shows a UTC reopening hint, then “Task-report builds and the catalog are still available.” if task-report is offered, or “The catalog is still available.” otherwise. A disabled or unready Umami host says “Umami builds are offline right now.” An availability response with custom builds disabled says “Custom builds are offline right now. The catalog is available.” With no availability response and no saved job, the custom-build section is hidden.

2. **Read, edit and accept the spec card.** Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) writes the card. The heading is “Edit or accept your spec card”, with the badge “Design, not a built bug”. Check its proposed change, why existing tests miss it, added checks and fix before choosing “Accept and build this custom bug”. For Umami, read the placement notice: “The builder places the bug in one of Umami's date-grouped reports that its harness supports, chosen to match your card where it can. It may differ from the report your card describes.”

   The time sentence uses this host's measurements. When it uses the [development evidence](evidence/build-time-2026-10-29.json), it begins “In development runs, a qualifying build attempt took about” and gives the median, p90, qualified-attempt count and measurement date. Those figures are task-report: median 15.5 minutes, p90 30.9; Umami: median 21.0 minutes, p90 34.2. They are not finished customer-build times: the OTF queue, cold start, confirmation and packaging are excluded. With no measurement for the host, the card says its build times are not measured yet.

3. **Follow the lane board.** The section is “Custom build progress”. `starting_builder` shows “Starting the Nebius machine.”, separate from `queued` and `building`. A stopped builder is started for the request; it is not itself a refusal. The cold-start minute estimate appears only when configured. Each racing lane shows its model, stage, iteration, change/checks/fix files, tokens, spend and round feedback. “Model spend so far:” is followed by the metered amount and “(metered by the builder; an upper bound).” It is separate from the catalog budget. “Stop custom build” requests a stop for the job this tab is showing; if another tab started a different build meanwhile, that build is shown instead and is not stopped. A lane that has already won can still deliver.

4. **Read the six-cell grid and, for Umami, the admission strip.** The grid shows the original suite and added checks on clean, buggy and fixed copies. Qualification expects:

   | Copy | Original suite | Added checks |
   |---|---|---|
   | clean | pass | pass |
   | buggy | pass | fail |
   | fixed | pass | pass |

   Task-report must repeat qualification in a confirmation round. Umami uses the [admission sequence](../admission-rules.md), without a separate confirmation round. Its grid comes from the first clean, planted and fixed admission copies, with planted shown as buggy. The strip labels are “Every copy ran every test”; “Fixed copies pass the added checks”; “Buggy copies fail as declared”; “Repeated runs agree”; “Partial and stub fixes are caught”; “The original suite misses the bug”; and “A second, independent fix also passes”. Successful strip entries show “passed”; `not_run` appears as “not run”. The grid uses “Not run” when its cells are absent. Neither means a pass.

5. **Inspect the certificate after `delivered`.** “Certificate and downloads” records the qualification cells, task-report confirmation cells or Umami admission result, models, spend and timings, and binds the agent and grader bundles by hash. Task-report says “Qualified by the RBW harness on the RBW builder (Nebius VM): six cells, pinned task-report kit image, 4 vCPU / 8 GB per copy, then confirmed in a second round.” Umami says “Qualified on the RBW builder (Nebius VM) with the local runner's admission sequence (docs/admission-rules.md) on the pinned Umami kit image with this build's checks, 4 vCPU / 8 GB per copy. Development evidence, not an RBW release.” Its certificate shows the admission result and runtime image digest; the confirmation grid is omitted when no confirmation cells exist. Qualification does not establish novelty. A candidate lane alone is not a delivery: the bundles and certificate must be stored.

6. **Download the separate bundles.** The links are “Agent bundle”, “Grader bundle” and “Certificate”. The agent bundle holds the buggy app and a symptom-level incident, with no checks, reference fix or accepted card. The grader bundle holds those evaluator materials and the qualification record; its checks are model-written executable code. Keep it out of the debugging agent's inputs. Umami's agent bundle includes the whole pinned app tree and runtime setup information; its grader bundle also includes probes and an alternative fix.

7. **Optionally validate the stored bundles.** Choose “Validate stored bundles”. For task-report: “Optional validation re-runs the six cells on the RBW builder.” For Umami: “Optional validation re-runs the admission sequence on the RBW builder from the stored bundles.” `queued` and `running` are pending states. Read the completed cells and admission result: `passed`, `failed` and `error` are distinct outcomes. A validation error is not a pass. If the builder machine stops while a validation runs, that validation ends as `error`; you can validate again. A host refusal says “Validation was not started.” followed by the host's reason. With no answer to a validation request, the page says “Your validation request has no answer yet. Refresh to check it, or validate again: a validation already queued is answered, not repeated.” Use “Refresh custom build” to check its status. The unanswered request is not a successful validation.

## Open behaviors (not available yet)

<!-- TODO-SHIP: open behaviors ship only if they pass acceptance before 2026-10-30 10:00Z. If they ship, replace the availability paragraph below with the production commit; if they do not, remove this section. -->

Open behaviors are not available yet. Until they ship, the picker offers only the three proven behaviors above. This section describes the design in the [OTF specification](SPEC.md#8-open-behaviors).

An open behavior is any other non-security behavior of the task-report service. Open behaviors are built only on the task-report service; Umami stays limited to the time-zone date/time criterion.

1. **Start from a bug designer card.** After the bug designer drafts a card, choose its custom-build handoff to have that card built. <!-- TODO-UI: the specification names this handoff "Build this as a custom bug"; check the label against the built UI. --> In the picker, the open behavior appears under the task-report service as “Another non-security behavior (not measured yet)”. <!-- TODO-UI: the picker's open option is not built yet; check that it shows OTF_OPEN_LABEL. -->

2. **Read the classification.** Nemotron 3 Super classifies the card. Its answer takes one of three forms: <!-- TODO-UI: the classification outcomes are not built yet; check this wording against the built UI. -->
   - **Proven match.** The card matches one of the three proven behaviors, and you can build it as that behavior. The open behavior may be offered beside it.
   - **Open behavior with a rule.** The answer names a bug family (`concurrency`, `date_time`, `data_handling` or `state_ui`) and proposes a grading rule: the observable failure that the added checks look for through the app's routes (40 to 600 characters) and the failure code they report on the buggy copy. You can edit the rule before you accept it.
   - **Refusal.** A security topic, or a behavior that could not plausibly exist in a task-and-report service, is refused with a reason, and that card cannot be built. An Umami card about anything other than time-zone grouping is offered as a task-report open behavior only when the behavior could plausibly exist there.

   The classification is advisory. Production checks what you submit, including the rule: a security topic in the rule is refused, and a rule outside the host's scope is rejected.

3. **Accept the card and rule.** Accepting starts the build, which runs on the same lane board as a proven behavior. <!-- TODO-UI: check the accept button label for an open behavior against the built UI. --> In place of any time estimate, the card shows “Build times for this kind of behavior are not measured yet. The board shows each step as it runs.” <!-- TODO-UI: the open time copy is not built yet; check that it shows OTF_OPEN_TIME_COPY. --> No build time, success rate or typical outcome has been measured for open behaviors, and none is shown.

4. **Read the grid and the certificate.** An open behavior is qualified on the same six-cell grid as a task-report proven behavior, then confirmed in a second round. On the buggy copy, the added checks must fail with the rule's failure code. The certificate uses the task-report wording from step 5 and records the criterion version `open-1`. It shows the rule: its family, observable failure and failure code. The rule grades this build only; it is not a catalog criterion. Qualification does not establish novelty. <!-- TODO-UI: the open certificate view is not built yet; check that it shows the rule and open-1. -->

## If the build does not deliver

Keep the lane feedback and model spend in view. These job outcomes come from the contract:

| Outcome | Meaning |
|---|---|
| `not_qualified` | Task-report: “No lane produced a bug that passed all six cells in 3 rounds.” Umami: “No lane produced a bug that passed the admission sequence in 3 rounds.” |
| `time_limit` | “The custom build reached its time limit.” The job reached its deadline; a lane can also stop when too little time remains to start a round. |
| `spend_limit` | “The custom build reached its model spend limit.” A lane or job spend cap was reached. |
| `cancelled` | “The custom build was cancelled.” The customer stopped the build. A stop after winner selection can still deliver: “Stopped after a lane won; the bug was delivered.” |
| `builder_start_failed` | “Error: the builder machine could not start.” The machine could not start (`capacity` or `api_error`), or no builder claimed the job before the startup timeout (`timeout`). |
| `builder_unavailable` | Usually “Error: the builder became unavailable.” Custom builds were disabled or put on hold while the job waited, or its host became unavailable. An unclaimed Umami job stopped by its calendar instead says “This custom build did not start: Umami is unavailable on UTC days 2–5.”, gives the UTC reopening date only while the calendar still blocks a new Umami build, and says “The closest catalog bug is offered below.” |
| `builder_lost` | “Error: contact with the builder was lost.” The claimed job stopped receiving builder posts. |
| `error` | “Error: an infrastructure failure stopped the custom build.” It is distinct from a failure to qualify. |

A refusal before creation is also distinct from a build outcome. `signed_out` requires a judge session; `busy`, `daily_cap` and `spend_cap` report capacity or cap limits. `host_unavailable` reports host readiness, configuration or calendar availability. It says “This custom build was not started.” followed by the host's reason, keeps the card and sentence, and offers “Edit custom design” and the catalog fallback. After a definite refusal, use “Retry the same custom build” to send the saved create again. `unavailable` reports disabled or unconfigured service, a hold, a machine-hours cap or a server fault. `refused_topic` and `invalid_spec` reject the requested topic or card. `idempotency_conflict` means the same request identity was used with a different body; it does not confirm a new build.

## Use the catalog fallback

Choose “Start the closest catalog bug” to start the existing catalog flow. It spends the shared judge budget only after that explicit choice and can run while the custom build runs. It is a “pre-qualified catalog bug, re-verified for your request”, not proof that the custom spec was built. The card says “Your catalog bug is ready” when it is ready. A builder capacity failure uses this fallback; no smaller builder is substituted.
