# Trying a custom build

Use the `/factory` page with a judge-passcode session. This guide follows the [merged UI](../../packages/web/src/components/otf/workspace.tsx), [host copy](../../packages/web/src/components/otf/host-copy.tsx), [OTF specification](SPEC.md) and [customer contract](../../packages/web/src/otf/contract.ts). Availability determines which hosts and behaviors you can use.

1. **Choose a behavior and add a sentence.** The intro is “Build a custom non-security bug. Choose a behavior from an offered host.” Under “Choose a behavior”, the picker groups the options into task-report service and Umami and shows example phrases. No behavior is selected initially. The task-report service offers concurrency criteria; Umami offers only the time-zone date/time criterion. Fill in “Describe it in one sentence”, then choose “Write my spec card”.

   A host that is not offered has a disabled group with a reason. Umami is unavailable on UTC days 2–5. A request whose planned window touches those days can also be unavailable. A calendar closure shows a UTC reopening hint, then “Task-report builds and the catalog are still available.” if task-report is offered, or “The catalog is still available.” otherwise. A disabled or unready Umami host says “Umami builds are offline right now.” An availability response with custom builds disabled says “Custom builds are offline right now. The catalog is available.” With no availability response and no saved job, the custom-build section is hidden.

2. **Read, edit and accept the spec card.** Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) writes the card. The heading is “Edit or accept your spec card”, with the badge “Design, not a built bug”. Check its proposed change, why existing tests miss it, added checks and fix before choosing “Accept and build this custom bug”. For Umami, read the placement notice: “The builder places the bug in one of Umami's date-grouped reports that its harness supports, chosen to match your card where it can. It may differ from the report your card describes.”

   The time sentence uses this host's measurements. When it uses the [development evidence](evidence/build-time-2026-10-29.json), it begins “In development runs, a qualifying build attempt took about” and gives the median, p90, qualified-attempt count and measurement date. Those figures are task-report: median 15.5 minutes, p90 30.9; Umami: median 21.0 minutes, p90 34.2. They are not finished customer-build times: the OTF queue, cold start, confirmation and packaging are excluded. With no measurement for the host, the card says its build times are not measured yet.

3. **Follow the lane board.** The section is “Custom build progress”. `starting_builder` shows “Starting the Nebius machine.”, separate from `queued` and `building`. A stopped builder is started for the request; it is not itself a refusal. The cold-start minute estimate appears only when configured. Each racing lane shows its model, stage, iteration, change/checks/fix files, tokens, spend and round feedback. “Model spend so far:” is followed by the metered amount and “(metered by the builder; an upper bound).” It is separate from the catalog budget. “Stop custom build” requests a stop; a lane that has already won can still deliver.

4. **Read the six-cell grid and, for Umami, the admission strip.** The grid shows the original suite and added checks on clean, buggy and fixed copies. Qualification expects:

   | Copy | Original suite | Added checks |
   |---|---|---|
   | clean | pass | pass |
   | buggy | pass | fail |
   | fixed | pass | pass |

   Task-report must repeat qualification in a confirmation round. Umami uses the [admission sequence](../admission-rules.md), without a separate confirmation round. Its grid comes from the first clean, planted and fixed admission copies, with planted shown as buggy. The strip labels are “Every copy ran every test”; “Fixed copies pass the added checks”; “Buggy copies fail as declared”; “Repeated runs agree”; “Partial and stub fixes are caught”; “The original suite misses the bug”; and “A second, independent fix also passes”. Successful strip entries show “passed”; `not_run` appears as “not run”. The grid uses “Not run” when its cells are absent. Neither means a pass.

