# @rbw/publisher

The trusted publisher. It publishes a terminal root run's experimental record to the public results repository and the public artifact store exactly once. In every other case it publishes nothing beyond a scanned `PublicRunStatus`.

It runs only on the host or in private CI. Nothing in it passes credentials to sandboxes, agents, app copies or models. It runs under Node 24 directly after `pnpm install`:

```
node packages/publisher/src/cli.ts policy  --project-id <uuid> --output-repository <url> --artifact-base-uri <url> --policy-version <n> --out <file>
node packages/publisher/src/cli.ts publish --policy <file> --root-run <file> --staging <dir> --state <dir> --patterns <file> [options]
node packages/publisher/src/cli.ts status  --state <dir>
```

## `policy`

Builds and validates a `ProjectPolicy` with purpose `public_demo` and visibility `public`, writes its canonical bytes to `--out`, and prints `project_policy_sha256`. An existing file is never overwritten: identical bytes print the hash again, different bytes exit 4. A new configuration needs a new `--policy-version` and a new file.

## `publish`

| Flag | Default | Meaning |
|---|---|---|
| `--policy <file>` | required | Frozen policy file. It must hold canonical bytes of a `public_demo`/`public` policy. |
| `--root-run <file>` | required | `RootRun` file. Its `project_id` and `project_policy_sha256` must match the policy. |
| `--staging <dir>` | required | Staging directory (layout below). Read only when freezing, and never modified. |
| `--state <dir>` | required | Private state directory, outside this repository, staging and the local destinations. Created with mode 0700. |
| `--patterns <file>` | required | Private pattern file, passed to the scanner and never read, copied or logged by the publisher. |
| `--redaction-values <file>` | none | Private redaction-values file (format below), read only when freezing. |
| `--branch <name>` | `main` | Target branch of the results repository. |
| `--replace` | off | Freeze a replacement candidate for a root whose current candidate is `blocked`. |
| `--local-remote <dir>` | local mode | A bare repository standing in for the results repository. It must be hook-free: git runs a local remote's own receive hooks, so an executable file in its `hooks/` (other than `*.sample`) or a `core.hooksPath` or `include` setting in its `config` is refused (exit 4). |
| `--local-store <dir>` | local mode | A directory standing in for the public store; the policy's base URI maps to it. |
| `--real` | off | Real mode: the policy's destinations and both credentials. |
| `--repository-url <url>` | real mode | Must equal the policy's `output_repository`, which must be on `github.com`. |
| `--artifact-base-uri <url>` | real mode | Must equal the policy's `public_artifact_base_uri`. |
| `--deploy-key-env <name>` | `RBW_RESULTS_DEPLOY_KEY_FILE` | Variable holding the deploy key's file path. Names that child processes inherit (`PATH`, `HOME`, `LANG`, `LANGUAGE`, `LC_*`) are refused. |
| `--store-token-env <name>` | `RBW_PUBLIC_STORE_TOKEN` | Variable holding the public store's read-write token. The same names are refused. |
| `--scanner <command>` | this Node binary running `tools/publication/src/cli.ts` of this checkout, by absolute path | Scanner command prefix, split on ASCII spaces. A relative token that names an existing file, such as `tools/publication/src/cli.ts`, is resolved against the current directory, because the scanner runs from a temporary directory. |
| `--gitleaks <command>` | the scanner's default | Passed to the scanner as `--gitleaks`, with relative file tokens resolved the same way. |
| `--scan-timeout-ms <n>` | `600000` | A scan that runs longer counts as unavailable. |
| `--large-threshold-bytes <n>` | `1048576` | Files larger than this go to the store; the rest go to the repository. |
| `--limit-push-attempts <n>` | `3` | Pushes per root: the first push and two retries. |
| `--limit-metadata-requests <n>` | `6` | Fetches of the results branch per root; each attempt makes one. |
| `--limit-new-public-bytes <n>` | `67108864` | New public bytes per root: each uploaded object, and the repository payload once however many pushes it takes. |
| `--limit-transfer-bytes <n>` | `134217728` | Uploads, pushed files on every push, and the bytes verification reads receive, per root. |
| `--limit-store-operations <n>` | `200` | Store reads and writes per root. |

Every local path is resolved against the current directory.

### Exit codes and output

| Exit | Meaning | stdout |
|---|---|---|
| 0 | published | the `PublicationRecord` as canonical JSON and a newline |
| 1 | blocked | the record; stderr lists only `path:line` locations |
| 2 | failed (or an internal error, which prints nothing on stdout) | the record |
| 3 | status only (root not terminal) | the `PublicRunStatus` |
| 4 | invalid input or configuration; nothing was written anywhere | nothing; stderr names the problem without echoing values |

