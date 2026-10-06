# Inputs for the first live recordings of `umami-tz-arg-001`

These files are the inputs for the first live writer recording (one card call and one issue call) and the first live search recording (six Tavily calls) of fixture `umami-tz-arg-001`. They are development evidence for the client path. The planted bug is synthetic, nothing here is an admitted issue, and no live call has been made with these files. The owner reviews them before any paid call is made from the private workflow.

Each value below is marked as one of:

- **copied**: taken unchanged from the named source;
- **computed**: produced by the named function;
- **chosen**: picked for this run, with the reason.

## Files

| File | What it is | Read by |
| --- | --- | --- |
| `writer-input.json` | `candidate`, `card` (the card source format) and `issue` (`symptom`, an `ObservedSymptom`, and `excluded_identifiers`) | `@rbw/writer`'s `record --input` |
| `search-input.json` | `{ input, settings, excluded_identifiers }`, the layout of the local runner's `--recorded` directory | `@rbw/search`'s `record`, split into three files (see [Running the recordings](#running-the-recordings)) |
| `rates.json` | The writer's rate file: two `token-factory` lines | `@rbw/writer`'s `record --rate-sheet` |
| `search-rates.json` | The search package's rate file: one `tavily` line | `@rbw/search`'s `record --rate-sheet` |
| `context.json` | The run context of a development recording | both `record` commands' `--context` |
| `max-calls` | The single line `2` | the writer's `record --max-calls` |
| `observed/` | The planted copy's recorded responses for the four checks, the source of the symptom's observed counts | this README and its test |

## `writer-input.json`

### `candidate`

`umami-tz-arg-001`: **copied** from the fixture's `fixture_id` (`packages/umami-fixture/data/umami-tz-arg-001.v1.json`). It is only part of the call names in the spend ledger; neither prompt contains it.

### `card` (the card source)

The source is the upstream fix: Umami commit `e6f3f3b4b40a490d5cb050471baa0999366dab2a` in pull request 4112, "fix: use settings timezone in revenue chart date range" (MIT).

| Field | Value | Kind and source |
| --- | --- | --- |
| `source_links` | `https://github.com/umami-software/umami/pull/4112`, `https://github.com/umami-software/umami/commit/e6f3f3b4b40a490d5cb050471baa0999366dab2a` | **copied**: the pull request and the commit. Both returned HTTP 200 to a logged-out `curl` on 2026-10-06. |
| `repository` | `https://github.com/umami-software/umami` | **copied** from the pull request |
| `date` | `2026-03-25` | **copied**: the commit's author date (the pull request was opened the same day and merged on 2026-03-30) |
| `license` | `MIT` | **copied** from Umami's `LICENSE` |
| `diff_excerpt` | The commit's whole diff, one file and one hunk | **copied**: `git show --format= e6f3f3b4b40a490d5cb050471baa0999366dab2a`, byte for byte without the final newline |
| `issue_text` | The pull request's title and description, quoted | **copied** from the pull request (`GET https://api.github.com/repos/umami-software/umami/pulls/4112`, fields `title` and `body`). The two labels around them ("Pull request title:", "Pull request description, quoted:") are **chosen**, so the model can tell the quote from the frame. The commit author's name is not included. |
| `confirmation.card_id` | `card-dt-1.tz-arg-umami-4112` | **chosen**: the shape ID, the upstream project and the pull request number, so it names one card |
| `confirmation.shape_id` | `DT-1.tz-arg` | **copied** from `SHAPE_ID` in `packages/shapes/src/shape.ts` |
| `confirmation.rules_matched` | `dt-1.tz-arg.source` | **copied** from `SOURCE_RULE_ID`: the source anchor rule is the one rule that runs on the source fix. The target rules match the Umami query file, not this commit. |
| `confirmation.matched_lines` | `-  } = useDateRange();` and `+  } = useDateRange({ timezone });` | **computed** by `confirmSource` of `@rbw/shapes` (below): the rule matched `useDateRange()` on line 10 before and `useDateRange({ timezone })` on line 11 after. The lines are the diff lines that hold those calls. |

The confirmation was produced by the shapes command on the fetched commit, which returned `status: "confirmed"`:

```sh
git init -q <dir>
git -C <dir> remote add origin https://github.com/umami-software/umami.git
git -C <dir> fetch -q --depth 2 origin e6f3f3b4b40a490d5cb050471baa0999366dab2a
node packages/shapes/src/cli.ts confirm-source --git-dir <dir>/.git \
  --commit e6f3f3b4b40a490d5cb050471baa0999366dab2a --parent 0a838649b773122cc68cbd0c3df78d4251b981c5
```

It reported the before call `useDateRange()` on line 10, the after call `useDateRange({ timezone })` on line 11, the binding `const { timezone } = useTimezone();` on line 8, the hunk `@@ -1,13 +1,14 @@` and the blob hashes pinned in `DT1_SOURCE`.

### `issue.symptom` (the `ObservedSymptom`)

The primary example is the fixture's Los Angeles check against the **planted** copy.

| Field | Kind and source |
| --- | --- |
| `schema_version` | `1`, the writer's only version |
| `user_action` | **chosen** wording of what the check does, in product terms: the date range of the data file's `request` (`startAt` March 7 00:00 UTC to `endAt` March 9 23:59:59.999 UTC) and the check's zone |
| `request.method`, `request.path` | **copied**: `GET` and the data file's `request.path` |
| `request.query` | **computed** by `queryString(fixture, check)` of `@rbw/umami-fixture` for the Los Angeles check: `startAt=1772841600000`, `endAt=1773100799999`, `unit=day`, `timezone=America/Los_Angeles`, in that order |
| `timezone` | `America/Los_Angeles`, **copied** from the check |
| `locale` | `null`, **chosen**: the check's request carries no locale and no `Accept-Language` header. The data file's `send.language` (`en-US`) describes the recorded visits, not the person reading the report. |
| `fixture_description` | **chosen** wording of the data file's `events` and the fixture README's description of them (they straddle local midnight in each zone and the Los Angeles daylight-saving change on March 8, 2026, at 10:00 UTC, between events 5 and 6) |
| `events` | **copied**: all twelve rows of the data file's `events`, in order (`timestamp_seconds` and `utc_instant`). The labels `pageview 1` to `pageview 12` are **chosen**; the data file's own IDs (`e01` …) are internal. |
| `http_status` | `200`, **copied** from the classifier's order (`classify` in the fixture README): a check reaches `local_day_counts_mismatch` only after a 200 response with valid JSON |
| `expected` | **copied**: labels from `bucket_labels`, counts `[3, 8, 1]` from the Los Angeles check's `expected` (the derivation script's table) |
| `observed` | See below |
| `follow_up_examples` | Auckland (expected `[1, 6, 5]`) and Kolkata (expected `[2, 7, 3]`), each built the same way as the primary example, with observed counts copied from `observed/` |
| `doc_excerpts` | **copied**: two sentences from `https://docs.umami.is/docs/api-reference/get-website-pageviews`, as fetched on 2026-10-06 (the endpoint description and the `timezone` parameter's description) |

**Where each observed number comes from.** For each of the three zones:

- **The outcome** is copied from `packages/umami-fixture/evidence/live-proof.json`, `states.planted.observed`: `assertion_fail` with `local_day_counts_mismatch` for `tzarg.la-day-counts`, `tzarg.auckland-day-counts` and `tzarg.kolkata-day-counts`.
- **The bucket labels** follow from that outcome. The classifier reports `local_day_counts_mismatch` only when the labels are exactly the three `bucket_labels`, unique and ascending.
- **The counts** are copied from the planted copy's recorded responses in `observed/` (`tzarg.<zone>-day-counts.json`, the `pageviews[].y` values in order). These are the response bodies of the observation job's `planted-01`, round 1, from the local runner's run of 2026-10-06 on kit image `sha256:f987de0d…51f1f75`. Every zone, UTC included, returned `[2, 8, 2]` with UTC-midnight buckets, so the planted copy ignores the time zone. A test checks that `observed` equals these files. The data file's `predicted_planted_counts` agrees, but it is a prediction and is not the source.

### `issue.excluded_identifiers`

Each term is **copied** from the named source. The writer's issue checks reject an issue that contains one, case-insensitively, on word boundaries.

| Terms | Source |
| --- | --- |
| `umami-tz-arg-001` | the fixture ID |
| `DT-1.tz-arg`, `dt-1.tz-arg`, `dt-1.tz-arg.planted`, `dt-1.tz-arg.source` | the shape ID and the three rule IDs (`packages/shapes/src/shape.ts`) |
| `tzarg.utc-day-counts`, `tzarg.la-day-counts`, `tzarg.auckland-day-counts`, `tzarg.kolkata-day-counts` | the fixture's check IDs |
| `src/queries/sql/pageviews/getPageviewStats.ts`, `getPageviewStats.ts`, `getPageviewStats` | the planted file, its name and the query it holds (`DT1_TARGET.path`) |
| `relationalQuery`, `getDateSQL`, `rawQuery`, `cohortQuery`, `website_event.created_at`, `website_event`, `created_at` | the function, the helper, and the names on and around the planted line (`packages/shapes/probes/dt-1.tz-arg/mutation.patch`) |
| `getQueryFilters`, `src/app/api/websites/[websiteId]/pageviews/route.ts` | the endpoint's route file and the filter builder it calls (`DT1_TARGET.routePath`, `routeFiltersPattern`) |
| `e6f3f3b4b40a490d5cb050471baa0999366dab2a`, `RevenuePage`, `useDateRange`, `useTimezone`, `parseDateRange` | the source-fix commit and the names the fix and its description use |

Not excluded, **chosen**: `timezone` and `unit`, which are the public query parameters in the symptom's own request, and `filters`, `x` and `y`, which are ordinary words or letters that a bug report can contain. A test checks that no excluded term appears in the symptom.

## `search-input.json`

| Field | Value | Kind and source |
| --- | --- | --- |
| `input.candidate` | `umami-tz-arg-001` | **copied**, as in the writer input |
| `input.source.shape_keywords` | `timezone`, `day counts`, `utc` | **copied** from the `keywords` metadata of rule `dt-1.tz-arg` (`packages/shapes/rules/dt-1.tz-arg.yml`), leaving out the code identifier `getDateSQL` and the internal terms `date bucket` and `default timezone` |
| `input.source.symptom_words` | `umami`, `daily pageviews`, `wrong day` | **chosen**: the words a user who saw this symptom would search for |
| `input.source.include_domains` | `github.com`, `stackoverflow.com` | **copied** from the package's `BASE_SOURCE_DOMAINS` |
| `input.source.start_date`, `end_date` | `2020-01-01`, `2026-10-06` | **chosen**: from the start of 2020, the year the Umami repository was created, to the date these inputs were written |
| `input.docs.url` | `https://docs.umami.is/docs/api-reference/get-website-pageviews` | **chosen**: the Umami documentation page for the endpoint the user called. Checked with `curl`: it returned HTTP 200 and its text describes the endpoint and its `timezone` parameter. `https://umami.is/docs` redirects to `docs.umami.is`, and the page is listed in `https://docs.umami.is/sitemap.xml`. |
| `input.docs.query` | `pageviews grouped by day in the selected time zone` | **chosen**: the symptom in the documentation's own terms |
| `input.phrases` | `daily pageview counts for one website`, `just before or just after local midnight`, `each local day's count depends on the selected time zone` | **copied** from the symptom's `user_action` and `fixture_description`. The issue text is not written yet, so the phrases come from the symptom wording that the issue is written from. A test checks that each one is in the symptom. |
| `input.docs_policy.allowed_domains` | `docs.umami.is` | **chosen**: the host of Umami's documentation |
| `input.docs_policy.excluded_domains` | `date-fns.org` | **chosen**: the documentation of `date-fns`, the date library in Umami's `package.json` at the pinned commit, which the search README says to exclude |
| `settings` | `timeout_seconds` 30, `max_results` 5, `excerpt_max_chars` 300, `passage_max_chars` 2000, `max_passages` 6, `project_docs_domains` empty | **copied** from the package's `DEFAULT_SETTINGS` |
| `excluded_identifiers` | the writer input's list | **copied**, so a query can contain none of the terms above |

The planned queries, as the preview test renders them:

1. `source-1`: `timezone day counts utc umami daily pageviews wrong day`
2. `source-2`: `umami daily pageviews wrong day timezone day counts utc`
3. `docs-1`: an extract of the docs URL with the docs query
4. `phrase-1` to `phrase-3`: each phrase in double quotes, exact match

## `rates.json` and `search-rates.json`

Both are in the array format that the writer and search packages read today (`{ service, unit, price, source_url }`). The prices and source URLs are **copied** from `@rbw/envelope`'s pinned sheet `packages/envelope/rate-sheets/v1.json`:

| File | Line | Price | Envelope entry |
| --- | --- | --- | --- |
| `rates.json` | `token-factory` `input_token` | 60,000 micro-USD per 1,000,000 tokens ($0.06 per million) | subject `nvidia/Nemotron-3_5-Lightning` |
| `rates.json` | `token-factory` `output_token` | 240,000 micro-USD per 1,000,000 tokens ($0.24 per million) | subject `nvidia/Nemotron-3_5-Lightning` |
| `search-rates.json` | `tavily` `credit` | 8,000 micro-USD per credit ($0.008) | subject `api` |

The envelope sheet records `account_confirmed: false`. The owner accepted these pinned rates for this development recording on 2026-10-06.

### Reserved amounts

Each call reserves its worst case before it starts, with every line rounded up:

| Calls | Per call | Total |
| --- | --- | --- |
| 2 writer calls | `ceil(32,768 × 60,000 ÷ 1,000,000)` + `ceil(8,192 × 240,000 ÷ 1,000,000)` = 1,967 + 1,967 = 3,934 micro-USD | 7,868 micro-USD |
| 6 Tavily calls | 2 credits × 8,000 = 16,000 micro-USD | 96,000 micro-USD |
| All 8 | | 103,868 micro-USD ($0.103868) |

These are reservations against pool `development`. Each call settles from the usage the provider reports, and releases the rest.

## `context.json`

| Field | Value | Kind and source |
| --- | --- | --- |
| `project_id` | `00000000-0000-4000-8000-000000000001` | **chosen**: the local runner's development project placeholder (`PLACEHOLDER_PROJECT_ID` in `src/jobs.ts`) |
| `project_policy_sha256` | `f4f15e4c…25663` | **computed** by `buildPolicy` of `@rbw/schema` with this project ID, no output repository, no public artifact URI and policy version 1 (purpose `evaluation`, visibility `private`) |
| `batch_id` | `00000000-0000-4000-8000-000000000171` | **chosen**: a fixed development UUID for this recording |
| `task_revision` | 64 zeros | **chosen**: a development placeholder. `taskRevision` needs the kit image's digest, the kit manifest's hash and the original suite's hash, which only a Docker run produces and none is committed. This is reported through the inbox. |
| `root_execution_id` | `00000000-0000-4000-8000-000000000172` | **chosen**: a fixed development UUID. Both `record` commands acquire the slot for it. |
| `execution_id` | `00000000-0000-4000-8000-000000000173` | **chosen**: a fixed development UUID |
| `parent_execution_id` | `00000000-0000-4000-8000-000000000172` | **chosen**: the root, as in the writer README's example |

The writer's operation IDs follow from these fields by `operationId` and `providerCallIdentity` of `@rbw/schema`. `record --max-calls 2` writes the card first, and the writer shares ordinals across both kinds, so the card is ordinal 1 and the issue ordinal 2. At this commit they are `46d365de…f8cccaa` for `writer.card:umami-tz-arg-001:1` and `7886668a…23dbbd6` for `writer.issue:umami-tz-arg-001:2`. They change when the writer profile changes.

Pool `development` and slot key `development` are passed on the command line. The pool is seeded by the `@rbw/spend` migrations. The slot key is not, so it must be created once with `createSlotKey`.

## `max-calls`

The single line `2`: **chosen**, one card call and one issue call, the writer's `record` maximum.

## Request preview

`test/unit/candidates.test.ts` renders both request paths with no network:

- The writer's `previewCard` and `previewIssue` give input-token bounds of 7,124 and 6,735 at this commit, below the 32,768 limit.
- The search client's six requests are answered in process. Every call passes the local checks (call plan, excluded identifiers, docs domain, source domains) and reserves 16,000 micro-USD.

## Running the recordings

The `record` commands read their inputs as follows:

- The writer reads `writer-input.json`, `rates.json`, `context.json` and the value in `max-calls` as they are.
- The search command takes the input, the settings and the excluded identifiers as three files, so `search-input.json` is split first:

  ```sh
  jq .input search-input.json > <dir>/input.json
  jq .settings search-input.json > <dir>/settings.json
  jq .excluded_identifiers search-input.json > <dir>/excluded.json
  ```
