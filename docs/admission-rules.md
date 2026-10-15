# Admission rules

These rules define how the first admission profile admits a candidate. They describe what each rule requires. A rule's status records whether `main` holds a marked implementation and test for it (see [Status](#status) and [Tracing a rule ID](#tracing-a-rule-id)); it does not by itself claim that every part of the rule is enforced. [Coverage notes](#coverage-notes) says where an implemented rule is covered only in part.

The first profile admits a candidate using **13 fresh app copies**: 1 clean, 5 fixed, 5 planted, 1 partial-fix and 1 stub-fix. Kit setup checks and the preliminary observation are separate operations and count as no admission evidence.

A family may record ADM-06 as not applicable, with its reason, when a partial or stub fix of its bug has no natural form. The race family (shape RC-1.atomic-backup-code) does: its fix is one guard, present or absent. Such a family is admitted on **11 fresh app copies**, the same profile without the partial-fix and stub-fix copies; ADM-02 to ADM-05 and ADM-08 apply to those 11 copies as their rows state for such a family, and the admission decision records ADM-06 as `not_applicable`. The family's probe set carries the record, and the runner builds the 11-copy profile only from a probe set that has it, so the time-zone family keeps all 13 copies.

## Stability

Rule IDs never change meaning. A retired rule keeps its ID and is marked `retired`, and its number is never reused. A new rule takes the next unused number.

## Status

`Status` is exactly one of:

- `planned`: the rule is published, and nothing on `main` implements it yet.
- `implemented`: the rule has an implementation and a test, each marked as described below.
- `retired`: the rule no longer applies. Its ID stays in the table.

The pull request that adds an implementation and its tests changes the rule's status to `implemented`.

## Rules

| ID | Status | Rule | Required work | Decision |
|---|---|---|---|---|
| ADM-01 | implemented | Scope and setup | Pinned source, host and image; a source-only permitted change; no git history or answer-bearing artifacts in the solver-visible copy; the selected grader permissions in force | A copy with invalid scope or setup cannot be admitted |
| ADM-02 | implemented | Fresh copies and executions | Exactly one clean, five fixed and five planted fresh copies, plus the two probe copies in ADM-06. The original test suite runs once in each of the 13 copies, partial and stub included. A family that records ADM-06 as not applicable has no probe copies: it uses exactly the 11 other copies, and the original suite runs once in each of those 11; the added checks run once in each, except for the repetitions in ADM-05. Every expected test must execute | A copy where an expected test did not execute is invalid |
| ADM-03 | implemented | Fixed copies pass | All five fixed copies pass the added checks; the clean and fixed original-suite results pass | A valid failed check rejects the candidate; missing, skipped or uncollected checks are invalid |
| ADM-04 | implemented | Planted copies fail as declared | All five planted copies fail the declared added assertions | An unexpected pass rejects the candidate; unrelated errors are invalid and are not evidence of the bug |
| ADM-05 | implemented | Stability | In the first fixed copy and the first planted copy, each added check runs exactly 20 times, with the fixture data reset each time | Fixed: 20 of 20 pass. Planted: all 20 repetitions match the declared outcome vector (the control check passes and every declared assertion fails). These 20 replace the single execution in those two copies; they do not multiply the original-suite runs |
| ADM-06 | implemented | Negative probes | One partial-fix copy and one stub-fix copy, using the profile's predeclared probe patches | Both build and start, execute every declared test, and match their predeclared outcome vectors. The first profile has no automatic regeneration or retry |
| ADM-07 | implemented | Card, issue and leak checks | A schema-valid pattern card; a symptom-only issue; a deterministic leak and scope scan; a human alignment check on the first case, recorded as the release's approval of the issue's SHA-256; three bounded exact-phrase searches | A phrase match, or an unresolved leak or alignment issue, prevents release. A search error is incomplete evidence, never "no public match" |
| ADM-08 | implemented | Original-suite comparison | The six cells (original suite and added checks, on clean, planted and fixed) come from the first clean, planted and fixed copies; other repetitions are kept as supporting evidence | The blind spot is shown only when the original suite passes in all 13 copies, including all five planted copies and both probe copies, and the added checks pass on clean and fixed and match the declared negative vectors on planted and probe copies. For a family that records ADM-06 as not applicable, the same holds over its 11 copies, with no probe copies to pass or match. Otherwise the result is "caught by the original suite", "not demonstrated", or invalid/incomplete |
| ADM-09 | implemented | Release | The final mutation-family split, the current revision, required reviews resolved, and an immutable release manifest | The same eligibility rule applies to reports and bundles. An uncalibrated profile supports no calibrated claims |
| ADM-10 | planned | Regrade for reported solves | A protected, passing regrade on a fresh copy for every solve that is ever reported | Required whenever calibration is enabled. The first profile records calibration as `not_requested`, with no solve denominator |

