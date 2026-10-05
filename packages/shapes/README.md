# @rbw/shapes

Bug shapes encoded as ast-grep rules and confirmed by code, with no model. The package holds one shape, `DT-1.tz-arg`: a caller has the selected timezone but does not pass it to a date operation, which then silently uses its default.

The shape is labeled `synthetic_transplant`, tier `B`: the source fix is in a React date-range hook, and the target is a SQL date helper.

## Contents

| Path | What it holds |
| --- | --- |
| `rules/dt-1.tz-arg.yml` | The target rules. `dt-1.tz-arg` matches `getDateSQL('website_event.created_at', unit, timezone)` inside the function `relationalQuery`; its `fix` drops the third argument. `dt-1.tz-arg.planted` matches the two-argument form in the same function. |
| `rules/dt-1.tz-arg.source.yml` | The source anchor rule: a `useDateRange(...)` call inside the function `RevenuePage`. It is separate from the target rules. |
| `rule-tests/` | Synthetic `valid` and `invalid` cases and snapshots for `ast-grep test` (configured by `sgconfig.yml`). |
| `probes/dt-1.tz-arg/` | The mutation, partial and stub probe patches, and `probes.json` with each probe's base and result hashes and expected outcome vector. |
| `src/shape.ts` | The pinned target and source data, including every expected hash. Callers cannot override these through the CLI or the package exports. |

The rules run through `@ast-grep/napi`, which loads the YAML files directly. The napi engine does not apply `fix`, so the package expands the rule's `fix` template with the match's metavariables and commits the edit through the engine. The `ast-grep` CLI gives the same bytes on the same input, and a unit test checks this.

## Target confirmation

`confirmTarget` takes the target file's path, git mode and bytes, the endpoint route file's bytes, and the rule file. It returns a confirmation record, or `not_applicable` with a reason code. Every check is required:

1. The path is `src/queries/sql/pageviews/getPageviewStats.ts`, the mode is `100644`, and the file hashes to the pinned SHA-256 (`file_hash_mismatch` otherwise).
2. The route file hashes to its pinned SHA-256 (`route_hash_mismatch`).
3. The rule matches exactly one call in the whole file (`match_count`), directly inside `relationalQuery` (`function_mismatch`).
4. `timezone` has exactly one binding in `relationalQuery`: a `const` destructure from `filters`, which is the function's second parameter and is not bound again. A rebinding, reassignment or other source is `binding_mismatch`.
5. The route builds `filters` with `getQueryFilters(query, websiteId)` and passes that binding to `getPageviewStats(websiteId, filters)` (`endpoint_mismatch`).
6. The rule's fix turns exactly the selected call into the planted form (`fix_not_single_call`). The unified diff has one hunk that changes only that line (`diff_not_single_hunk`), and the result hashes to the pinned result SHA-256 (`result_hash_mismatch`).

The record holds the shape ID, the fidelity label, the rule file's SHA-256, the target path, mode, line, original and result hashes, the git-style diff, the function identity `<path>#relationalQuery`, the changed-call count and the route file's hash. The declared mutation, which the projection audit reads, is written separately as canonical JSON: `{"diff":…,"files":[{"mode":…,"original_sha256":…,"path":…,"result_sha256":…}],"host_commit":…}`.

## Source confirmation

`confirmSource` takes a commit, the parent it is paired with, the commit's parents as git records them, the changed files, and the complete before and after blobs. Only one pairing is supported: commit `e6f3f3b4b40a490d5cb050471baa0999366dab2a` with its only parent `0a838649b773122cc68cbd0c3df78d4251b981c5`, changing only `RevenuePage.tsx`, with both blobs matching their pinned git blob IDs and SHA-256 hashes.

In `RevenuePage`, counting calls in nested callbacks too, the before side must have exactly one `useDateRange()` call with no argument and no `useTimezone` call. The after side must have exactly one `useDateRange({ timezone })` call, where `timezone` is bound only by `const { timezone } = useTimezone();` earlier in the same function. One diff hunk must remove the old call line and add the new one. Anything else is `unsupported_source_match` with a reason code: `unsupported_commit`, `not_first_parent`, `changed_files`, `rename`, `path_mismatch`, `blob_missing`, `blob_hash_mismatch`, `function_missing`, `call_count`, `before_form`, `after_form`, `binding_mismatch` or `hunk_mismatch`.

## Probes

`checkProbes` takes the planted file. It refuses a file whose hash is not the recorded planted hash, because the stub patch would also apply textually to the clean file. It then:

- restores the clean file by reversing the mutation patch, and checks that the result is identical to the clean file (the fixed reference);
- applies each probe patch to its recorded base;
- checks that each patch changes only the target file, in one hunk, and gives its recorded result hash.

`probes.json` also records each probe's expected outcome vector for the four added checks. It records that a build error, crash, timeout, missing result or setup failure on a probe copy makes the run invalid; such a run is never an effective negative probe.

## Command line

```sh
node packages/shapes/src/cli.ts confirm-target --file <file> --path <repository path> --route <route file> \
  [--mode <git mode>] [--rule <rule file>] [--record <out>] [--declared-mutation <out>]
node packages/shapes/src/cli.ts confirm-source --git-dir <dir> --commit <sha> --parent <sha> [--rule <rule file>] [--record <out>]
node packages/shapes/src/cli.ts check-probes --planted <file> [--record <out>]
```

Records are canonical JSON with sorted keys. Identical inputs give identical bytes. Without `--record`, the record goes to stdout. Without `--mode`, the mode comes from the file's execute bits. Exit codes:

- 0: confirmed;
- 1: `not_applicable`, `unsupported_source_match` or `refused`, with the reason printed to stderr;
- 2: the command cannot run (bad usage, unreadable input, malformed rule or probe data, or a failing git command).

## Tests

| Script | What it does |
| --- | --- |
| `pnpm --filter @rbw/shapes run test` | Unit tests on synthetic sources, including the rule test cases through the napi engine and `ast-grep test`. No network. |
| `pnpm --filter @rbw/shapes run test:upstream` | Checks against the pinned Umami blobs. It reads them from the git directory in `RBW_UMAMI_GIT_DIR`, or fetches the pinned commits into a temporary directory. When neither is possible, it prints a skip message and exits 0. It is not part of `pnpm test`. |
| `build`, `typecheck`, `lint` | The workspace's standard scripts. |

No Umami source file is committed. The probe patches carry a few lines of context from the pinned file.

## Not in this package

- Building or running Umami, and the added checks themselves.
- Mutation IDs and task revisions (the schema package computes identity hashes).
- Other shapes and other candidates.
