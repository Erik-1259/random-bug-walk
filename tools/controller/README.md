# @rbw/controller

The trusted controller. It runs one job (kit check, observation, admission or judge replay) end to end against the spend ledger, one app copy at a time, on Vercel Sandbox, or on Docker for the conductor's local checks. It also runs the candidate attempt: one factory root, from the kit check to the admission, under a project policy. The conductor starts it with one command; factory runs launch from a conductor command, not a web route. For a judge replay, the judge route (`packages/web`) starts the same controller in its own Vercel Sandbox (prebuilt mode, below). This is part of a hackathon prototype.

Everything it writes is **development evidence**. It makes no admission claim and publishes nothing, and the planted bug is synthetic.

It reuses the existing packages and does not re-implement them:
- **The job:** the local runner's builders (`buildJob`, `expectedVectors`, the code states and the copy profile).
- **Each copy:** the local runner's `run-copy` path (`runCopyCommand`), the same code the `run-copy` command runs.
- **The import:** `@rbw/admission`, through the local runner's `importJob`.
- **The money:** `@rbw/spend` for the ledger, and `@rbw/envelope`'s rate sheet, fixed limits and `toReserveRequest`.
- **The candidate text:** `@rbw/writer` for the card and the issue, and `@rbw/search` for the phrase checks and the novelty summary.

The new code is the orchestration between them (the ledger flow, the deadlines, replay and the grader proof), which no existing package does. That is why it is more than 200 lines. The candidate attempt (`src/attempt.ts` and `src/symptom.ts`) adds about 650 lines for the same reason: nothing else runs the jobs, the writer and the searcher as one root, builds the symptom from an observation and the docs extract, or picks the phrases from the issue.

## Commands

Run from the repository root.

```sh
node tools/controller/src/cli.ts run --job-kind <kit_check|observe|admission|judge_verify> --work <run dir> \
  --image <tag|digest> --manifest <file> --terms <file> --kit-stage <dir> \
  [--original-suite <file>] [--policy <file>] [--fix <dir>] [--name <job name>] \
  [--backend sandbox|docker] [--sandbox-image <repository>@sha256:<digest>] \
  [--trials <id,...>] [--ledger development|judge] [--ids <file>] [--project-policy <file>] \
  [--judge-fixed fixed|alternative_fix] [--family time-zone|race] [--race-latency-ms <0-10000>]
node tools/controller/src/cli.ts proof --work <run dir> --image ... --manifest ... --terms ... --kit-stage ... \
  [--original-suite <file>] [--policy <file>] [--backend sandbox|docker] [--sandbox-image ...]
node tools/controller/src/cli.ts create-slot-key --slot-key <key>
node tools/controller/src/cli.ts attempt --work <new run dir> --policy <ProjectPolicy> --candidate <private input> ...
node tools/controller/src/cli.ts run --job-kind judge_verify --request-id <uuid> --prebuilt <local store dir|judge job index key> \
  --release <release.json> --deadline-at <UTC time> [--backend sandbox] [--sandbox-image <the release's kit image>] [--work <dir>]
```

