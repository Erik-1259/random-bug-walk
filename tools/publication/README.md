# @rbw/publication

The publication boundary for agent work. It has four parts:

- **Scanner** (`src/cli.ts`, `scan()` from the package entry). Checks content against the private pattern list, the attribution rules and gitleaks. It runs in the container, on the host and in CI.
- **Host helper** (`src/helper.ts`). Answers publication requests from the inbox. It scans exactly what a push or PR text would make public, then pushes or posts those same bytes. Nothing is published unless that content scanned clean, and nothing is published when a check cannot run.
- **Wrapper** (`bin/rbw-publish`). The only publication route from inside the container. It writes one request into the inbox and waits for the helper's response.
- **Pre-push hook** (`hooks/pre-push`). Refuses every direct `git push` and points to the wrapper.

All four run under Node 24 directly, with no build step and no runtime dependencies outside the Node standard library. The helper also uses git, the gh CLI and, on the host, Docker for the pinned gitleaks image.

## Scanner

Run the scanner from the repository root:

```
node tools/publication/src/cli.ts scan --patterns <file> [--repository <owner>/<repo>]
    [--gitleaks <command>] [--license <file>]
    [ --range <base>..<head> | --files <path>... ] [ --text <name>=<file> ... ]
node tools/publication/src/cli.ts gitleaks-version
```

A call needs at least one input. `--range` and `--files` exclude each other. `--text` can be added to either, or used alone.

| Input | What is scanned |
|---|---|
| `--range <base>..<head>` | Every commit from `git rev-list <base>..<head>`. For each commit: the whole stored message (subject, body and trailers), followed by every commit header line except, by position, the first `tree` line, the `parent` lines right after it and one `author` and one `committer` line in their expected places (so a signature, an embedded tag, a repeated header name or a continuation line is scanned), numbered after the message's last line; the bytewise-sorted list of paths added or changed relative to the first parent, directory entries included (a root commit is compared with the empty tree); and the full content of each added or changed file, binary files and symlink targets included. Deleted files are not scanned. A submodule entry adds its path to the list but has no content. Author and committer fields are never scanned. History is read from the commit objects themselves: replace refs, a grafts file and commit-graph files are ignored. |
| `--files <path>...` | Each file's full content (a symlink's target text for a symlink), plus the list of given paths. Paths are relative to the current directory; a path outside it gives `unavailable`. |
| `--text <name>=<file>` | The file's content under a synthetic name matching `[A-Za-z0-9._-]+`. The helper uses `pr-title`, `pr-body` and `pr-comment`. |

| Option | Effect |
|---|---|
| `--patterns <file>` | The private pattern file (required). |
| `--repository <owner>/<repo>` | Turns on the repository URL exception for that repository. |
| `--license <file>` | The trusted `LICENSE` in files mode. In range mode the trusted `LICENSE` is always the root `LICENSE` at `<base>`. Text blobs never get the exception. |
| `--gitleaks <command>` | The gitleaks command (see below). Without the flag, `RBW_GITLEAKS_COMMAND` is used, and otherwise `gitleaks` on PATH. |

`gitleaks-version` prints the pinned gitleaks version, so CI and the host can fetch the same release.

### Output and exit codes

| Outcome | stdout | Exit |
|---|---|---|
| `clean` | `clean` | 0 |
| `blocked` | `blocked`, then one `<location>:<line>` per violation, sorted by location and then line, without duplicates | 1 |
| `unavailable` | `unavailable`; stderr may carry one generic category line | 2 |

A location is one of:

- a repository-relative path;
- `commit-<first 12 hex of the SHA>` for a commit message;
- `paths-<12 hex>` (range mode) or `paths` (files mode) for a path list, where the line is the path's 1-based position in that list;
- the synthetic name of a text blob.

A path that is itself a violation is never printed. Every violation in that file is reported under the path list position instead, for example `paths-0123456789ab:3`. The scanner never prints matched text, a term, the pattern file's path or contents, which check matched, raw gitleaks output or a stack trace.

