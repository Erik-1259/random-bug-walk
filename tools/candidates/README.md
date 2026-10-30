# @rbw/candidates

The candidate pipeline. Given a class-level shape rule, it lists every site the rule matches in the host tree and plants each site. What happens next depends on the route (`--route`):

- `behavioral-qualification/v1` (the default) checks and plants each site in memory and records the planted candidates for behavioral qualification: checks on clean, buggy and reference-fixed copies, which run outside this tool. It makes no copy, never builds or calls a screen, reads no screen key, needs no database and spends nothing. Each candidate records `difficulty: { status: "not_assessed" }`.
- `static-screen/v1` plants each site in its own scratch copy, runs the static-headroom screen on each copy, and ranks the candidates that survive, so checks (the expensive step of the bug generation pipeline) are written only for candidates worth building them for.

Either way the result is one run record.

The pipeline is wired to the real implementations:

| Function | Comes from | Contract |
| --- | --- | --- |
| `findSites(rule, hostDir)` | `@rbw/shapes` (the class-level site finder) | Returns `[{ file, line, diff, confidence, classId, plantedFormConfirmed, confidenceLevel }]`: a host-relative path with `/` separators, the 1-based line of the match in the clean file, a unified diff that changes only that file from the clean to the planted form (`a/` and `b/` prefixes allowed), a confidence from 0 to 1 (the shapes score, which sums signal weights), the class that matched, whether the planted form was confirmed, and the shapes confidence level. |
| `screen(job)` | `@rbw/screen` (the static-headroom screen) | Reads the planted copy and is told only the symptom text; asks one model, up to `budget.maxAttempts` times, to locate and fix the bug from the source and the symptom alone; and returns `{ verdict, hits, attempts, costMicrousd }`. `verdict` is `located` (some attempt found the planted change from the source alone: the candidate fails the screen), `not_located` (no attempt did: it survives) or `inconclusive` (with no hits). Every model call is metered against the spend ledger named by `DATABASE_URL`. |

`src/wiring.ts` binds them: `findSites` is `src/shapes-finder.ts` (the `@rbw/shapes` scan adapted to the pipeline's `Site` shape), and the screen is `src/static-screen.ts` (the `@rbw/screen` run adapted to the pipeline's `Screen`). The pipeline does not import `src/wiring.ts`; it takes the two functions as arguments, so the pipeline and command tests pass fakes for the model and the ledger. `test/wiring.test.ts` tests only the wiring's fetch and ledger connection, with a fake client. The interfaces are in `src/types.ts`.

## The symptom

A screen must be told a symptom — what a user sees — without being told where the bug is. The pipeline derives one **per candidate**, from the site alone, with no model call (`src/symptom.ts`): the endpoint the file implies (a file under an `api` directory becomes a path, a `route` filename dropping to its directory) and, at most, the name of the model the diff touches. It describes only what a user would see: no method call, no field and no read-then-write mechanics from the code. For the race class it describes what concurrent requests to that endpoint would show — for example that two requests arriving at once can both succeed when only one should. The tests check, for the synthetic fixtures and for every site the real finder returns from the synthetic race tree, that a symptom repeats no identifier from the diff's changed lines (other than the model name and the endpoint's own path segments) and no method or `<model>.<method>` call the diff touches. The run record keeps each candidate's symptom by SHA-256, never its text, and names the template generation (`race-class-template-v2`).

## What a static-screen/v1 run does