5. **Inspect the certificate after `delivered`.** “Certificate and downloads” records the qualification cells, task-report confirmation cells or Umami admission result, models, spend and timings, and binds the agent and grader bundles by hash. Task-report says “Qualified by the RBW harness on the RBW builder (Nebius VM): six cells, pinned task-report kit image, 4 vCPU / 8 GB per copy, then confirmed in a second round.” Umami says “Qualified on the RBW builder (Nebius VM) with the local runner's admission sequence (docs/admission-rules.md) on the pinned Umami kit image with this build's checks, 4 vCPU / 8 GB per copy. Development evidence, not an RBW release.” Its certificate shows the admission result and runtime image digest; the confirmation grid is omitted when no confirmation cells exist. Qualification does not establish novelty. A candidate lane alone is not a delivery: the bundles and certificate must be stored.

6. **Download the separate bundles.** The links are “Agent bundle”, “Grader bundle” and “Certificate”. The agent bundle holds the buggy app and a symptom-level incident, with no checks, reference fix or accepted card. The grader bundle holds those evaluator materials and the qualification record; its checks are model-written executable code. Keep it out of the debugging agent's inputs. Umami's agent bundle includes the whole pinned app tree and runtime setup information; its grader bundle also includes probes and an alternative fix.

7. **Optionally validate the stored bundles.** Choose “Validate stored bundles”. For task-report: “Optional validation re-runs the six cells on the RBW builder.” For Umami: “Optional validation re-runs the admission sequence on the RBW builder from the stored bundles.” `queued` and `running` are pending states. Read the completed cells and admission result: `passed`, `failed` and `error` are distinct outcomes. A validation error is not a pass. A host refusal says “Validation was not started.” followed by the host's reason. With no answer to a validation request, use “Refresh custom build” to check its status; the unanswered request is not a successful validation.

## If the build does not deliver

Keep the lane feedback and model spend in view. These job outcomes come from the contract:

| Outcome | Meaning |
|---|---|
| `not_qualified` | Task-report: “No lane produced a bug that passed all six cells in 3 rounds.” Umami: “No lane produced a bug that passed the admission sequence in 3 rounds.” |
| `time_limit` | “The custom build reached its time limit.” The job reached its deadline; a lane can also stop when too little time remains to start a round. |
| `spend_limit` | “The custom build reached its model spend limit.” A lane or job spend cap was reached. |
| `cancelled` | “The custom build was cancelled.” The customer stopped the build. A stop after winner selection can still deliver: “Stopped after a lane won; the bug was delivered.” |
| `builder_start_failed` | “Error: the builder machine could not start.” The machine could not start (`capacity` or `api_error`), or no builder claimed the job before the startup timeout (`timeout`). |
| `builder_unavailable` | Usually “Error: the builder became unavailable.” Custom builds were disabled or put on hold while the job waited, or its host became unavailable. An unclaimed Umami job stopped by its calendar instead says “This custom build did not start: Umami is unavailable on UTC days 2–5.” and shows a reopening hint and catalog fallback. |
| `builder_lost` | “Error: contact with the builder was lost.” The claimed job stopped receiving builder posts. |
| `error` | “Error: an infrastructure failure stopped the custom build.” It is distinct from a failure to qualify. |

A refusal before creation is also distinct from a build outcome. `signed_out` requires a judge session; `busy`, `daily_cap` and `spend_cap` report capacity or cap limits. `host_unavailable` reports host readiness, configuration or calendar availability. It says “This custom build was not started.” followed by the host's reason, keeps the card and sentence, and offers “Edit custom design” and the catalog fallback. After a definite refusal, use “Retry the same custom build” to send the saved create again. `unavailable` reports disabled or unconfigured service, a hold, a machine-hours cap or a server fault. `refused_topic` and `invalid_spec` reject the requested topic or card. `idempotency_conflict` means the same request identity was used with a different body; it does not confirm a new build.

## Use the catalog fallback

Choose “Start the closest catalog bug” to start the existing catalog flow. It spends the shared judge budget only after that explicit choice and can run while the custom build runs. It is a “pre-qualified catalog bug, re-verified for your request”, not proof that the custom spec was built. The card says “Your catalog bug is ready” when it is ready. A builder capacity failure uses this fallback; no smaller builder is substituted.
