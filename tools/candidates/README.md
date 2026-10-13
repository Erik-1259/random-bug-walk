# @rbw/candidates

The candidate pipeline. Given a class-level shape rule, it lists every site the rule matches in the host tree, plants each site in its own scratch copy, runs the static-headroom screen on each copy, and ranks the candidates that survive. The result is one run record, so checks (the expensive step of the bug generation pipeline) are written only for candidates worth building them for.

The pipeline calls two functions it does not implement. Both are passed in as arguments, and the command line takes them from `src/wiring.ts`:

| Function | Comes from | Contract |
| --- | --- | --- |
| `findSites(rule, hostDir)` | the class-level site finder in `@rbw/shapes` | Returns `[{ file, line, diff, confidence }]`: a host-relative path with `/` separators, the 1-based line of the match in the clean file, a unified diff that changes only that file from the clean to the planted form (`a/` and `b/` prefixes allowed), and a confidence from 0 to 1. It may return a promise. |
| `screen(plantedTree, symptom, budget)` | the static-headroom screen | Reads the planted copy at `plantedTree`, told only the symptom text, and returns `{ verdict, hits, attempts, costMicrousd }`. `verdict` is `located` (some attempt found the planted change from the source alone: the candidate fails the screen), `not_located` (no attempt did: it survives) or `inconclusive`. `hits` counts the attempts that found it. It must keep to `budget.maxAttempts` and `budget.maxCostMicrousd`. It may return a promise. |

The types are in `src/types.ts`. Until a real implementation lands, `src/wiring.ts` holds a placeholder that throws and names what should replace it. Wiring one is a one-line change in that file, for example `export { findSites } from "@rbw/shapes";` in place of the placeholder line. `@rbw/shapes` is already a dependency; the screen's package will need adding to `package.json` when it exists.

## What a run does

1. Calls `findSites` once. Exact duplicates (same file, line and diff) are collapsed. Sites are ordered by confidence, highest first, then by file and line.
2. Checks each site and plants it in memory: the path must stay inside the host, the line must be a positive integer, the confidence must be from 0 to 1, the file must be a regular file, and the diff must name only that file, apply exactly and change it. A site that fails is recorded as `invalid_site` or `plant_failed` with a reason code, and does not count toward the candidate cap. The first `--max-candidates` sites that plant become candidates; the rest are recorded as `over_candidate_cap`.
3. For each candidate in order, copies the host tree into a fresh directory under the run's own scratch directory (leaving out `.git` and `node_modules`), writes the planted file, and calls `screen`. Screens run one at a time.
4. Before each screen, checks that one whole per-screen budget still fits in what is left of the total spend cap. If it does not, that candidate and the rest are recorded as `skipped_spend_cap`. A screen that throws or returns a malformed result is recorded as `screen_error` and charged its whole budget, because its real cost is unknown; a malformed result that reports a cost above the budget is charged that cost instead. A screen that reports spending more than its budget, malformed or not, is recorded, and no further screens start (`skipped_after_overspend`). If the run itself fails after screening begins (for example a scratch directory cannot be made or removed), the candidates not yet screened are recorded as `skipped_after_error`, the scratch directory is removed, and the record of the spend so far is still written, with stop reason `pipeline_error`.
5. Ranks the survivors (`not_located`): more attempts first (more independent misses is stronger evidence that the bug cannot be found by reading), then higher finder confidence, then file and line.
6. Removes each scratch copy after its screen unless `--keep-scratch` is given, in which case the summary prints the kept scratch directory. The host tree is never written.

A dry run does steps 1 and 2 only: it makes no copies, calls no screen and spends nothing, and records the most the screens could spend under the caps.

## The run record

The record is canonical JSON (`@rbw/schema`'s `encodeCanonical`: sorted keys, integers only). It holds the record kind `candidate_run` and version 1, the run ID and time, whether it was a dry run, the rule's ID and SHA-256, the host commit when given, the symptom's SHA-256 (not its text), the finder and screen implementation names, the caps, every site with its status, reason, confidence in parts per million, diff, screen result, amount charged and rank, the ranking of survivor IDs, why screening stopped (if it did), and totals. A candidate's ID is the SHA-256 of its file, line and diff. See `RunRecord` in `src/pipeline.ts`.

The record lists candidate sites in the host, and a list of sites in a real host is private. The command line refuses an `--out` path inside this repository, and never overwrites an existing file. It claims the `--out` file before the pipeline runs, so an existing file or a missing directory is refused before any screen spends. If the record cannot be encoded as canonical JSON, it is kept as plain JSON; if it cannot be written to `--out`, it is written to a new file in the `--scratch` directory. Either way the spend is printed. Tests use a synthetic host tree only.

## Command line

```sh
node tools/candidates/src/cli.ts --rule <class rule file> --host <host tree> --symptom <symptom file> --out <new record file> \
  [--rule-id <id>] [--host-commit <40-hex sha>] [--dry-run] \
  [--max-candidates <n>] [--max-spend-usd <usd>] [--screen-budget-usd <usd>] [--screen-attempts <n>] \
  [--scratch <dir>] [--keep-scratch]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--rule-id` | the rule file's name without `.yml` | The rule ID recorded and passed to the finder. |
| `--max-candidates` | 10 | Most candidates planted and screened. |
| `--max-spend-usd` | 2.00 | Cap on the total the screens may spend. |
| `--screen-budget-usd` | 0.25 | Budget given to each screen. |
| `--screen-attempts` | 3 | Attempts allowed to each screen. |
| `--scratch` | the system temporary directory | Where the run makes its scratch directory. It must be outside `--host`. |

Amounts are decimal USD with at most six decimals and are held as integer micro-USD. A run without `--dry-run` is refused while the screen is not wired. It prints a short summary and the record's path.

Exit codes: 0 the run finished and the record was written; 1 the pipeline could not run or finish (an implementation is not wired, the finder failed, or the run failed after screening began), and once screening has begun the record of the spend so far is still kept and its path printed; 2 a usage or input error found before anything ran (including an `--out` that exists or sits in a missing directory, or a `--scratch` that is not a directory or sits inside `--host`), nothing written.

## Tests

`pnpm --filter @rbw/candidates test` runs the unit tests against a synthetic host tree with a fake finder and a scripted screen. No model, network or Docker is used.
