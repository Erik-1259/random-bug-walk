# Trying a custom build

Use the `/factory` page with a judge-passcode session. This guide follows the [OTF specification](SPEC.md) and [customer contract](../../packages/web/src/otf/contract.ts). Availability determines which hosts and behaviors you can use.

1. **Choose a behavior and add a sentence.** The picker groups the offered behaviors by host and shows example phrases. The task-report service offers concurrency criteria; Umami offers only the time-zone date/time criterion. Umami is unavailable on UTC days 2–5. A request whose planned window touches those days can also be unavailable. When custom builds are offline, the message is: “Custom builds are offline right now. The catalog is available.”

2. **Read, edit and accept the spec card.** Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) writes the card. Check its proposed change, why existing tests miss it, added checks and fix before accepting. A card is a design, not a qualified bug. For Umami, read the placement notice: “The builder places the bug in one of Umami's date-grouped reports that its harness supports, chosen to match your card where it can. It may differ from the report your card describes.”

3. **Follow the lane board.** `starting_builder` is the machine-start step, separate from `queued` and `building`. A stopped builder is started for the request; it is not itself a refusal. Each racing lane shows its model, stage, iteration, change/checks/fix files, tokens, spend and round feedback. The spend line reads “Model spend so far: $X (metered by the builder; an upper bound).” It is separate from the catalog budget. Timing estimates depend on the host's available measurements; the [development evidence](evidence/build-time-2026-10-29.json) measures attempts, not finished customer builds.

4. **Read the six-cell grid and, for Umami, the admission strip.** The grid shows the original suite and added checks on clean, buggy and fixed copies. Qualification expects:

   | Copy | Original suite | Added checks |
   |---|---|---|
   | Clean | pass | pass |
   | Buggy | pass | fail |
   | Fixed | pass | pass |

   Task-report must repeat qualification in a confirmation round. Umami uses the [admission sequence](../admission-rules.md), without a separate confirmation round. Its grid comes from the first clean, planted and fixed admission copies, with planted shown as buggy. The strip labels are “Every copy ran every test”; “Fixed copies pass the added checks”; “Buggy copies fail as declared”; “Repeated runs agree”; “Partial and stub fixes are caught”; “The original suite misses the bug”; and “A second, independent fix also passes”. A value of `not_run` appears as “not run”; it is not a pass.

5. **Inspect the certificate after `delivered`.** It records the qualification cells, task-report confirmation cells or Umami admission result, models, spend and timings, and binds the agent and grader bundles by hash. The Umami certificate says “Development evidence, not an RBW release.” It does not establish an RBW release or novelty. A candidate lane alone is not a delivery: the bundles and certificate must be stored.

6. **Download the separate bundles.** The **Agent bundle** holds the buggy app and a symptom-level incident, with no checks, reference fix or accepted card. The **Grader bundle** holds those evaluator materials and the qualification record; its checks are model-written executable code. Keep it out of the debugging agent's inputs. Umami's agent bundle includes the whole pinned app tree and runtime setup information; its grader bundle also includes probes and an alternative fix.

7. **Optionally validate the stored bundles.** For task-report: “Re-runs the six cells on the RBW builder.” For Umami: “Re-runs the admission sequence on the RBW builder from the stored bundles.” `queued` and `running` are pending states. Read the completed cells and admission result: `passed`, `failed` and `error` are distinct outcomes. A validation error is not a pass.

## If the build does not deliver

Keep the lane feedback and model spend in view. These job outcomes come from the contract:

| Outcome | Meaning |
|---|---|
| `not_qualified` | Task-report: “No lane produced a bug that passed all six cells in 3 rounds.” Umami: “No lane produced a bug that passed the admission sequence in 3 rounds.” |
| `time_limit` | The job reached its deadline. A lane can also stop when too little time remains to start a round. |
| `spend_limit` | A lane or job spend cap was reached. |
| `cancelled` | The customer stopped the build. A stop after winner selection can still deliver: “Stopped after a lane won; the bug was delivered.” |
| `builder_start_failed` | Error: the machine could not start (`capacity` or `api_error`), or no builder claimed the job before the startup timeout (`timeout`). |
| `builder_unavailable` | Error: custom builds were disabled or put on hold while the job waited, or its host became unavailable. |
| `builder_lost` | Error: the claimed job stopped receiving builder posts. |
| `error` | An infrastructure error stopped the build; it is distinct from a failure to qualify. |

A refusal before creation is also distinct from a build outcome. `signed_out` requires a judge session; `busy`, `daily_cap` and `spend_cap` report capacity or cap limits. `host_unavailable` reports host readiness, configuration or calendar availability; `unavailable` reports disabled or unconfigured service, a hold, a machine-hours cap or a server fault. `refused_topic` and `invalid_spec` reject the requested topic or card. `idempotency_conflict` means the same request identity was used with a different body; it does not confirm a new build.

## Use the catalog fallback

Choose “Start the closest catalog bug” to start the existing catalog flow. It spends the shared judge budget only after that explicit choice and can run while the custom build runs. It is a “pre-qualified catalog bug, re-verified for your request”, not proof that the custom spec was built. The card says “Your catalog bug is ready” when it is ready. A builder capacity failure uses this fallback; no smaller builder is substituted.
