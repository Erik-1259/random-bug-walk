# @rbw/admission

The trial-result importer and the admission outcome decisions. It reads one job's record set (the job request, its expected-trial manifest, and each trial's result, observations and artifacts), checks it in a fixed order, writes the evidence it accepted, and only then derives decisions from that evidence. For an admission job it gives a decision for each of ADM-02 to ADM-06, the six-cell original-suite comparison (ADM-08) and one `outcome_verdict`.

No HTTP callback, process exit code, log text or absent artifact becomes evidence or a decision. A `complete` trial result from the driver is evidence that a trial ran, not a verdict, and `outcome_verdict` is not an admission.

Every record is read with `parseRecord` from `@rbw/schema` (strict canonical parse, schema, code rules), with `{ request }` as context for records that carry request-identity fields, and its bytes must equal its canonical encoding. The package holds no second parser, schema or encoder.

```
node packages/admission/src/cli.ts import --records <dir> --out <dir>
```

## Record-set layout

One directory per job. Every key is resolved against the directory root; a key that is absolute, has an empty, `.` or `..` segment, or resolves outside the root (including through a symlink) is refused before it is read.

| Path | Content |
|---|---|
| `request.json` | The `JobRequest` |
| the request's `expected_trials_key` | The `ExpectedTrials` manifest |
| `results/<trial_id>/trial-result.json` | One `TrialResult` per trial |
| each result's `observations_key` | Its `TrialObservations` |
| each result's `artifacts_key` | Its `ArtifactManifest` |
| each `ArtifactEntry.key` | The artifact's bytes, including check responses and the original-suite outcomes |

An entry under `results/` whose name is not a trial in the manifest is refused at the identity stage.

## Original-suite outcomes

The shared schema has no record for per-test original-suite outcomes yet, so `src/original-suite.ts` reads them in this local format; it is the only module that changes if the driver's format differs.

- An `ArtifactManifest` entry with `kind` `original_suite_outcomes` and `media_type` `application/json`.
- Canonical JSON: `{ "schema_version": 1, "trial_id", "original_suite_sha256", "tests": [{ "test_id", "outcome" }] }`, where `outcome` is `passed`, `failed` or `skipped`, and `tests` are sorted by `test_id` in code point order and unique. Unknown fields are refused.
- Its `original_suite_sha256` equals the expected trial's, and its `trial_id` equals the result's.
- A trial with no original suite (`observe`) has no such entry; an entry there is an identity error.

## Import order

Request-level checks come first. Any failure here refuses the whole import with an error code: no evidence, no decision, CLI exit 1.