`unavailable` is given for: a usage error; a pattern file that is missing, unreadable, not valid UTF-8 or has no terms; gitleaks failing to start, reporting another version, exiting with an unexpected status or writing an unparseable report; a git error; a path outside the current directory; and any internal error. An unavailable scan is never clean.

### Checks

**(a) Private pattern list.** The file is UTF-8; a byte-order mark and CRLF line endings are accepted. Each line is trimmed, blank lines and lines starting with `#` are ignored, and every other line is one term. Matching is a case-insensitive literal substring search after both sides are NFC-normalised and lower-cased, so characters such as `.`, `*` and `(` are literal. A run of whitespace inside a term matches any run of whitespace in the text, including a line break, and the reported line is where the match starts. The check covers file content, commit messages, path lists and text blobs. Content that starts with a UTF-16 byte-order mark is decoded as UTF-16 for checks (a) and (b); all other content is decoded as UTF-8.

**(b) Attribution.** Case-insensitive, over file content, commit messages and text blobs. A *line prefix* is any run of whitespace, comment or list markers (`#`, `//`, `/*`, `*`, `-`, `+`, `>`, `<!--`) and emoji or other symbol characters. The scanner flags:

- a line that, after the prefix, starts with a trailer token for a co-author, sign-off, review, ack, help or suggestion (the token, optional whitespace and a colon);
- a line that, after the prefix, starts with the word *generated*, whitespace, and then *with* or *by*;
- any line containing the robot face emoji (U+1F916);
- an attribution note anywhere: one of the verbs *edited*, *reviewed*, *requested* or *approved* followed by whitespace and the word *by*, or the three words *on*, *behalf* and *of* in sequence, as whole words with any whitespace between them;
- a line that, after the prefix, starts with an author tag (an at sign followed by *author*).

The bare word "per" is not flagged, and neither is any of these forms quoted mid-sentence.

**(c) Secrets.** gitleaks scans file content, commit messages and text blobs. Findings map back to `<location>:<line>` and stay redacted; gitleaks' own output is never relayed.

### Exceptions

Both exceptions apply to check (a) only.

- **Copyright line.** In a file named exactly `LICENSE`, in any directory, a line byte-identical to the trusted copyright line is exempt. That line is the first line of the trusted `LICENSE` that starts with `Copyright`; a trailing CR is ignored. A changed copyright line is checked like any other line.
- **Repository URL.** The configured `<owner>/<repo>` is exempt only inside `https://github.com/<owner>/<repo>` (optionally ending in `.git`), `git@github.com:<owner>/<repo>.git` and `github.com/<owner>/<repo>`, matched case-insensitively. The repository name must end at a character that cannot continue a name: `<repo>-private` and `<repo>2` get no exception, but a sentence-final `.` or a deeper path such as `/pull/12` is fine. The bare form must not follow a host-name character, so `gist.github.com/...` gets no exception. Every other occurrence of the owner name is checked.

### gitleaks command

The pinned version is **gitleaks 8.30.1** (`PINNED_GITLEAKS_VERSION` in `src/gitleaks.ts`).

The command value is split on ASCII spaces, with no quoting. Every occurrence of `{dir}`, including one inside a token such as `{dir}:{dir}`, is replaced by the scan's temporary directory, and the scanner appends gitleaks' own arguments. Two forms are in use, and they differ only in this prefix:

| Where | Command |
|---|---|
| Container, CI and tests | `/path/to/gitleaks` (a downloaded release binary) |
| Host | `docker run --rm --pull never --network none -v {dir}:{dir} ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` |

The operator pulls the image once and checks its digest; the host form names it by that digest and with `--pull never`, so a scan never pulls an image and never runs one that a re-tag points at.

