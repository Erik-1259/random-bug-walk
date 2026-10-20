# @rbw/host-umami

The Umami host adapter of the bug factory: it makes Umami a factory host through the shared `HostAdapter` interface of `@rbw/factory-contract`, without changing anything the existing Umami demo, release or judge replay depends on. It wraps the existing pieces (the kit image, the protected driver and its copy script, the fixture, the probe set and `@rbw/admission`) and edits none of them. This is part of a hackathon prototype, and the planted bug is synthetic.

## Entries

| Import | What it holds |
|---|---|
| `@rbw/host-umami` | The adapter (`createUmamiAdapter`), its pins, catalog, protocol, calendar window, package inputs, copy plans, copy-result reading, interpretation and the released-case mapping. It loads no Docker, local-runner (beyond `@rbw/local-runner/shared`), sandbox or database code, so a web route can import it; a test checks the import graph. |
| `@rbw/host-umami/prepare` | `prepareStore`: builds the prepared store from the pinned kit image with Docker. |

## Baseline

`umami@ec0ff503`: Umami at commit `ec0ff50388c264ed8ce46f00967e92f7e71476ae`, with the original API suite `umami-api@ec0ff503`, pinned in `src/pins.ts` as `test_count: 271` in 24 spec files with frozen-manifest SHA-256 `8162af64…` (the driver's `freeze` writes the manifest and every copy re-checks it; `test/real.test.ts` checks the pins against a real prepared store when one is given). `test_ids_sha256` is the canonical JSON hash of the sorted test IDs.

## Catalog `umami-date-time`, version 1

One entry, `umami-date-time-01`, for bug type `date_time` and criterion `date_time.time-zone-grouping` version 1. It is the time-zone defect that was released:

- **Planted change:** the probe set's mutation patch against the pinned source (`packages/shapes/probes/dt-1.tz-arg/mutation.patch`, byte for byte), with its one target and the target's hashes before and after.
- **Reference repair:** the reverse patch, kind `revert`, which restores the clean file. It is the local runner's fixed-state patch, the one the release's judge job grades. The local runner's alternative fix is kept as extra evaluator evidence in the validator, not as the reference repair.
- **Incident:** the released `issue.json`, unchanged (named by its SHA-256; the bytes come from the prepared store).
- **Verification:** check set `umami-date-time-checks` version 1, identified by the fixture package's added-suite hash (`42c50a8b…`, the fixture the pinned image runs), the canonical hash of the clean, buggy and fixed vectors, and the protocol's hash.
- **Environment:** the pinned amd64 kit image as a neutral reference (`random-bug-walk/umami-kit`) and its digest. The reference names no registry; a runner has to map it to the repository the image was pushed to and run by the digest (see "Not yet connected").
- **Difficulty:** `not_assessed`.

Its IDs are opaque, and its presentation text names the symptom and the method only; a test checks that IDs and presentation carry no check IDs, file names, code identifiers or expected counts.

The checks report `local_day_counts_mismatch`, which is the criterion's published failure code (`TIME_ZONE_FAILURE_CODE`).

## Protocol `umami-time-zone-repeatability`, version 1

The existing `judge_verify` trial profile of `@rbw/schema`: one copy per state (`clean-01`, `planted-01`, `fixed-01`), each running the original suite once and the four checks once; every run is required. `protocol(entry)` reads it from the catalog alone. A copy's tests phase is limited to 240 s (the driver's limit) and the whole copy to 720 s. A different count would need a schema change to the trial profiles.

Its valid-trial rules:

| Rule | Meaning |
|---|---|
| `umami.frozen-job` | A copy's record set must carry the validator's frozen job (its `request.json` hash). |
| `umami.admission-import` | The record set is imported with `@rbw/admission`; its trial status and cells are the importer's. |
| `umami.own-trial-only` | Only the copy's own trial is read. The job's other trials must show as `result_missing`; a record set holding another trial is invalid. |
| `umami.original-suite-identity` | The original suite is the frozen 271-test suite; a missing or skipped test makes the copy incomplete. |
| `umami.declared-failure-code` | On the buggy copy, `local_day_counts_mismatch` is reported only when every declared check failed with it and the UTC control passed. A failing UTC control, or a check that failed with another assertion code or did not set up, makes the copy invalid (an unrelated failure), even when another check rejects; it is never a fail or a detection. A declared check that passed is a valid fail without the code. |
| `umami.min-valid-runs` | A cell is `error` when a copy's run of that cell is invalid, and `incomplete` with fewer valid runs than declared; a failure code counts only when every valid run reported it. The original suite's cell keeps the importer's own result, so a copy whose checks were invalid (by the importer or by the rule above) can still show its original suite's pass; the record's status (`invalid`) is what makes the candidate invalid. |

## Calendar window

`availability(entry, from, until)` reports the combination unavailable when any instant from `from` to `until` falls on UTC day 2 to 5 of a month: on those days two of Umami's own revenue tests fail on an unmodified copy (the driver README's known limit), so no case could qualify.

## Prepared store

`bugCaseInputs` and `validatorInputs` read the pinned inputs from a prepared store, a directory kept by content hash: `objects/<sha256>` holds each distinct file once and `index.json` (canonical JSON, format `rbw-host-umami-store/1`) lists:

- the image's app source (`/workspace/app` without `node_modules`, `src/proxy.ts` and the empty build outputs, as the local runner exports it): pinned in `src/pins.ts` as `source_file_count: 2026` with tree hash `712ebd68…`;
- the fixture package the image runs (`/opt/rbw/verifier/kit/umami-fixture`, without `node_modules` and `test-results`): tree hash `42c50a8b…`;
- the planted target file, the frozen original-suite manifest and the released incident.

