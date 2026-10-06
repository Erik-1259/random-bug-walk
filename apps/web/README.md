# @rbw/web

The results site: a Next.js app (App Router) that renders the case evidence page and a diagnostic catalog from published records. Every page and file is prerendered at build time from a results directory, and nothing is computed or launched at request time. This is part of a hackathon prototype.

## Pages

| Path | Content |
|---|---|
| `/` | The case page, with its six cells in a fixed order (below) |
| `/catalog` | Every run with its recorded status, and each published run's manifest entries |
| `/runs/<root>/<path>` | A published run's files and its `manifest.json`, at the paths they have in the results repository |

The case page's cells, in order:

1. the plain-language symptom and the synthetic-task label;
2. expected versus observed local-day counts for each time zone, with the source timestamps in a collapsed table;
3. the original API suite and the added checks on the clean, planted and fixed copies (the six cells of ADM-08), each with a text status;
4. the verified replay button and its state;
5. provenance (run, policy hash, task revision, kit version, release, calibration) and downloads;
6. the batch funnel, the limitations and the method.

The page names the measured original **API** suite and says that other upstream tests were not evaluated. Calibration is shown as "Not requested", never as a solve count. On narrow screens the suite matrix stacks its six cells, each with its row and column label. Every status is written in text; color only repeats it.

### No validated result yet

Releases (ADM-09) are planned and have no record format yet, so no published record can make a result eligible. The page therefore always shows "No validated blind-spot example yet", the funnel and the method; the replay button is disabled, and validated-task downloads are disabled. Published runs stay downloadable as diagnostic archives, each labelled "not validated". A run that holds an observed symptom is shown as the case, labelled "Development evidence, not validated".

The replay control's states (`disabled`, `ready`, `starting`, `running`, `passed`, `failed`) are defined in `src/model.ts`. Only `disabled` is reachable: the replay action is planned as the next item.

## Results directory

`src/release.ts` reads one directory with the layout the publisher (`packages/publisher`) writes to its two destinations:

```
repository/runs/<root>/manifest.json   each published run's RunManifest (canonical JSON)
repository/runs/<root>/<entry path>    the run's published files below the large-file threshold
store/status/<root>.json               each run's PublicRunStatus (canonical JSON)
store/sha256/<hex>                     large published files; optional, since pages link them by public_uri
```

`repository/` is a checkout of the results branch and `store/` a copy of the public store's objects. Inside a published run, the app reads:

| Path | Record | Used for |
|---|---|---|
| `generated/symptom.json` | `ObservedSymptom` (`@rbw/schema`) | cells 1 and 2 |
| `results/<execution>/evidence.json` and `decision.json` | the admission importer's outputs (`@rbw/admission`) | cell 3 and the funnel; the job whose decision kind is `admission`. A job whose two files were not both published has no records to show. |

The case is the run with a symptom that got furthest: a demonstrated blind spot, then any admission decision, then a symptom alone; ties go to the first root execution ID. Every run stays in the catalog.

These two paths are this app's reading convention. No current code stages the local runner's outputs for the publisher; that hand-off is planned.

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
| `symptom_invalid` | A symptom that fails `parseRecord("ObservedSymptom")` |
| `admission_invalid` | Published evidence or a decision that is not canonical or fails its shape, or a second admission job in one run |
| `admission_mismatch` | A decision whose `evidence_sha256` is not the evidence file's, or records of another root, execution or kind |

`/runs/<root>/<path>` serves only paths the manifest lists; any other path is not prerendered and gives 404.

## Configuration

`src/config.ts` is the one configuration loader. `RBW_RESULTS_DIR` names the results directory, relative to this directory or absolute. The default is `fixtures/development-2026-10-06`.

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
```

The build sets `NEXT_TELEMETRY_DISABLED=1`.

## Dependencies

- `next` lists `sharp` as an optional dependency for `next/image`. Its libvips binaries are LGPL, and this app does not use `next/image`, so `pnpm-workspace.yaml` removes it with an override.
- `next` depends on `caniuse-lite`, which is browser-support data under CC-BY-4.0.

## Tests

- `test/release.test.ts`: both fixtures parse; every refusal above; the development fixture's symptom and responses equal their committed sources.
- `test/page.test.tsx`: the six cells in order, their text statuses with and without admission records (evidence and decisions from the real importer over the admission package's synthetic record sets), the no-release state, the funnel and the catalog.
- `test/route.test.ts`: the file route serves exactly the published files, byte for byte, and 404 otherwise.
- `test/build.test.ts`: `next build` succeeds for both fixtures and prerenders the pages and files.

## What it does not do

- It shows no validated result: releases (ADM-09) and the card, issue and leak checks (ADM-07) are planned.
- It does not run replays and has no server route that launches compute.
- It reads a local results directory at build time; it fetches nothing from the results repository or the store.
- It uses no external fonts or assets.
