# @rbw/local-runner

A host-side command that runs the whole first local sequence on Docker: the kit check, the observation and admission, each as one job of app copies through the kit image (`kit/umami`) and the protected driver (`packages/umami-driver`). It is the local stand-in for the hosted controller, which is planned. This is part of a hackathon prototype.

Everything it writes is **development evidence**. It makes no admission claim, publishes nothing, and the planted bug is synthetic.

## What one run does

1. Reads and hashes every input, and resolves the image tag to its content digest (`docker image inspect`). Every container then runs by that digest.
2. Exports the pinned source from a created, never started, container of the image (see [Source projection and audit](#source-projection-and-audit)), and reads the image manifest.
3. Derives every code state's target file from the image's clean file (see [Code states](#code-states)).
4. Runs one freeze copy: the driver's `freeze` on a clean copy. Its manifest gives every job's `original_suite_sha256` and `original_test_ids`.
5. **Kit check** (`kit_check`): 5 clean copies, 20 added-check rounds in `clean-01` and 1 in the others, the original suite in each.
6. **Observation** (`observe`): 1 planted copy, the four added checks once, no original suite. Its request names the kit-check baseline, and it starts only when that baseline matches (see [Jobs](#jobs)).
7. **Admission** (`admission`): 13 copies (1 clean, 5 fixed, 5 planted, 1 partial, 1 stub), per ADM-02 to ADM-06: `fixed-01` and `planted-01` run 20 added-check rounds, every other copy one, and every copy runs the original suite once.
8. **Alternative fix**: one more copy, development evidence outside admission's 13 (see [Jobs](#jobs)).
9. Imports each job's record set with `@rbw/admission` (its own `import` command, which writes `evidence.json` before `decision.json`).
10. Runs the card, the issue and the three exact-phrase searches in recorded mode (see [Recorded mode](#recorded-mode)).
11. Writes `summary.json` (canonical JSON) and `summary.txt` (a short table) in the work directory.

## One copy

Each copy is one container of the kit image:

```sh
docker create --name <name> --network none --cpus 4 --memory 8g --security-opt no-new-privileges <image digest> \
  /bin/sh -c <copy script> rbw-copy trial <trial_id>
docker cp <verified target file> <name>:/workspace/app/src/queries/sql/pageviews/getPageviewStats.ts
docker cp <job dir> <name>:/var/lib/rbw/job
docker start <name>
docker wait <name>
docker cp <name>:/var/lib/rbw/results/rbw-runner <copy dir>/collected
docker rm --force <name>
```

- The resources are spec §9.4's 4 vCPU and 8 GB. A clean copy gets no `docker cp` of a target file: it keeps the image's own source.
- `docker cp` into a container creates the file as root, with the host file's mode; the runner writes the verified file with mode 0644, which is what the kit gives every app file (root-owned, read-only to `rbw-app`). The kit's `rbw-build-app` then builds the app as `rbw-app`.
- The copy script (`COPY_SCRIPT` in `src/copy.ts`) runs, as root under the image's `tini`, only the verifier's Node and the driver: `freeze`, then `run --job /var/lib/rbw/job --trial <trial_id> --out /var/lib/rbw/results/rbw-runner/out`. It writes each exit status to `freeze.exit` and `run.exit` beside the output. It runs nothing from the app copy.
- **Network:** nothing in a copy reaches any network (`--network none`). The driver reaches Umami over loopback inside the container, so the plan's "one forwarder" is not needed with the kit image, and the runner has none.
- **Outer limit:** 720 s, the driver's 600 s copy deadline plus 120 s, from `docker start`. When it is reached, the runner sends TERM (`docker kill --signal TERM`), waits 10 s, and sends KILL if the container is still running. The copy is recorded `incomplete` with reason `timeout`. A killed copy's partial files are never imported; when `run.exit` shows that the driver itself finished (0 or 3), its own records still count.
- **Driver exit codes**, as the driver README defines them: 0, records written; 3, an internal error with the records written as `incomplete`, which are imported; 2, refused, nothing written. Any other status, or none, is recorded without records.
- Each copy has its own container name (`rbw-<run tag>-<job>-<trial_id>`), its own copy and audit directories, and no shared mutable state; the job directory is written once before its copies start and only read after that.

## Code states

Patches are applied on the trusted side as data with the `diff` library, never by running anything from a copy:

| State | How it is made | Checks |
|---|---|---|
| clean | the image's own file | hash equals `probes.json`'s `clean_sha256` and the manifest's entry |
| planted | `probes/dt-1.tz-arg/mutation.patch` on clean | base and result hashes from `probes.json`; one patch, on the target file only |
| fixed | the mutation reversed on the planted file | the bytes must equal the clean file's exactly |
| partial, stub | their probe patches on their recorded base (planted) | base and result hashes from `probes.json`; target file only |
| alternative fix | `probes/alternative-fix.patch` here, on the planted file | `probes/alternative-fix.json`: base `7cb32193…6c`, result `49a8fba295573cce4577a4667c02781691f72057132f3554094d6a4f8e32e649`; must differ from clean |

The alternative fix is written for this project: line 28 passes `timezone || 'utc'`, so a missing or empty timezone falls back to UTC. It should pass every check. Each trial names its file by its `code_state` and `patch_sha256`; a fixed trial's patch hash is that of the planted-to-fixed diff the runner renders, and the alternative fix's is that of its patch file.

## Source projection and audit

The export reads `/workspace/app` with `docker cp <container>:/workspace/app -` as a tar stream and keeps every entry except what the kit adds that is not source: `node_modules`, `packages/api-client/node_modules`, `packages/mcp/node_modules`, the declared build input `src/proxy.ts`, and the empty `dir` and `file` entries of `kit/umami/build-outputs.txt`. Anything else the image holds stays in the projection, so the audit sees it.

Before its build, each copy's projection (the export with the copy's verified target file in place) gets `@rbw/projection`'s neutral commit and its `audit`, with the `--manifest` built by `manifest` at the pinned commit, the copy's declared mutation (the diff from the clean file), the `--terms` list and the policy (`--policy`, or no exclusions and the default neutral commit). The audit checks exactly the bytes that `docker cp` places. A `refused` or `unavailable` audit stops the copy before anything is created; the summary records the verdict, the finding reasons and the report's hash.

A clean or fixed copy has no declared change: its bytes are the pinned source. This version of the audit accepts only a mutation with at least one changed file, so for these copies the summary records `not_applicable` with `no_declared_change`; their other files are the same export the mutated copies' audits check. This is reported through the inbox.

The strict term list is private and is not in the repository; the runner takes it as `--terms <file>`. Tests and development runs use synthetic terms that exist only in the tests.

## Jobs

Every `JobRequest` and `ExpectedTrials` comes from `@rbw/schema`'s `buildJobRequest` and `buildExpectedTrials`, and every identity from its `taskRevision` and `mutationId`; the runner computes none itself.

- Trial IDs, code states and round counts come from `TRIAL_PROFILES`. Expected vectors come from the fixture's `outcome_vectors`; the run stops before its first job when a probe's recorded vector in `probes.json` disagrees with the fixture's vector for its state.
- `original_suite_sha256` and `original_test_ids` come from the freeze copy; `added_suite_sha256` from the driver's `addedSuiteSha256` over the staged kit's `umami-fixture/` (the value `stage-kit.ts` prints).
- The kit check has a `kit` task revision; observation, admission and the alternative fix share one `provisional` revision with the planted mutation's `mutation_id`. `kit_sha256` is the SHA-256 of the image manifest; `runtime_profile_sha256` and `environment_sha256` are the SHA-256 of the copy profile (`COPY_PROFILE` in `src/plan.ts`). The project ID, the policy hash and the 1 µUSD reservation are development placeholders: no controller issues them yet.
- **Observation baseline:** the observe request sets `baseline_evidence_key` to `jobs/kit-check/evidence.json` (under the work directory) and `baseline_evidence_sha256` to that file's hash. Before the observation starts, the runner checks that the file exists, that it hashes to the named value, and that the kit-check record set beside it (`jobs/kit-check/records`) still imports to that same evidence. Otherwise it refuses with `baseline_missing` or `baseline_mismatch`, naming the key or both hashes, and starts no copy.
- **Alternative fix:** it runs as `fixed-01` of its own `judge_verify` job, the one profile with a single fixed copy that runs the added checks once and the original suite once. That job's `clean-01` and `planted-01` never run, so its import lists them as missing results; the summary reads only `fixed-01`.

## Recorded mode

The card call, the issue call and the three phrase searches (`phrase-1` to `phrase-3`) go through `@rbw/writer` and `@rbw/search` with an in-memory PGlite spend ledger with every `@rbw/spend` migration applied (pool `development`, slot key `local-runner`).

- The writer answers from its own replay fetch. The search client's requests are answered by an axios adapter in the runner's process, matched by endpoint and canonical body as the search package's replay server matches them. No request leaves the process and no socket is opened. No API key is read; the search client requires a non-empty key, so it gets a fixed placeholder that only the in-process adapter sees.
- A request with no recording fails the step (`recording_missing`); so does a refused or failed call. The summary then records `candidate_text` as failed, and the run exits 1.
- `--recorded <dir>` names the directory, so live recordings can replace the synthetic ones without code changes. Its layout: `writer-input.json` (the writer `record` command's inputs format), `writer-rates.json`, `writer/*.json`; `search-input.json` (`{ input, settings, excluded_identifiers }`), `search-rates.json`, `search/*.json`. Two recordings for one request are refused. The default, `recorded/synthetic/`, holds byte copies of the writer's `card-valid` and `issue-valid` recordings and the search package's `phrase-N.zero-results` recordings, with inputs that match them; a test checks the copies against the packages' files. These synthetic inputs are not the tz-arg candidate's card and issue.

## Concurrency and `run-copy`

`--concurrency <n>` (default 1) runs up to `n` copies of a job at once; the alternative-fix copy shares admission's queue. The documented proof uses 1, so its timings are clean.

`run-copy` runs exactly one copy from a job directory and a trial ID, for a later hosted or cloud matrix to call: it reads the job with the driver's own reader, checks an observation's baseline against `--root` (the run directory that holds it) before any docker command, refuses an image whose digest is not the job's, then exports, derives, audits and runs the copy, and writes `copy-summary.json` in its work directory. With `--backend sandbox` the copy itself runs on Vercel Sandbox (next section).

## Vercel Sandbox backend

`run-copy --backend sandbox --sandbox-image <repository>@sha256:<digest>` runs the copy in a Vercel Sandbox microVM created from the kit image in Vercel Container Registry (VCR), instead of a Docker container. Everything before the copy is the same as with Docker, on the host: the job, the baseline, the image check, the export, the code state and the audit. The `run` command still uses Docker only. The controller that will call this is planned.

- **Image:** `--image` is still the local image, which must match the job's `image_digest`; `--sandbox-image` is the same image in VCR, pinned by digest, and must be one of the local image's repository digests (`docker image inspect --format '{{json .RepoDigests}}'`), which `docker push` records. VCR runs `linux/amd64` images only, so the image is built for that platform. When the platform reports the created sandbox's image, its digest must be the requested one, or the sandbox is stopped and nothing runs in it.
- **Create:** `persistent: false`, `networkPolicy: 'deny-all'`, `resources: { vcpus: 4 }` (spec §9.4; the platform gives 2 GB per vCPU, so 8 GB), and `timeout` equal to the outer limit, 720 000 ms. The name is the Docker container name, `rbw-<run tag>-<job>-<trial_id>`, where the run tag comes from the run's root execution ID. Each create also carries the tag `attempt`, a random UUID of that `run-copy` call. When a create call fails, the runner fetches the name with `Sandbox.get`: a pending or running sandbox with this call's tag is the one that call made, and the copy continues in it; no sandbox fails the copy (`sandbox_create_failed`); any other sandbox under the name, running or not, was left by an earlier attempt and is refused (`sandbox_name_in_use`) and left alone, so a retried `run-copy` never runs a second driver in it. A create is never retried, so no second sandbox is made.
- **Place:** one `writeFiles` call writes the verified target file (the same bytes the Docker backend places, also kept under `placed/`) to `/workspace/app/<target path>` and every file of the job directory under `/var/lib/rbw/job/`, all with mode 0644. A clean copy gets no target file.
- **Run:** the sandbox does not run the image's `ENTRYPOINT`, so there is no `tini` as PID 1, and the kit's `rbw-start` and `rbw-stop` do not reap their launchers themselves: `rbw-launch` and `rbw-stop` wait with `kill -0`, which a zombie still answers. The runner therefore runs the copy script as `/sbin/tini -s -- /bin/sh -c <copy script> rbw-copy <mode> <trial_id>`, as root (an image sandbox's default user, so without `sudo`, which the image does not have), with `cwd` `/workspace/app` and the `PATH` and `HOME` that a Docker container of the image has. With `-s`, tini is a child subreaper, so orphaned launchers are reparented to it and reaped.
- **Once per sandbox:** the SDK retries a request after a network or 5xx error, so a command whose start succeeded but whose response was lost can start a second time. The copy script is therefore `SANDBOX_COPY_SCRIPT`: `COPY_SCRIPT`, unchanged, in a subshell behind a lock. Its first step is `mkdir /var/lib/rbw/copy.lock`, which only one instance can win; that instance runs the copy and then writes its exit status to `/var/lib/rbw/copy.done`. Any other instance runs nothing, waits (`sleep 1`) until the marker holds a status, and exits with it. It uses only the shell, `mkdir` and `sleep`. The runner never uses the exit status of the handle it waited on: once that handle returns, it reads the marker (an artifact read), and while the marker is missing it reads again after 1 s, 2 s, 4 s and so on, up to the outer limit. `container_exit` is the marker's status, and the outcome comes from the marker and the exit files, as before.
- **Collect:** a second command packs `/var/lib/rbw/results/rbw-runner` into `/var/lib/rbw/collect.tar` and refuses, before anything is read, an archive over 72 MiB (the driver's 64 MiB artifact limit plus 8 MiB for the exit files, the driver's output and the frozen manifest). One `readFile` reads it back, stopping at the same limit, and the runner extracts its files and directories into `collected/`; any other entry, or one outside that directory, fails the copy (`collected_unreadable`). An archive over the limit fails the copy (`collected_over_limit`). The summary then measures the driver's artifact bytes against 64 MiB as for Docker, and the driver's exit codes are read and treated exactly as for Docker.
- **Outer limit:** 720 s from the create call, the same as the sandbox's own timeout. The run, the collection and every SDK call end by 710 s; at that point the sandbox is stopped and the copy is recorded `incomplete` with reason `timeout`. Nothing is read back from it, so none of its partial files is imported. Unlike Docker, a driver that finished just before the limit loses its records too.
- **Stop:** `stop()` is called once in every case where a sandbox was made, then `Sandbox.get` is checked up to 5 times, 2 s apart, until the status is `stopped`, `failed` or `aborted` (or the sandbox is gone), all within the 10 s left before the outer limit. The summary records `stop_confirmed` and the last status. A copy whose stop is not confirmed makes `run-copy` exit 1.
- **Calls:** each copy makes at most 4 mutating SDK calls (create, write, run, pack), 1 stop, and 2 artifact reads when the marker is there on the first read (the doublings reach the outer limit within 11 marker reads, so with the archive at most 12), against spec §9.4's 8, 12 and 1; the runner refuses a call past those limits. `copy-summary.json` has a `sandbox` object with the name, the image, whether the sandbox was recovered by name, the stop confirmation, and the counts (plus the status reads) with the limits.
- **Credentials:** the CLI reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` from its environment and passes them to the SDK as options. They never appear in arguments, output or files. A missing one is named, without any value, and the command exits 2.

## Summary

`summary.json` is canonical JSON (`encodeCanonical` from `@rbw/schema`). It holds:

- the labels (`development_evidence`, `admission_claim: false`, `published: false`);
- the run: start and end, the UTC run date, `concurrency`, and whether the date falls on the 2nd to the 5th of a month, the driver README's known limit for two upstream revenue tests (recorded, not refused);
- the image reference, digest and `kit_sha256`; every input hash; the original suite's hash and test count; every code state's hash and patch hash;
- per job: execution, task revision, request and expected-trials hashes, the baseline, any refusal, and the importer's evidence and decision hashes and per-trial status, stage, reason, code, added-check verdict and original-suite counts;
- per copy: status and reason, the audit, the placed file's hash, the freeze, driver and container exit statuses, the runner's phase timings, the driver's phase timings, the tests phase against 240 s and the artifact bytes against 64 MiB;
- for admission: the ADM-02 to ADM-06 decisions, the six cells (ADM-08) and the comparison from `@rbw/admission`, and `outcome_verdict`;
- whether the alternative fix passed every check; the card, the issue, the phrase-search records' outcomes and hashes, the novelty summary and the ledger's operations.

`summary.txt` has one line per copy and the decisions.

## Host commands

Run from the repository root on a host with Docker. `<stage>`, `<umami>`, `<manifest>`, `<terms>`, `<work>` and `<scratch>` are paths you choose; `<work>` must be absent or empty.

1. Build the kit image with the driver and the fixture:

   ```sh
   node packages/umami-driver/scripts/stage-kit.ts --dest <stage>
   docker build --build-arg REGISTRY=docker.io --build-context rbw-kit=<stage> -t rbw-umami-kit:local kit/umami
   docker image inspect -f '{{.Id}}' rbw-umami-kit:local
   ```

   `stage-kit.ts` printed `added_suite_sha256=42c50a8bf10c9d4139584f8f8d7e602293e91e0e9cc1d7abfbd3a13e5694c1ca` at this commit.

2. Build the manifest at the pinned commit, and provide the term list:

   ```sh
   git init -q <umami>
   git -C <umami> remote add origin https://github.com/umami-software/umami.git
   git -C <umami> fetch -q --depth 1 origin ec0ff50388c264ed8ce46f00967e92f7e71476ae
   node packages/projection/src/cli.ts manifest --repo <umami> --commit ec0ff50388c264ed8ce46f00967e92f7e71476ae --out <manifest>
   ```

   It printed `manifest_sha256=f21bc18e61849810aa8cbb47db59dc9afe45065106f63c7d6ff7a691316affbb files=2026 executable=3` here. `<terms>` is the owner's private strict list. For a development run, a synthetic list works, for example a file with the one line `strict:synthetic-local-runner-canary`.

3. Print the plan without Docker, then run the full sequence:

   ```sh
   node tools/local-runner/src/cli.ts run --dry-run --image rbw-umami-kit:local --kit-stage <stage> --manifest <manifest> --terms <terms> --work <work>
   node tools/local-runner/src/cli.ts run --image rbw-umami-kit:local --kit-stage <stage> --manifest <manifest> --terms <terms> --work <work> --concurrency 1
   cat <work>/summary.txt
   ```

4. Show that a mismatched baseline blocks the observation (no container starts):

   ```sh
   mkdir -p <scratch>/jobs && cp -R <work>/jobs/kit-check <scratch>/jobs/
   printf ' ' >> <scratch>/jobs/kit-check/evidence.json
   node tools/local-runner/src/cli.ts run-copy --job <work>/jobs/observe/job --trial planted-01 --root <scratch> \
     --image rbw-umami-kit:local --manifest <manifest> --terms <terms> --work <scratch>/copy
   ```

   This prints `refused baseline_mismatch: the request names <hash> but jobs/kit-check/evidence.json hashes to <hash>` and exits 1.

5. Run one clean and one planted copy on Vercel Sandbox. The job directories come from an earlier `run` (step 3) with the same image, so the image must be the `linux/amd64` build: add `--platform linux/amd64` to step 1's `docker build` on a host of another platform. `<vcr repository>` is the image's repository in VCR (`<team>/<project>/<repository>`, under VCR's registry host), and pushing needs a Docker login to VCR as Vercel's documentation describes.

   ```sh
   docker tag rbw-umami-kit:local <registry host>/<vcr repository>:<tag>
   docker push <registry host>/<vcr repository>:<tag>
   docker image inspect --format '{{json .RepoDigests}}' rbw-umami-kit:local
   ```

   The last command lists the pushed digest, `sha256:<digest>`. Set `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` in the shell from the owner's secret store, without putting the values on a command line (for example `read -rs VERCEL_TOKEN && export VERCEL_TOKEN`), then:

   ```sh
   node tools/local-runner/src/cli.ts run-copy --job <work>/jobs/admission/job --trial clean-01 \
     --image rbw-umami-kit:local --manifest <manifest> --terms <terms> --work <sandbox-clean> \
     --backend sandbox --sandbox-image <vcr repository>@sha256:<digest>
   node tools/local-runner/src/cli.ts run-copy --job <work>/jobs/admission/job --trial planted-02 \
     --image rbw-umami-kit:local --manifest <manifest> --terms <terms> --work <sandbox-planted> \
     --backend sandbox --sandbox-image <vcr repository>@sha256:<digest>
   jq '{status, reason, freeze_exit, driver_exit, timed_out, sandbox}' <sandbox-clean>/copy-summary.json <sandbox-planted>/copy-summary.json
   ```

   Each prints `trial=<trial_id> status=... records=<dir>` and exits 0 when its copy completed and its sandbox's stop was confirmed. Not run here: this container has no Vercel credentials.

Exit codes of `run` and `run-copy`: 0, every copy completed and every step ran (the summary says what the evidence shows); 1, the summary was written but a copy did not complete or a step was refused; 2, a usage or input error, with nothing run.

### Expected results

- Kit check: 5 copies `complete`, every added check `pass` (20 rounds in `clean-01`), all 271 original tests passing.
- Observation: `planted-01` matches the planted vector: the UTC check passes, the other three fail with `local_day_counts_mismatch`.
- Admission: ADM-02 to ADM-06 `pass`, comparison `blind_spot_demonstrated`, `outcome_verdict` `pass`.
- Alternative fix: `passes_every_check` true.
- The summary reports the timings and artifact bytes of every copy.
- A run on the 2nd to the 5th of a month will show 2 failing revenue tests on clean copies, so ADM-03 rejects (the driver README's known limit); the summary flags such a date.

### Expected duration

Not measured here. From the driver's phase limits and the fixture's reset study (the original suite took 54 to 74 s; a round with its reset about 1.2 s), one copy takes about 3 to 5 minutes, most of it the cold build. With `--concurrency 1`, the freeze copy and 20 trial copies take about 1 to 2 hours, plus a few minutes to export the source.

## Interface assumptions

- **Kit:** `/workspace/app` holds the pinned source, root-owned and read-only to `rbw-app`, and `rbw-build-app` builds whatever is there; the app file it builds can be replaced in a created container with `docker cp` before `docker start`; `/var/lib/rbw/` is writable by root; the image manifest is at `/opt/rbw/verifier/image-manifest.json`; the image's entrypoint is `tini`.
- **Driver:** it is at `/opt/rbw/verifier/kit/umami-driver/src/cli.ts`, run with `/opt/rbw/verifier/node/bin/node`; `freeze` without `--out` writes the manifest that `run` reads; `run`'s exit codes are 0, 2 and 3 as above; its record set has `results/<trial_id>/` with `artifacts.json` listing a `phase_timings` artifact whose phases include `tests`.
- **Projection:** `audit` takes a copy with a `.git` from `commitNeutral` and a declared mutation of at least one file; a copy with no change cannot be audited (see above).
- **Vercel Sandbox:** as Vercel's documentation describes it: an image sandbox does not run the image's `ENTRYPOINT` or `CMD`; commands in an image sandbox run as root; `writeFiles` extracts at `/` as the sandbox's default user, which is root for an image sandbox; `networkPolicy: 'deny-all'` at create blocks all egress, DNS included; `Sandbox.get` reports the current session's status. The kit's `/sbin/tini` supports `-s`, and its BusyBox provides `tar`, `wc`, `mkdir` and `sleep`.
- **Shapes:** `probes.json` records the clean, planted and each probe's base and result hashes, and its probe patches each change only the target file.

## Tests

```sh
pnpm --filter @rbw/local-runner test
```

The unit tests drive a fake Docker command layer and a fake clock, and start no container. `test/unit/sequence.test.ts` runs the whole sequence against a simulated kit image whose copies run the real driver's `runTrial` (with the driver's own test fakes for the app stack), so the merged record sets are the ones the real driver code writes, and the real importer decides admission from them. `test/unit/docker.test.ts` runs the real command layer against a stand-in `docker` script. `test/unit/sandbox.test.ts` drives the sandbox backend with a fake SDK (`test/support/fake-sandbox.ts`) and makes no live call. The recorded-mode tests use the committed synthetic recordings and PGlite.

## What it does not do

- It runs single copies on Vercel Sandbox through `run-copy` only; the full `run` uses Docker, and the controller that would run a job's copies in the cloud is planned. It publishes nothing.
- It makes no live model or search call.
- It does not calibrate anything, and its `outcome_verdict` is not an admission.
- It does not change the kit or the driver.