Each scan creates one new temporary directory `{dir}` and removes it afterwards. Each blob is written as a new regular file at `{dir}/content/<n>/<repository path>`, so two blobs never share a file even on file systems that ignore case or Unicode normalisation. Path-based gitleaks rules still see the repository path at the end of each file's path. Each blob is also written a second time, at `{dir}/content/<count + n>/blob`, so content rules still apply when the repository path matches gitleaks' built-in path allowlist. Commit messages and text blobs are written as `message.txt` and `text.txt` in their own numbered directories. gitleaks receives every path as an explicit argument under `{dir}`: the content directory, a configuration that extends the built-in rules, an empty ignore file and the report path. It also receives `--ignore-gitleaks-allow`, so a `.gitleaks.toml`, a `.gitleaksignore` or an inline allow comment inside the scanned content has no effect. The scanner first checks `gitleaks version`. It then treats exit 0 as clean and its own leaks-found status (42) as findings; any other status, including gitleaks' error status 1, gives `unavailable`.

The built-in gitleaks rules come with a global path allowlist (for example lock files, images, and paths containing `gitleaks.toml`); the second copy of each blob under the neutral name keeps those paths covered. gitleaks itself skips content whose detected type is binary, such as content starting with a PDF header, in every mode; the secrets check does not cover such content, and the pattern and attribution checks still do.

## Library

```ts
import { scan } from "@rbw/publication";

const result = await scan({
  patternFile: "/host/path/patterns.txt",
  repository: "owner/repo",            // optional: URL exception
  gitleaksCommand: "/path/to/gitleaks", // optional: default "gitleaks"
  gitTimeoutMs: 300000,                 // optional: limit for each git child
  gitleaksTimeoutMs: 600000,            // optional: limit for each gitleaks child
  git: { repository: ".", head: "HEAD", exclude: ["main"], licenseRevision: "main" }, // or files: { root, paths, licenseFile }
  texts: [{ name: "pr-body", content: new TextEncoder().encode("...") }],
});
// { outcome: "clean" } | { outcome: "blocked"; locations: string[] } | { outcome: "unavailable" }
```

A request takes at most one git source or one files source, plus any number of text items, and needs at least one input. With no excluded revision, every commit reachable from the head is scanned. `scan()` never throws; any error becomes `unavailable`.

## Container side

### `rbw-publish`

```
tools/publication/bin/rbw-publish push [--sha <sha>]
tools/publication/bin/rbw-publish pr-create --title <text> --body-file <file> [--sha <sha>]
tools/publication/bin/rbw-publish pr-comment --body-file <file> [--sha <sha>]
```

| Option | Default | Meaning |
|---|---|---|
| `--sha <sha>` | `HEAD` | For `push`, the commit to publish. For PR operations, the published branch head the text describes. |
| `--claim-timeout <seconds>` | 60 | How long to wait for the helper to claim the request. |
| `--result-timeout <seconds>` | 900 | How long, from the start, to wait for a response once the request is claimed. |
| `--inbox <dir>` | `/inbox` | Inbox root; tests override it. |

The worktree id comes from the clone's local git config key `rbw.worktreeId`, and the worktree token from `rbw.worktreeToken`. The wrapper sends the token in every request and never prints it. Before writing a request, the wrapper checks that the id is set, that the token is 64 lowercase hex characters, that the SHA names a commit, that a title is one line of 1 to 256 characters, and that a body is valid UTF-8 with no NUL and at most 65,536 characters. If a check fails, it exits 2 without writing a request.

When the claim wait runs out, the wrapper deletes its request file. If the delete succeeds, the helper never saw the request, and the wrapper reports `unavailable`. If the file is already gone, the helper has claimed it, and the wrapper keeps waiting up to the result timeout.

Output: the outcome on the first line, then `publishedSha` (published) or one location per line (blocked). A `blocked` with no locations adds one fixed line saying that the request, its registration or the branch state was refused and that the conductor can see why in the host log.