Log lines go to stderr as `publisher event=<name> key=value ...`. They hold IDs, counts, statuses, store keys and codes, never file contents, redaction values, credentials or staged paths.

### Credentials

Real mode reads exactly two credentials from the publisher's environment, and only in real mode. Local mode reads neither. The publisher never reads `.env` files and never falls back to a library's default variable such as `BLOB_READ_WRITE_TOKEN`.

| Variable (default name) | Holds | Reaches |
|---|---|---|
| `RBW_RESULTS_DEPLOY_KEY_FILE` | Absolute path of the results repository's deploy key (write access). The file must be owner-only (no group or other permission bits) and outside this repository, staging and the state directory. Its contents are never read by the publisher. | Only the push process, through `GIT_SSH_COMMAND`: `ssh -i <path> -o IdentitiesOnly=yes -o BatchMode=yes -F /dev/null -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<known hosts>` |
| `RBW_PUBLIC_STORE_TOKEN` | The Vercel Blob read-write token. | Only the Vercel Blob SDK's `put`, as its explicit `token` option |

The push goes to `git@github.com:<owner>/<repo>.git`, derived from `output_repository`. The fetch reads the public HTTPS URL without credentials. Store reads use plain public HTTPS requests without credentials.

Every child process is spawned without a shell and with an environment built from an allowlist (`PATH`, `HOME` and the locale variables). The scanner gets nothing else. git also gets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_TERMINAL_PROMPT=0`, and runs with `core.hooksPath=/dev/null`, an empty `credential.helper`, `core.autocrlf=false` and `commit.gpgSign=false`. Trace variables never pass the allowlist.

`config/github_known_hosts` holds GitHub's published SSH host keys; the file names its source. The push always uses this committed file; no flag replaces it.

### Staging layout

- Top level: only `inputs/`, `generated/`, `logs/`, `results/`, `report.md` and the optional `omissions.json`.
- Paths are relative POSIX paths. Each segment uses only letters, digits, `.`, `_` and `-`, and never starts with `.`.
- Regular files only, and no two paths that differ only by case.
- Child files go under `<category>/<child_execution_id>/`. A file one level deeper sits in a trial directory: `<category>/<child_execution_id>/<trial_id>/...`. A UUID-shaped segment right after the category must be the root's ID or one of its children's IDs; a UUID-shaped segment anywhere deeper is refused.

### Omissions file

`omissions.json` is private input and is never published. It is a `StagingOmissions` record:

```json
{
  "schema_version": 1,
  "entries": [
    { "outcome": "truncated", "path": "logs/run.log", "execution_id": "<uuid>", "trial_id": null, "reason": "size_limit" },
    { "outcome": "not_produced", "path": "results/<child>/<trial>/score.json", "execution_id": "<child>", "trial_id": "<trial>", "reason": "stage_failed" },
    { "outcome": "withheld_private", "execution_id": "<child>", "trial_id": "<trial>", "reason": "private_material" }
  ],
  "redactions": [{ "path": "logs/run.log", "category": "credential", "count": 1 }]
}
```

A `truncated` path and every redaction path must be staged; a `not_produced` path must not be. A declared execution and trial must match the path. Reason codes and redaction categories come from the schema's fixed lists.

### Sanitizing and the redaction-values file

The sanitizer applies two rules to the copied bytes. The header rule (for valid UTF-8 files) replaces the value of an `Authorization`, `Proxy-Authorization`, `Cookie` or `Set-Cookie` line with ` [redacted:auth_header]`, keeping the name, the colon and the line ending. The values rule then replaces every listed value with `[redacted:<category>]`, left to right and longest value first. It never matches inside a marker either rule inserted. Each replacement counts once in the entry's `redactions`, merged with the declarations in the omissions file.

The file itself is UTF-8. Blank lines and lines starting with `#` are ignored. Every other line is a category code, one tab, then the value up to the end of the line (a final CR is dropped). An unknown category, a missing tab, an empty value or one value under two categories makes the file invalid (exit 4). A staged or declared path, a declared trial ID (including a `withheld_private` entry's), a declared stage of the `RootRun` or one of its execution IDs that contains a listed value is also invalid; the error never names the value.

### What `publish` does

For a root that is `prepared`, `running` or `needs_reconciliation`, it does not read staging. It scans a `PublicRunStatus`, writes it to the store key `status/<root_execution_id>.json` (the only mutable key, cached for 60 seconds, the shortest lifetime Vercel Blob accepts), prints it and exits 3. Each status write counts one store operation against the root's persisted limits (the same limits a later terminal publish uses), so this call creates `roots/<root>/limits.json` in the state directory. When the store operation limit is reached it writes nothing, says `status object not written: limit_exceeded` on stderr and exits 2.

For a terminal root:

