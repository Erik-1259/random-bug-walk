# @rbw/projection

Trusted-side tool that decides whether a solver-visible copy of a host application holds exactly the pinned upstream source, minus approved whole-file exclusions, plus one declared source change, and nothing that gives the answer away. It implements part of ADM-01 (pinned source, source-only permitted change, no history or answer-bearing artifacts) and the deterministic scope-and-leak scan of ADM-07.

It has three commands:

- `manifest` builds the tracked-source manifest from the pinned commit.
- `commit-neutral` writes the copy's neutral single-commit git history.
- `audit` checks a finished copy before it is built.

The term list and the policy stay on the trusted side. Neither is committed or placed in the copy.

The package needs Node 24 and the git CLI, and has no runtime dependencies. Commands run from source:

```text
node packages/projection/src/cli.ts manifest --repo <git dir> --commit <sha> --out <file>
node packages/projection/src/cli.ts commit-neutral --dir <copy> --policy <file>
node packages/projection/src/cli.ts audit --manifest <file> --policy <file> --mutation <file> --terms <file> --copy <dir> --report <file>
```

Exit codes: 0 done (or audit `pass`), 1 audit `refused`, 2 usage error, malformed input, or audit `unavailable`. An unavailable audit is never a pass.

Every git call ignores global and system configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), drops the caller's `GIT_*` variables, points `core.hooksPath` at an empty directory, and ignores replace refs (`GIT_NO_REPLACE_OBJECTS=1`). Git's stderr is discarded.

## Inputs

All JSON inputs and outputs use snake_case keys and reject unknown keys. They are written with sorted keys and no insignificant whitespace (UTF-8, no trailing newline). Paths inside them are repository-relative POSIX paths. An absolute path, an empty, `.` or `..` segment, a backslash or a NUL makes the input malformed (exit 2).

### Tracked-source manifest

`manifest` reads `git ls-tree -r -l -z` and the blob bytes (`git cat-file --batch`) at the commit, never a working tree:

```json
{"files":[{"mode":"100644","path":"README.md","sha256":"<64 hex>","size_bytes":123}],"host_commit":"<40 hex>"}
```

- `files` holds one entry per tracked blob, sorted by the path's UTF-8 bytes.
- `mode` is `100644` or `100755`.
- A tracked symlink (`120000`) or submodule (`160000`) is refused with `manifest: unsupported_tracked_entry <path>` and exit 2.
- On success the command prints `manifest_sha256=<hex> files=<n> executable=<n>`. The hash is taken over the file's canonical bytes.

### Projection policy

```json
{
  "dependency_links": [{"path": "node_modules", "root": "/absolute/dir/outside/the/copy"}],
  "exclusions": [{"category": "original_test", "path": "src/app/api/auth/login/route.test.ts"}],
  "neutral_commit": {"date": "2000-01-01T00:00:00Z", "email": "workspace@example.invalid", "message": "Initial commit", "name": "workspace"}
}
```

- `exclusions`:
  - Each `path` is a file, or a directory ending in `/` that covers every manifest file under it.
  - `category` is one of `original_test`, `answer_metadata` or `revealing_comment`.
  - An entry that matches no manifest file makes the policy malformed, and so does a file that gets two categories.
  - Exclusions remove whole files only. Retained bytes are never rewritten.
- `dependency_links` are symlinks inside the copy that the audit does not enter.
  - A link must resolve inside its `root`, an absolute directory outside the copy.
  - A link path may not be a manifest path or one of its ancestors.
- `neutral_commit` and each of its fields are optional. The defaults are shown above.
  - `date` is RFC 3339 UTC ending in `Z`.
  - `name` and `email` must be non-empty and contain no `<`, `>` or line break.

The report records the SHA-256 of the policy's canonical bytes with the defaults filled in, so key order and whitespace do not change it.

### Declared mutation

```json
{"diff":"<git-style unified diff>","files":[{"mode":"100644","original_sha256":"<64 hex>","path":"<path>","result_sha256":"<64 hex>"}],"host_commit":"<40 hex>"}
```

This version supports modifications only. Each file must:

- exist in the manifest;
- not be excluded;
- keep its manifest mode;
- have an `original_sha256` equal to its manifest hash.

`host_commit` must equal the manifest's.

The diff needs one `diff --git` section per listed file and touches no other file. Each section has an optional `index` line, `--- a/<path>` and `+++ b/<path>`, then hunks. Sections with mode changes, new or deleted files, renames, copies, binary patches or quoted paths are malformed.

