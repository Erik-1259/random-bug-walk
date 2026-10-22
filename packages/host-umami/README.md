# @rbw/host-umami

The Umami host adapter of the bug factory: it makes Umami a factory host through the shared `HostAdapter` interface of `@rbw/factory-contract`, without changing anything the existing Umami demo, release or judge replay depends on. It wraps the existing pieces (the kit image, the runtime image made from it, the protected driver and the local runner's copy script, the fixture, the probe set and `@rbw/admission`) and edits none of them. This is part of a hackathon prototype, and the planted bug is synthetic.

## Entries

| Import | What it holds |
|---|---|
| `@rbw/host-umami` | The adapter (`createUmamiAdapter`), its pins, catalog, protocol, calendar window, package inputs, copy plans, copy-result reading, interpretation and the released-case mapping. It loads no Docker, local-runner (beyond `@rbw/local-runner/shared`), sandbox or database code, so a web route can import it; a test checks the import graph. |
| `@rbw/host-umami/prepare` | `prepareStore`: builds the prepared store from the pinned kit image with Docker. |

Two scripts run on a host: `src/prepare-cli.ts` prepares the store (see [Prepared store](#prepared-store)) and `src/pin-cli.ts` derives the runtime pin's frozen-job hashes (see [Runtime image](#runtime-image)).

## Baseline

`umami@ec0ff503`: Umami at commit `ec0ff50388c264ed8ce46f00967e92f7e71476ae`, with the original API suite `umami-api@ec0ff503`, pinned in `src/pins.ts` as `test_count: 271` with frozen-manifest SHA-256 `8162af64…` (the driver's `freeze` writes the manifest and every copy re-checks it). `test/pins.test.ts` checks the commit against the driver's pinned commit, and `test/real.test.ts` checks the suite's pins against a real prepared store when one is given. `test_ids_sha256` is the canonical JSON hash of the sorted test IDs.

## Catalog `umami-date-time`, version 1

One entry, `umami-date-time-01`, for bug type `date_time` and criterion `date_time.time-zone-grouping` version 1 (the catalog's, entry's, criterion's and check set's IDs and versions are constants in `src/catalog.ts`; `test/catalog.test.ts` checks them and that the catalog holds this one entry). It is the time-zone defect that was released:

- **Planted change:** the probe set's mutation patch against the pinned source (`packages/shapes/probes/dt-1.tz-arg/mutation.patch`, byte for byte), with its one target (the pins' `target`) and the target's hashes before and after.
- **Reference repair:** the reverse patch, kind `revert`, which restores the clean file. It is the local runner's fixed-state patch, the one the release's judge job grades. The local runner's alternative fix is kept as extra evaluator evidence in the validator, not as the reference repair.
- **Incident:** the released `issue.json`, unchanged (named by its SHA-256; the bytes come from the prepared store).
- **Verification:** check set `umami-date-time-checks` version 1, identified by the fixture package's added-suite hash (the pins' `kit.added_suite_sha256`, `42c50a8b…`, the fixture the pinned kit image ran; `test/pins.test.ts` recomputes it from the repository's fixture package), the canonical hash of the clean, buggy and fixed vectors, and the protocol's hash.
- **Environment:** the pinned amd64 runtime image (see [Runtime image](#runtime-image)) as a neutral reference (`random-bug-walk/umami-runtime`) and its digest, never the kit image. The reference names no registry; a runner has to map it to the repository the image was pushed to and run by the digest (see "Not yet connected").
- **Difficulty:** `not_assessed`.

Its IDs are opaque, and its presentation text names the symptom and the method only; a test checks that IDs and presentation carry no check IDs, file names, code identifiers or expected counts.

The checks report `local_day_counts_mismatch`, which is the criterion's published failure code (`TIME_ZONE_FAILURE_CODE`).

## Protocol `umami-time-zone-repeatability`, version 1

The existing `judge_verify` trial profile of `@rbw/schema`: one copy per state (`clean-01`, `planted-01`, `fixed-01`), each running the original suite once and the four checks once; every run is required. `protocol(entry)` reads it from the catalog alone. A copy's tests phase is limited to 240 s (the driver's `DEFAULT_PHASE_LIMITS.tests_ms`) and the whole copy to 720 s (`COPY_LIMITS.timeout_s` in `src/copy-plans.ts`). A different count would need a schema change to the trial profiles. `test/protocol.test.ts` checks the protocol's version, these trials, counts and limits; the four checks are the four entries per state of the pins' `vectors`, which `test/pins.test.ts` reads back from the fixture's data file.

Its valid-trial rules:

| Rule | Meaning |
|---|---|
| `umami.frozen-job` | A copy's record set must carry the validator's frozen job (its `request.json` hash). |
| `umami.admission-import` | The record set is imported with `@rbw/admission`; its trial status and cells are the importer's. |
| `umami.own-trial-only` | Only the copy's own trial is read. The job's other trials must show as `result_missing`; a record set holding another trial is invalid. |
| `umami.original-suite-identity` | The original suite is the frozen suite of the pinned `test_count` (271 tests); a missing or skipped test makes the copy incomplete. |
| `umami.declared-failure-code` | On the buggy copy, `local_day_counts_mismatch` is reported only when every declared check failed with it and the UTC control passed. A failing UTC control, or a check that failed with another assertion code or did not set up, makes the copy invalid (an unrelated failure), even when another check rejects; it is never a fail or a detection. A declared check that passed is a valid fail without the code. |
| `umami.min-valid-runs` | A cell is `error` when a copy's run of that cell is invalid, and `incomplete` with fewer valid runs than declared; a failure code counts only when every valid run reported it. The original suite's cell keeps the importer's own result, so a copy whose checks were invalid (by the importer or by the rule above) can still show its original suite's pass; the record's status (`invalid`) is what makes the candidate invalid. |

## Calendar window

`availability(entry, from, until)` reports the combination unavailable when any instant from `from` to `until` falls on UTC day 2 to 5 of a month (`FIRST_BLOCKED_DAY` and `LAST_BLOCKED_DAY` in `src/availability.ts`; `test/availability.test.ts` checks the 1st, 2nd, 5th and 6th): on those days two of Umami's own revenue tests fail on an unmodified copy (the driver README's known limit, which `CALENDAR_REASON` in the same file states), so no case could qualify.

## Prepared store

`bugCaseInputs` and `validatorInputs` read the pinned inputs from a prepared store, a directory kept by content hash: `objects/<sha256>` holds each distinct file once and `index.json` (canonical JSON, format `rbw-host-umami-store/1`, the constant `STORE_FORMAT` in `src/store.ts`) lists:

- the kit image's app source (`/workspace/app` without `node_modules`, `src/proxy.ts` and the empty build outputs, as the local runner exports it): pinned in `src/pins.ts` as `source_file_count: 2026` with tree hash `712ebd68…`;
- the fixture package the kit image runs (`/opt/rbw/verifier/kit/umami-fixture`, without `node_modules` and `test-results`): tree hash `42c50a8b…`, the pins' `kit.added_suite_sha256`;
- the planted target file, the frozen original-suite manifest and the released incident.

The adapter checks the index against the pins and every object's bytes against its name, never writes to the store, and writes each tree it hands out into a new directory. On a host with Docker:

```
node packages/host-umami/src/prepare-cli.ts --image <kit image> --dest <new dir> \
  --original-suite <frozen original-suite.json> --incident <released issue.json>
```

It reads the image's files from containers it creates and never starts, derives the planted file with the local runner's code-state derivation, refuses any input that is not the pinned one, and prints the index SHA-256.

The store is read from the kit image, never from the runtime image, which holds neither the source nor the fixture. Only the export reads the store. The exporter runs on a host with Docker before deployment and builds the adapter with `createUmamiAdapter({ store: "<prepared store directory>" })`. Validating a pair of exported archives calls only `catalog`, `copyPlans`, `collect` and `interpret`, which read no store, so a worker that runs the harness on the exported archives builds it with `createUmamiAdapter()`; its `bugCaseInputs` and `validatorInputs` refuse with `store_missing`.

## Runtime image

The bug case and every copy run in the runtime image (`kit/umami-runtime`): the pinned kit image without the clean source, the fixture and the hash list of the app's files, with the kit's locked dependencies, Postgres with its migrated database, the verifier, the driver and the pristine suite closure. A debugging agent runs as root in its container, so anything in the image is visible to it; the kit image would show it the planted change. The pins name the runtime image in `runtime` (`UmamiRuntimePin`: a neutral reference, the digest and the architecture) and keep the kit image in `kit`, from which the store is prepared and which the released case ran in.

The frozen job names the runtime image's digest, so its request and expected-trials hashes (the pins' `job`) change with the runtime pin. `src/pin-cli.ts` derives them from a prepared store for a given runtime image:

```
node packages/host-umami/src/pin-cli.ts --store <prepared store> --runtime-image <reference> \
  --runtime-digest <sha256:...> --runtime-architecture <amd64|arm64> \
  [--kit-image <reference> --kit-digest <sha256:...> --kit-sha256 <hex> --kit-architecture <amd64|arm64>]
```

It prints `{ kit, runtime, job }`; the kit options replace the kit pins for a store prepared from another build of the kit image, such as a local arm64 build. Adapter tests and local proofs build the adapter from such pins with `buildUmamiAdapter(pins)`.

## Package inputs

- `bugCaseInputs(entry)`: the buggy source (the pinned source with the planted target), the incident, the baseline and the runtime: the runtime image and its setup steps (`runtimeSetup(pins)`): copy the source tree to `/workspace/app`, run `/opt/rbw/bin/rbw-prepare-app` once, then the kit's build and start commands.
- `validatorInputs(entry)`: the checks (the fixture under `fixture/`, the frozen `judge_verify` job under `job/`, `expected-vectors.json`, and the alternative repair under `evidence/`), the expected matrix, the clean reconstruction (the reverse patch), the reference repair and the protocol. The frozen job is built with `buildJobRequest` and `buildExpectedTrials` with factory placeholder identities and the pinned suite, added suite, runtime image, profile, patches and vectors; the driver in each copy checks the suite and the added-suite hash against it before it runs.

## Copy plans

`copyPlans(state, unpacked, protocol)` places the trees the harness built from the exported bug case in the pinned runtime image and applies no patch. The runtime image holds no app source and no fixture, so a plan lists the state's whole source tree and, as evaluator files, the validator's `fixture/` and `job/` files (never its vectors or its evidence). The clean reconstruction must be the pinned source, and a state's tree may differ from it only by the entry's change for that state (the planted target on buggy, nothing on clean or on the reverted fixed copy); a missing or extra file, a change to the original suite's closure (the files the suite runs from its pristine copy, such as `src/lib/analytics-query.ts`, and every file under `tests/`), validator checks that are not the fixture the pinned kit image ran, or a job that is not the frozen one is refused. The copy runs within 720 s, 4 vCPU, 8 GB and no network (`COPY_LIMITS` in `src/copy-plans.ts`, with `memory_mb: 8192`; `test/pins.test.ts` checks it).

The command is the copy script (`COPY_SCRIPT`): first `COPY_PREPARE`, which moves `/var/lib/rbw/fixture` to `/opt/rbw/verifier/kit/umami-fixture`, where the driver reads the fixture, makes it root-only (directories 0700, files 0600) and runs the image's `rbw-prepare-app`, writing the step's exit status to `prepare.exit` and stopping with 92 when it failed; then the local runner's copy script unchanged (`freeze`, then `run` of the state's trial). `test/pins.test.ts` checks that the script is the local runner's with only `COPY_PREPARE` added after its output directory is made.

Destinations: the app files go to `/workspace/app`, the validator's `fixture/` and `job/` files under `/var/lib/rbw` (so the job is at `/var/lib/rbw/job`, where the copy script reads it), and the results directory is the copy script's output directory, `/var/lib/rbw/results/rbw-runner`.

## Collect

`collect(plan, collected)` reads only the plan's results directory as the runner brought it back: the exit statuses and the driver's record set under `out/`. A `setup_failed` copy is `invalid` and a `timed_out` copy `incomplete`, whatever it left behind; a copy whose driver did not finish, whose fixture placement or app preparation failed (`prepare.exit`), whose in-copy freeze failed or whose driver refused the job is `invalid`; a copy that ran another image than the plan's, or ran on another architecture than the runtime image's pinned one (the pins' `runtime.architecture`, `amd64`; a pinned digest can name a multi-architecture index, so a matching digest alone does not show it), is `invalid` and its results are not read; a copy that brought back no results is never `complete`. Otherwise the record set is imported with `@rbw/admission` under the valid-trial rules above, and the record's `evidence_sha256` is the collected `results_sha256`. `readCopyResults` is the same reading without the runner's envelope.

## Released-case mapping

`releasedCaseMapping(pins, entry, { defectId, caseId }, criteriaCatalogVersion)` maps release `319f3100-9ecf-441d-b7af-a643af9ae4e5` (`RELEASED_CASE` in `src/mapping.ts`: its record's SHA-256, family, mutation ID and task revision, which `test/real.test.ts` checks against the release record when one is given) to the entry, the criteria catalog version and the `defect_id` and `case_id` that the factory's identity functions, passed in, compute: `defectId(baseline, entry)`, then `caseId({ defect_id, entry, criteria_catalog_version })`. It refuses an entry with another planted change or incident, and pins whose kit image is not the one the release ran in, and changes nothing in the release. The entry itself names the runtime image made from that kit image, which its `case_id` covers.

## Not yet connected

These parts are planned and not built yet:

- **The pushed runtime image.** The amd64 runtime image is not pushed yet, so `UMAMI_PINS.runtime.digest` is all zeros and names no image: no copy and no debugging runtime on the real pins can start, and the frozen job's hashes in `UMAMI_PINS.job` are the ones for that digest. Once the image is pushed, the runtime pin takes its digest and the job hashes the ones `src/pin-cli.ts` derives for it.
- **The runtime image on Sandbox.** Copy plans name the runtime image by its neutral reference and pinned digest. No runner maps that reference to the registry repository the image was pushed to yet, so a hosted copy of this host cannot start until the sandbox runner has that mapping as a deployment setting and runs the mapped repository by the pinned digest. A local Docker run finds the image when it is present under the neutral reference with the pinned digest.
- **The released-case IDs.** The tests pass synthetic identity functions. The mapping record with the real `defect_id` and `case_id`, pinned as literal values, is added once the factory's identity module is in the repository.

## Tests

```
pnpm --filter @rbw/host-umami test
```

The tests build the adapter from synthetic pins, with a synthetic kit and runtime image, over a synthetic prepared store (the image's source tree, the frozen suite and the incident are not in the repository); the fixture package is the repository's own. They pin the real values against their sources in the repository, including the release's task revision recomputed from the pins. `test/real.test.ts` checks the real inputs and is skipped unless its variables are set: `RBW_UMAMI_RELEASE_DIR` (the release directory of the results repository), `RBW_UMAMI_STORE` (a prepared store) and `RBW_UMAMI_RECORDS_DIR` (a published judge replay job directory).
