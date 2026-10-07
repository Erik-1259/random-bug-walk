# @rbw/harvest

Finds public source fixes on GitHub that match shape `DT-1.tz-arg` (a caller has the selected time zone but does not pass it to a date operation), confirms them structurally, and reports a funnel with a count and a reason for every drop. It makes no model or paid calls, and it stops at "structurally confirmed". Writing cards for confirmed candidates is a later, paid step.

## Contents

| Path | What it holds |
| --- | --- |
| `src/github.ts` | The one GitHub REST client: `@octokit/core`, GET by exact path and query, with rate-limit handling. |
| `src/github-api.ts` | Zod schemas for the responses the funnel reads, and the URL builders. |
| `src/frozen.ts` | The recording transport (live) and the replay transport (offline), and the run directory's manifest. |
| `queries.json`, `src/queries.ts` | The searches a live harvest runs, in order, and their loader. |
| `src/license.ts` | The license filter. |
| `src/confirm.ts` | The candidate source rule and the structural confirmation. |
| `src/funnel.ts` | The funnel stages, their drop reasons, and the pipeline over a transport. |
| `src/harvest.ts`, `src/commands.ts`, `src/cli.ts` | The live run, the replay, and the command line. |
| `rules/tz-arg.candidate.yml` | The candidate source rule, one document per parser language (TypeScript and TSX). |
| `test/fixtures/synthetic-run/` | A committed run directory from a synthetic GitHub API. |

## Sources

- GitHub commit search (`/search/commits`) over commit messages, and issue search (`/search/issues` with `is:pr is:merged`) for merged pull requests. A pull request is followed to its merge commit.
- SWE-rebench V2 is not used. It is optional for this item and not part of this package.

The queries are in `queries.json`, so the list can be tuned without code changes. Each entry has a `kind` (`commits` or `pulls`), the search text `q`, and `api`, the date API it targets, which labels the query in the funnel. GitHub search matches commit messages and pull request titles and bodies, not diffs, so each query names a date API a time-zone fix touches (`formatInTimeZone`, `toZonedTime`, `fromZonedTime`, `utcToZonedTime`, `dayjs(...).tz(`, `Intl.DateTimeFormat` with `timeZone`, `useDateRange`, `startOfDay`, `startOfMonth`) together with words such as `timezone` and `fix`. The candidate rule then checks the diff.

Every query runs, and each reads the first page of 30 results. Results are then taken round-robin: the first result of each query in turn, then the second of each, and so on, until `--max` distinct candidates are collected. So every query that answers contributes, and the per-query report below can compare them. A candidate is a commit (`owner/repo@sha`) or a pull request (`owner/repo#n`). A result already collected is skipped. A search that fails is recorded with its status and the run continues.

## Funnel stages

Each candidate stops at its first drop. Every stage has a count and a count per drop reason.