1. Calls `findSites` once. Exact duplicates (same file, line and diff) are collapsed. Sites whose planted form the finder confirmed come first (an unconfirmed rewrite, such as one that leaves a second guard so the write stays conditional, may not plant the bug at all), then by confidence, highest first, then by file and line.
2. Checks each site and plants it in memory: the path must stay inside the host, the line must be a positive integer, the confidence must be from 0 to 1, the file must be a regular file, and the diff must name only that file, apply exactly and change it. A site that fails is recorded as `invalid_site` or `plant_failed` with a reason code, and does not count toward the candidate cap. The first `--max-candidates` sites that plant become candidates; the rest are recorded as `over_candidate_cap`. Each planted candidate gets its symptom (and the symptom's SHA-256 in the record).
3. For each candidate in order, copies the host tree into a fresh directory under the run's own scratch directory (leaving out `.git` and `node_modules`), writes the planted file, and calls `screen` with the planted copy, the candidate's symptom, the budget and the model. Screens run one at a time. The screen's own working files (its record, the model's answers and the call recordings) are written to a directory under `--scratch` (outside the repository) and removed after the screen, because they can name source from a real host; they are kept only with `--keep-scratch` or when the screen left spend to reconcile (step 4).
4. Before each screen, checks that one whole per-screen budget still fits in what is left of the total spend cap. If it does not, that candidate and the rest are recorded as `skipped_spend_cap`. A screen that throws or returns a malformed result is recorded as `screen_error` and charged its whole budget, because its real cost is unknown; a malformed result that reports a cost above the budget is charged that cost instead. A screen that reports spending more than its budget, malformed or not, is recorded, and no further screens start (`skipped_after_overspend`). The real screen stops the run (stop reason `screen_stopped`, the rest `skipped_after_screen_stop`) when it did not start (charged nothing, since nothing was sent; the cause, such as a held slot, would repeat for every candidate), when it left a call that may have been billed but is not settled (an uncertain call, an unsettled operation, a ledger refusal after launch, or an unexpected error; charged the whole budget), or when it could not release its spend slot. The candidate's reason then carries the screen's own last report, the root execution ID and the operation IDs to reconcile, and the screen's working files are kept in `--scratch` for that reconciliation. If the run itself fails after screening begins, the candidates not yet screened are recorded as `skipped_after_error`, the scratch directory is removed, and the record of the spend so far is still written, with stop reason `pipeline_error`.
5. Ranks the survivors (`not_located`): confirmed planted forms first, then more attempts (more independent misses is stronger evidence that the bug cannot be found by reading), then higher finder confidence, then file and line.
6. Removes each scratch copy after its screen unless `--keep-scratch` is given, in which case the summary prints the kept scratch directory. The host tree is never written.

A dry run does steps 1 and 2 only: it makes no copies, calls no screen and spends nothing, derives each candidate's symptom (recording its SHA-256) and records the most the screens could spend under the caps. A dry run needs neither `DATABASE_URL` nor the Token Factory key.

## The default route's record

A `behavioral-qualification/v1` run lists and plants as steps 1 and 2 above (the same checks, statuses and candidate cap), then writes a canonical record of kind `candidate_run`, version 2: the route (`{ route_id: "behavioral-qualification", version: "1" }`), the run ID and time, the rule's ID and SHA-256, the host commit when given, the finder's name, the candidate cap, every site with its status (`pending_qualification` for a planted candidate, or `invalid_site`, `plant_failed` or `over_candidate_cap`), reason, confidence in parts per million, planted-form confirmation and level, diff and `difficulty: { status: "not_assessed" }`, and totals. It has no screen fields. The screen options are still parsed and checked, but the route has no screen prerequisite: no key, no `DATABASE_URL`, no rate sheet and no per-screen budget check. Screen options given on this route are named in a note on stderr, so a screening invocation that leaves out `--route static-screen/v1` does not pass silently. See `BehavioralRunRecord` in `src/routes.ts`.

## The static-screen/v1 run record

