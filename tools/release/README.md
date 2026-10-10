# @rbw/release

The release tool. It turns a terminal root into a publisher staging directory, builds a checked release of a factory root with the frozen judge job a replay runs from, and publishes judge replays. It runs on the conductor's host; `build` needs Docker. This is part of a hackathon prototype, and the planted bug is synthetic.

It reuses the existing packages and does not re-implement them:
- **The job:** the local runner's `inspectImage`, `inspectRepoDigests`, `exportImage`, `deriveCodeStates`, `buildJob` and `candidateIdentity`, with the `JobContext` fields `projectPolicy`, `judgeFixed` and `issue`.
- **The reservation:** the controller's `judgeReservation` over the pinned rate sheet.
- **Publication:** the real publisher (`@rbw/publisher`): `publish` for runs, `release` for release directories, with its scanner and limits.
- **The records:** `@rbw/schema` (`Release`, `RootRun`, `RunManifest`, `PublicationRecord`, `checkPublicDemoInput`) and `@rbw/admission`'s evidence and decision checks.

The new code is the staging layout, the release checks and the judge job's files and index, which no existing package does. That is why it is more than 200 lines.

## Commands

Run from the repository root. Exit codes: 0 done; 1 refused (a root that is not terminal, failing release checks, or a replay the publisher did not publish), with nothing written by the refused step; 2 a usage or input error, with nothing written.

```sh
node tools/release/src/cli.ts stage --run <controller run dir> --root-run <RootRun file> \
  --out <new staging dir> --redactions-out <private file> [--symptom <file>] [--card <file>] [--novelty <file>]
node tools/release/src/cli.ts build --release-id <uuid> --run <published run dir> --publication <PublicationRecord> \
  --policy <ProjectPolicy> --root-run <file> --issue <file> --issue-check <file> --recordings <dir> --approval <file> \
  --registry packages/schema/registry/families.json --held-out <private HeldOutIdentityList> \
  --image <local kit image> --controller-image <repo@sha256:...> --kit-stage <dir> --manifest <file> --terms <file> \
  --audit-policy <file> --original-suite <file> [--local-store <dir>] --out <new release dir>
node tools/release/src/cli.ts publish-replays --policy <file> --state <dir> --patterns <file> [--local-runs <dir>] \
  [the publisher's destination options and limits]
node tools/release/scripts/release-fixture.ts --out tools/release/fixtures/release
```

In real mode, `build` and `publish-replays` get the private store only from `privateStoreFromEnv`, which reads `BLOB_PRIVATE_STORE_ID` and `VERCEL_OIDC_TOKEN`. `build` then removes the store's variables from its environment before Docker runs, so no child process inherits them. Nothing prints a credential. `--local-store` and `--local-runs` use a local store over a directory instead.

### `stage`

Writes a terminal root's run directory as a new staging directory for `publish`. It works for a factory root and for a `judge_replay` root downloaded from `judge/<root>/`.

