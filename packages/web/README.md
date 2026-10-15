# @rbw/web

The results site: a Next.js app (App Router) that renders the case evidence page and a diagnostic catalog from published records. Every page and file is prerendered at build time from a results directory. Only the judge routes run at request time; they start one judge replay at a time (below). This is part of a hackathon prototype.

## Pages

| Path | Content |
|---|---|
| `/` | The case page, with its six cells in a fixed order (below); with several releases, the list of released cases and then the first released case (see [Several releases](#several-releases)) |
| `/cases/<release_id>` | Each released case's own case page, with that release and its run as the case |
| `/catalog` | Every run with its kind (factory run, kit check or verification replay) and recorded status, and each published run's manifest entries |
| `/runs/<root>` | A published run's file index: its file count and total size, and every manifest entry with its outcome, size and SHA-256, linking the files below |
| `/runs/<root>/<path>` | A published run's files and its `manifest.json`, at the paths they have in the results repository |
| `/releases/<release_id>/<path>` | Each release's `release.json` and the files its record lists, at the paths they have in the results repository |

The case page opens with a short paragraph: what a blind-spot example is (a bug planted in a pinned copy of Umami that Umami's own original API suite does not catch, while added checks do), links to the code repository, the results repository and Umami, and the hosted services the code uses. Then its cells, in order:

1. the plain-language symptom and the synthetic-task label;
2. for a time-zone case, expected versus observed local-day counts for each time zone, with the source timestamps in a collapsed table; for a race case (a `RaceSymptom`), the two concurrent requests with their send and answer times, HTTP statuses, outcomes and error codes, the expected versus observed acceptance and refusal counts, and the same requests sent one after the other in a collapsed table;
3. the original API suite and the added checks on the clean, planted and fixed copies (the six cells of ADM-08), each with a text status, a note on why the planted and fixed cells count 20 times the clean cell's executions (ADM-05), and what the rule codes ADM-02 to ADM-09 mean, with a link to `docs/admission-rules.md`;
4. the verified replay button and its state;
5. provenance (release, run, policy, task revision, kit version, family, human check, the released run's novelty check, calibration) and downloads: the release's files, and for each published run one line with its file count, total size, `manifest.json`, `report.md` and a link to its file index page (`/runs/<root>`), never the full file list;
6. the batch funnel of factory runs, a sentence that it counts only the factory runs published for this site (so it is not a record of every attempt), the runs counted apart from it (below), the limitations and the method.

The method and the rule-code note count the case's fresh copies from its admission evidence, so each case shows its own count: 13 copies for the time-zone family, including a partial-fix and a stub-fix copy, and 11 for a family that records ADM-06 as not applicable (the race family), with no negative-probe copies. Without admission records they describe the full admission profile's 13 copies.

### Judge replays and kit checks

The funnel counts only roots whose `RootRun` kind is `factory`. Judge replays (kind `judge_replay`, published by `tools/release publish-replays`) are verification runs, and kit checks (kind `kit_check`) are not factory runs either, so a second table, "Runs counted apart from the factory funnel", counts them: "Verification replays (judge)", then one "Replays completed", "Replays failed", "Replays incomplete", "Replays cancelled" or "Replays not finished" line for each outcome some replay has, then "Paired comparisons" and "Kit checks" when there are any.

Paired comparison roots (kind `paired_comparison`, the paired solver comparison) are not factory runs either. The funnel leaves them out, the table above counts them, and the case page keeps them out of the diagnostic archive, so none is labeled "not validated". The catalog's Kind column says "Paired comparison", its opening sentence says that paired comparisons are not factory runs, and a paired comparison's file index page is labeled "Paired comparison, not a factory run".

A published replay holds `report.md`, its `judge_verify` job's `request.json`, `evidence.json` (the six cells), `decision.json`, `summary.json` and the copies' files. Its `decision.json` has no `outcome_verdict` and no comparison, and the verified or not-reproduced state the judge saw is not in the public records, so the replay lines count each replay's recorded outcome, and when any replay is recorded the page says that completed means the run ended, not that it reproduced the release.

The case page lists published replays under "Verification replays (judge)", apart from the diagnostic archive, so none is labeled "not validated". The catalog's Kind column says "Factory run", "Kit check" or "Verification replay (judge)", and its opening sentence says that replays are not factory runs. A replay's file index page is labeled "Verification replay (judge), not a factory run". Its files are served at `/runs/<root>/<path>` like any published run's.

The page names the measured original **API** suite and says that other upstream tests were not evaluated. Calibration is shown as "Not requested", never as a solve count. On narrow screens the suite matrix and the replay's six cells stack, each cell with its row and column label, and a file index table stacks its rows. Long identifiers (hashes, UUIDs, image references, paths) wrap anywhere, so no page scrolls sideways at a 375 px viewport; the catalog's run table scrolls inside its own box. Every status is written in text; color only repeats it.

### With and without a release

With a release (ADM-09), the page shows "Validated blind-spot example". The case is the released run, labeled "Validated release, synthetic planted bug". Provenance comes from `release.json`, and "Release files" lists `release.json` and the release's files, followed by the released run's file summary. Other published factory runs (not judge replays or paired comparisons) stay in the diagnostic archive, each labeled "not validated"; one whose admission passed with a blind spot demonstrated also says that no release names it and which run the one published release is for. The funnel counts 1 validated release. The catalog marks the released run. This paragraph describes a site with one release; [Several releases](#several-releases) describes more.

Without a release, the page shows "No validated blind-spot example yet", provenance says "Release: None published yet.", "Release files" says there are none, and the funnel counts 0 validated releases. A run that holds an observed symptom is shown as the case, labeled "Development evidence, not validated", and published runs are downloadable as diagnostic archives.

Without a release, or when the judge routes are not configured for the release, the replay control is disabled. Otherwise it shows a passcode field and the "Plant and verify this example" button (see Judge routes).

### Several releases

A site holds 1 to 99 releases. With one, every page is as described above, and `/cases/<release_id>` shows the same case page as `/`.

With more than one, every case page (`/` and each `/cases/<release_id>`) opens with "Released cases": a table of every release, newest first (by `created_at`, then release ID), with its date, its family ("Time-zone" or "Race", from the released run's symptom; the release's `family_id` when the run holds none), its status as the release records it ("Validated release (ADM-09): admission pass, blind spot demonstrated"), its count of published verification replays and a link to its page. `/` shows the first released case, the one it showed while it was the only release, so links shared before more releases were added still show the same case; it says so above the table. `/releases/<release_id>/<path>`, `/runs/<root>` and `/catalog` are unchanged.

Each case page shows its own release's provenance, files and replay control, and the replay it starts replays that release. The funnel counts every release under "Validated releases (ADM-09)", the diagnostic archive leaves out every released run, and the catalog and the run index pages mark each released run with its release; a released run's index page links back to its case page.

A judge replay's release is the `release_id` of its published `judge_verify` request (`results/<execution>/request.json`). With more than one release, a case page lists and counts only the replays of its release ("Verification replays (judge) of this release"), and "Verification replays not yet matched to a release" counts the replays that name none of the site's releases: those not published yet, and those whose request is missing or is not a `judge_verify` `JobRequest` (such a request does not fail the build). With one release, every replay is counted on its page, as before.

## Results directory

`src/release.ts` reads one directory with the layout the publisher (`packages/publisher`) writes to its two destinations:

```
repository/runs/<root>/manifest.json   each published run's RunManifest (canonical JSON)
repository/runs/<root>/<entry path>    the run's published files below the large-file threshold
store/status/<root>.json               each run's PublicRunStatus (canonical JSON)
store/sha256/<hex>                     large published files; optional, since pages link them by public_uri
repository/releases/<release_id>/      each release (1 to 99 when releases/ exists): release.json and the files its record lists
```

`repository/` is a checkout of the results branch and `store/` a copy of the public store's objects. Inside a published run, the app reads:

| Path | Record | Used for |
|---|---|---|
| `generated/symptom.json` | `ObservedSymptom`, or `RaceSymptom` when it has a `symptom_kind` field (`@rbw/schema`) | cells 1 and 2 |
| `generated/novelty.json` | the phrase checks' novelty summary (`@rbw/search`); its `status` and the number of `matching_urls` | cell 5, linked; "Not in this run's published records" when it is absent or not a novelty summary |
| `results/<execution>/evidence.json` and `decision.json` | the admission importer's outputs (`@rbw/admission`) | cell 3 and the funnel; the job whose decision kind is `admission`. A job whose two files were not both published has no records to show. |

The case is the run with a symptom that got furthest: a demonstrated blind spot, then any admission decision, then a symptom alone; ties go to the first root execution ID. Every run stays in the catalog.

With a release, the case is the released run instead; with several, `/` shows the first released case and each `/cases/<release_id>` its own.

The release step (`tools/release`) runs its checks before it writes a release, so the app does not rerun them. It checks that `release.json` is a canonical `Release` named after its directory, that the directory holds exactly the listed files with their SHA-256, and that `release.run` names a run published here whose `manifest.json` bytes have `manifest_sha256`. The release's integrity is the SHA-256 of `release.json`'s bytes (`Results.release.sha256`).

The symptom and admission paths are this app's reading convention. `tools/release stage` writes a controller run directory in this layout for the publisher.

### Refusals

`readResults` throws a `ReleaseError` with one of these codes, and the build fails:

| Code | Cause |
|---|---|
| `layout` | No `repository/` directory, a non-UUID entry in `runs/`, or a file that is not a regular file |
| `manifest_invalid` | A missing manifest, one that fails `parseRecord("RunManifest")`, or one that is not canonical bytes |
| `run_directory_mismatch` | A run directory whose name is not its manifest's root |
| `file_missing`, `file_hash_mismatch` | A listed file that is absent, or whose size or SHA-256 differs from its entry |
| `file_unlisted` | A file in a run directory that the manifest does not list as a repository file |
| `status_invalid` | A status object that fails `parseRecord("PublicRunStatus")`, is not canonical, or is named after another root |
| `status_mismatch` | A status object that disagrees with the published manifest |
| `run_missing` | A status object that says `published` for a run the repository does not hold |
| `symptom_invalid` | A symptom with a `symptom_kind` field that fails `parseRecord("RaceSymptom")`, or any other symptom that fails `parseRecord("ObservedSymptom")` |
| `admission_invalid` | Published evidence or a decision that is not canonical or fails its shape, or a second admission job in one run |
| `admission_mismatch` | A decision whose `evidence_sha256` is not the evidence file's, or records of another root, execution or kind |
| `release_invalid` | A `releases/` directory that holds no release or more than 99 entries (checked before any is read), an entry that is not a UUID-named directory, a `release.json` that is missing, fails `parseRecord("Release")`, is not canonical or names another release, a file that is unlisted, absent or has another SHA-256, or two releases that name the same run; each message names the release directory or directories. A results directory without `releases/` has no release |
| `release_mismatch` | A release whose run is not published here, or whose `manifest_sha256` is not that run's `manifest.json` bytes |

`/runs/<root>/<path>` serves only paths the manifest lists, and `/releases/<release_id>/<path>` only `release.json` and the paths the release lists; any other path is not prerendered and gives 404.

The pages and the file route call `loadResults`, which runs `readResults` once per directory per process and keeps the result with an index of the files the route serves. A build therefore reads and hashes each published file once to check it and once more to serve it, however many routes it prerenders. Under `next dev`, changes to the results directory show after a restart.

## Judge routes

A judge replay plants and verifies the released case again: three fresh copies (clean, planted, fixed) on Vercel Sandbox, started by a controller in its own sandbox, so no step runs on the conductor's machine. Only judges with the shared passcode can start one, and only one runs at a time.

| Route | Request | Answer |
|---|---|---|
| `POST /api/judge/session` | `{ passcode }` | A correct passcode sets the session cookie (HttpOnly, Secure, SameSite=Strict, an HMAC keyed with the passcode, so a new passcode ends every session); a wrong or missing one gives 401, and the page then says "That passcode is not right" and puts focus back on the field; a correct one moves focus to the start button |
| `GET /api/judge/session` | | 200 with `ready` while the session cookie is valid and `signed_out` otherwise (every page load asks, so neither is an error), so a reloaded page shows the start button without a new sign-in |
| `POST /api/judge` | exactly `{ request_id }`, a UUID the browser makes and keeps; or `{ request_id, release_id }` where a request may name its release (below) | `starting`, the replay's status when the request ID already has one (nothing new is written, reserved or created), or `unavailable` with a reason |
| `GET /api/judge/status?request_id=<uuid>[&release_id=<uuid>]` | | The replay's state, the copies' progress, the measured duration apart from the 35-minute hard cap, and at the end the six cells with their failing tests |

The judge routes refuse a request without the session cookie before any ledger, Blob or Sandbox call. The release comes from the build, not the request: the judge picks one of the releases the build froze, and the routes replay it only when its ID and the SHA-256 of its frozen `release.json` are on the allowlist (see [Configuration](#configuration)); otherwise they answer `unavailable` (the release) with nothing written. A request may name its release (`release_id`) when the build froze more than one release or `RBW_JUDGE_RELEASES` is set; otherwise a body with `release_id` is a bad request, exactly as with one release. Without `release_id` there must be exactly one release that is both frozen and allowlisted. On a site with several releases each case page's control names its release in both requests and keeps its request ID under its own browser key. Each replay starts the controller with its release's `release.json`, controller image and frozen judge job (`judge_job`). The one judge slot, the `judge` allocation, the hold and the halted and budget states are shared by every release. The start button is disabled while a start is in flight or a replay runs. While a replay starts or runs, the page asks the status route every 15 seconds; an `unavailable` answer then (the ledger or the access token, for a moment) says nothing about the replay, so the page shows it, keeps asking after 15, 30 and then every 60 seconds, and keeps the start button disabled until a final state or `unknown` arrives. The first status check after a reload is treated the same way, since the stored replay may still be running.

The budget: a replay reserves on the `judge-demo` pool's `judge` allocation, which is protected for judges; the `public` allocation is for anonymous use, and using it up never blocks a replay. Before it takes the slot, the POST checks that both the `judge` allocation and the pool as a whole can cover the job; when either cannot, it answers `unavailable` (budget) with no ledger write, no slot and no sandbox. An operation settled over its envelope anywhere halts all spend until an operator resumes it; the POST reads the ledger's halt status before it takes the slot and then answers `unavailable` (halted, "Paused: spending is halted for an operator check") the same way, and a reservation refused for a halt that began after that check also answers halted, after the slot is released. The spend ledger's connection retries its first connect twice (see `tools/controller`); when it still fails, both routes answer `unavailable` (the ledger) rather than a server error.

The states, each written in text; the page adds a plain explanation under `not_reproduced`, `incomplete`, `needs_reconciliation` and `unknown`, and each `unavailable` answer shows its reason's text:

| State | Meaning |
|---|---|
| `disabled` | No release, or the judge routes are not configured for this page's release |
| `ready` | The control can start a replay |
| `starting` | The controller sandbox was created and no copy has started; also shown, with "Could not reach the site", when the start request got no answer or one that was not JSON, since the replay may have started: the browser keeps the new request ID and the 15-second status check shows what happened |
| `running` | A copy has started |
| `verified` | All six cells came out as the release's did |
| `not_reproduced` | At least one cell did not |
| `incomplete` | The replay ended without a result, or ran past its timeout with nothing left open |
| `needs_reconciliation` | A launch or the end of the replay is not confirmed; the operator checks the ledger, and the judge can try again later |
| `unavailable` | Busy (another replay runs: try again shortly), the budget, a spend halt (an operator check: try again later), the hold, the release, the access token, the spend ledger, or a start that failed before anything ran |

The hold: after two `not_reproduced` replays in a row (`incomplete` ones do not count), new replays are `unavailable` ("held for inspection") until `RBW_JUDGE_HOLD_CLEARED_AT` is set to a later time.

The known condition: on the 2nd to the 5th of a month, when the only unexpected cells are the original suite's two upstream revenue tests, the replay is `verified` and the page says: "Two upstream revenue tests fail on the 2nd to the 5th of each month, a known date-dependent condition in Umami's own test data, not in this example. They are shown as failures and are not counted against this replay."

## Configuration

`src/config.ts` is the one configuration loader. `RBW_RESULTS_DIR` names the results directory, relative to this directory or absolute. The default is `fixtures/development-2026-10-06`.

The judge routes read these server variables at request time; none of them is in the client bundle, and the routes print none of them:

| Variable | Use |
|---|---|
| `RBW_JUDGE_PASSCODE` | The shared judge passcode, compared in constant time; unset disables the judge routes |
| `RBW_JUDGE_RELEASES` | The releases the routes accept: `<release_id>=<sha256>` pairs (the SHA-256 of each `release.json`'s bytes) separated by commas or white space, 1 to 99 of them, each release once. A value with no pair, more than 99, a repeated release or a malformed pair accepts no release. When it is set, the two variables below are ignored |
| `RBW_JUDGE_RELEASE_ID`, `RBW_JUDGE_RELEASE_SHA256` | Without `RBW_JUDGE_RELEASES`: the one release the routes accept, by ID and `release.json` SHA-256 |
| `RBW_JUDGE_HOLD_CLEARED_AT` | Optional UTC time; replays created before it do not count for the hold |
| `DATABASE_URL` | The spend ledger |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Vercel Sandbox, for the controller sandbox and its copies |
| `BLOB_PRIVATE_STORE_ID` | The private Blob store; the request's OIDC token authenticates it |

The controller sandbox receives the last four, and the request's OIDC token, as environment values. The build freezes every release's `release.json` and the pinned rate sheet into the server bundle (`next.config.ts`), because the functions do not hold the results directory. The case pages are prerendered, so a change to the judge variables reaches the pages' replay controls with the next build.

The record packages read their schema files next to their sources, which a bundled copy cannot do, so `src/records.ts` loads them with imports the bundler leaves out, and Node loads them from the workspace during prerendering.

## Fixtures

Both fixtures were written by the real publisher in local mode (`scripts/publish-fixture.ts`), so their bytes and layout are the publisher's own. Their root and execution IDs are placeholders, and their policy is the publisher proof's synthetic placeholder policy.

| Fixture | Content |
|---|---|
| `fixtures/development-2026-10-06` | One completed run: development evidence from the local runner's run of 2026-10-06. It holds the observed symptom (copied from `tools/local-runner/candidates/umami-tz-arg-001/writer-input.json`) and the planted copy's four recorded responses (copied from that directory's `observed/`). That run's kit-check and admission records are not committed in this repository, so the fixture has none, and the suite matrix shows "No record in this run". |
| `fixtures/no-release` | Synthetic diagnostic runs and no case: one failed and one incomplete published run (with a `not_produced` entry) and one running kit check that has only a status object |

`fixtures/sources/<fixture>/` holds the inputs: `roots/<root>.json` (each `RootRun` without `project_id` and `project_policy_sha256`, which come from the placeholder policy) and `staging/<root>/` (the staging directory). To write a fixture again:

```sh
pnpm --filter @rbw/web publish-fixture --sources fixtures/sources/<fixture> --out fixtures/<fixture> --gitleaks <gitleaks command> [--patterns <file>]
```

Without `--patterns` the script writes a synthetic pattern list. It needs gitleaks 8.30.1 (see `tools/publication/README.md`).

## Commands

```sh
pnpm --filter @rbw/web build       # next build; prerenders every page and file
pnpm --filter @rbw/web test        # unit tests, including one that runs next build for each fixture
pnpm --filter @rbw/web typecheck
pnpm --filter @rbw/web dev         # local development server
RBW_RESULTS_DIR=fixtures/no-release pnpm --filter @rbw/web build
RBW_RESULTS_DIR=../../tools/release/fixtures/release pnpm --filter @rbw/web build   # the synthetic release
```

The build sets `NEXT_TELEMETRY_DISABLED=1`.

## Deploying on Vercel

This repository holds no Vercel configuration. The project settings:

- Root Directory: `packages/web`, with source files outside the root directory included in the build, since the app imports workspace packages (`@rbw/schema`, `@rbw/admission` and others).
- Framework preset: Next.js. Vercel installs with pnpm from the repository root lockfile.
- Node.js version: 24.x.
- `RBW_RESULTS_DIR` is optional; unset, the build uses the development fixture, which holds no release. The judge routes' variables are listed under [Configuration](#configuration).

A push of a branch other than the production branch then builds a preview deployment from the committed fixture.

The live site is built from the published results, which are not in this repository. To deploy it:

1. Take a tree of this repository at the commit to deploy, for example `git archive <commit> | tar -x -C <new dir>`. For the judge routes, the commit must fit the controller image the release pins (see `--prebuilt` in `tools/controller/README.md`).
2. Assemble a results directory inside `packages/web` of that tree, from the public results repository and the public store:

   ```sh
   cd <tree>/packages/web
   node scripts/assemble-results.mjs results-snapshot \
     https://github.com/Erik-1259/random-bug-walk-results https://iguounh7tl23isfm.public.blob.vercel-storage.com/
   ```

   The script (`scripts/assemble-results.mjs`) makes a shallow clone of the results repository as `repository/`, downloads each run's status object to `store/status/` and each manifest entry that has a `public_uri` to `store/sha256/`, and checks every downloaded object against its manifest's SHA-256. A published run's status object must say `published`; because the publisher writes it after pushing the repository and the store caches it for up to 60 seconds, the script fetches it again every 15 seconds, up to 7 times, before it gives up (a missing status object counts as not yet published). Do not assemble while a publication is running: the script handles a publication that finishes just before it starts, not one that overlaps it. It reads public data only and needs no credentials. The output directory must not exist yet. It fetches status objects for the runs the repository holds. A run the publisher wrote only as a status object (still running, or failed before its manifest was published) has no repository directory, and the public store cannot be listed without credentials, so pass such runs' root IDs after the base URI to include them. If one of them is published while the script runs, its manifest is not in the clone, so the script stops and asks to be run again. The build does not need the clone's `repository/.git`, which can be moved out of the tree before the upload.
3. Set `RBW_RESULTS_DIR=results-snapshot` (relative to `packages/web`) in the project's environment, together with the judge routes' variables.
4. Deploy that tree, for example with `vercel deploy` from its root, linked to the project. The build checks the whole results directory (see [Refusals](#refusals)) and fails on any mismatch.

## Dependencies

- `next` lists `sharp` as an optional dependency for `next/image`. Its libvips binaries are LGPL, and this app does not use `next/image`, so `pnpm-workspace.yaml` removes it with an override.
- `next` depends on `caniuse-lite`, which is browser-support data under CC-BY-4.0.

## Tests

- `test/release.test.ts`: both fixtures and the release fixture (`tools/release/fixtures/release`, read in place) parse; every refusal above; the development fixture's symptom and responses equal their committed sources.
- `test/page.test.tsx`: the six cells in order, their text statuses with and without admission records (evidence and decisions from the real importer over the admission package's synthetic record sets), the no-release and release states, the funnel and the catalog.
- `test/race-case.test.tsx`: a case run whose symptom is `@rbw/schema`'s synthetic `RaceSymptom` fixture and whose admission evidence has 11 copies (the admission package's race-family record set, imported by the real importer) is read and rendered with its concurrent requests and acceptance counts, an invalid race symptom is refused as `symptom_invalid`, and the method counts 11 copies, or 13 for a time-zone admission, from the records.
- `test/replays.test.tsx`: with synthetic judge replay roots added to the release fixture (`addJudgeReplay` in `test/support/results.ts`), the funnel counts only the factory run, the second table counts the replays by outcome with the note that the records hold no verdict, the case page lists the replays apart from the diagnostic archive, and the catalog and the replay's file index page label them as verification replays.
- `test/route.test.ts`: the run and release file routes serve exactly the published files, byte for byte, and 404 otherwise.
- `test/multi-release.test.tsx`: two synthetic releases in one results directory (the release fixture's time-zone release and a race-family release of a race case run, `twoReleases` in `test/support/results.ts`) are read newest first with their families, get one case page each with their own symptom, files and replay control, are listed on `/` with their status while `/` keeps the first released case, are served under their own release paths and marked in the catalog; replays are counted per release from their published request; 100 release entries, an invalid release beside a valid one and two releases of one run are refused, each naming the cause, and 99 entries pass the count.
- `test/reads.test.ts`: a directory is checked once per process, and prerendering every file route reads each added published file exactly twice, so reads grow linearly with the number of files.
- `test/layout.test.tsx`: the case page summarizes each run's files and links its index page instead of listing them; the run index page lists every entry; the opening paragraph and its links; the rule codes and the execution-count note beside the matrix; why another passing run is not validated; the funnel's scope; the replay's labeled six cells and its announced status line.
- `test/judge/judge.test.ts`: the judge routes against a local ledger, store and Sandbox SDK, including the allowlist: `RBW_JUDGE_RELEASES` parsing (0, 99 and 100 entries, duplicates, malformed pairs) and its precedence over the single pair; with two frozen releases, the chosen release is replayed with its own judge job and controller image, a release that is not frozen, not allowlisted or has another hash is refused, and the slot and the hold stay shared.
- `test/build.test.ts`: `next build` succeeds for the two fixtures, the release fixture and two synthetic releases, and prerenders the pages, each run's index page, each case page and the files; the built judge route replays only an allowlisted frozen release.

## What it does not do

- It does not rerun the release step's checks; it reads `release.json` and checks only its files and its link to the run.
- It does not render the frozen issue inline; `issue.json` is a download.
- Its only routes that launch compute are the judge routes, and only for judges with the passcode. It has no anonymous replays, no queue and no cancel action.
- It reads a local results directory at build time; the app fetches nothing from the results repository or the store. Only `scripts/assemble-results.mjs`, run before a build, downloads them.
- It uses no external fonts or assets.
