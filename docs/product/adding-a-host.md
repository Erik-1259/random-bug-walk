# Adding a host

How a third host application is connected to the bug factory. Version 1 serves two hosts, `task-report` and `umami`; their adapters are the references below and are planned (contract section 15). Every step names the code it touches. Parts marked **planned** do not exist yet.

## 1. What a host provides

| Piece | Where it lives | Used by |
|---|---|---|
| Baseline identity | the host package | capabilities, `defect_id`, both package manifests |
| Kit image | the host's kit directory, pinned by digest | every copy |
| Catalog of entries | the host package | interpretation, assignment, the exporter |
| Verification checks and protocol | the host package | the validator package, `interpret` |
| Host adapter (`HostAdapter`) | the host package | the exporter, the harness, the worker |
| Registry line | `tools/case-validate/src/registry.ts` | the harness CLI, the worker, the service's capabilities (planned) |

## 2. Steps

1. **Contract revision (planned for any third host).** `HostId` is a closed enumeration in the [bug request contract](bug-request-v1.md) and its JSON Schema. Capabilities list every host exactly once in `hosts` and every (host, bug type) pair exactly once in `combinations` (contract sections 4 and 4.2), and the schema enforces both with one clause for each host and one for each pair. A new host therefore needs a contract revision that adds its `host_id` to the enumeration and to those clauses, regenerated shared types in `@rbw/factory-contract`, and capabilities fixtures that list the host once and one combination for each bug type. Shapes change only through a revision (contract section 15).
2. **Baseline.** Pin the application at one commit. `BaselineIdentity` names `baseline_id` (`<host>@<short commit>`), the full `app_commit`, and the original suite's identity: `suite_id`, the suite's `sha256`, `test_count` and `test_ids_sha256`. The suite is never changed to qualify a case.
3. **Kit image.** An amd64 image, pinned by digest, with the runtime and tools the copy command needs. A copy has no network. The runner places the app tree at the plan's `destinations.app` and the evaluator files at `destinations.evaluator`, both owned by root and readable by every user, and creates `destinations.results` writable by every user. Files keep no executable bit, so the command names its interpreter. A kit that writes into the app tree as an unprivileged user copies the tree to a writable location first.
4. **Catalog entries.** Each `CatalogEntry` declares its source and catalog version, its bug type and the criteria it targets (from the criteria catalog, whose failure codes are published per criterion; an entry never carries its own), the planted change (a patch and its targets with before and after hashes), the reference repair (a patch, the result hash of every changed path, `revert` or `independent`), the permitted incident description (plain language, no fix hints), the client-safe presentation text, the verification identity (check set, expected vectors, protocol ID and hash), the kit environment and `difficulty: not_assessed`. Patches follow [the package format's patch rules](bug-package-v1.md#5-patches): git-style, modify-only, paths relative to the exported source root.
5. **Verification checks.** The checks, their fixtures and expected vectors go into `ValidatorInputs.checks`. On the buggy copy they report the failure code of every criterion the entry targets; on the clean and fixed copies they pass.
6. **Protocol.** `protocol(entry)` returns the declared repetition protocol from the catalog alone, with no archive: copies, rounds per copy and minimum valid runs per state, and the valid-trial rules that `interpret` applies. The factory prices a candidate's worst case from it before the candidate starts.
7. **Adapter.** Implement every method of `HostAdapter` (`@rbw/factory-contract`):
   - `baseline()`, `catalog()`, `protocol(entry)`, and optionally `availability(entry, from, until)` (absent means always available; when it reports unavailable for the run's planned span, the harness runs no copy and answers `error`).
   - `bugCaseInputs(entry)`: the buggy source with the unchanged original tests, the incident description and the runtime. It must pass the exporter's separation checks ([package format section 2](bug-package-v1.md#2-bug-case-rbw-bug-case1)): no checks, fixtures, expected values, patches, pristine copies of changed files, version-control history or evaluator locations.
   - `validatorInputs(entry)`: the checks, the expected matrix (the qualification table), the clean reconstruction, the reference repair and the protocol.
   - `copyPlans(state, unpacked, protocol)`: maps the trees the harness built from the exported parts to copy plans. It applies no patch; a plan may place only files of its state's tree and of the evaluator files, unchanged, and must run the bug case's `runtime` image (the entry's `kit_image` at `kit_image_digest`), or the harness answers `error`. A package built on an earlier kit therefore answers `error` with an adapter that plans a rebuilt one.
   - `collect(plan, collected)`: reads only what the copy wrote under `destinations.results`. A copy that could not be set up or timed out becomes a record with status `invalid` or `incomplete` and cells `error` or `incomplete`, never a pass, a fail or a detection; `evidence_sha256` is the collected `results_sha256`.
   - `interpret(records, protocol)`: the state's two cells, with invalid and incomplete kept distinct and fewer valid runs than the protocol requires reported as `incomplete`.
8. **Registry line.** Add one entry to `REGISTRATIONS` in `tools/case-validate/src/registry.ts`: `{ host_id, label, description, license, adapter }`. The label and description are what capabilities show; the license is the host application's SPDX identifier, recorded in both package manifests. The service builds its capabilities from this registry (planned).
9. **Prepare and validate locally.** Export the host's entries with `case-package prepare` (`--registry tools/case-validate/src/registry.ts`, the factory's identity module, the scan hook, `--out <dir>`), then run `rbw-validate` on one prepared bug case and its validator with the local `docker` runner. Both are free and need no hosted service.
10. **Tests.** At least: a sentinel placed in every piece of validator material never appears in the bug case inputs; `copyPlans` applies no patch; `collect` never turns a copy that did not run into an observation; `interpret` keeps invalid and incomplete apart; and one local end-to-end validation of a prepared pair.

## 3. The two existing hosts

| | `task-report` | `umami` |
|---|---|---|
| Baseline | `task-report@ca4a71f` | `umami@ec0ff503` |
| Bug type in version 1 | `concurrency` | `date_time` |
| Criterion | `concurrency.lost-acknowledged-change` | `date_time.time-zone-grouping` |
| Host package | `packages/host-task-report` (baseline, catalog, checks, protocol and copy driver; adapter planned) | `packages/host-umami` (planned) |
| What `collect` reads (planned) | the copy driver's record set | the copy script's record set, imported with `@rbw/admission` |
| Registry line | planned, added when the host adapter lands | planned, added when the host adapter lands |

The synthetic host in `@rbw/case-package/synthetic` implements the whole adapter over a small synthetic application and is the working example until the real hosts land.