Hunks apply only at the line numbers their headers state, with no fuzz and no offset. A `\ No newline at end of file` marker is accepted only on a non-empty last line of its side, and a result with a missing newline anywhere but the end is refused, so forward and reverse application are inverses. The pinned bytes are not in the copy. The audit therefore checks that the copy's file hashes to `result_sha256`, and that reversing the diff on it gives bytes that hash to `original_sha256`. Together these mean that applying the diff to the pinned bytes gives exactly the declared result.

### Term list

The host supplies the term list at run time:

- One term per line, written `strict:<term>` or `generic:<term>`.
- Whitespace around each line and each term is trimmed.
- Blank lines and lines starting with `#` are ignored.
- Any other line, an empty term, or bytes that are not UTF-8 make the list malformed.

A missing, unreadable or malformed list, or one with no strict term, makes the audit `unavailable` (`error=terms_unavailable`). A list path that resolves inside the copy, lexically or through a symlink, is refused (`error=terms_inside_copy`). Output never contains a term, a line of the list, or which term matched.

## `commit-neutral`

The command refuses a copy that already has a `.git` (`commit-neutral: git_exists`, exit 2). Otherwise it:

1. runs `git init` with an empty template and `--initial-branch=main`, so no sample hooks are written;
2. sets `core.logAllRefUpdates=false` in the new repository;
3. writes one parentless commit on `refs/heads/main` with `git fast-import`, as loose objects only (`fastimport.unpackLimit`). Author and committer are both the policy's neutral identity at its fixed date (`+0000`), with its fixed message;
4. fills the index with `git read-tree`, with the index format pinned (`index.version=2`, no split index).

The commit holds every regular file in the copy outside `.git`, with its executable bit, including the declared mutation. `fast-import` stores the exact bytes, without `.gitattributes` or line-ending filters. Symlinks (including the declared dependency links), special files and names that are not UTF-8 are left out, and the audit refuses the undeclared ones. On success the command prints `commit=<sha>`. The same copy and policy give the same commit SHA.

## `audit`

The audit walks the copy without following symlinks and reports every finding. Each finding has a stable reason and a location:

| Reason | When |
|---|---|
| `unlisted_file` | A regular file is not in the manifest and no more specific reason applies |
| `missing_file` | A manifest file that is not excluded is absent |
| `changed_bytes` | An included, unmutated file's SHA-256 differs from its pinned hash |
| `mode_changed` | An included file's executable bit differs from its manifest mode |
| `excluded_present` | An excluded file is present |
| `mutation_mismatch` | A mutated file's bytes do not hash to `result_sha256`, or reversing the diff does not give `original_sha256` |
| `symlink` | A symlink that is not a declared dependency link, or a declared link whose target does not resolve inside its `root` |
| `path_traversal` | An undeclared symlink whose target escapes the copy, or a name with a backslash, a control character, or bytes that are not UTF-8 |
| `special_file` | A FIFO, socket or device node |
| `inherited_build_artifact` | Outside the manifest: a `.next`, `.turbo`, `.swc` or `.cache` directory, or a `*.map`, `*.tsbuildinfo` or `.eslintcache` file |
| `strict_term` | A strict term in a file's contents (`path:line`), in a path, at the entry where the term is first complete (`path`; terms containing `/` are matched across segments), in the commit object (`.git:line`), in any other file under `.git` (`.git/<file>:line`), or in any name under `.git` that git did not choose itself (`.git/<path>`). Object names, git's fixed directory names, the index, `HEAD` and ref files are checked exactly instead, so a term that looks like hex or a git keyword does not match them |
| `git_missing` | No `.git` directory: absent, a `gitdir:` file, a symlink, or not a usable repository |
| `git_history` | More than one commit reachable from the refs, a commit with a parent, no `refs/heads/main`, a `.git/shallow`, `info/grafts`, `objects/info/alternates`, `objects/info/http-alternates` or `commondir`, a replace ref, a reflog under `.git/logs`, any top-level `.git` entry other than `HEAD`, `config`, `index`, `packed-refs` (regular files) and `objects`, `refs`, `hooks`, `logs` (directories), such as `modules/`, `COMMIT_EDITMSG`, `MERGE_MSG` or a file under `info/`, or anything under `.git` that is not a regular file or directory, or cannot be read (never opened; when there is any, no git command runs on the copy) |
| `git_identity` | The commit object is not exactly `tree`, any `parent` lines, then author and committer as the policy's neutral identity, a blank line and the policy's message: a different identity, date or message, another header (such as a signature), a continuation line or a second `tree` |
| `git_tree_mismatch` | The commit's tree does not hold exactly the copy's regular files with the same bytes and modes, or holds a subtree (empty or not) that contains none of them (location: the differing path), or its tree object is not byte for byte the one those files give (location `.git`), or `.git/index` is not byte for byte what `git read-tree` of the commit writes, as `commit-neutral` leaves it (location `.git/index`; an index that git has refreshed or extended is refused) |
| `git_extra_ref` | Any ref other than `refs/heads/main`, a file under `refs/` that git does not read as a ref or that holds anything but one object id, a `HEAD` that is not exactly `ref: refs/heads/main`, a `packed-refs` file, a remote in `.git/config`, or a top-level `*_HEAD` file such as `ORIG_HEAD` or `FETCH_HEAD` |
| `git_extra_object` | An object in the store that the commit does not reach (location `.git/objects/<xx>/<rest>`); a loose object that does not inflate completely to bytes hashing to its name, or has data after its compressed stream; or any other file in `objects/`, including packs, pack indexes and `info/packs`, since `commit-neutral` writes loose objects only |
| `git_hooks` | Any entry in `.git/hooks` |