| Exit | Meaning |
|---|---|
| 0 | published |
| 1 | blocked |
| 2 | unavailable (also a failed local check, or a request withdrawn after the claim wait) |
| 3 | stale |
| 4 | not an outcome: the helper claimed the request but no response arrived within the result timeout. The wrapper prints `unknown` and the request id, so the conductor can find the outcome in the host log. |

### Pre-push hook

`hooks/pre-push` refuses every push with exit 1 and points to `tools/publication/bin/rbw-publish push`. Agent clones enable it with:

```
git config core.hooksPath tools/publication/hooks
```

## Host helper

The conductor runs the helper with Node 24 from a host-owned checkout, never from an agent's working copy:

```
node tools/publication/src/helper.ts serve --inbox <inbox> --registry <registry.json> --state <state dir> \
    --patterns <pattern file> --gitleaks "<gitleaks command>" [--gh <gh command>] [--poll-interval-ms 2000] \
    [--pass-env SSH_AUTH_SOCK] [--git-timeout-ms 300000] [--gh-timeout-ms 120000] [--gitleaks-timeout-ms 600000]
```

- `serve` polls `requests/` at the poll interval until SIGINT or SIGTERM, finishing the current request first. An error in one request never stops it. It stops by itself, with exit 1 and one host-log alert line, when an inbox directory changes (see "Untrusted inbox").
- `once` processes the pending requests and exits.
- Only one helper runs per state directory. The helper takes `helper.lock` there at start-up, holding its process id, and refuses to start (exit 2) while another running process holds it. A lock left by a process that no longer runs is replaced only while the helper holds an exclusively created `helper.lock.takeover`, and only if the lock still holds what was read, so two helpers starting together cannot both run. If a takeover file is left behind, the helper refuses to start until the conductor removes it.

### Configuration

One loader reads each setting from its flag, then its environment variable, then the default.

| Flag | Variable | Default | Meaning |
|---|---|---|---|
| `--inbox` | `RBW_INBOX` | required | Host inbox root; the helper uses `<inbox>/publication/requests` and `<inbox>/publication/responses` (see "Untrusted inbox"). |
| `--registry` | `RBW_REGISTRY` | required | Host-only registry file. |
| `--state` | `RBW_STATE_DIR` | required | Host-only state directory. |
| `--patterns` | `RBW_PATTERNS` | required | Private pattern file. |
| `--gitleaks` | `RBW_GITLEAKS_COMMAND` | `gitleaks` | gitleaks command, in the format above. |
| `--gh` | `RBW_GH_COMMAND` | `gh` | gh command, split on ASCII spaces. |
| `--poll-interval-ms` | `RBW_POLL_INTERVAL_MS` | `2000` | `serve` poll interval. |
| `--pass-env` | `RBW_PASS_ENV` | none | Comma-separated names of extra environment variables for commands that reach the registered remote, and for gh (for example `SSH_AUTH_SOCK`). |
| `--git-timeout-ms` | `RBW_GIT_TIMEOUT_MS` | `300000` | Time limit for each git child, including the git commands the scan runs. |
| `--gh-timeout-ms` | `RBW_GH_TIMEOUT_MS` | `120000` | Time limit for each gh child. |
| `--gitleaks-timeout-ms` | `RBW_GITLEAKS_TIMEOUT_MS` | `600000` | Time limit for each gitleaks child. |

The helper refuses to start if the registry, the pattern file or the state directory cannot be resolved or lies inside the inbox or inside any registered working copy, or if git is older than 2.45.1. The refusal is one generic line that names no path. From that release on, upload-pack refuses lazy fetches by default.

### Environment given to git and gh