| Code | Cause |
|---|---|
| `import:request_missing` | No records directory or no `request.json` |
| `import:request_invalid` | `request.json` fails `parseRecord` or is not canonical bytes (an absolute or `..` `expected_trials_key` fails the schema here) |
| `import:key_unsafe` | A key resolves outside the root, for example through a symlink |
| `import:expected_trials_missing` | No file at `expected_trials_key` |
| `import:expected_trials_hash` | The manifest's SHA-256 is not the request's `expected_trials_sha256` |
| `import:expected_trials_invalid` | The manifest fails `parseRecord` against the request (for example it does not follow the kind's trial profile), or is not canonical bytes |

The importer accepts any `JobKind`. Then each expected trial goes through five stages, in order. The first stage that fails sets the trial's status, reason and code, and later stages do not run for that trial. `stage` in the evidence names the stage where the trial stopped (`outcomes` for a trial that ran all five).

| Stage | Code | Status | Reason | Cause |
|---|---|---|---|---|
| shape | `import:shape_result` | `invalid` | | The result fails `parseRecord` or is not canonical bytes |
| shape | `import:shape_observations` | `invalid` | | The observations record fails the same |
| shape | `import:shape_artifacts` | `invalid` | | The artifact manifest fails the same |
| shape | `import:shape_original_suite` | `invalid` | | The outcomes file fails its format, or its media type is wrong |
| shape | `import:key_unsafe` | `invalid` | | A result, observations, manifest or outcomes key resolves outside the root |
| identity | `import:identity_request` | `invalid` | | The result's policy hash, root, execution, task revision or manifest hash differs from the request's |
| identity | `import:identity_trial_id` | `invalid` | | The result's `trial_id` is not its directory's trial |
| identity | `import:identity_code_state` | `invalid` | | The result's `code_state` differs from the manifest's |
| identity | `import:identity_observations` | `invalid` | | The observations' execution or trial differs |
| identity | `import:identity_artifacts` | `invalid` | | The artifact manifest's identity fields or trial differ |
| identity | `import:identity_original_suite` | `invalid` | | The outcomes' trial or suite hash differs, more than one outcomes entry, or one for a trial without an original suite |
| identity | `import:identity_unexpected_trial` | `invalid` | | An entry under `results/` for a trial the manifest does not list (in `unexpected_results`) |
| driver | `import:driver_status` | the driver's | the driver's | The driver marked the result `invalid` or `incomplete` |
| completeness | `import:result_missing` | `incomplete` | `artifact_missing` | No result for an expected trial |
| completeness | `import:test_unexpected` | `invalid` | | An outcomes test that is not expected |
| completeness | `import:check_unexpected` | `invalid` | | An observation for a check that is not expected |
| completeness | `import:repeat_unexpected` | `invalid` | | A `repeat_index` above the trial's repeat count |
| completeness | `import:test_missing` | `incomplete` | `test_missing` | An expected test is absent, or there is no outcomes entry |
| completeness | `import:check_missing` | `incomplete` | `test_missing` | A check or a repetition from 1 to the repeat count is absent |
| completeness | `import:test_skipped` | `incomplete` | `test_skipped` | An expected test was skipped |
| provenance | `import:observations_missing`, `import:artifacts_missing`, `import:artifact_missing` | `incomplete` | `artifact_missing` | A referenced file is absent |
| provenance | `import:response_unlisted` | `incomplete` | `artifact_missing` | A response key the artifact manifest does not list |
| provenance | `import:observations_hash_mismatch`, `import:artifacts_hash_mismatch`, `import:artifact_hash_mismatch`, `import:response_hash_mismatch` | `incomplete` | `artifact_hash_mismatch` | Bytes do not match the declared hash or size, or a response hash differs from its manifest entry |
| provenance | `import:key_unsafe` | `invalid` | | An artifact key resolves outside the root |
| outcomes | `import:outcome_setup_fail` | `invalid` | the observation's code | A `setup_fail` observation |
| outcomes | `import:outcome_unrelated_code` | `invalid` | `unrelated_failure` | An expected assertion failure with another failure code |
| outcomes | `import:outcome_not_run` | `incomplete` | the observation's code | A `skipped` or `not_run` observation |

Within a stage, `invalid` findings come before `incomplete` ones, and a missing item before a skipped one. Every finding of the stopping stage is kept in `findings`.

The driver's status is never upgraded. A result the driver marked `invalid` or `incomplete` passes shape and identity on the result alone, keeps its status and `invalid_reason`, and its observations are kept only as `diagnostics` (when they parse and belong to the trial). A `complete` result is re-checked through all five stages and can be downgraded. A placeholder hash, such as 64 `a`s, passes provenance only when bytes with that hash are present.

### Added-check classification

| Expected | Observed | Classification |
|---|---|---|
| `pass` | `pass` | `positive` |
| `pass` | `assertion_fail` (any code) | `reject`, never an infrastructure failure |
| `assertion_fail` X | `assertion_fail` X | `negative_control` |
| `assertion_fail` X | `assertion_fail` Y ≠ X | `invalid` (`unrelated_failure`) |
| `assertion_fail` | `pass` | `reject` |
| any | `setup_fail` | `invalid`, with the observation's code |
| any | `skipped`, `not_run` | `incomplete`, with the observation's code |

A trial's added-check verdict combines its observations: any `reject`, else any `invalid`, else any `incomplete`, else `match`. A rejecting trial stays `complete`: it ran fully and holds a valid rejection. Every repetition's classification is kept. Every expected original test that executed is `passed` or `failed`; a `failed` test is valid evidence on every code state.

## Decisions (admission jobs)

`decide(evidence)` is a pure function of the evidence. Each rule decision is `pass`, `reject`, `invalid` or `incomplete` and lists the trials behind it, with the basis (`trial_status`, `execution`, `added_checks`, `original_suite` or `unexpected_result`), status, reason and code.

| Rule | Reads | Decision |
|---|---|---|
| ADM-02 | all 13 trials | `invalid` or `incomplete` when a trial fails stages 1–4 or the driver failed it, an observation is `setup_fail`, `skipped` or `not_run`, or `results/` holds an unexpected trial; otherwise `pass` |
| ADM-03 | added checks of `fixed-01`…`fixed-05`; original suite of `clean-01` and the fixed copies | `reject` on a valid added-check or original-test failure; otherwise the status of a broken trial; otherwise `pass` |
| ADM-04 | added checks of `planted-01`…`planted-05` | `reject` on a valid mismatch (unexpected pass, failing control); otherwise the status of a broken trial (an unrelated code or setup failure is `invalid`); otherwise `pass` |
| ADM-05 | added checks of `fixed-01` and `planted-01`, all 20 repetitions | `reject` on one valid inconsistent repetition; `incomplete` for a missing repetition |
| ADM-06 | added checks of `partial-01` and `stub-01` | `reject` on a valid mismatch with the probe's own vector; a probe trial that is `invalid` or `incomplete` is a broken required probe and leaves the rule `incomplete` |

A trial counts as broken for a rule when it is not `complete` and the rule reads its added checks, or it stopped before the outcomes stage. So a setup failure in `clean-01`'s added checks does not affect ADM-03, which reads only its original suite.

`outcome_verdict`: any `reject` among ADM-02 to ADM-06 gives `reject` (a valid rejection is conclusive); otherwise any `invalid` gives `invalid`; otherwise any `incomplete` gives `incomplete`; otherwise `pass`. The ADM-08 classification is reported next to it and does not enter it. ADM-01, ADM-07, ADM-09 and ADM-10 are decided elsewhere and are listed in `not_evaluated_here`.

For other job kinds, `decisions`, `comparison` and `outcome_verdict` are `null`.

### The six cells and the comparison (ADM-08)

The cells are computed whenever the manifest has `clean-01`, `planted-01` and `fixed-01` (admission and `judge_verify`): for each, one original-suite cell and one added-checks cell, in that order. Every cell starts `not_run` (`initialCells`) and then holds the observed matrix: `state` (`not_run`, `pass`, `fail`, `invalid`, `incomplete`), `matches_expectation`, `suite_sha256`, expected and executed IDs and counts, `failing` (test IDs, or each failing check with its repetition and code) and `artifact_keys`. A cell whose suite was never classified takes the trial's status. The expectations: the original suite passes in all three; the added checks pass on clean and fixed, and on planted fail only at the declared assertions with the control passing. The added-checks cells of `planted-01` and `fixed-01` cover all 20 repetitions.

The comparison, for admission jobs, first match wins:

1. any of the 13 trials `invalid` → `invalid`; otherwise any `incomplete` → `incomplete`;
2. any original-test failure, or added checks not matching, on a clean or fixed copy → `not_demonstrated`;
3. any original-test failure on any planted copy → `caught_by_original_suite`, even when `planted-01` was missed;
4. any planted or probe copy not matching its declared vector, or any original-test failure on a probe copy → `not_demonstrated`;
5. otherwise → `blind_spot_demonstrated`.

Rules 2 and 4's handling of probe-copy suite failures, and the `outcome_verdict` precedence above, are decisions of the work item that added this package.

## Outputs

`importRecordSet(dir)` returns the `Evidence`, or throws `ImportRefusal` with a request-level code. The CLI removes any `evidence.json`, `evidence.sha256` and `decision.json` left in `--out`, then writes `evidence.json` (canonical JSON) and `evidence.sha256` (its SHA-256 and a newline), and only after both are written derives and writes `decision.json` (canonical JSON), whose `evidence_sha256` is the SHA-256 of the `evidence.json` bytes. If writing the evidence fails, no decision is written. It prints a summary of the decisions.

| Exit | Meaning |
|---|---|
| 0 | A decision was written, whatever it is |
| 1 | The request-level checks refused the import; nothing is written |
| 2 | Usage error |
| 3 | No decision was written: an output could not be written, or an internal error |

The decision never comes from the exit code. `src/output.ts` defines both output shapes; `evidenceErrors` and `decisionErrors` check a value against them.

`evidence.json`: `schema_version`, `request` (kind, execution, root, policy hash, task revision, manifest key and hash), `trials` (manifest order; each with status, stage, reason, code, findings, the driver's status and reason, record keys, listed artifact keys, `added` with the verdict and every observation's classification, `original` with every executed test and the failed IDs, and `diagnostics`), `unexpected_results` and `cells`.

`decision.json`: `schema_version`, `evidence_sha256`, `kind`, `execution_id`, `decisions` (`ADM-02` to `ADM-06`), `comparison` (classification and trials), `outcome_verdict` and `not_evaluated_here`.

## Tests

```
pnpm --filter @rbw/admission test
RBW_ADMISSION_RECORDS_DIR=<dir> pnpm --filter @rbw/admission test
```

`test/support/record-set.ts` writes synthetic record sets (13-trial admission, `kit_check` and `judge_verify`) from `buildJobRequest` and `buildExpectedTrials`, and each test case is a mutator over that baseline. `test/real-records.test.ts` imports the directory in `RBW_ADMISSION_RECORDS_DIR` and prints its decisions; it is skipped when the variable is unset and asserts no particular verdict.