Directory-level artifacts are reported once, at the directory. A file path that is in the manifest is never an artifact, so tracked files under `tests/api/coverage/` and tracked source maps are allowed. When `refs/heads/main` is missing, the identity and tree checks run on `HEAD`'s commit.

The audit runs only git plumbing commands against the copy's `.git`.

### Term scan

- Matching is case-insensitive and literal.
- A run of whitespace in a term matches any run of whitespace in the content, so a phrase wrapped across lines is still caught. The finding's line is where the match starts.
- Content that is not valid UTF-8 is scanned as bytes with ASCII case folding only.
- Strict terms fail anywhere: file contents (pinned or not), every path segment, and the commit object's identity and message.
- Generic terms never fail. A generic match that touches a line the declared diff adds goes in the report's `review` list as `path:line`. Generic matches elsewhere are ignored.
- The shortest run of whole path segments that holds a strict term is shown as `[redacted-N]` in every output, so a location never reveals a term. Placeholders are numbered by the sorted redacted text.
- In the report's `git` block, an identity field that holds a strict term is shown as `[withheld]`. The message itself is not reported.

Shipped prose is scanned like every other file. The report lists the prose files it found:

- every `README*`, `CONTRIBUTING*`, `CHANGELOG*` and `HISTORY*` file at any depth;
- root-level `*.md`, `*.mdx` and `*.markdown`;
- everything under `docs/`.

### Output

stdout carries `verdict=<verdict>`, then one `<reason> <location>` line per finding, then one `review <location>` line per review entry. When the audit is unavailable it prints `verdict=unavailable error=<code>`. A location that is not plain printable ASCII, or that holds a quote or backslash, is printed JSON-quoted.

Unavailable codes:

- `copy_unreadable`
- `report_inside_copy` (no report is written)
- `terms_inside_copy`
- `terms_unavailable`
- `malformed_manifest`
- `malformed_policy`
- `malformed_mutation`
- `report_unwritable`
- `internal_error`

### Report

`--report` is written with mode 0600 (also over an existing file). It is trusted-side evidence, not for publication. The same inputs give the same bytes. Its keys:

| Key | Content |
|---|---|
| `verdict`, `exit_code` | `pass` 0, `refused` 1 |
| `manifest_sha256`, `policy_sha256` | SHA-256 of the canonical bytes |
| `terms_sha256` | SHA-256 of the term-list file |
| `exclusions` | The expanded exclusion list, `{category, path}` sorted by path |
| `counts` | `included` (manifest files not excluded), `excluded`, `mutated` |
| `git` | `commit`, `author` and `committer` (`name`, `email`, `date`, `timezone`) and `message_matches_policy`, or null when there is no usable commit |
| `prose_files` | The shipped prose files scanned |
| `findings` | `{line, path, reason}` sorted by path, then line, then reason; `line` is null for file-level findings |
| `review` | `path:line` entries for generic terms in added lines |

An unavailable audit writes `{"error":"<code>","exit_code":2,"verdict":"unavailable"}`.

## Tests

`pnpm --filter @rbw/projection test` runs the Vitest suite. It builds synthetic git repositories and copies in a temporary directory, needs no network, and uses only synthetic terms (`synthetic-strict-canary`, `synthetic strict phrase`, `synthetic-generic-word`). Test names carry the ADM ID they cover.

## Not in this package (planned elsewhere)

- Building the image, applying patches during a run, and re-scanning the built layout before grading.
- Dependency and toolchain manifests.
- Issue-text leak checks and phrase searches.
- Mutations that add, delete or rename files, or change a mode.
- Choosing the real exclusions and terms, which the host owns.