| Stage | A candidate reaches it when | Drop reasons |
| --- | --- | --- |
| `harvested` | A search returned it, within `--max`. | none |
| `license_permitted` | The repository is available and not a fork, and its license, as GitHub detects it, is MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause or ISC. | `repo_unavailable`, `fork`, `license_missing`, `license_unrecognized` (GitHub's `NOASSERTION`), `license_not_permitted` |
| `diff_fetched` | A pull request is merged. Its commit is not a duplicate (see below). The commit has one parent and fewer than 300 files, and it modifies or renames at least one TypeScript or JavaScript file with a patch. For each such file whose added lines mention a time zone (at most 10 files), the parent and commit blobs are fetched (the parent blob from the old path of a renamed file) and hash to the git blob IDs GitHub lists. | `pr_unavailable`, `pr_not_merged`, `commit_unavailable`, `duplicate_commit`, `duplicate_patch`, `not_single_parent`, `too_many_files`, `no_ts_js_change`, `patch_missing`, `blob_unavailable`, `blob_too_large` (no inline content, over 1 MB), `blob_mismatch` |
| `source_rule_matched` | The candidate source rule matches a call whose time-zone argument is on a line the commit added. | `no_timezone_text_added`, `no_rule_match_on_added_line` |
| `structurally_confirmed` | A matched call passes the structural checks below. | `function_missing_before`, `call_added`, `before_has_timezone_argument`, `timezone_is_constant`, `timezone_unbound` |

### Repository and license

- The fork flag comes from the commit search result. When the result lacks it, as for every pull request, the repository record (`/repos/{owner}/{repo}`) is read. A fork drops as `fork`.
- The license comes from the search result when it carries one. Otherwise it comes from the repository record, if that was read. If neither names a license, the license endpoint (`/repos/{owner}/{repo}/license`) is read before the candidate drops as `license_missing`; its 404 means no license. Each candidate records which of the three named its license, as `license_source`.
- Each repository's record and license are requested at most once a run.

### De-duplication

Candidates are checked in harvest order up to their commit. Then, among the candidates that reached a commit:

- a commit SHA already held by another candidate, in any repository, drops as `duplicate_commit`;
- then a patch ID already held by another candidate drops as `duplicate_patch`.

The candidate kept is the one with the earliest committer date, and earlier in harvest order on a tie. The patch ID is in the manner of `git patch-id`, though not byte-compatible with it: a SHA-256 over each file's name and its added and removed lines, with whitespace and line numbers ignored, and the blob ID for a file GitHub gives no patch for. A commit with no patch at all has no patch ID. A commit that will drop as `not_single_parent` or `too_many_files` does not hold its patch ID, so a later single-parent copy of the same patch is kept. Each candidate records its `committed_at` and `patch_id`. Only the candidates kept go on to the blob fetches and the source rule.

### Which source rule

The shape's own source rule, `dt-1.tz-arg.source` in `@rbw/shapes`, and its `confirmSource` are pinned to one upstream component and commit. Every other commit would fail with `unsupported_commit`. So this package matches candidates with its own rule for the candidate's call, `rules/tz-arg.candidate.yml`, loaded with `@rbw/shapes`' rule loader and run with `@ast-grep/napi`. The funnel records this choice, with the rule file's SHA-256, under `source_rule`.

The rule matches a call to a date operation that passes a time-zone value as a direct argument. The callee's name (the property of a member callee such as `dayjs(d).tz`) is a date operation when it is one of the known date functions listed in the rule file, such as `format`, `formatInTimeZone`, `toZonedTime` or `startOfMonth`, or when its camel-case or snake-case words include a date word (`date`, `time`, `day`, `week`, `month`, `year`, `zone`, `period`, `calendar` and the others the rule file lists) as a whole word: `formatDate` and `get_date_range` match, `updatePreferences` does not.

The time-zone value is:

- a name whose whole identifier, or whose final word or words, is `timezone`, `timeZone`, `time_zone`, `tz` or `zone`, such as `timezone`, `userTimezone` or `USER_TZ`, but not `timezoneOffset`;
- a member whose property is such a name, such as `filters.timezone`;
- or an options object with such a key, as in `{ timezone }` or `{ timeZone: zone }`.

`.ts`, `.mts` and `.cts` files parse as TypeScript; `.tsx` and every JavaScript form parse as TSX.

### Structural confirmation

For a rule match whose time-zone argument is on an added line, in the commit's version of the file:

1. The parent version has a function at the same nesting path, by name (`function_missing_before`).
2. That function calls the same callee the same number of times in both versions, and one of the parent's calls that no other call in the commit's version keeps unchanged has the same other arguments: identical as text after whitespace is normalized, leaving out the time-zone argument or property and trailing empty objects. So the fix changed this call rather than adding or replacing one (`call_added`). When several parent calls qualify, the one at the same position is preferred. The paired call passes no time-zone value (`before_has_timezone_argument`).
3. The time-zone value is not a literal such as `"UTC"`, and does not read the runtime's own zone through a `guess()` or `resolvedOptions()` call, as in `dayjs.tz.guess()` (`timezone_is_constant`).
4. The name the value is read from is declared in the call's function, an enclosing function or the module, for example as a parameter, a destructured `const` or an import (`timezone_unbound`). The name is the leftmost name of a member chain or call, as in `user?.settings.timezone` or `getZone()`, read through casts, `await`, and the left side of `??` and `||`, so `user.timezone ?? "UTC"` is read from `user`. A value with no such name, such as a template with substitutions, is also `timezone_unbound`. This is the shape's precondition: the caller had the time zone.

The first confirmed match makes the candidate confirmed. Otherwise the candidate drops with the first match's reason. Every match and its outcome is listed in the candidate's record.

### Limits

The rule and the checks are syntactic: they read each file's syntax tree, with no types, no data flow and no other files. `structurally_confirmed` means the change has the shape of the fix, not that the code is proven to be the fix. Known cases it gets wrong:

- **Confirmed, though not the fix.**
  - A literal wrapped in a cast or parentheses, as in `const timezone = "UTC" as const`.
  - A literal declared in an inner block that shadows a selected zone declared earlier in the function.
  - A call removed from one anonymous callback and added to a sibling one: both are paired as the same function.
  - A constant reached through more than one alias, a function's return value or another file.
- **Dropped, though a real fix.** The callee or the time-zone value has a name outside the rule's lists, or the zone arrives through a spread or a computed key.

These are accepted rather than patched one by one. Closing them needs semantic analysis, such as a type checker, which this package does not do. A false confirmation costs little, because each confirmed candidate still goes through its card, the owner's alignment check and admission, where the planted copy must fail and the fixed copy must pass.

## Per-query report

Each entry of `funnel.json`'s `harvest.queries` has the query's status, result count and the number of candidates it added, with:

- `stages`: how many of its candidates reached each stage;
- `drops`: its drop reasons with their stage and count, most frequent first, then in stage order, then by name.

`harvest` also prints one line per query with its candidates added and confirmed and its top three drop reasons.

## Frozen responses and replay

A harvest writes a new run directory:

- `manifest.json` (schema version 2): the API base URL, whether a token was used, `max`, the queries, and the start and completion times;
- `responses/<hash>.json`: one file per request, with its URL, `requested_at` and `completed_at` (UTC), each rate-limited attempt and its wait, the status, the rate-limit headers and the response body;
- `funnel.json`: the funnel.

Bodies are frozen as projected by `src/github-api.ts`, so they hold only the fields the funnel reads. Commit authors, committer names and emails, user records and commit messages are dropped; the committer date is kept. No request header is recorded. The live run's pipeline reads the same projected bodies a replay reads, so `funnel --in` rebuilds the same `funnel.json` from the directory with no network. A request with no frozen response fails the replay; it never reaches the network. A run that did not complete cannot be replayed. Nor can a run with manifest schema version 1, written before the license endpoint, de-duplication and the round-robin harvest: its frozen responses do not cover this funnel's requests.

A live run directory holds third-party source files and patches from the harvested repositories, and repository names that include their owners' account names. It belongs outside this repository and is not committed here. Anything taken from it for publication passes the publication checks first.

## Rate limits

- Before each request, a request in a bucket (`search` or `core`) whose last response reported no remaining calls waits until that bucket's reset time.
- A 403 or 429 that is a rate limit is retried, up to 3 times. The client waits for `retry-after` when given. Otherwise it waits until `x-ratelimit-reset` when no calls remain, or one minute for a secondary limit with no time given.
- A wait longer than 61 minutes, or a fourth rate-limited response, stops the run with exit 2.
- Requests run one at a time.

Without a token GitHub allows 10 searches a minute and 60 other requests an hour, so a 50-candidate run without a token waits for several hourly resets. Every query in `queries.json` runs once per harvest. With a token it allows 30 searches a minute and 5,000 other requests an hour.

## Command line

```sh
node packages/harvest/src/cli.ts harvest --out <new directory> [--max <n>]
node packages/harvest/src/cli.ts funnel --in <run directory>
```

- `harvest` makes live calls to the public GitHub REST API, writes the run directory (which must be new or empty) and prints a stage summary. `--max` defaults to 50.
- `GITHUB_TOKEN` is read from the environment only, sent only as the authorization header, and never printed or recorded. A token with read access to public repositories is enough.
- `funnel` prints the funnel as canonical JSON (sorted keys) from the frozen responses, with no network.
- Exit codes: 0 done; 2 the command cannot run (bad usage, an unreadable, non-empty or incomplete run directory, a rate limit beyond the cap, a request that fails without a response).

## Tests

`pnpm --filter @rbw/harvest run test` runs the unit tests. No test reaches the network:

- The committed run in `test/fixtures/synthetic-run/` is a harvest against a synthetic GitHub API (`test/support/synthetic-github.ts`) with a fixed clock. `node packages/harvest/test/support/generate-fixture.ts` regenerates it, and a test fails if the committed files differ from the generator's output.
- The funnel test replays the committed run with `fetch` stubbed to fail and checks every stage count and every drop reason.
- Further tests cover the query file, the round-robin harvest, the per-query report, de-duplication, the license lookup and filter, rate-limit handling with an injected clock, the frozen responses and the structural confirmation.

## Not in this package

- Model calls, cards and anything after `structurally_confirmed`.
- SWE-rebench V2 and sources other than GitHub search.
- Target confirmation and probes, which stay in `@rbw/shapes`.
