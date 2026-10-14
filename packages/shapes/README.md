# @rbw/shapes

Bug shapes encoded as ast-grep rules and confirmed by code, with no model. The package holds two site-level shapes, listed below. It also holds class-level rules for the race family, which list every site of a class in a host tree (see [Class rules and site finding](#class-rules-and-site-finding)).

- `DT-1.tz-arg`: a caller has the selected timezone but does not pass it to a date operation, which then silently uses its default. It is labeled `synthetic_transplant`, tier `B`: the source fix is in a React date-range hook, and the target is a SQL date helper.
- `RC-1.atomic-backup-code`: a two-factor backup code is read as unused, then, after an `await`, written back as used without checking that it is still unused, so two concurrent requests can both spend it. It is labeled `partial_reversion`, tier `A`: see [RC-1](#rc-1atomic-backup-code) below.

The sections on target confirmation, source confirmation and the command line describe `DT-1.tz-arg`. The probe checker serves both shapes.

## Contents

| Path | What it holds |
| --- | --- |
| `rules/dt-1.tz-arg.yml` | The target rules. `dt-1.tz-arg` matches `getDateSQL('website_event.created_at', unit, timezone)` inside the function `relationalQuery`; its `fix` drops the third argument. `dt-1.tz-arg.planted` matches the two-argument form in the same function. |
| `rules/dt-1.tz-arg.source.yml` | The source anchor rule: a `useDateRange(...)` call inside the function `RevenuePage`. It is separate from the target rules. |
| `rule-tests/` | Synthetic `valid` and `invalid` cases and snapshots for `ast-grep test` (configured by `sgconfig.yml`). |
| `probes/dt-1.tz-arg/` | The mutation, partial and stub probe patches, and `probes.json` with each probe's base and result hashes and expected outcome vector. |
| `src/shape.ts` | The pinned target and source data, including every expected hash. Callers cannot override these through the CLI or the package exports. |
| `rules/rc-1.atomic-backup-code.yml`, `rules/rc-1.atomic-backup-code.source.yml`, `probes/rc-1.atomic-backup-code/`, `src/rc1.ts` | The same parts for `RC-1.atomic-backup-code`. |
| `rules/race.class.yml` | The race class rules: `race.guarded-write` and `race.upsert`, each with a fix, and their `.planted` rules. |
| `src/classes.ts` | `findSites` and `findSitesInSource`: run the class rules over a tree or one file and list each site with its planted diff and a structural confidence. |

The rules run through `@ast-grep/napi`, which loads the YAML files directly. The napi engine does not apply `fix`, so the package expands the rule's `fix` template with the match's metavariables and commits the edit through the engine. It follows the CLI where that matters: a fix may be a mapping with `template`, `expandStart` and `expandEnd` (the edit widens over adjacent siblings that match), a rule may define `utils`, and a multi-line capture is re-indented to its new position. The `ast-grep` CLI gives the same bytes on the same input, and unit tests check this for every rule file.

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

`probes.json` also records each probe's expected outcome vector for the added checks. It records that a build error, crash, timeout, missing result or setup failure on a probe copy makes the run invalid; such a run is never an effective negative probe.

A shape may record ADM-06 (the partial and stub probes) as not applicable with an `adm_06` entry: `{"reason": …, "status": "not_applicable"}`. Its probe set must then hold the mutation probe alone, and the confirmed record carries the same entry. A probe set without `adm_06` is unchanged. For such a probe set the local runner derives only the clean, planted and fixed states and builds the admission job from the 11-trial profile without `partial-01` and `stub-01` (`ADMISSION_WITHOUT_PROBES_PROFILE` in `@rbw/schema`); `@rbw/admission` then records ADM-06 as `not_applicable`. A probe set without the entry still needs both probes, and its runs keep all 13 copies.

## RC-1.atomic-backup-code

The target is `src/app/api/2fa/verify/route.ts` at host commit `ec0ff50388c264ed8ce46f00967e92f7e71476ae` (mode `100644`, SHA-256 `3e766a0b…cb87`). The mutation is one line, line 97, in the backup-code `updateMany` inside `POST`:

```diff
-      where: { id: unusedCodes[matchIndex].id, used: false },
+      where: { id: unusedCodes[matchIndex].id },
```

The planted file hashes to `30426f04…66fb`. Between the `findMany` that reads the unused codes and this write, the handler awaits the bcrypt compare, so two concurrent requests can both read the code as unused and both succeed.

- `rc-1.atomic-backup-code` matches the `where` object `{ id: unusedCodes[matchIndex].id, used: false }` passed to `prisma.client.twoFactorBackupCode.updateMany` inside `POST`. Its fix, `{ id: $ID }`, drops the guard. `rc-1.atomic-backup-code.planted` matches the guardless object in the same place.
- `rc-1.atomic-backup-code.source` anchors the upstream fix, commit `3e165a8c6fea303250e626dc952a396e40887c71` ("fix(2FA): backup code double-use race condition") with its only parent `b4bb9cc727cd0ec05dc233e3e1f506f2e3633e34`. It finds `prisma.client.twoFactorBackupCode.update(…)` before the fix and `.updateMany(…)` after it. `src/rc1.ts` pins both blobs.
- `probes.json` holds the mutation alone. It names the race fixture's two checks (`packages/umami-fixture-rc1`): the serial control `rc1.backup-code-serial-reuse`, expected to pass on the planted copy, and the race `rc1.backup-code-concurrent-double-spend`, expected to fail there with the reason `double_spend`. The local runner refuses a run whose fixture vector differs from this one. ADM-06 is recorded as not applicable, with the reason.

The label is `partial_reversion`, tier `A`: the source fix and the target are the same handler, through the same Prisma API, and the mutation reverts only the fix's `used: false` guard. It keeps the fix's `updateMany` and its `consumed.count === 0` branch, which the planted code can no longer reach. That dead branch is visible to anyone reading the planted file.

There is no `confirm-target` or `confirm-source` command for this shape yet. The unit tests check the rules on synthetic sources, and `test:upstream` checks them, the recorded hashes and the mutation patch against the pinned blobs.

## Class rules and site finding

The site rules above name one file, function and variable. The class rules name none of them: they match a bug class by its structure, so one rule finds every site of the class in a host tree. Each class has a fixed-form rule, whose fix plants the bug at a site, and a planted-form rule, `<id>.planted`, that matches what the fix produces. Both share `metadata.class_id`.

| Class | Fixed form (matched) | Planted form (after the fix) |
| --- | --- | --- |
| `RACE.guarded-write` | A function reads a model (`find*` or `count` on `<client>.<model>`) and also writes the same model (`update`, `updateMany`, `delete` or `deleteMany`) with a `where` that holds a state guard after at least one other key. A guard is a key that is not an identity or scope key (`id`, `*Id`, `*_id`), with a literal value (`false`, `true`, `null`, a number or a string), a comparison object (`{ lt: limit }`), or a version key (`version`, `updatedAt`, and similar). The guard makes the write apply only while the state it read still holds. | The guard and the comma before it are removed, so the write applies even when another request changed the record after the read: two concurrent requests can both spend the same record. The planted form counts only when every key left in the `where` is an identity key (`id`, `*Id`, `*_id`), and `findSites` further requires each one other than `id` to be a key of the read's own `where` with the same value text, where that value is a literal or a name bound by `const` in the enclosing function (a `let` or `var` binding or a parameter may be reassigned between the read and the write, so it never confirms). A write in a function nested inside the read's is never confirmed, not even through the read's own `id`, because a parameter there can shadow the read's value. |
| `RACE.check-then-act` | An `upsert` whose argument has exactly `where`, `update` and `create`, in any order, that is the direct operand of `await` in its own statement (`await <client>.<model>.upsert(...);` or `const row = await <client>.<model>.upsert(...);`), and not inside any argument of a `$transaction(...)` call. | A `findUnique` on the same `where`, then an `update` or a `create` depending on the result. Two concurrent requests can both see no record and both create it. |

The rules leave out, by design: a guard in the first position of `where` (the rewrite takes the comma before the guard), a guard in a `where` that holds a comment anywhere (the rewrite removes only the guard and the comma next to it, and a comment beside either could leave a stray comma), a guard nested in `AND`/`OR`, an `upsert` with any other entry in its argument (another key such as `select: {...}`, a shorthand key such as `select`, or a spread such as `...base`), which the rewrite would drop, an `upsert` that is not the direct operand of `await` in its own statement (a promise kept in a variable and awaited later, passed to another call such as `Promise.all` or a batch `$transaction([...])`, or chained with `.then` or `.catch`), including any returned `upsert` (`return db.m.upsert(...)`, `return await db.m.upsert(...)`, or the body of an arrow such as `async (tx) => tx.m.upsert(...)`), whose caller may keep the promise and change an input object before awaiting it, after the split form has started its lookup, any `upsert` inside an argument of `$transaction(...)`, whether a batch array or an interactive callback such as `$transaction(async (tx) => tx.m.upsert(...))`, because code between the call and the await could change the values the split form reads after the lookup, an `upsert` whose argument names `found`, or holds an `await`, a `yield`, a call, a `new`, an assignment or an increment, or whose client is computed by a call (the rewrite evaluates its values later, once or twice, inside a callback that binds `found`), a read inside a callback nested in the function, which may never run before the write, a read that is not the direct operand of `await` in its own statement or initializer (a read promise created before the write and awaited later, or passed to another call such as `Promise.all`), which may not have finished when the write runs and so never counts as the read before it, the planted form of a write inside a function nested relative to the read, which is never confirmed, not even through the read's own `id`, because a name there may bind something else (a callback parameter can shadow the read's value), and writes through anything other than `<client>.<model>.<method>(...)`.

`findSites(root, ruleBytes, prefix)` scans every `.ts` and `.tsx` file under `root`, parsing `.tsx` files as TSX so code inside JSX is read (skipping `node_modules`, `.git`, build output and `.d.ts` files). For each fixed-form match it applies the fix to that match alone and records:

- `class_id`, `rule_id`, `path` (with `prefix`), `line`, `column`, the nearest named enclosing `function` and the `matched` text;
- `diff`: a git-style unified diff of that one site, and the file's `original_sha256` and `result_sha256`;
- `planted_form_confirmed`: the planted-form rule matches the rewritten file at the edited spot (false when any key other than the record's identity remains in the `where`, whatever its value: a second guard in any position, including the first, a field compared with what was read such as `status: row.status`, an `AND`/`OR`/`NOT`, a spread such as `...expected`, which may carry a guard the rule cannot see, or an identity-like key such as `ownerId` that the read's own `where` does not filter on, filters on with a different value, or filters on with a value that is neither a literal nor a `const` name of the enclosing function). A `where` with two guards gives one site per guard, and each rewrite keeps the other guard, so the write stays conditional and may still stop the second request; such sites are therefore always ranked `low`. This includes a guard paired with a soft-delete key such as `deletedAt: null`, which the rule counts as a guard;
- `confidence`: named boolean `signals`, a `score` that sums their weights, and a `level` (`high` from 0.75, `medium` from 0.45, otherwise `low`; always `low` when the planted form is not confirmed).

| Class | Signal | Weight | Holds when |
| --- | --- | --- | --- |
| `RACE.guarded-write` | `read_before_write` | 0.3 | A read of the same model, awaited directly in its own statement or initializer, ends before the write starts. |
| | `read_checks_guard` | 0.25 | That read filters on the guard key with the same value, or the code reads `<read result>.<guard key>` between the read and the end of the write. |
| | `write_result_used` | 0.2 | The write's result is bound to a name that is used after the write (for example, a `count` check). |
| | `identity_from_read` | 0.15 | Another key of the `where` uses the read's result. |
| | `await_between` | 0.1 | Another `await` sits between the read and the write. |
| `RACE.check-then-act` | `not_in_batch_transaction` | 0.3 | The `upsert` is not inside the array of a batch `$transaction([...])`, where the split form would not run. The rule already leaves out every `upsert` inside a `$transaction(...)` argument, so this holds for every match; it stays as a second check. |
| | `create_covers_where` | 0.25 | Every key of `where` appears in `create` with the same value. |
| | `request_handler` | 0.25 | An enclosing function is named `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, or the path has an `api` directory. |
| | `where_is_object` | 0.2 | `where` is an object literal. |

The confidence ranks sites for the next steps; it does not prove a site is a race or that a planted copy can be told apart by tests. The report (`rule_sha256`, `classes`, `files_scanned`, `site_count`, `sites` sorted by path, line, column and rule) is canonical JSON, so the same tree gives the same bytes. A list of sites in a real host can describe weaknesses in that host, so it is kept out of this repository; the tests use the synthetic tree in `test/unit/fixtures/race/`.

## Command line

```sh
node packages/shapes/src/cli.ts confirm-target --file <file> --path <repository path> --route <route file> \
  [--mode <git mode>] [--rule <rule file>] [--record <out>] [--declared-mutation <out>]
node packages/shapes/src/cli.ts confirm-source --git-dir <dir> --commit <sha> --parent <sha> [--rule <rule file>] [--record <out>]
node packages/shapes/src/cli.ts check-probes --planted <file> [--record <out>]
node packages/shapes/src/cli.ts find-sites --root <source dir> [--prefix <repository path prefix>] [--rule <class rule file>] [--record <out>]
```

Records are canonical JSON with sorted keys. Identical inputs give identical bytes. Without `--record`, the record goes to stdout. Without `--mode`, the mode comes from the file's execute bits. Exit codes:

- 0: confirmed, or for `find-sites`, the scan ran (the site count goes to stderr);
- 1: `not_applicable`, `unsupported_source_match` or `refused`, with the reason printed to stderr;
- 2: the command cannot run (bad usage, unreadable input, malformed rule or probe data, or a failing git command).

## Tests

| Script | What it does |
| --- | --- |
| `pnpm --filter @rbw/shapes run test` | Unit tests on synthetic sources, including the rule test cases through the napi engine and `ast-grep test`. No network. |
| `pnpm --filter @rbw/shapes run test:upstream` | Checks both shapes against the pinned Umami blobs. It reads them from the git directory in `RBW_UMAMI_GIT_DIR`, or fetches the pinned commits into a temporary directory. When neither is possible, it prints a skip message and exits 0. It is not part of `pnpm test`. |
| `build`, `typecheck`, `lint` | The workspace's standard scripts. |

No Umami source file is committed. The probe patches carry a few lines of context from the pinned file.

## Not in this package

- Building or running Umami, and the added checks themselves.
- Mutation IDs and task revisions (the schema package computes identity hashes).
- Other site-level shapes and other candidates. Planting the class sites in a copy, screening them and writing their checks.
- The race fixture's concurrent check: it lives in `packages/umami-fixture-rc1`, with the race kit image in `kit/umami-race`.
