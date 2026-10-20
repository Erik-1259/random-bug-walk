# Bug generation pipeline

This project turns a known kind of bug into a validated task in a pinned host app: it finds public fixes of that kind, encodes the bug's shape as code, plants a bug of the same shape in the host, proves the planted bug is a blind spot of the host's own test suite, and admits it only after repeated sandboxed runs. This page says what each step does today, which package does it, and what is still manual. The current host is Umami at a pinned commit (`kit/umami`).

## The steps

| Step | What it does | Where | Today |
|---|---|---|---|
| 1. Find real fixes of a class | Search public fix commits and reports for one bug shape | `packages/harvest` (GitHub fix commits, structural confirmation, a funnel with a reason for every drop); `packages/harvest-review` (two models judge each candidate that matched the source rule); `packages/search` (Tavily source search and docs extract, run inside a candidate attempt) | Automated for `DT-1.tz-arg`. `packages/harvest` and `packages/harvest-review` also support the race class `RC-1.guarded-write` (its review prompt has not been run against a live model). Other shapes need their own harvest queries. |
| 2. Encode the shape | Turn a fix into a rule: the fixed form, the buggy form and the rewrite between them | `packages/shapes` (ast-grep rules and probes) | Written by hand. The site rules (`DT-1.tz-arg`, `RC-1.atomic-backup-code`) are tied to one chosen site each. The race class rules (`race.guarded-write`, `race.upsert` in `packages/shapes/rules/race.class.yml`) name no file, function or variable. |
| 3. Find sites in the host | Run the fixed-form rule over the host tree to list where the shape occurs | `packages/shapes` | Automated. A site rule finds its chosen site. The race class rules list every site in a host tree that matches their structure (`findSites` in `packages/shapes/src/classes.ts`, used by `tools/candidates`); the shapes README lists the forms they leave out. The time-zone shape has no class rule. |
| 4. Plant | Apply the rule's rewrite to make the planted copy, and derive the clean, planted and fixed code states | `packages/shapes`, `tools/local-runner` (code states, projection audit) | Automated. |
| 5. Prove the bug | Checks that fail on the planted copy and pass on the clean and fixed copies, while the host's original suite still passes | `packages/umami-fixture` (time-zone family), `packages/umami-fixture-rc1` (race family, parked), `packages/umami-driver` (runs a copy and its checks), `kit/umami`, `kit/umami-race` | Written by hand per family. This is the most expensive step: a race family needs a concurrency driver, seeded state and timing control. The time-zone family runs end to end. The race family's checks exist, and the schema, driver, admission, local runner, controller and release accept the family, but it did not reach admission and is parked. |
| 6. Write and check | Observe the symptom, write the card and the issue, check the issue's numbers and novelty | `packages/writer`, `packages/search`, `tools/controller` (candidate attempt) | Automated. |
| 7. Admit and release | 13 sandboxed copies (11 for a family that records ADM-06 as not applicable) with fixed expectations, a human alignment check of the issue, then a release with a frozen judge job | `packages/admission`, `tools/controller`, `tools/release`, `packages/publisher` | Automated, apart from the human alignment check. |
| 8. Replay | A judge replays the released case on fresh copies | `packages/web` (judge routes), `tools/controller` (judge replay) | Automated. |

## What a new bug class costs

The time-zone family is the one that has gone from candidate attempt to release and judge replay (release `319f3100-9ecf-441d-b7af-a643af9ae4e5` in the results repository). A second family, the race family, is wired through the same steps. The local runner and the controller take `--family time-zone|race` (`tools/local-runner/src/family.ts`), the candidate attempt passes the selected family to its symptom builder (`tools/controller/src/symptom.ts`), the writer has a race prompt and checks, and the release's judge-job construction (`tools/release/src/judge-job.ts`) takes the admitted run's family. The race family did not reach admission and is parked. Each family is still a named entry in those places, so a new class needs:

- **Per class, once:** harvest support (step 1): queries, a candidate rule, the text filter and structural confirmation in `packages/harvest` (which select these by `--shape`; `DT-1.tz-arg` and `RC-1.guarded-write` have them today), and a review prompt and input shape in `packages/harvest-review`; a shape rule (step 2), checks with whatever driver the class needs (step 5), a symptom shape the writer can use (step 6), and an entry for the family, its source fix and mutation in `packages/schema/registry/families.json`, without which the release build refuses the case as unregistered (step 7).
- **A family entry:** the local runner's family table (`tools/local-runner/src/family.ts`: fixture, probes, alternative fix, kit image), which the controller and the release's judge-job construction read, and the controller's symptom builder (`tools/controller/src/symptom.ts`) each need an entry for the new family. The steps already take the family as an input.
- **Classes without partial and stub probes** record ADM-06 as not applicable in their probe set. The code-state derivation (`tools/local-runner/src/code-states.ts`) and the 11-copy admission profile already accept such a probe set.

Once a class is wired, another site of the same class in the same host can reuse its driver, kit changes and seeding, so it should cost much less than the first.

## The static-headroom screen

A planted bug used to compare debugging tools (for example, a solver with and without the app's server logs) must not be findable from the planted source alone; otherwise both arms solve it by reading and the tool cannot make a difference. The screen records are in `docs/uc1-screen/`. Both current families fail it: the time-zone mutation leaves the destructured `timezone` unused while a sibling query in the same file still passes it, and the backup-code race mutation leaves a guard that can no longer trigger and a matching filter 15 lines above it. The time-zone case remains a valid factory case; the race family did not reach admission and is parked.

A planted change often leaves such traces, because the surrounding code still reflects what the removed line was for: a variable that is now unused, a sibling that still does it right, or a check that can no longer fire. That is why the screen is applied to each candidate rather than assumed.

## Class-level tools

- **Class-level rules (race class only).** `packages/shapes/rules/race.class.yml` matches the race class by structure, and `findSites` (`packages/shapes/src/classes.ts`) lists every site in a host tree that matches it. The time-zone shape has only its site rule.
- **An automated static screen.** `packages/screen`: a bounded, metered model probe per planted candidate that tries to locate the bug from the source and the symptom alone.
- **A candidate pipeline.** `tools/candidates`: lists the sites a class rule matches and plants each. Its default route, `behavioral-qualification/v1`, plants in memory and records the planted candidates for behavioral qualification (checks on clean, buggy and reference-fixed copies, which run outside the tool), with no copy, no screen and no spend, and marks each candidate's difficulty as not assessed. The `static-screen/v1` route (`--route static-screen/v1`) plants each in its own temporary copy, screens each, and ranks the survivors; its symptom templates cover the race class only.

No admitted task has come from these tools so far.