`attempt` is described in [The candidate attempt](#the-candidate-attempt).

- `--image`, `--manifest`, `--terms`, `--policy` and `--kit-stage` are the local runner's inputs (its README, Host commands). The kit image must be local, because each copy's source export and audit run on the host.
- `--original-suite` is the driver's frozen original-suite manifest. Without it, the controller first runs one freeze copy on local Docker. That copy is free and not on the ledger.
- `--fix` is for `judge_verify` only: the fix to grade as `fixed-01`, in the local runner's alternative-fix layout (`alternative-fix.json` and its patch). The default is the family's alternative fix. The race family has none, so `run --job-kind judge_verify --family race` without `--fix` grades the reference fix. A prebuilt judge replay (`--prebuilt`) of a race release runs the race family too: the controller reads the family from the frozen job's expected vectors (the race fixture's) and the latency from its `runtime_profile_sha256` (the copy profile with that latency), then runs the replay as `--family race --race-latency-ms <ms>` would, with the race probe set and the latency in every copy. A race job whose profile hash is no latency's, or is the plain copy profile with no latency (the time-zone family's; the release tool never builds a race job without a latency), is refused before any copy (`family_unreadable`). A time-zone replay is unchanged.
- `--trials` runs only the named trials of the kind's profile, separated by commas (for example `--trials fixed-01`). An unknown trial refuses the job. The default is every trial.
- `--ledger` picks where the job's spend and slot are recorded. Without it, `judge_verify` uses the judge-demo pool's `judge` allocation under the `judge` slot, and every other kind the `development` pool and slot. `--ledger development` runs `judge_verify` on the development pool and slot, so a solver grade never takes the slot live judges wait on or draws on the judge allocation. `--ledger judge` is for `judge_verify` only.
- `--ids` is a JSON file holding a root's IDs (the local runner's `RunIds`: `run_tag`, `project_id`, `batch_id`, `root_execution_id`, `executions` and `release_id`), so every job of one root shares them. Without it, the job makes its own.
- `--project-policy` is a canonical `ProjectPolicy` record. The job records its hash under the grading policy ID. It needs `--ids`, whose `project_id` must be the policy's, and it refuses the development placeholder project.
- `--judge-fixed` is for `judge_verify` only: the code state `fixed-01` grades. `fixed` grades the reference fix, the clean file's exact bytes. A solver fix that equals the clean file is graded this way, because the alternative-fix layout refuses a fix equal to the clean file. The default, `alternative_fix`, grades `--fix` (or the local runner's alternative fix).
- `--family` picks the bug family, as in the local runner (its README, Bug families): the fixture the kit stage must hold, the probe set, the kit image and the alternative fix. Without it the job is the time-zone family's, with the same fingerprint and request bytes as before families existed. A race admission job has 11 copies and records ADM-06 as `not_applicable`. `--race-latency-ms` (race only, 0 to 10000) is the latency every copy sets with `rbw-proxy set-latency`; absent, the image's default holds. A set latency is part of the hashed runtime profile (`runtime_profile_sha256` and the task revision's `environment_sha256`), so two latencies give two task revisions. A race job's `summary.json` has a `family` object: the family, ADM-06's status and reason, the admission copy count and `race_latency_ms` (null for the image default). Each copy that set a latency also has a `proxy` object in its copy summary with rbw-proxy's exit status and the latency and source it reported. `proof` takes neither, because its grader cases are the time-zone family's.
- The judge controller (`--prebuilt`) refuses `--trials`, `--ledger`, `--ids`, `--project-policy`, `--judge-fixed`, `--fix`, `--family` and `--race-latency-ms`.
- `--backend sandbox` is the default. It reads `DATABASE_URL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` from the environment, never from arguments, and prints none of them. A missing one is named and the command exits 2.
- `--backend docker` runs the copies on local Docker with an in-memory PGlite ledger. That ledger has every `@rbw/spend` migration and both slot keys, as the local runner's recorded mode uses. It needs no credentials. Its amounts are what the same copies would reserve and settle on Sandbox.
- `--prebuilt` is prebuilt mode, the judge controller: it runs the release's frozen judge job with no Docker and writes `judge/<root>/` in the private store (`BLOB_PRIVATE_STORE_ID` and `VERCEL_OIDC_TOKEN`, or a local store directory). The judge route starts it; `src/judge-run.ts` describes its checks and its end order. The route and the controller each compute the controller operation's ID and payload hash, so the judge web deploy must be built from the commit the controller image was built from, or from a later commit that leaves `tools/controller/src/{envelope,limits,judge-web}.ts` and `packages/envelope` (with its rate sheet) unchanged.
- `create-slot-key` is an owner action on the database in `DATABASE_URL`. The migrations seed the pools but no slot key, so `development` and `judge` are each created once.

The job goes in `<run dir>/jobs/<name>/`. The name defaults to `kit-check`, `observe`, `admission` or `judge`. An observation reads its baseline from `<run dir>/jobs/kit-check/evidence.json`, so the kit check and the observation share one run directory.

Exit codes:
- 0: the job is complete (for `proof`, every case held).
- 1: the summary was written, but the job is `incomplete`, `refused` or `needs_reconciliation`.
- 2: a usage or input error, with nothing run.

## Limits (spec §9.4)

| Job | Controller deadline | Ceiling | Copies | Pool, allocation | Slot key |
|---|---|---|---|---|---|
| `kit_check` | 9,000 s (admission's) | $8 | 5 | `development` | `development` |
| `observe` | 900 s | $1 | 1 | `development` | `development` |
| `admission` | 9,000 s | $8 | 13 | `development` | `development` |
| `judge_verify` | 2,100 s | $2 | 3 | `judge-demo`, `judge` | `judge` |

- The deadlines, ceilings and copy counts come from `@rbw/envelope`'s `FIXED_LIMITS`. The grader proof's `judge_verify` jobs use the development pool and slot key.
- Each app copy has 4 vCPU and 8 GB, with the driver's 600 s copy deadline. Per copy, the run-copy path makes at most 3 mutating SDK calls, 12 artifact reads and 1 stop. The copies run strictly one after the other.
- Before building, the controller refuses a job with more copies than its limit (`too_many_copies`). It also refuses a job whose copies' reservations together would exceed its ceiling (`ceiling_exceeded`).
- **Child deadline:** a copy's deadline is the minimum of 600 s and the parent's remaining time minus 120 s. A copy with no positive time is refused (`parent_deadline`).
- The run-copy path always gives a copy the driver's whole 600 s, plus 120 s to stop and collect. So a copy starts only when its child deadline is the whole 600 s. A shorter positive child deadline also stops new launches (`child_deadline_short`). This is checked before the reservation, and again at the create itself, after the copy's export and audit.
- When the parent deadline passes, no new copy starts. A running copy is never cut short: it ends within its own outer limit, which the rule above keeps inside the parent deadline. The job is reported `incomplete`.
- Nothing is retried: no launch, copy or job.

## The ledger flow

Before the first copy, the controller acquires the slot for the job's root execution. A `slot_held` or `unknown_slot` refusal stops the job (`refused`) before anything is reserved.

For each copy, in order:

1. Check the child deadline.
2. **Reserve** the copy's priced envelope (operation kind `sandbox.copy`, call name `sandbox.copy:<job>:<trial_id>`, provider `vercel-sandbox` or `docker`). This happens before the copy's sandbox exists.
3. Mark it **launching** under the slot key.
4. Run the copy through `runCopyCommand`. The controller passes it a wrapped SDK and Docker layer, which only note whether the create was called and what it returned, and refuse the create when the child deadline no longer allows the copy.
5. Record the sandbox (or container) as a **child resource** with the `running` transition.
6. **Confirm** its terminal state with `confirmChild`. The evidence is `jobs/<name>/stops/<trial_id>.json` and its SHA-256: the stop confirmation, the final status, the call counts and the phase timings.
7. Mark the copy **terminal**: `completed` when the copy completed, `failed` otherwise.
8. **Settle** from the measured lifetime at the envelope's rates. The lifetime is measured directly, from the create call until the copy returns after its confirmed stop, so the untimed steps between phases count too. It is rounded up to whole seconds and recorded per copy as `live_ms`. Each line's actual cost is rounded up, and all usage is known, so the operation becomes `reconciled`.

A copy whose create was never called (refused before it, or refused by the deadline check at the create) goes `launching → terminal (cancelled)` and settles at zero.

After the last copy, the controller merges and imports the record set. It releases the slot only when every copy's resource is confirmed terminal and nothing is uncertain. The database also refuses a release while any child is unconfirmed.

### An uncertain launch

A launch is uncertain when the controller cannot confirm the copy's resource has ended. That covers:
- a create that was called and failed without the sandbox being recovered by name;
- a stop that was not confirmed;
- any error after the create.

On an uncertain launch the controller:
- records `uncertain` (`lost_response` when no resource came back, `unknown_status` after `running` otherwise);
- stops the job and launches nothing more;
- leaves the slot held and the reservation open;
- still imports what the earlier copies collected, and reports `needs_reconciliation` with what is known.

The operator then follows `@rbw/spend`'s procedures:
- manual reconciliation with the provider's evidence (`accept_complete` keeps a completed copy's result; `confirm_no_launch` when nothing was made);
- then the slot release by an operator.

A ledger call that fails (a dropped connection) is handled the same way: the job stops with `ledger_unavailable` and the slot is not released.

Only the first connect to the database is retried, because a suspended Neon compute can refuse it while it wakes: `databaseLedger` (`src/database-ledger.ts`) makes at most three attempts, waiting 1 s and then 2 s, each with a fresh client. It retries only a transient failure: a Node network code (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`), a server that is shutting down or starting up (SQLSTATE `57P01`, `57P02`, `57P03`), a connection exception (`08000`, `08001`, `08003`, `08006`), or pg's code-less "Connection terminated unexpectedly" or "timeout expired". Each attempt has a 10 s connect timeout, so a connect that hangs is retried too, and the three attempts end within about 33 s. An authentication error or any other error fails at once. No ledger query or write is ever retried. The error names only `DATABASE_URL` and the last driver code. The judge web routes open the ledger through the same function. A controller image built before this change keeps its single connect.

### The per-copy envelope

`@rbw/envelope` prices whole jobs (a controller sandbox plus its copies). This controller runs on the conductor's host and reserves each copy on its own, so `src/envelope.ts` builds one copy's envelope from the same rate sheet and fixed limits. It passes the result to `toReserveRequest`.

The time limit is the copy sandbox's own timeout, which the provider enforces: the run-copy path's 720 s (the driver's 600 s plus 120 s), plus the 60 s shutdown allowance.

| Line | Limit | Price | Reserved (micro-USD) |
|---|---|---|---|
| `vcpu_second`, `provider_timeout` | 4 × 780 = 3,120 | 128,000 per 3,600 | 110,934 |
| `memory_gb_second`, `provider_timeout` | 8 × 780 = 6,240 | 21,200 per 3,600 | 36,747 |
| `creation`, `client_counter` | 1 | 600,000 per 1,000,000 | 1 |
| **Total** | | | **147,682** |

The most copies of each kind fit under its ceiling: 13 copies reserve 1,919,866 micro-USD against admission's 8,000,000. The job request names the total it reserves (copies × 147,682) as `reservation_microusd`, and its deadline as `deadline_at`.

## Replay

A job directory holds `controller.json`, written before anything runs. It records the job's IDs and a fingerprint of its inputs:
- the command's options and the hash of every input file;
- the image's resolved digest, so a rebuild under the same tag counts as a different job;
- the kit stage's fixture and added suite;
- for an observation, the kit-check baseline's hash.

Running the same command again with the same run directory and name is a replay:
- With a summary, it returns the existing job's summary. It makes no ledger write and launches nothing.
- Without one (the earlier run stopped part-way, or is still running), it reports `needs_reconciliation` (`interrupted`) with the slot's holder and blockers. It launches nothing.

Different inputs under the same name are refused, and the command exits 2. A new attempt uses a new run directory or `--name`. For example, an observation refused because the kit check had not run yet is run again as `--name observe-2` once the kit check has run.

## Grader proof (spec §9.2)

`proof` runs two `judge_verify` jobs, three copies in all, then re-imports two tampered copies of the first job's record set. Its inputs are the small patches in `proof/`, each pinned by its SHA-256 in `proof/inputs.json`. Every patch applies to the planted target file (`7cb32193…6c`).

| Case | Patch | SHA-256 | Copy | Holds when |
|---|---|---|---|---|
| Valid fix | `valid-fix.patch` (the local runner's alternative fix: line 28 passes `timezone \|\| 'utc'`) | `eb9f8e13…f5c3` | `proof-fix` `fixed-01` | complete, added verdict `match`, original suite run with no failure, and the placed file is `49a8fba2…e649` |
| Empty fix | `empty-fix.patch` (0 bytes) | `e3b0c442…b855` | `proof-fix` `planted-01` | the planted file, complete with added verdict `match` against the planted vector: it fails exactly as declared |
| Attempted forgery | `forgery.patch` | `fa97cef8…ba48` | `proof-forgery` `fixed-01` | complete with added verdict `reject` (the planted failures remain), and the marker `synthetic-forged-pass` appears nowhere in the record set or in what the copy brought back |
| Failed protected regrade | `valid-fix.patch` | `eb9f8e13…f5c3` | `proof-fix` `fixed-01`, re-imported | the valid fix passed, and with `fixed-01`'s `trial-result.json` removed, or its observations altered, the trial imports as `incomplete` or `invalid`, never a pass |

- The forgery keeps the planted bug. On every query, it tries to write a passing `trial-result.json`, a `run.exit`, a `reward.txt` and a report to these paths: its own temp directory, the root-only results directory, `/logs/verifier`, and `/tmp`. The kit lets the app write only its own temp directory and build outputs, and the driver reads only its own records.
- `proof.json` in the run directory records each case's inputs, expectation, observation and result.

## The candidate attempt

`attempt` runs one new factory root under a project policy, on Vercel Sandbox only:

```sh
node tools/controller/src/cli.ts attempt --work <new run dir> --policy <ProjectPolicy> --candidate <private input> \
  --writer-rates <file> --search-rates <file> --image <local kit image> --manifest <file> --terms <file> \
  --audit-policy <file> --kit-stage <dir> --sandbox-image <repository>@sha256:<digest> [--original-suite <file>] \
  [--family time-zone|race] [--race-latency-ms <0-10000>]
```

- `--policy` is the `ProjectPolicy` record. Its `project_id` is the root's project, and the SHA-256 of the file's bytes is the root's `project_policy_sha256`. A policy that names the development placeholder project is refused.
- `--audit-policy` is the projection audit policy that `run --policy` takes.
- `--writer-rates` and `--search-rates` are the writer's and the searcher's rate files, in the formats their `record` commands take.
- Credentials come only from the environment: `DATABASE_URL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` (as `run` reads them), plus `TOKEN_FACTORY_WRITER_KEY` and `TAVILY_API_KEY`. A missing one is named, and the command exits 2 before anything runs. The two keys are read once and removed from the environment before any child process starts. No key reaches a log line, a record or an error message.
- `--work` must be absent or empty. An attempt never resumes: a retry is a new root in a new directory.
- `--family` and `--race-latency-ms` are `run`'s, and every job of the attempt gets both. The family also picks the symptom the issue writer gets (below): a `RaceSymptom` for `--family race`, whose admission runs 11 copies with ADM-06 not applicable. Without `--family`, or with `--family time-zone`, the attempt writes the same job, symptom and issue bytes as before the family was an attempt input.
- The private input's fields are the same for every family; for a race attempt, its prose, search words and excluded identifiers describe the race candidate. The card writer reads only `card_source`, so it needs nothing family-specific.
- `tools/release stage` still validates `symptom.json` as an `ObservedSymptom`, so it refuses a race attempt's symptom (`symptom_invalid`) until the release tool accepts a `RaceSymptom`. Its jobs stage without it.

Exit codes: 0 when the root ends `terminal` and `completed`; 1 when `root-run.json` was written with any other state; 2 for a usage or input error, with nothing run.

### The private input

`--candidate` is one JSON object, validated before anything runs. Errors name fields, never values. A synthetic example:

```json
{
  "candidate": "synthetic-candidate-1",
  "card_source": {
    "source_links": ["https://code.example.invalid/synthetic-project/pull/1"],
    "repository": "https://code.example.invalid/synthetic-project",
    "date": "2026-01-15",
    "license": "MIT",
    "diff_excerpt": "- const range = synthetic(start, end);\n+ const range = synthetic(start, end, zone);",
    "issue_text": "Synthetic source issue: daily totals shift by a day for some timezones.",
    "confirmation": { "card_id": "synthetic-card-1", "shape_id": "synthetic-shape-1", "rules_matched": ["synthetic-rule-a"], "matched_lines": ["+ const range = synthetic(start, end, zone);"] }
  },
  "excluded_identifiers": ["syntheticRangeHelper", "tzarg.la-day-counts"],
  "search_settings": { "timeout_seconds": 30, "max_results": 5, "excerpt_max_chars": 300, "passage_max_chars": 2000, "max_passages": 6, "project_docs_domains": [] },
  "search": {
    "schema_version": 1,
    "candidate": "synthetic-candidate-1",
    "source": { "shape_keywords": ["synthetic", "timezone"], "symptom_words": ["daily", "counts"], "include_domains": ["github.com"], "start_date": "2020-01-01", "end_date": "2026-10-01" },
    "docs": { "url": "https://docs.example.invalid/reports", "query": "daily counts timezone" },
    "docs_policy": { "allowed_domains": ["docs.example.invalid"], "excluded_domains": ["datelib.example.invalid"] }
  },
  "user_action": "Opened the daily pageview report for three days with the report time zone set far from UTC.",
  "locale": "en-US",
  "fixture_description": "Twelve synthetic pageviews spread over three days, several of them close to local midnight.",
  "doc_excerpts": [{ "text": "Synthetic excerpt: reports group pageviews by day in the time zone selected for the report.", "source_url": "https://docs.example.invalid/reports" }]
}
```

- `candidate`: lowercase letters, digits, `_` and `-`, at most 40 characters; one name for the writer and the searcher.
- `card_source`: the writer's `CardSource`.
- `excluded_identifiers`: one list, for the writer's identifier scan and the searcher's query check.
- `search_settings` and `search`: the searcher's `SearchSettings`, and its `SearchInput` without `phrases`, for the same `candidate`. `source` drives the two source searches and `docs` the docs extract. The searcher's domain and query checks run here too, so a source domain outside GitHub, Stack Overflow and `project_docs_domains`, a docs URL outside `docs_policy`, or a source or docs query that contains an excluded identifier is refused before anything runs (the error names the search policy code, never the value).
- `user_action`, `locale`, `fixture_description` and `doc_excerpts`: the symptom's prose. Its numbers come only from the fixture and the observation. `doc_excerpts` is the fallback for the docs extract: the issue writer gets it only when the extract returns no usable passage.

### The stages

The attempt makes one `RunIds` with the policy's `project_id`. Every stage runs under that root, in this order, and each one gates the next:

1. **`kit_check` and `observe`:** `runJob` with the root's IDs and the policy, `policy_id` `umami-uc3-v1` (the release check requires it, and `ProjectPolicy` has no such field), on the development pool and slot. Without `--original-suite`, the kit check's freeze copy makes it, and every later job takes that same file.
2. **`write`:** the symptom, the two source searches (`source-1`, `source-2`) and the docs extract (`docs-1`), then one card call and one issue call. There are no repairs.
3. **`novelty`:** the exact-phrase checks (three, less any left out for want of a 6-word phrase), then `summarizeNovelty` over the checks that ran.
4. **`admission`:** `runJob`, 13 copies (11 for the race family), with the same IDs, policy and original suite.

`runJob` takes two optional `JobInputs` fields for this, `ids` and `projectPolicy`. Both go into the job's fingerprint. Without them a job's bytes are what they were before.

**The symptom** (`src/symptom.ts`, spec §9.6) depends on the family, which `buildSymptom(observeJobDir, prose, family)` takes as a parameter (`TIME_ZONE_FAMILY` or `RACE_FAMILY`, named by fixture ID). The attempt passes the one its `--family` maps to: `time-zone` (the default) to `TIME_ZONE_FAMILY`, `race` to `RACE_FAMILY`.

For the time-zone family (`umami-tz-arg-001`) it is a schema-valid `ObservedSymptom`:
- from the fixture: the request (its path; `startAt`, `endAt`, `unit` and `timezone` as strings), the time zone, the events (labeled `pageview <id>`) and every expected count, labeled by the date part of each bucket label;
- from the observation: every observed count, read from the observe copy's recorded response body for that check, parsed as `classify` parses it, and `http_status` 200;
- the first non-UTC check in fixture order is the primary zone, the other non-UTC checks are `follow_up_examples`, and the UTC control is left out;
- a non-UTC check with no recorded response, or one that `classify` does not grade `local_day_counts_mismatch`, refuses the symptom (`symptom_unavailable`).

For the race family (`rc-1-backup-code-001`, `@rbw/umami-fixture-rc1`) it is a schema-valid `RaceSymptom`:
- the concurrent example is the first observation, in trial and observation order, that graded the double-spend check `double_spend`. Its recorded evidence (the two verify requests with their times) must grade `double_spend` again under the fixture's `classifyDoubleSpend`. Each request becomes `{ label, sent_ms, settled_ms, http_status, outcome, error_code }`, with times rounded to whole milliseconds, and `overlap_ms` is the earlier settle minus the later send of the rounded times;
- `expected` is one acceptance and one refusal (the fixture's pass verdict), and `observed` counts the concurrent outcomes;
- the sequential example is the serial control of the same trial and repeat, which must have passed (first use accepted, reuse refused);
- the request is the public verify endpoint with no query; no backup code, token or check ID is copied;
- no such observation, a missing or ungradable recording, a missing or failed control, or an overlap under a whole millisecond refuses the symptom (`symptom_unavailable`).

**The source searches and the docs extract** (spec §5: sources at the start, the extract while the issue is written) run before the card, in the search package's plan order:
- `source-1` and `source-2` search the shape keywords and symptom words in both orders, limited to `include_domains` and the date range. Their records are evidence for the operator only. A hit has not passed the shape's rules (spec §3.7), so nothing from it reaches the card, whose source stays the confirmed fix in `card_source`.
- `docs-1` extracts the docs URL with the docs query. Its passages become the symptom's `doc_excerpts`, each with the URL Tavily reports, and replace the input's `doc_excerpts`. A passage that contains an excluded identifier is left out, because the symptom must not hand the writer a function name, source path or check ID. When the extract is incomplete or leaves no passage, the input's `doc_excerpts` stay.
- `symptom.json` is written after the extract, so it holds exactly what the issue writer got.

A failed source search or extract (an `incomplete` record: a provider error, a failed URL or a malformed response) is recorded, and the attempt continues. Spec §1 lists the exact-phrase check as Tavily's only admission check, and §5 counts only novelty rejections in the funnel, so missing source evidence or grounding does not block admission by itself. An uncertain call stops the root for reconciliation, and a spend refusal stops it as `incomplete`, as the search package's `record` command stops at the first spend refusal.

**The phrases** are picked by code from the frozen issue: the `title`, the first sentence of `expected_result` and the first sentence of `actual_result`. Each has its double quotes removed and its whitespace collapsed, and is cut to at most 12 words. When a first sentence has fewer than 6 words, its phrase is the start of the field instead, up to 12 words: a shorter phrase matches almost any page. A race issue's fixed count lines (`Expected: accepted=<n>, refused=<n>` and `Observed: accepted=<n>, refused=<n>`, which the issue check reads) are dropped before the pick, so no phrase is taken from them. No phrase under 6 words is ever searched. When a field still has fewer than 6 words (a short title, or result prose of one short sentence), its phrase comes from adjacent reproduction steps joined in order, the first run of 6 or more words (cut to 12) that no earlier phrase used. When none is left, that phrase check is left out: the command prints `stage=novelty omitted=<calls> reason=no_phrase_of_6_words`, `novelty.json` names them in `omitted_calls`, and novelty is summarized over the checks that ran. With no phrase at all, the root fails as `novelty_no_phrase`.

**The candidate text** runs in the attempt's process, against the controller's own ledger. Its run context is the admission's: the policy's project and hash, the batch, the observation's candidate `task_revision`, the root, and the `candidate-text` execution with the root as parent. It acquires the development slot for the root first, and releases it at the end when nothing blocks it. The writer and the searcher use the development pool, so their own caps (12 writer calls and 6 searches per candidate) and the ledger are the controls.

**What the candidate text reserves.** Each call reserves its worst case before it starts and settles from the usage the provider reports. At the committed rates (`packages/envelope/rate-sheets/v1.json`, copied into `tools/local-runner/candidates/umami-tz-arg-001/`):

| Calls | Per call | Total |
|---|---|---|
| 2 writer calls (card, issue) | `ceil(32,768 × 60,000 ÷ 1,000,000)` + `ceil(8,192 × 240,000 ÷ 1,000,000)` = 3,934 micro-USD | 7,868 micro-USD |
| 2 source searches and 1 docs extract | 2 credits × 8,000 = 16,000 micro-USD | 48,000 micro-USD |
| 3 phrase checks | 2 credits × 8,000 = 16,000 micro-USD | 48,000 micro-USD |
| All 8 | | 103,868 micro-USD ($0.103868) |

The six Tavily calls are the search package's closed plan: each name once, at most 6 calls and 12 credits (96,000 micro-USD) per candidate, as spec §9.4 caps them. The source searches and the extract add 48,000 micro-USD to the attempt's reservation. A basic search or extract reports 1 credit, so a clean run settles about 8,000 micro-USD per call. The jobs' copy reservations are unchanged.

### Outputs

`<work>/` holds `jobs/kit-check/`, `jobs/observe/` and `jobs/admission/` (as `run` writes them), `candidate/` and `root-run.json`. Each file under `candidate/` is written once:

| File | Content | Read by |
|---|---|---|
| `symptom.json`, `card.json`, `novelty.json` | the symptom the issue writer got (with the extract's passages as `doc_excerpts`), the writer's card, and the novelty summary with `issue_sha256` | `tools/release stage` |
| `issue.json`, `issue-check.json`, `recordings/` | the frozen issue (canonical), the writer's check report with `issue_sha256`, and the card and issue recordings (provenance `live`) | `tools/release build` |
| `search/` | the two source search records, the docs extract record and the three phrase records | |
| `ledger.json` | each writer and search operation's ID, kind, state, and reserved and settled micro-USD | the conductor |

`issue_sha256` is the SHA-256 of `issue.json`'s bytes, so a check report or a novelty summary of another issue fails the release check. Nothing of the candidate text goes under `jobs/`, so `stage` never reads it. The issue text, its phrases and the search records (their queries, URLs and results) stay under `candidate/`: they never reach a report line, a log line or a run record, and `stage` declares them `withheld_private`. The extract's passages are public user documentation, and they are published only inside `symptom.json`.

`root-run.json` is the canonical `RootRun`: the policy's `project_id` and hash, `kind: "factory"`, `declared_stages` `kit_check`, `observe`, `write`, `novelty` and `admission`, and `child_execution_ids` for the jobs that have a job directory. The candidate-text execution has none, so it is not a child.

The command prints one line per stage: its status and reason, each job's settled micro-USD, each source search's outcome and result count, the extract's outcome, its kept passage count and whether the excerpts came from the extract or the input, the card and issue call outcomes, the issue check status, each phrase check's outcome, the novelty status and the admission's `outcome_verdict`. It never prints issue text, phrases, queries, passages or URLs.

### Stops

Nothing is retried, and every stop still writes `root-run.json`. The admission does not run after a stop.

| Cause | Root |
|---|---|
| A job `refused`, `symptom_unavailable`, a refused or failed writer call, an issue check other than `ready_for_review`, novelty `blocked`, no phrase of 6 words to check | `terminal`, `failed` |
| A job `incomplete`, novelty `incomplete`, a spend refusal of a source search or the extract | `terminal`, `incomplete` |
| A job `needs_reconciliation`, an `uncertain` writer call, a search call left uncertain (a source search, the extract or a phrase check), an operation left unresolved in the ledger, a ledger call that failed, a slot release that was refused | `needs_reconciliation` (outcome `null`); the slot stays held and nothing more runs |

## Summary

`jobs/<name>/summary.json` is canonical JSON (`encodeCanonical`). It holds:

- the labels (`development_evidence`, `admission_claim: false`, `published: false`);
- `status` (`complete`, `incomplete`, `needs_reconciliation`, `refused`), with a reason and detail;
- the job: execution IDs, task revision, request and expected-trials hashes, deadline, baseline and trials;
- the controller: backend, ledger, pool, allocation, slot key, limits, the copy's reserved amount, start and end;
- the image digest and `kit_sha256`, and the original suite's hash, test count and source;
- per copy:
  - the status and reason;
  - `launch` (`not_launched`, `confirmed`, `uncertain`), the child resource ID and the stop confirmation;
  - the phase timings;
  - the operation ID, the reserved and settled micro-USD and the ledger state;
  - the run-copy summary, which includes the sandbox's call counts;
- the importer's evidence and decision hashes and per-trial results;
- the job's total reserved, settled and open micro-USD, read back from the ledger;
- whether the slot was acquired and released, and any release blockers.

## Conductor commands

Run on the host, from the repository root, with the kit image built and pushed as in the local runner's README (Host commands, steps 1, 2 and 5).

Load the secrets into the shell from the owner's private env file, never on a command line. For example `set -a; . <private env file>; set +a`, where the file sets `DATABASE_URL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`.

1. Once per database: apply the migrations and create both slot keys.

   ```sh
   pnpm --filter @rbw/spend run migrate
   node tools/controller/src/cli.ts create-slot-key --slot-key development
   node tools/controller/src/cli.ts create-slot-key --slot-key judge
   ```

2. A live kit check, then a live observation, on Sandbox, in one run directory `<run>`:

   ```sh
   node tools/controller/src/cli.ts run --job-kind kit_check --work <run> --image rbw-umami-kit:local \
     --manifest <manifest> --terms <terms> --kit-stage <stage> \
     --backend sandbox --sandbox-image <vcr repository>@sha256:<digest>
   node tools/controller/src/cli.ts run --job-kind observe --work <run> --image rbw-umami-kit:local \
     --manifest <manifest> --terms <terms> --kit-stage <stage> \
     --original-suite <run>/jobs/kit-check/freeze/collected/original-suite.json \
     --backend sandbox --sandbox-image <vcr repository>@sha256:<digest>
   jq '{status, reason, spend, slot, copies: [.copies[] | {trial_id, status, launch, reserved_microusd, settled_microusd, child_resource_id}]}' <run>/jobs/kit-check/summary.json <run>/jobs/observe/summary.json
   ```

   The observation needs the kit check's original suite, so it reads the manifest the kit check's freeze copy made.

3. The four grader proofs, in a new run directory `<proof run>`:

   ```sh
   node tools/controller/src/cli.ts proof --work <proof run> --image rbw-umami-kit:local \
     --manifest <manifest> --terms <terms> --kit-stage <stage> \
     --backend sandbox --sandbox-image <vcr repository>@sha256:<digest>
   jq '.cases[] | {case, ok, trial_id, observed}' <proof run>/proof.json
   ```

Adding `--backend docker` (and leaving out `--sandbox-image`) runs any of these on local Docker with the in-memory ledger, with no credentials.

4. A candidate attempt, in a new run directory outside the repository. The private env file also sets `TOKEN_FACTORY_WRITER_KEY` and `TAVILY_API_KEY`. The policy, the private input and both rate files are the conductor's own files, never committed. The attempt runs on Sandbox only.

   ```sh
   run="$(mktemp -d)/run"
   node tools/controller/src/cli.ts attempt --work "$run" --policy <public_demo ProjectPolicy> --candidate <private input> \
     --writer-rates <writer rates> --search-rates <search rates> --image rbw-umami-kit:local \
     --manifest <manifest> --terms <terms> --audit-policy <audit policy> --kit-stage <stage> \
     --sandbox-image <vcr repository>@sha256:<digest>
   jq -n --slurpfile ledger "$run/candidate/ledger.json" '{root: (input | {status, outcome}), jobs: [inputs | {name: .job.name, status, reason, settled_microusd: .spend.settled_microusd}], text: [$ledger[0].operations[] | {kind, state, reserved_microusd, settled_microusd}]}' \
     "$run/root-run.json" "$run"/jobs/*/summary.json
   ```

   A root that stopped before the write stage has no `candidate/ledger.json`; jq then names the missing file. `tools/release stage` then takes `--run "$run" --root-run "$run/root-run.json"` with `--symptom`, `--card` and `--novelty` from `$run/candidate/`, and `build` takes `--issue "$run/candidate/issue.json" --issue-check "$run/candidate/issue-check.json" --recordings "$run/candidate/recordings"`.

## Tests

```sh
pnpm --filter @rbw/controller test
pnpm --filter @rbw/controller run test:integration
```

The unit tests use a PGlite ledger with every spend migration, plus the local runner's test doubles: its fake Sandbox SDK, and its simulated kit image, whose copies run the real driver's `runTrial`. They start no container and use no network. They cover:
- the ledger flow and its order against the SDK calls;
- the judge pool;
- the `run` command's options (`src/run-options.ts`): the trials, the ledger choice, the root's IDs, the project policy and the graded fixed state, and a `judge_verify` job on `--ledger development` that never takes the `judge` slot;
- an uncertain create, and a lost create recovered by name;
- both deadline stops, and the refusal at the create;
- the Docker backend;
- replay;
- the per-copy envelope;
- the committed proof inputs, and the grader proof against the fake backend;
- the candidate attempt: `runJob` with shared IDs and a policy, the symptom, the phrase picker, the order and identity of one root, the metering of all six searches, the source and docs records and the doc excerpts, staging without private material, its stops, a failed or uncertain source search or extract, the search policy checks on the input, no resume, the keys and the privacy of the issue text, and the command's missing variable. These tests run on the Docker backend with a fake writer `fetch` and a search client answered in process. They replace the driver's canned response bodies with an Umami-shaped one, and use a fake clock that moves only when released, so 13 simulated copies fit the admission's deadline.

Spec §6.1's four serial-run checks are in `test/support/serial-checks.ts`:
- a replay creates no second job;
- an uncertain launch holds its slot and reservation;
- manual reconciliation of a completed copy keeps its result;
- the slot is released only after termination is confirmed.

They run on PGlite in the unit tests, and on the Postgres in `DATABASE_URL` in `test:integration`. There each check gets its own random schema, dropped afterwards. With `DATABASE_URL` unset, `test:integration` prints a skip message and exits 0.

## What it does not do

- It is not the web route that starts a judge replay (`packages/web`).
- The candidate attempt runs no writer repair, puts no source search hit on the card, and publishes nothing: `tools/release` stages, publishes and builds from its root.
- It never retries a launch, a copy or a job, and it never reconciles or releases a slot after an uncertain launch. Both are the operator's recorded actions.
- It does not shorten a copy below the driver's 600 s: when the child deadline is shorter, the copy does not start.
- It does not calibrate anything, and its summaries are not admissions.
- For factory runs it runs on the conductor's host, not in a sandbox, so it reserves only the copies. A judge replay's controller runs in its own sandbox, which the judge route reserves.
- It does not measure its own sandbox's lifetime. A judge replay's controller settles its operation at the full envelope: 2 vCPUs and 4 GB for 2,100 s plus the 60 s shutdown allowance, 204,481 µUSD with the pinned rate sheet, however soon its sandbox ends. So a replay's recorded cost includes the unused part of the controller's deadline. The copies settle their measured lifetimes. Settling the controller's measured lifetime changes the controller image, which a published release pins, so it waits for the next release.
