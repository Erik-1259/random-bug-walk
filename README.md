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

The issue writer’s model, NVIDIA Nemotron 3.5 Lightning, runs on Nebius Token Factory (see [NVIDIA Nemotron on Nebius Token Factory](#nvidia-nemotron-on-nebius-token-factory)). Vercel hosts the site, runs app copies on Sandbox, and stores status and large files on Blob. Neon Postgres holds the spend ledger. Tavily supplied the released issue’s exact-phrase novelty searches.

The bug factory, a request service built on the same validation, runs on the production site at [`/factory`](https://random-bug-walk.vercel.app/factory); see [Bug factory](#bug-factory) for what exists and what is planned.

## NVIDIA Nemotron on Nebius Token Factory

The project's model calls all go to Nebius Token Factory. Where each model is used:

- **Bug designer and classifier on `/factory`.** NVIDIA Nemotron 3.5 Super (`nvidia/Nemotron-3.5-Super-VL`), the successor of Nemotron 3 Super, drafts bug specification cards by default and classifies a designer card before an on-the-fly build. Tavily searches supply the designer's sources.
- **Catalog bug reports.** NVIDIA Nemotron 3.5 Lightning (`nvidia/Nemotron-3_5-Lightning`) wrote the released case's bug report, which every catalog Umami case carries (below).
- **On-the-fly builds.** Goose agents race on Token Factory models, one model per lane: DeepSeek-V4.1-Flash-1017 (`deepseek-ai/DeepSeek-V4.1-Flash-1017`), plus GLM-5.3-Flash (`zai-org/GLM-5.3-Flash`) for task-report or MiniMax-M3 (`MiniMaxAI/MiniMax-M3`) for Umami. Nemotron 3.5 Super writes each build's symptom-level incident. The builder runs on a Nebius AI Cloud VM.
- **Operator tools.** The static-headroom screen, the harvest review and the UC1 solver use Nemotron 3.5 Super, with Kimi-K3 (`moonshotai/Kimi-K3`) as the fallback or second judge (below).

The bug report writer, [`packages/writer`](packages/writer/README.md), sends every Nemotron 3.5 Lightning request to Token Factory's OpenAI-compatible endpoint, `https://api.tokenfactory.nebius.com/v1/chat/completions`, with a fixed profile in [`src/config.ts`](packages/writer/src/config.ts): thinking off, a strict JSON schema response format, no tools, no retries, at most 8,192 output tokens per call and at most 12 billed calls per candidate. There is no fallback model.

- **What it writes.** In the candidate attempt (the controller's `attempt` command, run by the operator), the writer makes one call for the pattern card, written from public information about the upstream fix, and one for the bug report, written from the observed symptom. Code then checks the report's structure, every number in it and a scan for internal identifiers, and a human approved it before release.
- **The released case.** Two live calls, both HTTP 200 and with no repair call: the card (1,281 input and 866 output tokens) and the report (2,022 input and 263 output tokens). At the list prices in the committed rate sheet, [`packages/envelope/rate-sheets/v1.json`](packages/envelope/rate-sheets/v1.json) ($0.06 per million input and $0.24 per million output tokens, each line rounded up to a whole micro-dollar), they cost 471 micro-dollars ($0.000471) together. Both recordings, request and response included, are public: [`card-1.recording.json`](https://github.com/Erik-1259/random-bug-walk-results/blob/d79fc64123c8a95171c229b1062e3ac3f903936d/releases/319f3100-9ecf-441d-b7af-a643af9ae4e5/recordings/card-1.recording.json) and [`issue-2.recording.json`](https://github.com/Erik-1259/random-bug-walk-results/blob/d79fc64123c8a95171c229b1062e3ac3f903936d/releases/319f3100-9ecf-441d-b7af-a643af9ae4e5/recordings/issue-2.recording.json).
- **In the factory.** Every catalog Umami case that `/factory` delivers carries that report unchanged as its incident description. The Umami adapter pins it by SHA-256 in [`packages/host-umami/src/pins.ts`](packages/host-umami/src/pins.ts), and its mapping to the release refuses any other incident. A custom build has its own symptom-level incident.
- **Where Token Factory helped.** Writing is cheap and quick enough to run inside every attempt: the two calls together cost under a tenth of a cent, and their recordings are stamped 1.5 seconds apart (`recorded_at`). Strict JSON schema output means each answer is a JSON object that the writer validates against its schema, with nothing parsed out of free text. Because the endpoint is OpenAI-compatible, the writer uses the AI SDK's OpenAI-compatible provider rather than a custom client, and the same metered call serves other models through their own profiles.
- **Other Token Factory components.** Two operator-run tools make that metered call with NVIDIA Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`, "Super" below): the static-headroom screen ([`packages/screen`](packages/screen/README.md), with Kimi-K3, `moonshotai/Kimi-K3`, as a fallback) and the harvest review ([`packages/harvest-review`](packages/harvest-review/README.md), where Super and Kimi-K3 each judge a harvested fix). The UC1 solver ([`packages/solver`](packages/solver/README.md)) is a tool-calling loop on Super, pre-registered with no result reported. These models replace Nemotron 3 Super and Kimi-K2.7-Code, which the provider retires in November 2026; the UC1 pre-registration named the earlier models and records the change as a deviation. Their run outputs are not in this repository or the results repository, so this README gives no figures for them; the committed screen records in `docs/uc1-screen/` are written judgments, made with no model probe.
- **What uses a model, and which Nebius services run.** A catalog `/factory` request and a judge replay make no model call: the factory matches a description against exact phrases, its only metered service is Vercel Sandbox, and catalog app copies run there. The bug designer on `/factory` calls NVIDIA Nemotron 3.5 Super on Token Factory by default to draft a bug specification. “Build a custom bug” writes its own spec card, and a designer card can also go to the builder through the open-behavior handoff described below. On-the-fly custom builds use the designer's model to write their spec card, then race Goose agents on Token Factory models; the lane board names each lane's model, and the certificate names the designer's model and the winning lane's model. They run on a Nebius AI Cloud VM that production starts per request and that stops when idle, at 4 vCPUs and 8 GB per copy: task-report builds are qualified by the RBW harness, Umami builds by the local runner's admission sequence. The project does not use Token Factory Sandboxes or the Nebius AI Cloud Serverless Jobs, Serverless Endpoints or DevPods.

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
| [`packages/web`](packages/web/README.md) | The results site (Next.js), its judge routes, and the `/factory` page with the bug request routes under `/api/factory/` (a local test mode runs them, and live mode runs them on the deployed site) |
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
| [`docs/product/bug-request-v1.md`](docs/product/bug-request-v1.md) | The bug request contract `bug-request/1` (draft, revision 3); its endpoints run in local test mode and in live mode on the deployed site |
| [`docs/product/bug-request-v1-enforcement.md`](docs/product/bug-request-v1-enforcement.md) | Which layer and component enforce each contract requirement, and which tests cover it |
| [`docs/product/factory-ui-integration.md`](docs/product/factory-ui-integration.md) | Integration status of the `/factory` page |
| [`docs/product/fixtures/bug-request-v1/`](docs/product/fixtures/bug-request-v1/README.md) | Synthetic example bodies for the contract: shapes and states, not measured results |
| [`docs/bug-discovery-and-evaluation.md`](docs/bug-discovery-and-evaluation.md) | Research note separating candidate discovery, test-suite blind spots and developer-tool evaluation; existing rules remain unchanged |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Planned work beyond the current release, starting with open behaviors on Umami |
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

The judge routes stay disabled unless their variables are set, and the bug request routes that need the ledger answer unavailable unless test mode or live mode's variables are set (see [Bug factory](#bug-factory)). See [`packages/web/README.md`](packages/web/README.md) for the pages, the results directory layout, the fixtures and the configuration.

## How a candidate, a release and a judge replay fit together

1. **Candidate attempt.** The controller's `attempt` command runs one factory root on Vercel Sandbox: a kit check, an observation, two Tavily source searches and a Tavily docs extract (whose passages, when it returns usable ones, become the symptom's documentation excerpts), the writer's card and issue, the searcher's three exact-phrase checks, and the 13-copy admission, each reserved on the spend ledger. The source searches and the docs extract were added after the released run (PR #59). The released case's Tavily calls were the three exact-phrase checks. The one published run with source searches and an extract (`8bdc650f-6dce-4278-b9b8-d50431225b04`) was not released. See [The candidate attempt](tools/controller/README.md#the-candidate-attempt).
2. **Publication.** `tools/release stage` turns the terminal root into a staging directory, and the publisher publishes it to the results repository and the public store. See [`tools/release`](tools/release/README.md) and [`packages/publisher`](packages/publisher/README.md).
3. **Release.** After the owner approves the frozen issue, `tools/release build` checks the published run and writes a release with a frozen judge job in the private store; the publisher's `release` command publishes the release directory. The results site, rebuilt with it, shows the validated example.
4. **Judge replay.** On the site, a judge with the passcode starts a replay. The judge route reserves the budget and starts the controller in its own sandbox, which runs the frozen judge job on three fresh copies (clean, planted, fixed) and compares the six cells with the release. `tools/release publish-replays` later publishes finished replays. See [Judge routes](packages/web/README.md#judge-routes) and `--prebuilt` in [`tools/controller`](tools/controller/README.md#commands).

## Bug factory

The bug factory is a service that takes a bug request and returns validated bug cases. A request names one or both host apps, a quantity of each bug type (`concurrency` or `date_time`), an optional plain-language description and one budget. A case qualifies only when the host's unchanged original suite passes on clean, buggy and reference-fixed copies, while the case's separate checks pass on the clean and fixed copies and detect the declared failure on the buggy copy. Each case is delivered as two package parts: a bug case for a debugging agent and a validator package for an evaluator. It runs in a local test mode, in the worker's local mode, and in live mode on the production site and on hosted preview deployments (below).

- **Contract.** [`docs/product/bug-request-v1.md`](docs/product/bug-request-v1.md) defines `bug-request/1` (draft, revision 3). The package format is [`docs/product/bug-package-v1.md`](docs/product/bug-package-v1.md), and [`docs/product/adding-a-host.md`](docs/product/adding-a-host.md) describes how a host is connected.
- **Hosts.** Umami, the host of the released demonstration case, and task-report, a synthetic task-and-report service built for experiments and vendored in `hosts/task-report`. The validation harness's host registry holds both, and each host's linux/amd64 copy image is pushed to a registry and pinned by digest. Two host and bug type pairs are live: task-report with `concurrency`, and Umami with `date_time` (the released time-zone case); the other two pairs are reported unsupported. No task-report case is released or published.

What exists on main and how it is exercised:

- The factory core (`packages/factory`), the contract schema and types (`packages/factory-contract`), the exporter (`tools/case-package`), the standalone harness `rbw-validate` (`tools/case-validate`) and the factory worker (`tools/controller`) are merged and covered by unit tests.
- **Test mode.** The `/factory` page and every request endpoint under `/api/factory/` run over HTTP in one local server process, against deterministic in-memory fakes. Test mode needs no network service and is refused on any Vercel deployment. See [Test mode](packages/web/README.md#test-mode) for the scenarios and the test endpoints:

  ```sh
  RBW_FACTORY_TEST_MODE=1 RBW_JUDGE_PASSCODE=synthetic-factory-passcode pnpm --filter @rbw/web dev --port 3000
  ```

- **The worker's local mode.** `factory-worker --backend docker` runs a request or a validation run on one machine, against a local Postgres ledger, with each copy as a local Docker container. Its tests run a full local request with a validation run over the package tooling's synthetic host. See [Factory worker](tools/controller/README.md#factory-worker).
- **Hosted preview.** On a hosted Vercel preview deployment of commit `269a22a` (October 26 and 27, 2026), the `/factory` page and the routes under `/api/factory/` run in live mode: a judge-passcode session, capabilities, interpretation, starting a request, status, stop, package downloads and validation runs of the delivered task-report and Umami cases, which both passed. Starting a request launches the factory worker in its own Vercel Sandbox from a pushed linux/amd64 worker image that carries the scanned prepared packages; the web service and the worker share the Neon ledger (the factory pool and the serial factory slot). A later preview deployment, with the worker image rebuilt at commit `ca6c77a`, also fulfilled a request. See [Factory service](packages/web/README.md#factory-service).
- **Production.** The production site has served the `/factory` page and its routes in live mode since October 27, 2026, first from commit `ca6c77a`, and later deployments added on-the-fly custom builds (see [On-the-fly bugs](#on-the-fly-bugs-custom-builds)). Its catalog offers task-report for `concurrency` and Umami for `date_time`. Umami is unavailable on UTC days 2–5, including any request whose planned window touches those days ([calendar window](packages/host-umami/README.md#calendar-window)). On those days the request form says so, an Umami request cannot start, and task-report requests are not affected. The measured results below come from hosted preview deployments, not from production.
- **Hosted preview results.** A task-report request, an Umami request and one request with both hosts were each fulfilled. In each delivered case all six behavior cells matched (the original suite and the verification checks on the clean, buggy and reference-fixed copies), and every delivered package part downloaded through the deployment matched its published sha256. A user stop ended a request as `cancelled` with nothing delivered. The worker's worst-case reservation (about $0.35) is settled in full on each request, so a request costs at least that much.
- **Package scan.** The prepare scan blocks a package part with any private-pattern, attribution or credential finding. The only exceptions are two exact upstream lines of Umami's pinned source, named by hash (PR #166).

Planned:

- The completed example's two package archives and their publication.
- A request API acceptance runner (`tools/product-acceptance`).

## On-the-fly bugs (custom builds)

On `/factory`, the picker says “Build a custom non-security bug. Choose a behavior from an offered host.” Behaviors are grouped by host; choose one and describe it in a sentence. “Write my spec card” asks the designer, Nemotron 3.5 Super (`nvidia/Nemotron-3.5-Super-VL`) by default, for a card you can edit. “Accept and build this custom bug” starts the build: Goose agents race on Nebius Token Factory models to implement the bug and its checks. Each build also includes a reference fix. The lane board shows their progress, round feedback, tokens and model spend. See the [judge guide](docs/otf/JUDGES.md) for the screens and the [OTF specification](docs/otf/SPEC.md) for the contract.

| Host | Custom-build scope | Qualification |
|---|---|---|
| task-report service | Concurrency: a lost acknowledged change or a stale success response | The RBW harness's tier-B round, followed by a confirmation round |
| Umami | The time-zone date/time criterion only | The local runner's admission sequence, including repeated runs and an alternative fix; no separate confirmation round |

The six-cell grid compares the original suite and added checks on clean, buggy and fixed copies. Umami also shows an admission strip. Its result is development evidence, not an RBW release. For Umami, the builder chooses among supported date-grouped reports to match the card where it can; the placement may differ from the card's description.

A delivered build has a certificate bound by hashes to its bundles, with the qualification results, models, spend and timings. Give the **agent bundle** to the debugging agent: it contains the buggy app and a symptom-level incident, without checks, fix or spec. Keep the **grader bundle** separate: it contains evaluator material, including the model-written checks and reference fix. Optional validation re-runs the host's qualification on the RBW builder from the stored bundles.

The builder is a Nebius VM started per request and stopped when idle. A cold start adds machine start-up time; the UI shows “Starting the Nebius machine.” as its own step and gives a minute estimate only when one is configured.

The [development timing evidence](docs/otf/evidence/build-time-2026-10-29.json) records these wall times for **qualifying development attempts, not finished customer builds**:

| Host | Median (minutes) | p90 (minutes) |
|---|---:|---:|
| task-report | 15.5 | 30.9 |
| Umami | 21.0 | 34.2 |

The spec card uses the selected host's time estimate. An estimate based on this evidence is labeled as development runs and includes its sample count and measurement date. If a host has no measurement, the UI says its build times are not measured yet. These attempt times include any wait for a qualification slot. They exclude the OTF job queue, cold start, confirmation and packaging. Your bug may take longer or not qualify.

Custom builds depend on current availability. A host that is not offered has a disabled group with a reason. Umami is unavailable on UTC days 2–5. With no availability response and no saved job, the custom-build section is hidden. A capacity failure offers the catalog fallback. Caps apply per lane and per job; model spend is metered as an upper bound, separately from the catalog's shared judge budget. Starting the closest catalog bug is an explicit choice, never an automatic charge.

### Open behaviors

Production offers open behaviors as well as the three proven behaviors above. An open behavior is any other non-security behavior of the task-report service. A finished bug specification in the bug designer has a “Build this as a custom bug” button. It sends the card to the custom-build panel, which shows “Classifying this spec card. No custom build has started.” while the classifier, NVIDIA Nemotron 3.5 Super (`nvidia/Nemotron-3.5-Super-VL`), classifies it; a card written with “Write my spec card” is classified the same way. The answer is a proven match (“This matches the proven behavior” followed by its label), an open behavior with a grading rule you can edit (family, observable failure and failure code), or a refusal: the panel shows the reason, then “The closest catalog bug is offered below.” A security topic or code in the sentence or card is refused before any model call. If a model answer remains unusable after one repair, the route returns a refusal with that catalog fallback. A failed or unavailable classify request instead shows its reason and “Try again”; an edit to the card or sentence clears the classification and asks you to “Classify again”. You then choose “Accept and build this custom bug”. The classification is advisory: production checks the submitted rule, not the classifier's answer.

Open behaviors are built only on the task-report service. The picker labels them “Another non-security behavior (not measured yet)”, and in place of a time estimate the spec card and lane board show “Build times for this kind of behavior are not measured yet. The board shows each step as it runs.” No success rate is claimed. They are qualified on the same six-cell grid as the task-report proven behaviors, with a confirmation round. The certificate adds an “Open behavior (not measured yet)” section with the rule's family, observable failure and failure code, and its criterion version is `open-1`. See the [judge guide](docs/otf/JUDGES.md#open-behaviors).

## Deployment

The site is deployed on Vercel from a tree of this repository plus a results directory assembled from the public results repository and the public store with `packages/web/scripts/assemble-results.mjs`. The steps and project settings are in [Deploying on Vercel](packages/web/README.md#deploying-on-vercel).

## What it does not do

- It is a hackathon prototype with one released case: a time-zone bug in Umami at a pinned commit, from one bug shape and its fixture. A second family, the race family, has its shape, fixture and kit image on main but did not reach admission and is parked. A second host, task-report, has its adapter, checks and copy image on main and no released case.
- Its planted bugs are synthetic; it finds no real Umami bug and files nothing upstream.
- It makes no calibrated claim: calibration is recorded as `not_requested`, and ADM-10 (regrade for reported solves) is planned.
- Anonymous visitors cannot start a replay; only judges with the passcode can, one replay at a time. Candidate attempts start from a controller command on the operator's machine, not from the site.
- The bug factory does not assess source-only difficulty, serves only its two hosts, and does not publish live results to the results repository.
- It does not evaluate Umami's upstream tests other than the API suite.

## How this was built

Claude Code and Codex wrote the code under the author's direction: the author directed, specified and reviewed the work.

## License

MIT; see [LICENSE](LICENSE). Umami, which the kit image builds from source, is under its own MIT license.
