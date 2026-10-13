# Bug generation pipeline

This project turns a known kind of bug into a validated task in a pinned host app: it finds public fixes of that kind, encodes the bug's shape as code, plants a bug of the same shape in the host, proves the planted bug is a blind spot of the host's own test suite, and admits it only after repeated sandboxed runs. This page says what each step does today, which package does it, and what is still manual. The current host is Umami at a pinned commit (`kit/umami`).

## The steps

| Step | What it does | Where | Today |
|---|---|---|---|
| 1. Find real fixes of a class | Search public fix commits and reports for one bug shape | `packages/harvest` (GitHub fix commits, structural confirmation, a funnel with a reason for every drop); `packages/harvest-review` (two models judge each harvested candidate); `packages/search` (Tavily source search and docs extract, run inside a candidate attempt) | Automated for `DT-1.tz-arg`. Other shapes need their own harvest queries. |
| 2. Encode the shape | Turn a fix into a rule: the fixed form, the buggy form and the rewrite between them | `packages/shapes` (ast-grep rules and probes) | Written by hand, one rule per shape. The current rules (`DT-1.tz-arg`, `RC-1.atomic-backup-code`) are tied to one chosen site each. |
| 3. Find sites in the host | Run the fixed-form rule over the host tree to list where the shape occurs | `packages/shapes` | Automated for the rule as written. Because the rules are site-specific, they find the chosen site, not every site of the class. |
| 4. Plant | Apply the rule's rewrite to make the planted copy, and derive the clean, planted and fixed code states | `packages/shapes`, `tools/local-runner` (code states, projection audit) | Automated. |
| 5. Prove the bug | Checks that fail on the planted copy and pass on the clean and fixed copies, while the host's original suite still passes | `packages/umami-fixture` (time-zone family), `packages/umami-fixture-rc1` (race family, in progress), `packages/umami-driver` (runs a copy and its checks), `kit/umami`, `kit/umami-race` | Written by hand per family. This is the most expensive step: a race family needs a concurrency driver, seeded state and timing control. The time-zone family runs end to end. The race family is in progress: its checks exist, but its planted outcome is not yet reproducible enough for admission until a proxy delay is chosen, and the schema, driver and admission still need to accept it (see its README's admission status). |
| 6. Write and check | Observe the symptom, write the card and the issue, check the issue's numbers and novelty | `packages/writer`, `packages/search`, `tools/controller` (candidate attempt) | Automated. |
| 7. Admit and release | 13 sandboxed copies with fixed expectations, a human alignment check of the issue, then a release with a frozen judge job | `packages/admission`, `tools/controller`, `tools/release`, `packages/publisher` | Automated, apart from the human alignment check. |
| 8. Replay | A judge replays the released case on fresh copies | `packages/web` (judge routes), `tools/controller` (judge replay) | Automated. |

## What a new bug class costs

Today the pipeline is wired end to end for one family, the time-zone family: the local runner's inputs default to its probes, alternative fix and fixture, the candidate attempt's symptom builder (`tools/controller/src/symptom.ts`) accepts only its day-count mismatch, and the release's judge-job construction (`tools/release/src/judge-job.ts`) loads its fixture, probes and alternative fix (the judge replay then runs that frozen job). The steps are written as separate packages, but running a second class through them needs family selection in each of those places. Planned work for that:

- **Per class, once:** harvest queries (step 1), a shape rule (step 2), checks with whatever driver the class needs (step 5), a symptom shape the writer can use (step 6), and an entry for the family, its source fix and mutation in `packages/schema/registry/families.json`, without which the release build refuses the case as unregistered (step 7).
- **Family selection:** the local runner (probes, alternative fix, fixture), the controller (fixture staging, symptom, kit image) and the release's judge-job construction need to take the family as an input instead of assuming the time-zone family.
- **Classes without partial and stub probes** (such as the race family) also need the code-state derivation (`tools/local-runner/src/code-states.ts`, which loads all three probes today) and the admission profile to accept a mutation-only probe set.

Once a class is wired, another site of the same class in the same host can reuse its driver, kit changes and seeding, so it should cost much less than the first.

## The static-headroom screen

A planted bug used to compare debugging tools (for example, a solver with and without the app's server logs) must not be findable from the planted source alone; otherwise both arms solve it by reading and the tool cannot make a difference. The screen records are in `docs/uc1-screen/`. Both current families fail it: the time-zone mutation leaves the destructured `timezone` unused while a sibling query in the same file still passes it, and the backup-code race mutation leaves a guard that can no longer trigger and a matching filter 15 lines above it. They remain valid factory cases.

A planted change often leaves such traces, because the surrounding code still reflects what the removed line was for: a variable that is now unused, a sibling that still does it right, or a check that can no longer fire. That is why the screen is applied to each candidate rather than assumed.

## Planned

- **Class-level rules.** Shape rules that match a class (for example, a read, an await and an unguarded write of the same record) rather than one chosen site, so step 3 lists every candidate site in the host.
- **An automated static screen.** A small, bounded model probe per planted candidate that tries to locate the bug from the source alone, so candidates can be screened before checks are written for them.
- **A candidate pipeline.** Enumerate sites, plant each, screen each, and rank the survivors, so step 5 is spent only on candidates worth building checks for.
