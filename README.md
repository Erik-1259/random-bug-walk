# Random Bug Walk

Random Bug Walk plants and validates synthetic bugs to expose gaps in an application’s tests.

This hackathon prototype demonstrates one released example: a synthetic time-zone bug deliberately planted in a pinned copy of [Umami](https://github.com/umami-software/umami). The [271 measured original API tests pass despite that defect](https://random-bug-walk.vercel.app/#cell-3). All four added checks pass on clean and fixed copies. On the planted copy, the three non-UTC checks fail as expected while the UTC control passes. Other upstream tests were not evaluated. This result demonstrates a test-suite blind spot; it does not measure debugging-agent performance. Debugging tasks and developer-tool evaluation are subsequent uses.

A model wrote the bug report from recorded symptoms, and a human approved it before release. The evidence measures API responses, not independently verified chart rendering or dashboard interactions.

- Results site: <https://random-bug-walk.vercel.app>
- Results repository (published runs and releases): <https://github.com/Erik-1259/random-bug-walk-results>

The planted bug is synthetic, labeled as such everywhere, and never filed upstream. Results are a demonstration, not findings.

## Quick judge route

No sign-in or new replay is needed:

1. [See the time-zone mismatch](https://random-bug-walk.vercel.app/#cell-2).
2. [Read the original-suite versus added-check comparison](https://random-bug-walk.vercel.app/#cell-3).
3. [Read the generated bug report](https://random-bug-walk.vercel.app/#bug-report).
4. [Inspect a recorded replay](https://random-bug-walk.vercel.app/#recorded-replays).
5. [Read scope and limitations](https://random-bug-walk.vercel.app/#cell-6).

The [full diagnostic catalog](https://random-bug-walk.vercel.app/catalog) remains available. Starting a new replay is optional, requires the judge passcode, and has a 35-minute hard limit.

The issue writer’s model runs on Nebius Token Factory. Vercel hosts the site, runs app copies on Sandbox, and stores status and large files on Blob. Neon Postgres holds the spend ledger. Tavily supplied the released issue’s exact-phrase novelty searches.

The bug factory, a request service built on the same validation, is in progress: it runs on a hosted preview deployment and is not on the production site yet; see [Bug factory (in progress)](#bug-factory-in-progress) for what exists and what is planned.

## Repository map

| Path | What it is |
|---|---|
| [`packages/admission`](packages/admission/README.md) | Trial-result importer and the admission decisions (ADM-02 to ADM-06, the ADM-08 comparison) |
| [`packages/envelope`](packages/envelope/README.md) | Versioned provider rates and priced envelopes for the spend ledger |
| [`packages/factory`](packages/factory/README.md) | Factory core for bug requests: criteria catalog, capabilities, interpretation, the canonical start, identities, budget admission, assignment, the qualification verdict, the request loop with injected effects, and the status projection; the web service and the worker share it |
| [`packages/factory-contract`](packages/factory-contract/README.md) | The bug request contract `bug-request/1` in machine-readable form: a JSON Schema, TypeScript types generated from it, interfaces for host adapters and copy runners, and a validator; shapes only, with no endpoint or behavior |
| [`packages/harvest`](packages/harvest/README.md) | Finds public source fixes on GitHub that match a bug shape (`DT-1.tz-arg` or the race class `RC-1.guarded-write`) and reports a funnel |
| [`packages/harvest-review`](packages/harvest-review/README.md) | Two-model review of the harvest's matches |
| [`packages/host-task-report`](packages/host-task-report/README.md) | The task-report host's evaluator material (baseline identity, original-suite runner, verification check, evaluator versions 1 and 2) and its factory adapter |
| [`packages/host-umami`](packages/host-umami/README.md) | The Umami host adapter of the bug factory: baseline, the released time-zone case as its one catalog entry, protocol, calendar window, package inputs from a prepared store, copy plans and copy results; every copy runs on the Umami runtime image, pushed for linux/amd64 and pinned by digest |
| [`packages/projection`](packages/projection/README.md) | Audits a solver-visible copy: pinned source, one declared change, no history or answer-bearing files (part of ADM-01, ADM-07's scan) |
| [`packages/publisher`](packages/publisher/README.md) | Trusted publisher of runs and releases to the results repository and the public store |
| [`packages/schema`](packages/schema/README.md) | Shared record schema, canonical JSON, the project policy builder, the family registry and job contracts (TypeScript, with the Python package in `python/schema`) |
| [`packages/screen`](packages/screen/README.md) | Automated static-headroom screen: bounded model probes that try to locate a planted bug from the source alone |
| [`packages/search`](packages/search/README.md) | Tavily searches, including the exact-phrase checks on issue text |
| [`packages/shapes`](packages/shapes/README.md) | The bug shapes (`DT-1.tz-arg`, `RC-1.atomic-backup-code`) as ast-grep rules with their planted mutations and probe patches, plus class-level race rules and a site finder |
| [`packages/solver`](packages/solver/README.md) | The fixed solver for the UC1 paired comparison: a metered tool-calling loop on Token Factory, and the analysis of graded attempts |
| [`packages/spend`](packages/spend/README.md) | Postgres spend pools, the serial execution slot, and the factory's request budgets and insert-only request records |
| [`packages/umami-driver`](packages/umami-driver/README.md) | Protected command that runs one trial inside an app copy and writes its records |
| [`packages/umami-fixture`](packages/umami-fixture/README.md) | The fixture `umami-tz-arg-001`: data and the four added checks |
| [`packages/umami-fixture-rc1`](packages/umami-fixture-rc1/README.md) | The race-family fixture `rc-1-backup-code-001`: data and two added checks (serial and concurrent backup-code use); the family did not reach admission and is parked |
| [`packages/web`](packages/web/README.md) | The results site (Next.js), its judge routes, and the `/factory` page with the bug request routes under `/api/factory/` (a local test mode runs them, and live mode runs them on a hosted preview deployment; the production site does not serve the factory yet) |
| [`packages/writer`](packages/writer/README.md) | Model-written pattern cards and bug reports, with code checks on every issue |
| [`tools/candidates`](tools/candidates/README.md) | Candidate pipeline: lists the sites a class rule matches in the host and plants each; by default records them for behavioral qualification, or with `--route static-screen/v1` screens each planted copy and ranks the survivors |
| [`tools/case-package`](tools/case-package/README.md) | Exporter for a case's two package parts (bug case and validator package): deterministic archives, pair binding, separation checks, final-validator assembly, a synthetic host, and the prepared package directory built into the factory worker image |
| [`tools/case-validate`](tools/case-validate/README.md) | Standalone validation harness `rbw-validate`, the `docker` copy runner and the host registry (it holds `task-report` and `umami`) |
| [`tools/controller`](tools/controller/README.md) | Runs jobs and the candidate attempt against the spend ledger on Vercel Sandbox; also the judge replay's controller, and the factory worker that runs a bug request or validation run in its own sandbox (the web service starts it), with a local mode on Docker |
| [`tools/local-runner`](tools/local-runner/README.md) | Runs the kit check, observation and admission on local Docker; its job builders and copy path are reused by the controller |
| [`tools/release`](tools/release/README.md) | Stages runs for the publisher, builds a checked release with its frozen judge job, and publishes judge replays |
| [`tools/uc1`](tools/uc1/README.md) | Runs the UC1 paired comparison's attempts (server logs off and on) in the pre-registered order, with the spend guard and both grades |
| [`tools/solver-session`](tools/solver-session/README.md) | One UC1 solver attempt's session in a local Docker kit container (planted copy, tools, log scrub, submitted diff), and grading a submitted fix through the controller |
| [`tools/publication`](tools/publication/README.md) | Publication boundary for agent work: scanner (with a public-only mode for the cloud route), host helper, wrapper and pre-push hook |
| `tools/neon-ci` | Creates and deletes the throwaway Neon database branches that the integration workflows use |
| [`tools/product-acceptance`](tools/product-acceptance/README.md) | Planned acceptance coverage of the bug request API; no runner is implemented yet |
| [`hosts/task-report`](hosts/task-report/SOURCE.md) | The vendored baseline of the task-report host: a synthetic task-and-report HTTP service built for experiments, with its original Playwright suite |
| [`kit/umami`](kit/umami/README.md) | The kit image: pinned Umami, PostgreSQL and the protected verifier area |
| [`kit/umami-race`](kit/umami-race/README.md) | The race family's kit image: the `kit/umami` image with Toxiproxy between Umami and Postgres for a fixed database delay |
| [`kit/umami-runtime`](kit/umami-runtime/README.md) | The Umami runtime image: the `kit/umami` image without the app source, the fixture package or the file-hash list, for a debugging agent's copy and the factory's validation copies |
| [`kit/task-report`](kit/task-report/README.md) | The task-report host's copy image (version 1, and version 2 under `v2/`): one app copy with its own PostgreSQL and no network |
| [`kit/factory-worker`](kit/factory-worker/README.md) | The linux/amd64 image the factory service starts on Vercel Sandbox for each request and validation run, with the scanned prepared catalog packages built in |
| [`docs/admission-rules.md`](docs/admission-rules.md) | Admission rules ADM-01 to ADM-10 and their status |
| [`docs/bug-generation-pipeline.md`](docs/bug-generation-pipeline.md) | What each pipeline step does today, which package does it, and what is still manual |
| [`docs/product/bug-package-v1.md`](docs/product/bug-package-v1.md) | The package format of a case's two parts (`rbw-bug-case/1`, `rbw-validator/1`) |
| [`docs/product/adding-a-host.md`](docs/product/adding-a-host.md) | How a third host application is connected to the bug factory |
| [`docs/product/bug-request-v1.md`](docs/product/bug-request-v1.md) | The bug request contract `bug-request/1` (draft, revision 3); its endpoints run in local test mode, and in live mode on a hosted preview deployment |
| [`docs/product/bug-request-v1-enforcement.md`](docs/product/bug-request-v1-enforcement.md) | Which layer and component enforce each contract requirement, and which tests cover it |
| [`docs/product/factory-ui-integration.md`](docs/product/factory-ui-integration.md) | Integration status of the `/factory` page |
| [`docs/product/fixtures/bug-request-v1/`](docs/product/fixtures/bug-request-v1/README.md) | Synthetic example bodies for the contract: shapes and states, not measured results |
| [`docs/bug-discovery-and-evaluation.md`](docs/bug-discovery-and-evaluation.md) | Research note separating candidate discovery, test-suite blind spots and developer-tool evaluation; existing rules remain unchanged |
| [`docs/uc1-preregistration.md`](docs/uc1-preregistration.md) | Pre-registration of the UC1 paired comparison (server logs on versus off), fixed before any counted run; it reports no result. Screen records are in `docs/uc1-screen/` |
| `container/` | The development container for coding agents (`Dockerfile`, `entrypoint.sh`, `run-agent.sh`, `check-isolation.sh`) |
| `scripts/checks/` | Repository checks: prose, admission rule IDs, test-count floors, dependency audit, docs-only classification, the publication scan for CI and a runtime check of the check scripts |
| `.github/workflows/` | CI (also callable from another repository), the Postgres integration tests, Neon branch cleanup, and a placeholder heavy-integration workflow (no heavy suite exists yet) |

## Prerequisites

- Node.js 24 (`>=24.21 <25`, from `package.json`), which runs the `.ts` sources directly.
- pnpm 10 (`pnpm@10.33.2`).
- [uv](https://docs.astral.sh/uv/), which provisions Python 3.12 for the Python schema package.

The development container (`container/Dockerfile`) has the same tools. It is meant to be started through `container/run-agent.sh`, which mounts one working copy and an inbox directory.

Some host steps need more: Docker for the kit image and local runs, a Postgres database for the spend ledger, and provider credentials for live runs. The package READMEs list what each command needs.

## Install, test, typecheck and lint

From the repository root:

```sh
pnpm install --frozen-lockfile
uv sync --locked --all-packages
pnpm test        # Vitest and pytest unit tests; they need no credentials
pnpm typecheck   # tsc for every package, plus pyright
pnpm lint        # ESLint, ruff check and ruff format --check
pnpm build       # every package's build, including the results site
node scripts/checks/prose.ts
node scripts/checks/admission-ids.ts
```

Integration tests that need Postgres are separate (`test:integration` in the packages that have one); with `DATABASE_URL` unset they print a skip message.

## Run the results site locally

The site prerenders every page from a results directory. Without configuration it uses the committed development fixture:

```sh
pnpm --filter @rbw/web dev     # development server
pnpm --filter @rbw/web build   # production build of every page
RBW_RESULTS_DIR=fixtures/no-release pnpm --filter @rbw/web build
RBW_RESULTS_DIR=../../tools/release/fixtures/release pnpm --filter @rbw/web build   # a synthetic release
```

The judge routes stay disabled unless their variables are set, and the bug request routes that need the ledger answer unavailable unless test mode or live mode's variables are set (see [Bug factory](#bug-factory-in-progress)). See [`packages/web/README.md`](packages/web/README.md) for the pages, the results directory layout, the fixtures and the configuration.

## How a candidate, a release and a judge replay fit together

1. **Candidate attempt.** The controller's `attempt` command runs one factory root on Vercel Sandbox: a kit check, an observation, two Tavily source searches and a Tavily docs extract (whose passages, when it returns usable ones, become the symptom's documentation excerpts), the writer's card and issue, the searcher's three exact-phrase checks, and the 13-copy admission, each reserved on the spend ledger. The source searches and the docs extract were added after the released run (PR #59). The released case's Tavily calls were the three exact-phrase checks. The one published run with source searches and an extract (`8bdc650f-6dce-4278-b9b8-d50431225b04`) was not released. See [The candidate attempt](tools/controller/README.md#the-candidate-attempt).
2. **Publication.** `tools/release stage` turns the terminal root into a staging directory, and the publisher publishes it to the results repository and the public store. See [`tools/release`](tools/release/README.md) and [`packages/publisher`](packages/publisher/README.md).
3. **Release.** After the owner approves the frozen issue, `tools/release build` checks the published run and writes a release with a frozen judge job in the private store; the publisher's `release` command publishes the release directory. The results site, rebuilt with it, shows the validated example.
4. **Judge replay.** On the site, a judge with the passcode starts a replay. The judge route reserves the budget and starts the controller in its own sandbox, which runs the frozen judge job on three fresh copies (clean, planted, fixed) and compares the six cells with the release. `tools/release publish-replays` later publishes finished replays. See [Judge routes](packages/web/README.md#judge-routes) and `--prebuilt` in [`tools/controller`](tools/controller/README.md#commands).

## Bug factory (in progress)

The bug factory is a service that takes a bug request and returns validated bug cases. A request names one or both host apps, a quantity of each bug type (`concurrency` or `date_time`), an optional plain-language description and one budget. A case qualifies only when the host's unchanged original suite passes on clean, buggy and reference-fixed copies, while the case's separate checks pass on the clean and fixed copies and detect the declared failure on the buggy copy. Each case is delivered as two package parts: a bug case for a debugging agent and a validator package for an evaluator. It runs in a local test mode, in the worker's local mode and in live mode on a hosted preview deployment (below). The production site is not deployed with the factory yet.

- **Contract.** [`docs/product/bug-request-v1.md`](docs/product/bug-request-v1.md) defines `bug-request/1` (draft, revision 3). The package format is [`docs/product/bug-package-v1.md`](docs/product/bug-package-v1.md), and [`docs/product/adding-a-host.md`](docs/product/adding-a-host.md) describes how a host is connected.
- **Hosts.** Umami, the host of the released demonstration case, and task-report, a synthetic task-and-report service built for experiments and vendored in `hosts/task-report`. The validation harness's host registry holds both, and each host's linux/amd64 copy image is pushed to a registry and pinned by digest. Two host and bug type pairs are live: task-report with `concurrency`, and Umami with `date_time` (the released time-zone case); the other two pairs are reported unsupported. No task-report case is released or published.

What exists on main and how it is exercised:

- The factory core (`packages/factory`), the contract schema and types (`packages/factory-contract`), the exporter (`tools/case-package`), the standalone harness `rbw-validate` (`tools/case-validate`) and the factory worker (`tools/controller`) are merged and covered by unit tests.
- **Test mode.** The `/factory` page and every request endpoint under `/api/factory/` run over HTTP in one local server process, against deterministic in-memory fakes. Test mode needs no network service and is refused on any Vercel deployment. See [Test mode](packages/web/README.md#test-mode) for the scenarios and the test endpoints:

  ```sh
  RBW_FACTORY_TEST_MODE=1 RBW_JUDGE_PASSCODE=synthetic-factory-passcode pnpm --filter @rbw/web dev --port 3000
  ```

- **The worker's local mode.** `factory-worker --backend docker` runs a request or a validation run on one machine, against a local Postgres ledger, with each copy as a local Docker container. Its tests run a full local request with a validation run over the package tooling's synthetic host. See [Factory worker](tools/controller/README.md#factory-worker).
- **Hosted preview.** On a hosted Vercel preview deployment of commit `269a22a` (October 26 and 27, 2026), the `/factory` page and the routes under `/api/factory/` run in live mode: a judge-passcode session, capabilities, interpretation, starting a request, status, stop, package downloads and validation runs. Starting a request launches the factory worker in its own Vercel Sandbox from a pushed linux/amd64 worker image that carries the scanned prepared packages; the web service and the worker share the Neon ledger (the factory pool and the serial factory slot). See [Factory service](packages/web/README.md#factory-service).
- **Hosted results.** A task-report request was fulfilled in about 5 minutes for about $0.41, an Umami request in about 11 minutes for about $0.47, and one request with both hosts in about 14 minutes for about $0.50 of a $1.50 budget. In each delivered case all six behavior cells matched (the original suite and the verification checks on the clean, buggy and reference-fixed copies), and every delivered package part downloaded through the deployment matched its published sha256. A user stop ended a request as cancelled with nothing delivered. The worker's worst-case reservation (about $0.35) is settled in full on each request, so a request costs at least that much.
- **Package scan.** The prepare scan blocks a package part with any private-pattern, attribution or credential finding. The only exceptions are two exact upstream lines of Umami's pinned source, named by hash (PR #166).

Planned:

- The factory on the production site. The preview is the only hosted factory so far.
- The completed example's two package archives and their publication.
- A request API acceptance runner (`tools/product-acceptance`).

## Deployment

The site is deployed on Vercel from a tree of this repository plus a results directory assembled from the public results repository and the public store with `packages/web/scripts/assemble-results.mjs`. The steps and project settings are in [Deploying on Vercel](packages/web/README.md#deploying-on-vercel).

## What it does not do

- It is a hackathon prototype with one released case: a time-zone bug in Umami at a pinned commit, from one bug shape and its fixture. A second family, the race family, has its shape, fixture and kit image on main but did not reach admission and is parked. A second host, task-report, has its adapter, checks and copy image on main and no released case.
- Its planted bugs are synthetic; it finds no real Umami bug and files nothing upstream.
- It makes no calibrated claim: calibration is recorded as `not_requested`, and ADM-10 (regrade for reported solves) is planned.
- Anonymous visitors cannot start a replay; only judges with the passcode can, one replay at a time. Candidate attempts start from a controller command on the operator's machine, not from the site.
- The bug factory takes live requests only on a hosted preview deployment; the production site is not deployed with it yet. It does not assess source-only difficulty, serves only its two hosts, and does not publish live results to the results repository.
- It does not evaluate Umami's upstream tests other than the API suite.

## How this was built

Claude Code and Codex wrote the code under the author's direction: the author directed, specified and reviewed the work.

## License

MIT; see [LICENSE](LICENSE). Umami, which the kit image builds from source, is under its own MIT license.