The record is canonical JSON (`@rbw/schema`'s `encodeCanonical`: sorted keys, integers only). It holds the record kind `candidate_run` and version 1, the run ID and time, whether it was a dry run, the rule's ID and SHA-256, the host commit when given, how the symptoms were made (`symptom_source`), the screen model (`screen_model`), the finder and screen implementation names, the caps, every site with its status, reason, confidence in parts per million, whether its planted form was confirmed and its confidence level (null when the finder reports neither), diff, its symptom's SHA-256 (not the text; null for a site that did not plant), screen result, amount charged and rank, the ranking of survivor IDs, why screening stopped (if it did), and totals. A candidate's ID is the SHA-256 of its file, line and diff. See `RunRecord` in `src/pipeline.ts`.

The record lists candidate sites in the host, and a list of sites in a real host is private. The command line refuses an `--out` path inside this repository or inside `--host` (following symbolic links), and never overwrites an existing file. It claims the `--out` file before the pipeline runs, so an existing file or a missing directory is refused before any screen spends. If the record cannot be encoded as canonical JSON, it is kept as plain JSON; if it cannot be written to `--out`, it is written to a new file in the `--scratch` directory. Either way the spend is printed. Tests use a synthetic host tree only.

## Command line

```sh
node tools/candidates/src/cli.ts --rule <class rule file> --host <host tree> --out <new record file> \
  [--route behavioral-qualification/v1|static-screen/v1] \
  [--rule-id <id>] [--host-commit <40-hex sha>] [--dry-run] [--model super|kimi] \
  [--max-candidates <n>] [--max-spend-usd <usd>] [--screen-budget-usd <usd>] [--screen-attempts <n>] \
  [--slot-key <key>] [--pool <key>] [--rate-sheet <path>] \
  [--scratch <dir>] [--keep-scratch]
```

A real `static-screen/v1` run (no `--dry-run`) reads `DATABASE_URL` and `TOKEN_FACTORY_SCREEN_KEY` from the environment and never prints either value. The spend ledger named by `DATABASE_URL` must already have the `@rbw/spend` migrations applied. Before anything runs, the command checks what the real screen would otherwise refuse once per candidate: that both variables are set (real run only), that the rate sheet prices the model, and that `--screen-attempts` calls at the model's worst-case price fit in `--screen-budget-usd` (on a dry run too). Model calls go through `@rbw/screen`'s fetch, whose timeouts match the longest screen profile, and a dropped database connection is reported as that screen's failure instead of ending the process.

| Option | Default | Meaning |
| --- | --- | --- |
| `--route` | `behavioral-qualification/v1` | The candidate route: `behavioral-qualification/v1` or `static-screen/v1`. |
| `--rule-id` | the rule file's name without `.yml` | The rule ID recorded and passed to the finder. |
| `--model` | `super` | The screen model profile (`super` or `kimi`). |
| `--max-candidates` | 10 | Most candidates planted and screened. |
| `--max-spend-usd` | 2.00 | Cap on the total the screens may spend. |
| `--screen-budget-usd` | 0.25 | Budget given to each screen. One Kimi-K3 call's worst case is 319,488 micro-USD, so `--model kimi` needs a larger budget or the run is refused before it starts. |
| `--screen-attempts` | 3 | Attempts allowed to each screen, from 1 to 8. |
| `--slot-key`, `--pool` | `development` | The spend ledger slot each run acquires and the pool each call reserves from. |
| `--rate-sheet` | `packages/screen/rates.json` | The price file hashed into every reservation. |
| `--scratch` | the system temporary directory | Where the run makes its scratch directory, and the screen its working directories (`rbw-screen-*`). It must be outside `--host` and outside this repository. |
| `--keep-scratch` | off | Keeps the planted copies and the screen's working directories. |

Amounts are decimal USD with at most six decimals and are held as integer micro-USD. It prints a short summary and the record's path.

Exit codes: 0 the run finished and the record was written; 1 the pipeline could not run or finish (the finder failed, the run failed after screening began, or a screen stopped the run, in which case its reason is printed), and once screening has begun the record of the spend so far is still kept and its path printed; 2 a usage or input error found before anything ran (including an `--out` that exists, sits in a missing directory or sits inside `--host`, a `--scratch` that is not a directory or sits inside `--host` or this repository, an unreadable `--rate-sheet`, an unknown `--model`, a missing `DATABASE_URL` or key on a real run, or a per-screen budget the attempts cannot fit), nothing written.

### Screening the race class over a host tree

With `DATABASE_URL` and `TOKEN_FACTORY_SCREEN_KEY` set, and the record written **outside** this repository (a list of real host sites is private):

```sh
DATABASE_URL=… TOKEN_FACTORY_SCREEN_KEY=… \
node tools/candidates/src/cli.ts \
  --route static-screen/v1 \
  --rule packages/shapes/rules/race.class.yml \
  --rule-id race.class \
  --host /path/to/host/checkout \
  --out /path/to/private/race-run.json \
  --model super \
  --max-candidates 10 --max-spend-usd 2.00 --screen-budget-usd 0.25 --screen-attempts 3
```

Try it first with `--dry-run` (no `DATABASE_URL`, no key): it lists and checks the candidates, derives their symptoms and reports the most the screens could spend, without a copy, a screen or any spend.

## Tests

`pnpm --filter @rbw/candidates test` runs the unit tests. They use a synthetic host tree with a fake finder and a scripted screen, the real `@rbw/shapes` finder over `@rbw/shapes`'s synthetic race fixtures, and the real `@rbw/screen` run driven end to end with a scripted fake model and an in-memory PGlite ledger. No model, network or real database is used.