## Coverage notes

- ADM-01: the projection audit (`packages/projection`) checks that a copy holds the pinned source, minus approved whole-file exclusions, plus one source-only declared change, with a neutral single-commit history and no build output or answer-bearing artifacts. The local runner (`tools/local-runner`) runs the audit on every copy before the copy is built, in every job, including each admission copy (13, or 11 for a family that records ADM-06 as not applicable); the controller runs copies through the same path. A refused or unavailable audit stops the copy. A clean or fixed copy has no declared change, so its audit is recorded as `not_applicable`. Each copy runs from the kit image by its content digest. The admission importer (`packages/admission`) does not decide ADM-01 and lists it as not evaluated.
- ADM-06: for a family that records it as not applicable, the probe set's `adm_06` entry holds the reason, the admission job's expected trials follow the 11-copy profile, and `packages/admission` reports ADM-06 as `not_applicable` with no trials. A 13-copy job with a missing or broken probe stays `incomplete`.
- ADM-10: no solve is reported, because the first profile records calibration as `not_requested`.

## General rules

- An expected failure means the assertion ran and produced the specified behavioral mismatch, not merely that the test runner exited non-zero.
- Positive and negative runs collect every expected execution and never stop at the first failure.
- A valid unexpected outcome rejects the relevant claim. A missing execution or a setup failure is invalid or incomplete.
- A later planted copy caught by the original suite also prevents release of the blind-spot claim, even if the first planted copy was missed.
- A broken required probe leaves admission incomplete. Fixing it creates a new revision and a separately bounded request; nothing relaunches until it passes.
- Model-generated near-miss fixes, alternative-correct-fix samples, extra issue-style studies and adaptive calibration are off in the first profile. A later profile must declare its extra trials and cost envelope before it runs.

## Tracing a rule ID

`node scripts/checks/admission-ids.ts` lists every ID in the table with its markers. It exits 1 when a rule marked `implemented` has no implementation marker or no test marker, when a marker names an ID that is not in the table, or when a `retired` rule still has a test marker. A `planned` rule without markers is listed and does not fail. CI runs the check in the `prose` job.

An implementation marker is a comment that contains the ID as a whole token: `ADM-` and two digits, not followed by another digit. It sits in a tracked, non-test source file (`.ts`, `.tsx`, `.js`, `.mjs` or `.py`) under `packages/`, `tools/` or `python/`. A comment is a line where the ID follows `//`, `/*`, a leading `*` or `#`:

```ts
// ADM-04: an unexpected pass rejects the candidate
```

A test marker is one of:

- TypeScript: the ID inside the first string argument of `describe`, `it` or `test` (`.each` forms included), on the line of the call, for example `it("ADM-04 rejects an unexpected pass", ...)`. The `.skip` and `.todo` forms do not count.
- Python: a test function or class name that contains `adm_NN` or `ADM_NN`, for example `def test_adm_04_rejects_unexpected_pass`.

Test files are `*.test.ts`, `*.test.tsx`, `test_*.py` and `*_test.py`. An ID in a test file's comment or assertion text is not a test marker.

The check does not scan `scripts/checks/`, `docs/`, or untracked and ignored files. It reads the file list from `git ls-files`.

Limits: the check is static, so it cannot tell whether a test runs; the test-count floors cover that. It also cannot tell whether a marked implementation does what the rule says.
