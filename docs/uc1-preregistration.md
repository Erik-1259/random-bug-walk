# UC1 pre-registration: server logs on versus off

This document fixes the UC1 paired comparison before any counted run. UC1 is the use case "test a developer tool on your own app" (spec §2.3). The tool here is read access to the app's server logs, and the comparison is a small illustration (spec §2.4), not an estimate of the tool's effect.

Nothing in this document reports a result. No counted attempt has run when it is committed. The race-case screen record is a separate file written by the race-class work, at `docs/uc1-screen/<case-id>.json`, and this document only states what that record must contain (see "Bug selection"). The time-zone case's screen record is `docs/uc1-screen/umami-tz-arg-001.json`, committed with this document.

## Status and changes

- **Committed:** Oct 13, 2026, before any counted attempt.
- **One amendment window:** after the harness pilot (below) and before the first counted attempt of the main run, the per-attempt caps and the solver model may be changed once, in a committed amendment to this file that states the measured reason. The same amendment, or an earlier one, records the owner's answer on what the spending cap covers (see "Caps"), with its date. Nothing else changes after this commit. Nothing changes after the first counted attempt.
- A change made outside that window is reported as a deviation next to the result, with its date and reason.

## Owner decisions of Oct 13, 2026

1. **Decision change.** The owner authorized the race class and UC1 together on Oct 13. This reverses plan decisions #11 and #12 (UC1 only if the race class is dropped) and #24 (a UC1 demonstration without the race class).
2. **Priority.** UC1 depends on the race class. Without an admitted race case that passes its screen, there is no UC1 run. If the two compete for build lanes, the development slot or supervised hours, the race class wins and UC1 is cut first.
3. **Race family, ADM-06.** The race family records ADM-06 (partial-fix and stub-fix probe states) as not applicable, with the reason stated in the race family's own records. This document does not restate that reason.
4. **RootRun kind.** A new RootRun kind, `paired_comparison`, is approved as an addition to the kinds listed in spec §9.9 (`factory`, `kit_check`, `judge_replay`). Every UC1 attempt, model reservation and grade sits under one such root per bug run.
5. **Spending cap.** **$40** on Nemotron 3 Super, **$75** if the Kimi-K2.7-Code fallback is needed. The decision does not say what the cap covers; this document's reading is stated under "Caps", pending the owner's confirmation.
6. **Fallback to the time-zone case: open until Oct 18, 2026 at noon.** The owner decides at that time whether UC1 falls back to the released time-zone case (`umami-tz-arg-001`) if no race case has been admitted and screened. Until then, nothing is built that assumes either answer. The two branches are pre-registered here so that the decision changes only which branch applies:
   - **No fallback:** if no screened race case exists by Oct 18 at noon, UC1 is not run. The pilot stays development evidence only.
   - **Fallback chosen:** the time-zone case runs under this same protocol, labeled throughout as a **low-headroom contrast**, never as a tool-effect illustration. That case fails the static-headroom screen of spec §8.3 (its mutation leaves the destructured `timezone` unused while the same file's ClickHouse branch still passes it; the binding judgment and its line references are in `docs/uc1-screen/umami-tz-arg-001.json`), so a result on it says nothing about how much logs help on bugs the source does not already reveal. Choosing this branch amends plan decision #32, and the amendment is recorded with the owner's decision.

## Bug selection

- The bug is an admitted race-class case that passes the race class's binding screen record. It is chosen before any solver attempt runs on it and never on solver or tool results (spec §2.3, "What can go wrong").
- The screen record must hold (a) a binding written judgment that the omission is not plain from the pre-fix source alone (spec §8.3) and (b) a check of what the issue text, the observe or writer evidence and the HTTP responses (for example `/api/send` under concurrency, as reachable in the off arm) already reveal, compared with the logs. A case whose issue or responses already carry the Prisma or Postgres error message fails as a log-tool case.
- The screen record is the file `docs/uc1-screen/<case-id>.json`, in the format of `docs/uc1-screen/umami-tz-arg-001.json`: `schema_version` (1), `case_id`, `recorded` (date), `recorded_by`, `target` (upstream, host commit, path, SHA-256 and mutation reference), `static_headroom` (`verdict` of `pass` or `fail`, the written `judgment` and its `reasons`), `leak_screen` (`verdict` of `pass`, `fail` or `not_assessed`, and what the issue text, the observe or writer evidence and the HTTP responses reveal compared with the logs) and `uc1_use`. A race case is eligible only when both verdicts are `pass`.
- A second race bug is added only if one is admitted and screened in time and the supervised windows have room. It follows the same protocol and is reported separately.
- `umami-tz-arg-001` is used only for the harness pilot, unless the fallback branch above is chosen. Its screen record (`docs/uc1-screen/umami-tz-arg-001.json`) fails it on static headroom.

## Design

- **Solver.** One fixed agent: a small TypeScript tool-calling loop on Nemotron 3 Super through Token Factory, with a fixed system prompt, and a fixed temperature and seed per attempt index, shared across arms.
- **Arms.** Off and on. Both arms start from the same solver-visible planted projection, with the same prompt, issue text, caps and tools: `bash` (as the unprivileged app user), `read_file`, `write_file`, `rebuild_restart` and `submit`. The on arm also has `server_logs`, a byte-capped tail with a cursor over the Umami and Postgres stderr logs the kit already captures. `rebuild_restart` returns build output and exit status only; runtime log tails are scrubbed from it in both arms. The tool list is the only difference between the arms.
- **Attempts.** k = 20 per arm per bug, 40 in total.
- **Independence.** The two arms are independent samples. A shared seed does not pair attempts, because the tool list changes the prompt. Pairing exists only at the bug level.
- **Order.** Attempt indexes 1 to 40 follow ABBA blocks (off, on, on, off, repeated ten times), fixed in advance. Order is by index, never by finish time. Up to 3 sessions run at once on local Docker.
- **Grading (R1, spec §8.3).** Each attempt's extracted fix is graded twice: grade 1 is a local Docker `judge_verify` run on a fresh copy, and grade 2 is a protected fresh-copy regrade on Vercel Sandbox. Grade 2 is authoritative. Both grades are charged to the development pool and slot, never the judge allocation. Every disagreement between the grades is published.
- **Pilot (excluded from all results).** 2 off and 2 on attempts on `umami-tz-arg-001`, plus seeded grade round trips with no model. The pilot checks the harness, the tool calling and the cost per attempt. It is published only as "harness pilot; bug fails the static-headroom screen; not a UC1 result".

## Hypothesis

With read access to server logs, the fixed agent solves the race bug more often, and uses fewer tokens and fewer model turns per attempt. All tests are two-sided, so a tool that makes the agent worse is detected the same way as one that helps.

## Smallest differences worth reporting

- **Solve rate:** 25 percentage points, on minus off.
- **Tokens per attempt:** a 25% reduction in the median.
- **Turns per attempt:** no separate threshold; the difference is reported with its interval.

These are the differences that would matter to a tool builder. At k = 20 per arm they are smaller than what the comparison can reliably detect (next section), so a true difference of this size would most likely be reported as inconclusive. That is the reason the result is called an illustration.

## Detectable difference (calculated)

The tables below are calculated, not measured. `docs/uc1-preregistration/power.py` generates the block between the markers, and `--check` confirms that the block here matches. The repository's test suite runs `--check` on every change, including a change to this file alone (`scripts/checks/test/uc1-preregistration.test.ts`). The solve table is exact: it enumerates all 21 × 21 outcome tables, finds the Fisher rejection region with exact rational arithmetic, and sums binomial probabilities over it. The token and turn table is a seeded simulation, labeled as such. The alpha 0.0167 columns are alpha/3 = 0.05/3, the first step of Holm's procedure across the 3 co-primary outcomes.

<!-- BEGIN GENERATED: docs/uc1-preregistration/power.py -->

Solve outcome: smallest detectable difference in percentage points at 80% power, k = 20 per arm, two-sided Fisher exact test, by exact enumeration. Each cell is `difference (power at that difference)`. "Increase" means the on arm solves more often than the off arm; "decrease" means it solves less often. `none` means no difference within 0-100% reaches the power. "Size" is the actual false-positive rate when both arms share the base rate (Fisher is conservative at this size).

| Off-arm base rate | Increase, alpha 0.05 | Increase, alpha 0.0167 | Decrease, alpha 0.05 | Decrease, alpha 0.0167 | Size, alpha 0.05 | Size, alpha 0.0167 |
|---|---|---|---|---|---|---|
| 0% | 32 (0.817) | 42 (0.804) | none | none | 0.0000 | 0.0000 |
| 5% | 40 (0.818) | 48 (0.812) | none | none | 0.0019 | 0.0000 |
| 10% | 43 (0.803) | 51 (0.804) | none | none | 0.0118 | 0.0006 |
| 15% | 46 (0.815) | 53 (0.804) | none | none | 0.0199 | 0.0022 |
| 20% | 48 (0.813) | 54 (0.811) | none | none | 0.0226 | 0.0039 |
| 25% | 49 (0.815) | 54 (0.811) | none | none | 0.0235 | 0.0053 |
| 30% | 48 (0.803) | 54 (0.820) | none | none | 0.0248 | 0.0060 |
| 35% | 47 (0.808) | 53 (0.822) | 34 (0.822) | none | 0.0252 | 0.0062 |
| 40% | 46 (0.823) | 51 (0.815) | 37 (0.813) | none | 0.0238 | 0.0063 |
| 45% | 44 (0.813) | 49 (0.817) | 40 (0.818) | 44 (0.815) | 0.0215 | 0.0065 |
| 50% | 42 (0.806) | 47 (0.827) | 42 (0.806) | 47 (0.827) | 0.0204 | 0.0066 |
| 55% | 40 (0.818) | 44 (0.815) | 44 (0.813) | 49 (0.817) | 0.0215 | 0.0065 |
| 60% | 37 (0.813) | none | 46 (0.823) | 51 (0.815) | 0.0238 | 0.0063 |
| 65% | 34 (0.822) | none | 47 (0.808) | 53 (0.822) | 0.0252 | 0.0062 |
| 70% | none | none | 48 (0.803) | 54 (0.820) | 0.0248 | 0.0060 |
| 75% | none | none | 49 (0.815) | 54 (0.811) | 0.0235 | 0.0053 |
| 80% | none | none | 48 (0.813) | 54 (0.811) | 0.0226 | 0.0039 |
| 85% | none | none | 46 (0.815) | 53 (0.804) | 0.0199 | 0.0022 |
| 90% | none | none | 43 (0.803) | 51 (0.804) | 0.0118 | 0.0006 |
| 95% | none | none | 40 (0.818) | 48 (0.812) | 0.0019 | 0.0000 |
| 100% | none | none | 32 (0.817) | 42 (0.804) | 0.0000 | 0.0000 |

Tokens and turns: smallest normal location shift (SD units, step 0.05) detected with at least 80% power by the two-sided exact Mann-Whitney test, k = 20 per arm, no ties. Monte Carlo, 20000 replicates, seed 20261013 (standard error about 0.003 near 0.80).

| Alpha | Mann-Whitney critical U | Detectable shift (SD) | Simulated power |
|---|---|---|---|
| 0.05 | 127 | 0.95 | 0.810 |
| 0.0167 | 111 | 1.15 | 0.837 |

<!-- END GENERATED -->

How to read it:

- A difference counts as detectable when the power is at least 80% at that difference and at every larger feasible difference in the same direction. Differences are whole percentage points.
- The result page quotes the row for the observed off-arm rate, rounded to the nearest 5 points.
- Near the expected range (off-arm rate 0–25%), only an increase of about 32–49 points is detectable at alpha 0.05, and 42–54 points at Holm's first step. The pre-registered 25-point difference is well below that.
- These numbers replace the rounded estimates in the design notes (35/45 at 0%, 45/55 at 10%, 50/55 at 25%, 45/50 at 50%). The calculated values are 32/42, 43/51, 49/54 and 42/47.
- **Tokens.** Mann-Whitney uses ranks, so the shift applies equally to log tokens. Under a lognormal model, a 25% median reduction is a shift of ln(4/3) ≈ 0.29 in log tokens. It is detectable at alpha 0.05 only if the standard deviation of log tokens per attempt is about 0.30 or less (0.29 / 0.95). That standard deviation is unknown until the pilot measures it, so this is a prediction, not a measurement.
- **Ties.** The table assumes no ties. Turns are whole numbers from 1 to 50 over 40 attempts, so turns will be tied, and capped attempts share the cap values of both outcomes. The test that is run handles ties (see "Outcomes"), but the table is optimistic for turns, and for tokens if attempts hit a cap.

## Outcomes

Three co-primary outcomes, with Holm's procedure across the three at a family alpha of 0.05:

1. **Solve**, from grade 2. An attempt is solved only when grade 2 is complete, its added-check verdict matches the fixed outcome, and the original suite has no failure. A missing, invalid, refused or tampered grade counts as unsolved, never as solved. Test: two-sided Fisher exact test, off versus on.
2. **Tokens per attempt:** total input plus output tokens over all model calls in the attempt. Test: two-sided Mann-Whitney (below). Estimate: the Hodges–Lehmann shift on natural-log tokens, on minus off, reported as the ratio exp(shift) with its 95% interval (the exponentiated interval endpoints). A ratio of 0.75 is the 25% reduction named above, so the interval can be read against that threshold directly.
3. **Turns per attempt:** the number of model calls in the attempt. Test: two-sided Mann-Whitney (below). Estimate: the Hodges–Lehmann shift on raw turns, on minus off, in turns, with its 95% interval. Turns have no threshold, so no relative scale is used.

**Mann-Whitney procedure, for both outcomes.** The statistic is the sum of the on arm's ranks over all 40 counted attempts, with midranks for tied values. The p-value comes from the exact permutation distribution of that sum conditional on the observed values, ties included: every one of the C(40, 20) ways to split the 40 values into two arms of 20, counted by dynamic programming over doubled midranks. Two-sided p is the probability of a rank sum at least as far from its null mean as the observed one. Without ties this is the exact test in the table above. The rank test is the same on raw and log tokens, so the scale of the estimate does not change the p-value. The 95% interval for the Hodges–Lehmann shift runs from the 128th to the 273rd of the 400 ordered pairwise differences (on minus off), from the no-ties critical value 127 at 0.05. With ties its coverage is approximate, and the result says so next to it. If infrastructure exclusions leave arms of unequal size, the same procedure runs on the actual sizes, and the interval uses the no-ties critical value for those sizes.

Every counted attempt enters all three outcomes; the futility rule (under "Stop and futility rules") changes only how the solve outcome is tested, not which attempts are graded or counted. An attempt that hits a cap is counted, with its capped token and turn values recorded as they are and its solve status from its grade (unsolved if it submitted nothing). An infrastructure error that survives its reruns is excluded from all three and reported (below).

Also reported per arm, without tests: the solve count with a 95% Clopper–Pearson interval, the grade-1 result for every attempt, tool-call counts by tool, the contamination flag, out_of_scope and prohibited-edit counts (spec §8.3, R5), wall time, spend, and the infrastructure errors and reruns.

## Caps

Per attempt (revisable once, in the amendment window, from pilot measurements):

- 50 model turns;
- 1.5 million input tokens;
- 40 minutes of wall time;
- at most 8 `rebuild_restart` calls. Cold builds take most of the wall time.

Per run:

- The total UC1 spend cap is $40 on Nemotron 3 Super, or $75 if the Kimi-K2.7-Code fallback is adopted after the pilot (owner decision 5). Spend is reserved and settled per model call under the bug run's root.
- **What the cap covers (this document's reading, pending the owner's confirmation).** Model calls, Sandbox regrades and reruns, including the pilot. The owner decision of Oct 13 does not state this. Until the owner confirms it, the run is held to this reading, which is the stricter one. If the owner states a different scope, the answer and its date are recorded in an amendment before the first counted attempt (see "Status and changes").

## Model

Nemotron 3 Super, frozen after the pilot. Kimi-K2.7-Code is used only if the pilot shows Super's tool calling broken over Token Factory: it then gets 2 pilot attempts, and the model is frozen. No model switch happens after the first counted attempt. Every call is tagged with its model ID, endpoint and date (spec §8.3, R8).

## Reruns and infrastructure errors

- An infrastructure error is a failure outside the agent's control: the container fails to start, the kit build tooling fails on unchanged code, or the model endpoint fails or times out. A build that fails because of the agent's edit is not an infrastructure error.
- An attempt that hits an infrastructure error is rerun from scratch at the same index, up to 2 times. After that, it counts as an infrastructure error: excluded from the outcomes and reported with its cause.
- Infrastructure errors are always reported apart from failures (R8). A grade that fails for infrastructure reasons is retried as a grade only; the attempt is not rerun.
- No other reason permits a rerun.

## Checks

- **Tool use.** The share of on-arm attempts that call `server_logs` at least once, with the call counts. A low share is reported next to the result, since an unused tool cannot help.
- **Contamination.** In either arm, attempts that start their own server process or read Umami or Postgres process output other than through `server_logs`, detected from the bash transcripts. Reported per arm. It cannot be blocked cheaply (the app user can read the env files and the app tree), so it is counted, and a high off-arm rate weakens the claim.
- **Scope.** A fix that changes anything except the target file is out_of_scope: unsolved and not graded. Counted per arm.
- **Leak screen.** The bug's screen record (race-class work) must already show that the issue text and HTTP responses do not carry the log evidence.

## Stop and futility rules

- **Futility.** After the first 6 counted attempts in each arm (by index), if both arms are 0/6 or both are 6/6, the solve test stops: Fisher's test is not run, and its slot in Holm's procedure is fixed at p = 1, so the token and turn tests keep the same three-outcome thresholds. The remaining attempts still run and are still graded. The solve outcome is then reported over all counted attempts in each arm (denominator 20, or the actual arm size after infrastructure exclusions) as counts with Clopper–Pearson intervals, labeled a floor or a ceiling with the 6-attempt check that triggered the rule. This rule only stops; it never declares an effect, so it does not raise the false-positive rate.
- **Spend.** If spend passes the cap (owner decision 5, with the coverage under "Caps"), or the ledger shows any uncertainty, the run stops and the ledger is reconciled before anything else happens.
- **Schedule.** If the harness is not merged, or the pilot fails, by the end of Oct 15, UC1 is dropped and the pilot stays development evidence. If no screened race case exists by Oct 18 at noon, the fallback decision (owner decision 6) applies.
- **Tool calling.** If tool calling is broken on both Super and the single fallback, UC1 is dropped.
- **Conflicts.** Any conflict with race-class lanes, the development slot or supervised hours cuts UC1 (owner decision 2).
- A stopped run is still published, with the reason it stopped.

## Claim wording

- The headline is "Illustration on N bug(s), k = 20 per arm", followed by the detectable difference from the table for the observed off-arm rate.
- Results are reported per bug only. There is no pooled or clustered claim with fewer than 3 bugs, and pairing is at the bug level only.
- Each bug gets a "made worse" statement: the off-minus-on solve rate, and the token ratio (on over off, from the Hodges–Lehmann shift on log tokens) with its interval. It says plainly whether the tool made this bug worse.
- A non-detection is reported only as "inconclusive at this sample size", never as "no effect".
- The result is never presented as an estimate of the tool's effect. About 30 bugs would be needed for a 15-point detectable difference (spec §2.3), there is no held-out split, and no tool-off calibration exists.
- On the fallback branch, every mention reads "low-headroom contrast" and states that the bug fails the static-headroom screen.
- Every number on the result page traces to committed run records published under the `paired_comparison` root (spec §9.9).

## Reproducing the tables

From the repository root, with Python 3.12 (the repository's dev image provides it through `uv`):

```sh
uv run --no-project --python 3.12 python docs/uc1-preregistration/power.py          # print the block
uv run --no-project --python 3.12 python docs/uc1-preregistration/power.py --check  # compare with this file
```

The script checks itself against reference values before printing: Fisher's tea-tasting p of 34/70, the exact p for 0/20 versus 6/20, and the published Mann-Whitney critical values for 20 and 20 (127 at 0.05 and 105 at 0.01, two-sided). It uses only the Python standard library.
