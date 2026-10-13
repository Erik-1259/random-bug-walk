# Random Bug Walk

Random Bug Walk is a hackathon prototype of a "bug factory". It plants a synthetic bug in a pinned copy of the open-source analytics app [Umami](https://github.com/umami-software/umami), modeled on a public source fix that matches one bug shape (`DT-1.tz-arg`: a caller has the selected time zone but does not pass it to a date operation). It then checks, on fresh app copies on Vercel Sandbox, whether Umami's own API test suite misses the bug while four added checks catch it, has a model write a user-style bug report from the observed symptom, and publishes the evidence. Every metered call and sandbox is reserved against a spend ledger before it starts. A results site shows the case, and judges with a passcode can plant and verify the released example again on three fresh copies.

- Results site: <https://random-bug-walk.vercel.app>
- Results repository (published runs and releases): <https://github.com/Erik-1259/random-bug-walk-results>

The planted bug is synthetic, labeled as such everywhere, and never filed upstream. Results are a demonstration, not findings.

## Repository map

| Path | What it is |
|---|---|
| [`packages/admission`](packages/admission/README.md) | Trial-result importer and the admission decisions (ADM-02 to ADM-06, the ADM-08 comparison) |
| [`packages/envelope`](packages/envelope/README.md) | Versioned provider rates and priced envelopes for the spend ledger |
| [`packages/harvest`](packages/harvest/README.md) | Finds public source fixes on GitHub that match the bug shape and reports a funnel |
| [`packages/harvest-review`](packages/harvest-review/README.md) | Two-model review of the harvest's matches |
| [`packages/projection`](packages/projection/README.md) | Audits a solver-visible copy: pinned source, one declared change, no history or answer-bearing files (part of ADM-01, ADM-07's scan) |
| [`packages/publisher`](packages/publisher/README.md) | Trusted publisher of runs and releases to the results repository and the public store |
| [`packages/schema`](packages/schema/README.md) | Shared record schema, canonical JSON and job contracts (TypeScript, with the Python package in `python/schema`) |
| [`packages/search`](packages/search/README.md) | Tavily searches, including the exact-phrase checks on issue text |
| [`packages/shapes`](packages/shapes/README.md) | The bug shape as ast-grep rules, with the planted mutation and probe patches |
| [`packages/spend`](packages/spend/README.md) | Postgres spend pools and the serial execution slot |
| [`packages/umami-driver`](packages/umami-driver/README.md) | Protected command that runs one trial inside an app copy and writes its records |
| [`packages/umami-fixture`](packages/umami-fixture/README.md) | The fixture `umami-tz-arg-001`: data and the four added checks |
| [`packages/web`](packages/web/README.md) | The results site (Next.js) and its judge routes |
| [`packages/writer`](packages/writer/README.md) | Model-written pattern cards and bug reports, with code checks on every issue |
| [`tools/controller`](tools/controller/README.md) | Runs jobs and the candidate attempt against the spend ledger on Vercel Sandbox; also the judge replay's controller |
| [`tools/local-runner`](tools/local-runner/README.md) | Runs the kit check, observation and admission on local Docker; its job builders and copy path are reused by the controller |
| [`tools/release`](tools/release/README.md) | Stages runs for the publisher, builds a checked release with its frozen judge job, and publishes judge replays |
| [`tools/publication`](tools/publication/README.md) | Publication boundary for agent work: scanner, host helper, wrapper and pre-push hook |
| `tools/neon-ci` | Creates and deletes the throwaway Neon database branches that the integration workflows use |
| [`kit/umami`](kit/umami/README.md) | The kit image: pinned Umami, PostgreSQL and the protected verifier area |
| [`docs/admission-rules.md`](docs/admission-rules.md) | Admission rules ADM-01 to ADM-10 and their status |
| `container/` | The development container for coding agents (`Dockerfile`, `run-agent.sh`, `check-isolation.sh`) |
| `scripts/checks/` | Repository checks: prose, admission rule IDs, test-count floors, dependency audit, docs-only classification |
| `.github/workflows/` | CI, the Postgres integration tests and Neon branch cleanup |

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

The judge routes stay disabled unless their variables are set. See [`packages/web/README.md`](packages/web/README.md) for the pages, the results directory layout, the fixtures and the configuration.

## How a candidate, a release and a judge replay fit together

1. **Candidate attempt.** The controller's `attempt` command runs one factory root on Vercel Sandbox: a kit check, an observation, the writer's card and issue, the searcher's exact-phrase checks, and the 13-copy admission, each reserved on the spend ledger. See [The candidate attempt](tools/controller/README.md#the-candidate-attempt).
2. **Publication.** `tools/release stage` turns the terminal root into a staging directory, and the publisher publishes it to the results repository and the public store. See [`tools/release`](tools/release/README.md) and [`packages/publisher`](packages/publisher/README.md).
3. **Release.** After the owner approves the frozen issue, `tools/release build` checks the published run and writes a release with a frozen judge job in the private store; the publisher's `release` command publishes the release directory. The results site, rebuilt with it, shows the validated example.
4. **Judge replay.** On the site, a judge with the passcode starts a replay. The judge route reserves the budget and starts the controller in its own sandbox, which runs the frozen judge job on three fresh copies (clean, planted, fixed) and compares the six cells with the release. `tools/release publish-replays` later publishes finished replays. See [Judge routes](packages/web/README.md#judge-routes) and `--prebuilt` in [`tools/controller`](tools/controller/README.md#commands).

## Deployment

The site is deployed on Vercel from a tree of this repository plus a results directory assembled from the public results repository and the public store with `packages/web/scripts/assemble-results.mjs`. The steps and project settings are in [Deploying on Vercel](packages/web/README.md#deploying-on-vercel).

## What it does not do

- It is a hackathon prototype: one app (Umami at a pinned commit), one bug shape and one fixture.
- Its planted bugs are synthetic; it finds no real Umami bug and files nothing upstream.
- It makes no calibrated claim: calibration is recorded as `not_requested`, and ADM-10 (regrade for reported solves) is planned.
- Anonymous visitors cannot start a replay; only judges with the passcode can, one replay at a time. Factory runs start from a command on the conductor's host, not from the site.
- It does not evaluate Umami's upstream tests other than the API suite.

## How this was built

Claude Code and Codex wrote the code under the author's direction: the author directed, specified and reviewed the work.

## License

MIT; see [LICENSE](LICENSE). Umami, which the kit image builds from source, is under its own MIT license.