1. **Freeze, on the first call only.** Read staging, sanitize the copied bytes, hash them, build the `RunManifest`, store everything in the state directory and record `prepared`. The publication ID is a UUID derived from the root ID and the manifest hash. Later calls reuse the frozen candidate and never read staging again.
2. **Scan, on every attempt.** Re-verify the frozen bytes against their hashes, the frozen file list against the manifest, and the manifest against the record (a difference records `failed` with `candidate_corrupt`), then run the scanner in files mode over a directory laid out as `runs/<root>/...` (every file, large ones included, and the manifest, so names are scanned too) and in text mode over the commit message. A blocked scan records `blocked` (`scan_blocked`) and exits 1; an unavailable scan, an unknown exit code, a crash or a timeout records `failed` (`scan_unavailable`) and exits 2.
3. **Inspect the remote branch** with one fetch, before any push-limit check, so a push that reached the remote without being recorded is found even after the last allowed push. If `runs/<root>/` exists with the candidate's tree, read every large object back, upload only a missing one, and record `published` with the commit that added the run. A different tree records `failed` (`repository_conflict`).
4. **Upload large objects first** to `sha256/<hex>`, reusing an object with the same bytes and never overwriting one, then read each back and check its hash and size (`store_mismatch` on a difference). Before the first upload it checks that a push attempt is left and that the uploads, their read-back and the push all fit the byte and store-operation limits, so a run that cannot finish uploads nothing.
5. **Commit and push.** One commit on the fetched head (or a first commit) adds only `runs/<root>/manifest.json` and the smaller files, as exact blobs with mode `100644`. Author and committer are `Random Bug Walk` with an empty email and `+0000` dates; the message is `chore(runs): publish <root>`. The push is fast-forward only. A rejected push records `failed` (`repository_unavailable`); the next call fetches again and retries.
6. **Record `published`** only after the push succeeded and every object was verified.

After each attempt, including one that finds the frozen candidate corrupt, it scans the status object on its own and rewrites it with the record's status; a failed or blocked status write is reported on stderr and changes neither the record nor the exit code. `published` is final: later calls print the stored record and contact nothing. Revising a published manifest is planned later work.

### Limits

Limits are counted per root in the state directory and persist across retries. The limits stored on first use can be lowered by later flags but never raised or reset. Reaching one records `failed` (`limit_exceeded`), and later calls print that record without contacting anything. An attempt after the last allowed push still makes its one fetch to inspect the remote, then records `limit_exceeded` without reading or uploading anything if the run is not there. The transfer limit counts uploads, pushed files and the bytes verification reads receive (a read of a missing object counts nothing); the bytes a fetch of the results branch downloads are not counted.

### State directory

```
roots/<root>/current                        publication ID of the current candidate
roots/<root>/limits.json                    limits, usage and the amounts counted once
roots/<root>/candidates/<id>/manifest.json  the frozen RunManifest
roots/<root>/candidates/<id>/files.json     the frozen file list
roots/<root>/candidates/<id>/blobs/<sha256> the frozen, sanitized bytes
roots/<root>/candidates/<id>/record.json    the latest PublicationRecord
repository.git                              the publisher's own bare repository
```

## `status`

Read-only. Prints `root <id> <status>` for each root with a candidate, sorted by ID, then `count <status> <n>` for `prepared`, `published`, `blocked` and `failed`.

## Integration proof

```
node packages/publisher/scripts/proof.ts --work <temp dir> [--patterns <file>] [--scanner <command>] [--gitleaks <command>]
node packages/publisher/scripts/proof.ts --work <temp dir> --real --policy <frozen policy> --branch <test branch> [--patterns <file>] [--scanner <command>] [--gitleaks <command>]
```

The proof creates a synthetic pattern file, a synthetic redaction-values file and synthetic staged runs (one child, one trial, one large file, one `not_produced` and one `withheld_private` entry, one declared redaction, and a log with a synthetic `Authorization` line and a listed value). In local mode it also creates a bare repository, a store directory and the placeholder policy. It runs four scenarios, each with fresh root IDs:

| Scenario | Expected |
|---|---|
| a | `published`; every blob and object matches the manifest; the log holds markers instead of the synthetic values; redactions appear as category and count only |
| b | publishing again gives the same record, no new commit and no upload |
| c | a synthetic forbidden term gives `blocked`, no commit and no upload; this scenario always uses the script's own pattern file |
| d | a `running` root writes only the status object |

It prints one line per scenario, then the `status` counts, and exits non-zero on any mismatch. Real mode reads both credentials through the publisher from the variables above, and checks the repository and the store without credentials.

## Tests

```
pnpm --filter @rbw/publisher test
```

The tests use a bare repository in a temporary directory, the filesystem store, the C2 scanner with a gitleaks stand-in that reports the version from `node tools/publication/src/cli.ts gitleaks-version` and no findings, and synthetic pattern and redaction-values files.