The adapter checks the index against the pins and every object's bytes against its name, never writes to the store, and writes each tree it hands out into a new directory. On a host with Docker:

```
node packages/host-umami/src/prepare-cli.ts --image <kit image> --dest <new dir> \
  --original-suite <frozen original-suite.json> --incident <released issue.json>
```

It reads the image's files from containers it creates and never starts, derives the planted file with the local runner's code-state derivation, refuses any input that is not the pinned one, and prints the index SHA-256.

Only the export reads the store. The exporter runs on a host with Docker before deployment and builds the adapter with `createUmamiAdapter({ store: "<prepared store directory>" })`. Validating a pair of exported archives calls only `catalog`, `copyPlans`, `collect` and `interpret`, which read no store, so a worker that runs the harness on the exported archives builds it with `createUmamiAdapter()`; its `bugCaseInputs` and `validatorInputs` refuse with `store_missing`.

## Package inputs

- `bugCaseInputs(entry)`: the buggy source (the image's source with the planted target), the incident, the baseline and the runtime (the kit image and its build and start commands).
- `validatorInputs(entry)`: the checks (the fixture under `fixture/`, the frozen `judge_verify` job under `job/`, `expected-vectors.json`, and the alternative repair under `evidence/`), the expected matrix, the clean reconstruction (the reverse patch), the reference repair and the protocol. The frozen job is built with `buildJobRequest` and `buildExpectedTrials` with factory placeholder identities and the pinned suite, added suite, image, profile, patches and vectors; the driver in each copy checks the suite and the added-suite hash against it before it runs.

## Copy plans

`copyPlans(state, unpacked, protocol)` maps the trees the harness built from the exported bug case onto the pinned kit image and applies no patch. The image already holds the clean source, so a plan lists only the files whose hash differs from the image's tree (the planted target on buggy, nothing on clean or on the reverted fixed copy); a missing or extra file, a change to the original suite's closure (the files the suite runs from its pristine copy, such as `src/lib/analytics-query.ts`, and every file under `tests/`), a clean reconstruction that is not the image's source, validator checks that are not the fixture the image runs, or a job that is not the frozen one is refused. The command is the local runner's copy script (`freeze`, then `run` of the state's trial), within 720 s, 4 vCPU, 8 GB and no network.

Destinations: the app files go to `/workspace/app`, the validator's `job/` files under `/var/lib/rbw` (so the job is at `/var/lib/rbw/job`, where the copy script reads it), and the results directory is the copy script's output directory, `/var/lib/rbw/results/rbw-runner`.

## Collect

`collect(plan, collected)` reads only the plan's results directory as the runner brought it back: the exit statuses and the driver's record set under `out/`. A `setup_failed` copy is `invalid` and a `timed_out` copy `incomplete`, whatever it left behind; a copy whose driver did not finish, whose in-copy freeze failed or whose driver refused the job is `invalid`; a copy that ran another image than the plan's, or ran on another architecture than the pinned `amd64` (the pins' `kit.architecture`; a pinned digest can name a multi-architecture index, so a matching digest alone does not show it), is `invalid` and its results are not read; a copy that brought back no results is never `complete`. Otherwise the record set is imported with `@rbw/admission` under the valid-trial rules above, and the record's `evidence_sha256` is the collected `results_sha256`. `readCopyResults` is the same reading without the runner's envelope.

## Released-case mapping

`releasedCaseMapping(pins, entry, { defectId, caseId }, criteriaCatalogVersion)` maps release `319f3100-9ecf-441d-b7af-a643af9ae4e5` (its record's SHA-256, family, mutation ID and task revision) to the entry, the criteria catalog version and the `defect_id` and `case_id` that the factory's identity functions, passed in, compute: `defectId(baseline, entry)`, then `caseId({ defect_id, entry, criteria_catalog_version })`. It refuses an entry with another planted change, incident or kit image, and changes nothing in the release.

## Not yet connected

These parts are planned and not built yet:

- **The kit image on Sandbox.** Copy plans name the kit image by its neutral reference and pinned digest. No runner maps that reference to the registry repository the image was pushed to yet, so a hosted copy of this host cannot start until the sandbox runner has that mapping as a deployment setting and runs the mapped repository by the pinned digest. A local Docker run finds the image when it is present under the neutral reference with the pinned digest.
- **The released-case IDs.** The tests pass synthetic identity functions. The mapping record with the real `defect_id` and `case_id`, pinned as literal values, is added once the factory's identity module is in the repository.
- **A debugging runtime without validator material.** `bugCaseInputs` names the kit image as the runtime, and its build and start commands run as root. The kit image also holds the fixture's checks and outcome vectors under `/opt/rbw/verifier` and the clean source at `/workspace/app`, so the runtime is not yet separated from the validator. A runtime image without that material is planned.

## Tests

```
pnpm --filter @rbw/host-umami test
```

The tests build the adapter from synthetic pins over a synthetic prepared store (the image's source tree, the frozen suite and the incident are not in the repository); the fixture package is the repository's own. They pin the real values against their sources in the repository, including the release's task revision recomputed from the pins. `test/real.test.ts` checks the real inputs and is skipped unless its variables are set: `RBW_UMAMI_RELEASE_DIR` (the release directory of the results repository), `RBW_UMAMI_STORE` (a prepared store) and `RBW_UMAMI_RECORDS_DIR` (a published judge replay job directory).