- `generated/symptom.json`, `generated/card.json` and `generated/novelty.json` (factory roots only), from the optional flags. The novelty summary holds outcomes and times, never phrases.
- Per job, with the controller's job directories flattened, because the publisher refuses a UUID-shaped segment below `<category>/<execution>/`: `results/<exec>/request.json`, `results/<exec>/expected-trials.json`, `results/<exec>/<trial>/...` (the record set), and `results/<exec>/evidence.json`, `decision.json` and the sanitized `summary.json`.
- `report.md`, a short table of the root's jobs.
- `omissions.json`: each missing generated file, evidence, decision or summary as `not_produced`, and, for a factory root, the issue, its check report, the phrase records, the writer recordings and the search recordings as `withheld_private` (`private_material`). `stage` never reads any of them, so none appears in a run record.
- Provider resource IDs (each copy's child resource, container and sandbox name) go to `--redactions-out` as `provider_identifier` lines for the publisher's `--redaction-values`. The file must be outside the staging directory and this repository.

A root that is not `terminal` is refused (`root_not_terminal`) and nothing is written.

### `build`

Order: read the inputs, build the judge job, run every check, then store the judge job, then write the release directory. Any failing check stores and writes nothing and prints every failing code. Two codes stop before the other checks, because the release record they read cannot be assembled without them: `admission_missing` (no single published admission in the run) and `judge_job_unbuildable`. `--approval` is the owner's `{ "decision": "approved", "issue_sha256": "<hex>", "reviewed_at": "<UTC time>" }` for the frozen issue. JSON inputs are written as canonical bytes.

The release directory (`--out`, published by the publisher's `release` as `releases/<release_id>/`):

```
release.json                  the Release record (canonical)
issue.json                    the frozen issue
issue-check.json              the writer's check report
recordings/<name>             the writer's card and issue recordings
```

### `publish-replays`

For each `judge/<root>/root-run.json` in the private store, in root order: a root that is not terminal is skipped (`root <id> skipped not_terminal`); a terminal root is downloaded to a fresh directory, staged and published with `publish`, one at a time, and the publisher's status is printed (`root <id> published`). The publisher is idempotent by root and content hash, so an already-published root prints `published` again. There are no retries beyond the publisher's own. The exit code is the highest publisher exit code.

## The release record

`Release` in `@rbw/schema`; every field is required. `release_id` is the UUID the conductor assigns before `build` and reuses on any rerun. Its integrity is the SHA-256 of `release.json`'s canonical bytes.

- `project_id`, `project_policy_sha256` (the `--policy` file), `policy_id` (from the published admission request), `created_at`, `calibration: "not_requested"`.
- `revisions`: one complete revision `{ sha256, identity }`, the built judge job's `candidateIdentity(ctx)` and its request's `task_revision`. It is the admission's provisional identity with `revision_kind: "complete"`, `issue_sha256` (the frozen issue) and `issue_style: "user-report"`.
- `images`: `kit_image` (from `inspectRepoDigests`) and `controller_image` (`--controller-image`).
- `family`: the registry family that links the mutation, its source fix, `mutation_id` and `split: "public_demo"`.
- `run`: the root and its `PublicationRecord`'s `publication_id`, `manifest_sha256` and `repository_commit`.
- `admission`: the admission execution, `outcome_verdict` and ADM-08 `classification`.
- `files`: the path and SHA-256 of every file in the release directory but `release.json`.
- `approval`: ADM-07's human check.
- `judge_job`: the index key and its SHA-256.

## The judge job

Stored with no overwrite in the private store under `judge-jobs/<release_id>/`, every file first and the index last:

```
judge-job.json               the canonical index: { release_id, files: [{ path, sha256 }] } and nothing else
request.json                 the complete judge_verify JobRequest
expected-trials.json         its ExpectedTrials: clean-01, planted-01, fixed-01
source.tar                   the image's exported source (sorted entries, mtime 0, owner 0)
original-suite.json          the admission's frozen original suite (--original-suite)
projection-manifest.json     the fix audit's inputs: --manifest,
strict-terms.txt             --terms
audit-policy.json            and --audit-policy
```

The request holds the real project, policy hash, `policy_id`, release ID and `reservation_microusd` (`judgeReservation`: three copy envelopes plus the controller envelope). fixed-01 grades the source fix's `fixed` state, so its patch hash is the admission's fixed trials' hash. Only the fields a replay's overlay replaces are fixed placeholders: `root_execution_id`, `batch_id`, `execution_id`, `parent_execution_id` and `deadline_at`, with `expected_trials_key`, `operation_id` and `payload_hash` derived from them by `buildJobRequest`.

An object already stored with the same bytes counts as stored, so a rerun with the same inputs succeeds; other bytes are refused with `store_mismatch` and no release is written.

## Check codes

`checkRelease(release, run, releaseDir)` (ADM-07 and ADM-09) reads the published run, as a fresh clone of the results repository holds `runs/<root>/`, and the release directory:

| Code | Fails when |
|---|---|
| `run_manifest_mismatch` | the run's `manifest.json` is missing, invalid, of another root, or not the hash the publication record names |
| `run_file_mismatch` | a file the manifest names is missing or has another hash |
| `publication_mismatch` | the publication record is not `published`, or names another root, publication, manifest or commit |
| `policy_not_public_demo` | the policy is not a canonical `public_demo`, `public` `ProjectPolicy` |
| `policy_mismatch` | the policy's hash or project differs from the release, the publication record or the manifest |
| `root_mismatch` | the root run is another root, or under another policy |
| `root_not_factory` | the root is not a `factory` root |
| `root_not_completed` | the root is not `terminal` and `completed` |
| `admission_missing` | there is no valid published admission request, evidence and decision |
| `admission_evidence_mismatch` | the decision does not name the evidence's hash or the request's execution |
| `outcome_verdict_not_pass` | the admission's verdict is not `pass` |
| `classification_not_blind_spot` | the classification is not `blind_spot_demonstrated` (for example, caught by the original suite) |
| `audit_not_pass` | a copy with a declared change has an audit that is not `pass`; clean and fixed copies are `not_applicable` |
| `policy_id_not_uc3` | the admission request's `policy_id` is not `umami-uc3-v1` |
| `revision_mismatch` | the complete revision does not hash to its `sha256`, or, with `revision_kind` set back to provisional and the issue fields cleared, does not hash to the admission request's revision |
| `release_file_mismatch` | the release directory does not hold exactly the listed files with their hashes |
| `issue_mismatch` | the complete revision's `issue_sha256` is not the issue's hash |
| `issue_not_ready` | the check report's status is not `ready_for_review` |
| `novelty_blocked` | the published novelty summary is `blocked` |
| `novelty_incomplete` | the published novelty summary is missing or not `clear` |
| `approval_issue_mismatch` | the approval is not for this issue's hash |

`build` adds:

| Code | Fails when |
|---|---|
| `unregistered`, `held_out_conflict`, `invalid` | `checkPublicDemoInput` refuses the mutation against the registry and the held-out list |
| `source_fix_ambiguous` | the family does not name exactly one source fix |
| `kit_image_missing` | `inspectRepoDigests` returns no repository digest for the kit image |
| `judge_job_unbuildable` | the image, its export or the code states cannot be read |
| `store_mismatch`, `store_unavailable` | the private store holds other bytes under a judge job key, or cannot be used |

## The private store

The judge job is stored with `@rbw/publisher/private-store`. Real mode builds the store with `privateStoreFromEnv` (`BLOB_PRIVATE_STORE_ID` and `VERCEL_OIDC_TOKEN`); `--local-store` and `--local-runs` use `LocalPrivateStore`.

## Fixture

`fixtures/release/` is a synthetic results directory for the results site, made by `scripts/release-fixture.ts` from `fixtures/sources/` and the local runner's simulated kit: one completed factory root (`repository/runs/`), its release (`repository/releases/`), the store's status object (`store/`), its judge job in a local store (`private-store/`), and the inputs `checkRelease` reads (`inputs/`). The web's `readResults` reads it unchanged. Failed and incomplete roots are in `packages/web/fixtures`.

## What it does not do

- It runs no replay. The judge route, the controller sandbox and the per-replay overlay are planned (W2-8).
- It has no Vercel client for the private store until the prerequisite merges.
- It makes no calibrated claim: `calibration` is always `not_requested`.

## Tests

```sh
pnpm --filter @rbw/release test
```

The tests use the local runner's simulated kit behind a fake Docker, the real publisher in local mode with a gitleaks stand-in, and a local private store; no container and no network.
