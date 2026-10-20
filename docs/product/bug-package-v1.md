# Bug package format, version 1

**Status: draft, version 1.** This document defines the two package parts of a case, the formats `rbw-bug-case/1` and `rbw-validator/1`, which section 10.3 of the [bug request contract](bug-request-v1.md) (revision 2) refers to. The exporter (`tools/case-package`) and the standalone harness `rbw-validate` (`tools/case-validate`) implement it. Section 11 lists what is implemented and what is planned.

A case is two separate downloads:

| Part | Format | File name | Reader |
|---|---|---|---|
| Bug case | `rbw-bug-case/1` | `rbw-bug-case-<id>-v<package_version>.tar.gz` | the debugging agent |
| Validator package | `rbw-validator/1` | `rbw-validator-<id>-v<package_version>.tar.gz` | the evaluator and the harness |

In a file name, `<id>` is the first 12 hex digits of the `case_id`, so each package version of a case downloads under its own name (for example `rbw-bug-case-cacacacacaca-v1.tar.gz`, as in the contract's fixtures).

The bug case is everything a debugging agent may see. The validator package is evaluator material: its checks, expected values, clean reconstruction and reference repair never reach a debugging agent or a client payload.

## 1. Archive encoding (both parts)

Each part is a gzip-compressed POSIX ustar archive (media type `application/gzip`) built so that the same members give the same bytes on every platform:

- **Members** are regular files only: no directories, links or devices. Each path is a relative POSIX path as the contract's `RelativePath` defines it (segments joined by `/`, no empty, `.` or `..` segment, no backslash or control character), encoded as UTF-8. Paths are unique, and no two paths differ only in letter case.
- **Order** is by the UTF-8 bytes of the path.
- **Metadata** is fixed: mode `0644`, owner and group `0`, empty user and group names, modification time `0`. A path that does not fit the ustar name and prefix fields is carried in a PAX extended header with a single `path` record. Executable bits are not kept, so commands name their interpreter (`node script.js`, `sh script.sh`).
- **Compression** is DEFLATE at level 6 with memory level 8 from one pinned pure-JavaScript implementation (fflate 0.8.2). The gzip header has modification time `0`, no file name and operating-system byte `3`.
- **Manifests** (`bug-case.json`, `validator.json`) are canonical JSON v1 bytes (the repository's canonical JSON: sorted ASCII keys, no insignificant white space, integers only), with no trailing newline.

A reader refuses an archive that is not gzip data, unpacks to more than 1 GiB or holds more than 200,000 members, has a bad header checksum, is truncated, has data after its end marker, or holds anything but regular files with valid, unique paths.

## 2. Bug case: `rbw-bug-case/1`

```text
bug-case.json          the manifest
source/<path>          the buggy application source with the unchanged original test suite, no version-control history
incident/<path>        the permitted plain-language incident description
```

`bug-case.json`:

| Field | Meaning |
|---|---|
| `format` | `"rbw-bug-case/1"` |
| `package_version` | Positive integer; both parts name the same version. |
| `case_id`, `defect_id` | The case's identities (contract section 10.4). |
| `host_id` | `umami` or `task-report`. |
| `baseline` | The host baseline: `host_id`, `baseline_id`, `app_commit`, and `original_suite` (`suite_id`, `sha256`, `test_count`, `test_ids_sha256`). |
| `runtime` | `kit_image`, `kit_image_digest` (the pinned amd64 kit image) and `setup` (the setup commands, in order). |
| `provenance` | Neutral provenance: `license` (the host application's license, an SPDX identifier) and `tools` (`[{ name, version }]`, the exporter `rbw-case-package` and its version). |
| `files` | Every other member as `{ path, sha256 }`, in path order. |

The bug case never contains: a verification check, fixture or expected value; the clean reconstruction, the reference repair or the planted change as a patch, whole or as a hunk; a byte copy of any validator file; a file whose content equals the original or repaired content of a changed file; version-control history (`.git`, `.hg`, `.svn` anywhere); evaluator locations (`evaluator/`, `validator/` or `.rbw/` at the top of the source tree); generation history; credentials, private operational identifiers, the requesting user or other requests' data.

## 3. Validator package: `rbw-validator/1`

```text
validator.json                 the manifest
checks/<path>                  the verification checks, their fixtures and expected vectors
reconstruction/clean.patch     turns the exported buggy source into the clean copy
repair/reference.patch         the pinned reference repair, applied to the exported buggy source
evidence/qualification.json    the per-run qualification evidence (final archive only)
```

`validator.json`:

| Field | Meaning |
|---|---|
| `format` | `"rbw-validator/1"` |
| `package_version`, `case_id`, `defect_id`, `host_id`, `baseline` | Equal to the bug case's. |
| `entry_id` | The catalog entry the case came from (an opaque identifier). |
| `bug_case_sha256` | The SHA-256 of the one bug-case archive this validator belongs to (section 4). |
| `expected` | The expected outcome of every cell: the qualification table of contract section 1 (original suite pass, pass, pass; verification checks pass, fail, pass). |
| `protocol` | The declared repetition protocol: `protocol_id`, `version`, `sha256`, per-state `copies`, `rounds_per_copy` and `min_valid_runs`, and `valid_trial_rules`. |
| `clean_reconstruction` | `{ path: "reconstruction/clean.patch", patch_sha256, result_sha256 }`. |
| `reference_repair` | `{ path: "repair/reference.patch", patch_sha256, result_sha256, kind }`, `kind` `revert` or `independent`. |
| `provenance` | As in the bug case. |
| `files` | Every core member except `validator.json` as `{ path, sha256 }`, in path order. |

`result_sha256` lists every path the patch changes, with the SHA-256 that path must have after the patch is applied to the exported buggy source.

**Core and final archive.** The validator *core* holds every member above except `evidence/qualification.json`; it is built once per catalog entry and stored by content hash. The *final* validator archive, the downloadable part, is the core plus the evidence member, packed with the encoding of section 1 (the evidence member takes its place in path order). The evidence member holds the canonical JSON v1 bytes of the evidence value, so a value read back from storage with its keys reordered gives the same archive. `assembleFinalValidator(core, evidence)` (`@rbw/case-package/assembly`, pure, in memory) is the one assembly function; the worker that records the final archive's SHA-256 and the download route that re-assembles and hash-checks it both call it. `files` never lists the evidence member, and a reader accepts a validator package with or without it. The evidence content (the qualification record and copy records) is defined by the qualification route (planned).

## 4. Pair binding

- `validator.json` names `bug_case_sha256`, the SHA-256 of the exact bug-case archive, and the bug case's `case_id`, `defect_id`, `package_version`, `host_id` and `baseline`.
- `pair_sha256` (contract section 10.3) is the SHA-256 of the canonical JSON v1 bytes of exactly `{ "bug_case_sha256", "case_id", "validator_sha256" }`, where `validator_sha256` is the SHA-256 of the downloadable (final) validator archive. Neither archive can hold it, because the final validator would have to hold its own hash; it is computed from the two parts. `pairSha256({ bug_case_sha256, validator_sha256, case_id })` in `@rbw/case-package/format` is the one implementation.
- The harness refuses a pair whose validator names another bug case, case, defect, host, baseline or package version; a swapped pair (the bug case argument is a validator package); a member missing from, added to or changed against its manifest; and a non-canonical evidence member.

## 5. Patches

Both patches are git-style unified diffs that only modify files: one `diff --git a/<path> b/<path>` section per file with `--- a/<path>` and `+++ b/<path>`, paths relative to the exported source root, and no new, deleted, renamed, copied, mode-change or binary sections. Hunks apply at exactly the positions their headers state, with no fuzz or offset (the applier of `@rbw/projection`).

- **Clean** is the clean reconstruction applied to the exported buggy source. Its `result_sha256` is the planted change's targets with their original hashes.
- **Buggy** is the exported source as it is.
- **Fixed** is the reference repair applied to the **exported** buggy source, never to a clean copy.

A patch that does not apply, or whose changed paths and hashes differ from its `result_sha256`, is an export mismatch: the harness answers `error`. The exporter runs the same two applications before it writes anything and refuses an entry whose patches do not reproduce their recorded results.

## 6. Exporter

`exportCase` (`@rbw/case-package`) takes a host adapter, one of its catalog entries, the factory's identity functions and the host's license. It:

1. reads the adapter's bug case and validator inputs and checks them against the entry and the adapter (host, entry, baseline, protocol, incident description, runtime image, patch hashes, the planted change present in the exported source, the qualification table);
2. reads every listed file, refusing links, other non-regular files and bytes that differ from the listed hash;
3. applies both patches to the exported buggy source and compares the results with their recorded hashes (section 5);
4. refuses a bug case that breaks section 2's list (the separation checks);
5. packs both parts (section 1) and passes every member of each part, manifests included, to the pre-write scan hook; any answer other than `clean` refuses the export.

`case_id` and `defect_id` are computed by the factory's identity functions, which the exporter receives (`CaseIdentity`); the exporter never derives them itself.

## 7. Prepared directory

`case-package prepare` (`node tools/case-package/src/cli.ts prepare ...`) exports catalog entries into a content-addressed directory:

```text
<sha256>.tar.gz     each bug case and each validator core, named by its SHA-256
index.json          canonical JSON v1: { "format": "rbw-prepared-packages/1", "entries": [...] }
```

Each index entry has `host_id`, `entry_id`, `catalog_version`, `package_version`, `case_id`, `defect_id`, `bug_case_sha256`, `bug_case_size_bytes`, `validator_core_sha256`, `validator_core_size_bytes` and `scanned` (whether the pre-write scan ran). Entries are ordered by `host_id`, then `entry_id`; a later run replaces an entry with the same host and entry ID and keeps the others. `readPreparedIndex` and `readPreparedObject` (which checks each object's hash) read it back.

## 8. Harness: `rbw-validate`

```text
rbw-validate <bug-case.tar.gz> <validator.tar.gz> [--out <dir>]
```

The harness reads nothing outside the two archives except the host adapter code (resolved from the manifests' `host_id` through the host registry) and the copy runner. It:

1. verifies both archives and their binding (sections 1 to 4);
2. unpacks each part into its own directory of one fresh workspace and builds the clean, buggy and fixed trees (section 5);
3. asks the host adapter for the copy plans of each state, one per copy the protocol declares; a plan may place only files of its state's tree and of the validator's checks, unchanged;
4. when the adapter declares availability, checks the run's planned span (from now until now plus every planned copy's time limit, or an explicit end) and runs no copy when the combination is unavailable;
5. runs the copies one at a time in the order clean, buggy, fixed: the runner places the files at the plan's destinations, runs the command and brings the results directory back with its hash; the adapter's `collect` turns that into a copy record, and after each state the adapter's `interpret` gives the state's two cells, where a pass or fail on fewer valid runs than the protocol's `min_valid_runs` counts as `incomplete`, and the harness itself makes both cells of a state with an invalid copy record `error` and those of a state with an incomplete one at least `incomplete`, whatever the adapter interpreted;
6. prints the matrix and the result, and with `--out` writes `validation.json` and keeps each copy's results under `<dir>/copies/`.

| Result | When | Exit code |
|---|---|---|
| `passed` | Every cell observed a valid pass or fail equal to its expectation. | 0 |
| `failed` | Every cell observed a valid pass or fail, and at least one differs from its expectation. | 1 |
| `error` | The pair was refused, no adapter serves the host, the host is unavailable, the workspace could not be written, a copy was not set up, timed out or ran too few valid runs, or a cell is `error` or `incomplete`. | 2 |
| usage | Wrong arguments. | 64 |

A copy that could not be set up or passed its time limit is never a pass, a fail or a detection. The library entry point `validatePair` returns the same result with an `error_code` (`export_mismatch`, `unsupported_host`, `host_unavailable`, `adapter_error`, `runner_error`, `workspace_error`, `cells_invalid`, `stopped`), a client-safe `message` and an evaluator-only `diagnostic`; `workspace_error` means the harness could not write its own workspace, before any copy ran. Its `pair_sha256` covers the validator bytes it was given, so it is the binding of section 4 only for the final archive; a run on the validator core gives another value. It rejects only when the runner rejects (an uncertain provider outcome) or a caller's callback throws; the records collected before that have reached the caller's `onCopy`, and no further copy runs.

## 9. Synthetic packages

`@rbw/case-package/synthetic` builds synthetic pairs for tests and test modes: a small synthetic application with one planted defect, its original tests, a verification check and a copy driver, with a host adapter over it. `buildSyntheticPair` is deterministic per host, entry seed and defect seed (entries with one defect seed share a defect), takes the factory's identity functions when given, and returns the bytes, hashes and IDs; `buildMismatchedSyntheticPair` returns a validator bound to another bug case. Synthetic packages are labeled synthetic and prove the tooling, not a real host.

## 10. Versioning

A change to the member layout, a manifest field, the encoding or the binding is a new format version (`rbw-bug-case/2`, `rbw-validator/2`) and a new revision of this document. `package_version` numbers the packaging of one case within a format version.

## 11. Implementation status

| Part | Status |
|---|---|
| Encoding, both manifests, pair binding, separation checks, exporter, scan hook, prepared directory, final-validator assembly | implemented (`tools/case-package`) |
| Pair verification, workspace and patch checks, copy loop, matrix and result, CLI, `docker` runner, host registry | implemented (`tools/case-validate`) |
| Real host adapters in the host registry (`task-report`, `umami`) | planned; the registry is empty until the host adapters land |
| Wiring of the factory's identity functions into `case-package prepare` | planned; the command takes them as a module until then |
| Evidence content, the `sandbox` runner, the worker's and the download route's use of the assembly | planned (backend) |