Every git, gh and gitleaks command gets an environment built from an allowlist: `PATH`, `HOME` and the locale variables (`LANG`, `LANGUAGE`, `LC_*`). No inherited `GIT_*` or `GH_*` variable passes. The helper always sets `GIT_NO_LAZY_FETCH=1`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1` and `GH_NO_UPDATE_NOTIFIER=1`, even when its own environment says otherwise. The `--pass-env` variables are added only for gh and for git commands that reach the registered remote: the remote branch read, the push and the `ls-remote` read-back. The fetch from a working copy never gets them. Every git command runs with `--no-replace-objects`, `core.hooksPath=/dev/null`, `core.fsmonitor=false` and `core.commitGraph=false`, and with `GIT_GRAFT_FILE=/dev/null`. Git runs against helper-owned bare repositories in the state directory, and gh runs from a helper-owned directory, so neither ever uses a working copy as its repository or current directory.

Every git, gh and gitleaks child runs in a session of its own, so it has no controlling terminal, and its stdin is not connected (only `git cat-file --batch` gets a pipe carrying the object names). Each child has a time limit (see the timeout settings); when it runs out, the child's whole process group is killed. A timeout gives `unavailable`, except after a push or post attempt, where the request stays pending and the resume rules settle it.

### Registry

A host-only JSON file that never lives in a repository or in the inbox. It is re-read for each request; if it is missing or invalid, the outcome is `unavailable`.

```json
{ "version": 1, "worktrees": { "<worktree id>": {
    "path": "<absolute host path of a standalone clone>",
    "remote": "<push URL, or a local bare repository for tests>",
    "repository": "<owner>/<repo> (needed for PR operations and the URL exception)",
    "branch": "<the only branch this worktree may publish>",
    "approvedBase": "<40-hex commit the branch may be created from>",
    "identity": { "name": "<author and committer name>", "email": "<author and committer email>" },
    "token": "<64 lowercase hex; the clone holds the same value as rbw.worktreeToken>" } } }
```

An entry is invalid if `branch` is `main` or not a valid branch name; if `remote` carries user information (other than the `git` user of an SSH URL), a password, a query or a fragment; if a path or `file:` `remote` lies inside the inbox or inside any registered working copy; if `path` is relative; if `approvedBase` is not 40 lowercase hex; if `identity` is not exactly a non-empty `name` and `email` without `<`, `>` or a line break; if `token` is not 64 lowercase hex characters; or if `repository` is set and `remote` is neither a recognised GitHub form (`https://github.com/<owner>/<repo>`, `ssh://git@github.com/<owner>/<repo>` or `git@github.com:<owner>/<repo>`, each optionally ending in `.git`) naming that repository nor a local path (used by tests).

The token check compares the request's `token` with the entry's in constant time. The identity check requires every commit a push would publish to have an author name, author email, committer name and committer email exactly equal to `identity`. When the remote has no branch heads yet, that includes the history of `approvedBase`, so the conductor seeds the remote's `main` at `approvedBase` first. Neither value appears in responses or the host log.

### Requests

The wrapper writes `requests/<requestId>.json` under a dot-prefixed temporary name in the same directory, then renames it into place. The helper ignores dot-files. A request is at most 1 MiB and has exactly these fields:

```json
{ "version": 1, "requestId": "<id>", "worktreeId": "<id>", "token": "<rbw.worktreeToken>",
  "operation": "push | pr-create | pr-comment", "sha": "<40 lowercase hex>",
  "title": "<pr-create only>", "body": "<pr-create and pr-comment only>" }
```

A request without `token` is still well formed, but the helper refuses it as `invalid-token`.

- `requestId` matches `[A-Za-z0-9-]{8,64}` and equals the file name. The wrapper builds it from a UTC timestamp and a random suffix. A file with any other name is logged on the host and never answered.
- `worktreeId` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- `title` is one line of 1 to 256 characters; `body` has at most 65,536 characters. Both are valid UTF-8 with no NUL.

### Responses

The helper writes `responses/<requestId>.json` as a new file followed by a rename:

```json
{ "version": 1, "requestId": "<id>", "requestedSha": "<sha, or null if the request was invalid>",
  "outcome": "published | blocked | unavailable | stale",
  "publishedSha": "<published only>", "locations": ["<location>:<line>"] }
```

| Outcome | Meaning |
|---|---|
| `published` | The remote now holds exactly the scanned content; `publishedSha` equals `requestedSha`. |
| `blocked` | Nothing was published. `locations` lists the content violations. It is empty for a refusal that is not about content; the category appears only in the host log. |
| `unavailable` | The helper, registry, pattern file, git, gitleaks or gh could not be used; nothing was published. |
| `stale` | Nothing was published; a new request is needed. The candidate could not be fetched, the remote branch moved before the push completed, or, for a PR operation, the remote branch head is not `sha`. |

Host-log categories for `blocked`: `content`, `invalid-request` (also a push `sha` that names a tag or other non-commit object), `unknown-worktree`, `invalid-registration`, `invalid-token`, `invalid-worktree`, `identity-mismatch`, `not-fast-forward`, `pull-request-exists` and `no-pull-request`. A timeout is logged as `timeout`.

### Claiming, records and resuming

- The helper claims a request by renaming it from `requests/` into `<state>/claimed/`, which agents cannot reach, so the state directory must be on the same device as the inbox (the helper refuses to serve otherwise). It reads it once and stores those bytes in the state directory; from then on, including after a restart, it works only from the stored copy. A restart also stores any claimed file that was not stored yet.
- Requests are processed one at a time, oldest first.
- Before writing a response, the helper records the request id and the full response in the state directory. That record decides whether a request is finished. A recorded id is answered again from the record and never re-executed, for example when its response file was deleted (rewritten at start-up) or the same id arrives again.
- On start, and on each poll in `serve`, the helper finishes every stored request without a record. A push is re-run, and is idempotent: if the remote branch already points at the SHA, the outcome is `published`. A push that reached `git push` before first reads the remote branch, so it is `published` when the branch holds the SHA, whatever the working copy holds by then. Until that check has run, a problem that would otherwise refuse such a request (a missing registry, an unknown or invalid entry, a changed token, a helper repository that cannot be prepared) keeps it pending instead of answering it. A PR request that reached gh before is first checked against GitHub. If an open PR from the branch already has the stored title and body (`pr-create`), or a comment with the stored body (`pr-comment`), ignoring line-ending differences and surrounding whitespace, the outcome is `published` and nothing is posted.
- Each start of work on a stored request is counted. A request that has made no push or post attempt and has already been started three times, for example because it ended the helper each time, is answered `unavailable` (`too-many-attempts`) without running it again.

State directory layout: `claimed/` (claimed request files), `requests/` (stored bytes), `records/`, `attempts/` (requests that reached `git push` or gh), `starts/` (start counts), `repositories/<worktree id>.git` (helper-owned bare repositories), `tmp/` (frozen PR text, mode 0600), `gh-cwd/` and `helper.log`.

### Untrusted inbox

The container launcher mounts `<inbox>/publication` read-only and `<inbox>/publication/requests` read-write inside it, so agents cannot rename or replace `publication/`, `requests/` or `responses/`, and cannot write into `responses/`. They can still create any entry inside `requests/`. The helper checks this layout itself:

- At start it checks `publication/`, `requests/` and `responses/` with `lstat`, in that order. It creates a missing one only inside a parent it has just verified as a real directory. If any of them is a symlink or not a directory, it writes nothing, logs the problem and refuses to serve (exit 1).
- It records the device and inode of the three directories, and re-checks them immediately before and after every claim, claimed-file read and response write, and at the start of every poll. On any mismatch it stops serving and writes one host-log alert line.
- A request file is opened only if `lstat` shows a regular file, without following symlinks or blocking, and only if `fstat` on the open file shows the same device and inode. Anything else is answered as an invalid request.
- Responses are created exclusively under a dot-prefixed name and renamed into place, so a symlink planted at a response path is replaced rather than written through.

The device and inode check depends on the old directory staying in place: a directory removed and recreated at once can get the same inode number back. The mount layout is what prevents the swap; the check is a second line of defence.

### Push

1. Check the request, its registry entry and its token. Check the working copy: `.git` and `.git/objects` must be real directories, with no `commondir` file and no non-empty `objects/info/alternates`. A failed check is `blocked` (`invalid-worktree`); a missing `path` is `unavailable`.
2. Fetch the candidate SHA into the helper-owned bare repository for that worktree id. The fetch requests protocol v2 through upload-pack against the working copy's `.git`, with lazy fetching off and fsck of the transferred objects. Afterwards the working-copy check runs again, and `.git` and `.git/objects` must still have the device and inode seen before the fetch; otherwise the candidate ref is deleted and the outcome is `blocked` (`invalid-worktree`). If the candidate cannot be fetched, the outcome is `stale`. If `sha` names a tag or any object other than a commit, the outcome is `blocked` (`invalid-request`).
3. Read the remote's branch heads into the helper repository.
4. The candidate must descend from the remote tip of the registered branch, or from `approvedBase` if that branch does not exist yet; otherwise `blocked` (`not-fast-forward`). If the branch already points at the candidate, the outcome is `published`. Every commit reachable from the candidate but from no remote branch head must carry the registered identity; otherwise `blocked` (`identity-mismatch`).
5. Scan every commit reachable from the candidate but from no remote branch head, with the URL exception for the registry's `repository` and the copyright line from the root `LICENSE` at `approvedBase`.
6. Push exactly `<sha>:refs/heads/<branch>` to the registered remote URL with `--force-with-lease=refs/heads/<branch>:<tip read in step 3>` (empty when the branch must not exist yet), with no tags, no submodules and no hooks.
7. If git push exits non-zero, read the branch back with `ls-remote`. It is `published` if the branch equals the SHA, `unavailable` if it still equals the leased tip (or is still absent), and `stale` otherwise. If the push timed out and the branch does not equal the SHA, or if the read-back fails, nothing is recorded and the request is settled when it is resumed.

### PR create and PR comment

- The entry needs a `repository` (otherwise `unavailable`), and the remote head of the registered branch must equal `sha` (otherwise `stale`).
- Open PRs are listed with `gh pr list --repo <repository> --head <branch> --state open --json number,title,body,isCrossRepository,headRepositoryOwner`. Only PRs with `isCrossRepository` false and a head owner equal, ignoring case, to the registry's owner are used, so a fork PR with the same branch name never counts.
- The title and body from the stored request are frozen into helper-owned files with mode 0600. Exactly those bytes are scanned (as `pr-title`, and `pr-body` or `pr-comment`) and sent: the body through `--body-file`, the title as `--title=<text>`.
- `pr-create` runs `gh pr create --repo <repository> --draft --base main --head <branch>`. If a selected open PR already exists, it is `blocked` (`pull-request-exists`).
- `pr-comment` runs `gh pr comment <number> --repo <repository> --body-file <file>` on the one selected open PR. If there is none, it is `blocked` (`no-pull-request`).
- If gh fails, the resume check runs before the helper answers, so it never answers `unavailable` when the text was in fact posted.

The helper has no merge, approval, label or release operation.

### Host log

One line per request on stdout, also appended to `<state>/helper.log`:

```
time=<ISO time> request=<id> worktree=<id> operation=<op> outcome=<outcome> category=<category> requested=<sha> published=<sha> pr=<number>
```

The log never contains request text, matched text, terms, the pattern file's path or raw output from the scanner, git or gh.

## Tests and proof

- `pnpm --filter @rbw/publication test` runs the hermetic unit tests. They use temporary git repositories, a local bare remote, a stub gitleaks and a stub gh.
- `pnpm --filter @rbw/publication run proof [--gitleaks <command>]` runs the integration proof against a temporary inbox, a synthetic pattern file, a registry, a standalone working copy and a local bare remote. It runs the helper (`once` and one `serve` run) and the wrapper as separate processes, and prints one PASS or FAIL line per check. It takes the gitleaks command the same way as the CLI, so the host can rerun it with the Docker form.
