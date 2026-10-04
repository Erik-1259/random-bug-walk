# Working rules for agents and people

These are the engineering rules for any coding agent or person working in this repository. Codex reads this file directly; Claude Code reads it through the import in `CLAUDE.md`.

## Working environment

- Coding agents work in a development container that the host starts with `container/run-agent.sh`; `container/check-isolation.sh` verifies its isolation.
- The container mounts a standalone clone of this repository read-write at `/workspace` and the shared inbox at `/inbox`, and nothing else from the host. The inbox's `publication/` directory is mounted read-only, with its `requests/` directory read-write as a separate mount, so agents cannot change `responses/`.
- It runs as an unprivileged user without sudo, with all capabilities dropped.
- It holds no GitHub, Vercel, Neon or Blob credentials. The only credentials passed in are the two model-provider API keys, read from an owner-only credentials file that the launcher is given at start. Git's author and committer identity comes from the clone's own git config.
- It has no Docker, no database server and no GitHub CLI. It has network access for package registries and public documentation.
- Tools: Node 24 (runs erasable-syntax `.ts` files directly), pnpm, uv (provisions Python 3.12), git, ripgrep, jq, curl, and the Claude Code and Codex CLIs at pinned versions with self-update off.
- Codex's own sandbox is off in the image, because the container is the isolation boundary.

## Public safety

- Pushing is publishing. Anyone signed in to GitHub can read a public repository's branches, draft PRs, commit messages, review comments, Actions logs and artifacts, and history keeps them after deletion. This repository is public from its first commit.
- Never make any of these public, in code, history, PRs, comments, Actions logs, artifacts or the results site:
  - secrets, keys, tokens, authentication headers, and private provider or account identifiers;
  - names, code identifiers, paths or internal IDs of other private projects;
  - personal information about anyone;
  - people's names, email addresses or other identifiers, and notes crediting work to anyone;
  - the names or contents of private planning documents;
  - held-out bugs: their patches, issue texts, IDs or results;
  - private and evaluation model transcripts.
- Public-demo prompts and responses are experimental outputs. Their model context starts from public inputs, and they pass the same scan before publication.
- Exceptions, and only these: the repository's own URL, which contains the owner's account name; the exact copyright line of `LICENSE`, in files named `LICENSE`; git's author and committer fields, which stay as the owner's git config sets them. The checks read text, not those fields.
- Every publication is checked by machine before it happens (see the next section). Required CI scans the same surfaces again, and GitHub push protection stays on. The checks are gitleaks, an attribution check and a private pattern list that is never committed, logged or copied into the container.
- A violation reports only a repository-relative `path:line` (a synthetic name and line for PR text and comments), never the matched text or the pattern. An unavailable check blocks publication; it never counts as a pass.
- Code reads well to a stranger: no commented-out code, debug logging, untracked TODOs or personal paths. Fixtures use synthetic data (reserved `.invalid` domains, `synthetic-` prefixes), with placeholders that cannot be mistaken for real credentials.
- Planted bugs are labeled synthetic in every bundle and on the results site, and are never filed upstream. A real Umami bug found along the way goes to the owner and is not planted; reporting it upstream needs the owner's OK.

## Publishing: pushes, pull requests and comments

- Agents publish only through `tools/publication/bin/rbw-publish`. It pushes the current branch, creates a PR, or posts a PR comment. Its own usage output lists the exact subcommands and options.
- The wrapper writes one request file to `/inbox/publication/requests/` and waits for the host helper's response in `/inbox/publication/responses/`. A request names only a request ID, the registered working copy, the operation, the candidate commit SHA and any proposed public text. It cannot choose a host path, command, remote or file.
- For a push, the helper checks that the exact candidate commit exists in the registered working copy and fast-forwards the permitted branch, or creates a pre-registered branch from its approved base (never `main`). It scans every newly introduced file and commit message, trailers included, and then pushes that exact SHA with host-owned git configuration, never the agent's hooks. A later `HEAD` never replaces the scanned SHA.
- For PR titles, bodies and comments, the helper scans and freezes the exact bytes and publishes those bytes.
- Outcomes:
  - `published`, with the published SHA;
  - `blocked`, with locations only;
  - `unavailable`: the helper, patterns or scanner could not be used, and nothing was published;
  - `stale`: the branch or input changed, nothing was published, and a new request is needed.
- A clean scan alone is never reported as a successful push.
- A pre-push hook in `tools/publication/hooks/` refuses a direct `git push` and points to the wrapper; clones enable it with `core.hooksPath`. Do not disable or bypass it. The host helper, not the hook, is the publication boundary.
- To ask Codex for a review, post a PR comment whose whole text is `@codex review`, through the wrapper.

## Claims and public text

- These rules cover every public surface, including PR descriptions, commit messages and review replies.
- Every number in public text points to a committed results file or artifact. Results are a demonstration, not findings. Remarks about other people's tools and services stay factual and constructive.
- Docs describe what exists, and planned work is labeled planned. The README says this is a hackathon prototype and has a "What it does not do" section.
- The README's "How this was built" section says, without naming anyone, that Claude Code and Codex wrote the code under the author's direction: the author directed, specified and reviewed the work. Its wording follows these rules.
- README, docs and results-site copy pass a CI prose check for inflated wording; the check holds the word list.
- Publication outside the repository (results-site copy, entry pages, video, posts) needs the owner's approval, the owner's review, and a logged-out check of every link.
- Public-demo experimental outputs go to their configured destinations through the trusted publisher and pass the same checks. Publishing them gives them no validated label and supports no new claim.

## Commits, pull requests and attribution

- Commits and PRs are public documentation. `main` gets squash merges whose message is the checked PR title and body: a specific conventional-commit subject (`type(scope): summary`) and a body that says why. No iteration commits reach `main`.
- PR descriptions read clearly to a stranger, say what they implement (with public rule IDs where they apply) and what the integration proof showed, and end with "Deviations: None" or the approved deviations.
- Agents' PR comments are short, factual and courteous, because they are posted from the owner's account and read as the owner's.
- No attribution of any kind, anywhere (commits, PRs, comments, code, docs): no co-author trailers, no tool-generated footers, no signatures, no notes crediting anyone with writing, editing, reviewing, requesting or approving work, and no author tags in code.
- Claude Code's commit and PR attribution is off in `.claude/settings.json`.
- Codex has no documented local setting for commit or PR attribution in the pinned version, so the repository holds no `.codex/` configuration. The publication checks block both trailers and footers.
- The publication checks block such lines. Records of human review name a role ("human reviewer"), not a person.
- Exporters run the same scan before they write any public file. Author fields in exported files, such as Harbor task files, carry the project name, Random Bug Walk; author email fields stay empty.

## Specification fidelity

- The public specification binds the design. Each work item cites the public rule IDs it implements.
- No silent drift: when code cannot or should not follow the specification, stop and say why through the inbox. Either the specification changes first, with the owner's approval, or the code follows it.
- Once a specification structure exists as a schema or type in code, the code is its single home.
- Planned: the admission, grading and calibration rules, published in `docs/admission-rules.md` with stable IDs that never change meaning (a retired rule keeps its ID and is marked retired). Each ID will appear in the specification, in a comment at its implementation and in its test's name, and a CI script will list IDs with no implementation or no test.
- Publication rule IDs:
  - PUB-01: implementation agents receive only sanitized, accessible requirements and cannot read private planning or pattern files.
  - PUB-02: public pushes and text pass the host-owned helper against the exact content published, and unavailable checks prevent publication.
- Scope fence: anything outside the specification or the work item is out of scope. Ideas go to the inbox as proposals.

## Code and tests

- TypeScript: strict, ESM, zero lint warnings. No `any`, no `@ts-ignore`, no swallowed errors. One logger, one HTTP client and one config loader, with no second way of doing the same thing. Only erasable syntax (no enums, namespaces or parameter properties), so Node runs the files directly.
- Python: 3.12, uv with a lockfile, pyright strict, ruff for lint and format with zero warnings. No `Any` or `# type: ignore` without a stated reason, no bare `except`, no swallowed exceptions.
- Tests: Vitest for TypeScript, pytest for Python. Each test asserts specific behaviour that would fail if the code were reverted.
- Workspace: pnpm members are `packages/*` and `tools/*`, named `@rbw/<folder>`; Python members live under `python/*` in a uv workspace. Each package provides `build`, `typecheck`, `lint` and `test`, and the root `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` run across all members.
- Postgres-dependent tests sit behind a separate `test:integration` script that reads `DATABASE_URL` and skips with a clear message when it is unset. Unit tests use no network service.
- CI runs `pip-audit` alongside `npm audit`, and Dependabot covers both lockfiles.
- Every test suite has a test-count floor in CI and fails below it, so a silent skip cannot pass.
- Work items carry a risk class. For class A (work that decides what is admitted or published, or spends money), tests are written first and shown failing before the implementation.

## Required checks

- `main` requires these GitHub Actions jobs by exact name: `typecheck`, `lint`, `unit-tests`, `build`, `integration`, `public-safety`, `names-attribution` and `prose`. Each reports a status on every PR. On docs-only changes the expensive jobs report skipped, which counts as success, and are never absent. No job uses a matrix or a name suffix that changes its reported name.
- The `integration` job creates a throwaway Neon branch for each run, exposes its connection string as `DATABASE_URL`, runs `pnpm -r --if-present run test:integration`, and deletes the branch afterwards, including when the run is cancelled.
- The `integration-heavy` workflow (job `heavy-integration`) reports its own status and is not required (see Integration proof).

## Git, review and merge

- One branch per work item (`type/short-slug`). Open a draft PR early, through the wrapper. Squash merges only. No force pushes and no direct pushes to `main` (branch protection). Agents do not rebase shared branches.
- The implementer first reviews its own diff against the item's done-when list and the specification. Codex then reviews the PR. When Codex wrote the change, the conductor reviews it too, so the model that wrote a change is never its only reviewer.
- Every finding gets one disposition: fix, defer to the inbox, or reject with a reason.
- Review has converged when the final head has no P0, P1 or P2 finding, and a PR merges only after that. The owner may merge without Codex's review. There is no fixed count of review passes.
- Severity:
  - P0: wrong admission or grading, a false published number, unauthorized or runaway spend, or exposure of a secret or private material;
  - P1: a major defect;
  - P2: a minor defect;
  - P3: a nit or style point, which never blocks.

## Review guidelines

For automated pull request reviews, including Codex's:

- Look for correctness bugs and real defects in the change: wrong behaviour, broken edge cases, data loss, wrong spend or admission logic, and secrets or private data reaching public output.
- Do not suggest process, workflow-hardening or defence-in-depth changes unless they fix a concrete defect in the change. This is a short hackathon project.
- Accepted risk, not a finding: workflows on same-repository pull requests can reach repository secrets. Only the owner's account opens pull requests here, each after the checked publication step, and pull requests from forks get no secrets.

## Integration proof

- Every check-in carries an integration proof; passing unit tests never make a PR done on their own.
- The proof runs the change with its real neighbours: the workflow step, the database on a throwaway Neon branch, the library it wraps. Paid model calls are the only thing replaced, and only in public CI, by recorded responses.
- The proof shows the outcome happening and would fail if the change were reverted. For class A, that is shown once against the reverted change.
- The `integration-heavy` workflow (job `heavy-integration`) starts only on PRs labeled `heavy-integration` or on a manual run. It is a separate workflow, not a required check, and it currently runs a placeholder. The heavy proof itself (Umami in a sandbox copy) is planned; once it exists, the owner sees its status before merging.
- Runs with live models happen in the private execution repository.

## Reuse, dependencies and licences

- Reuse in this order: the services and libraries the specification names, and their built-in features; Umami's own code, harness, seed data and API client; maintained open-source packages with compatible licences; new code.
- Each work item says what already covers it, what is left to write and a rough size. A PR adding more than about 200 lines of new non-test code says in one line why nothing existing fits.
- Follow the patterns already in the repository; the first implementation of a kind sets the pattern.
- Licences: MIT, Apache-2.0, BSD or ISC. Nothing GPL, AGPL, LGPL, noncommercial or share-alike in code. Pin exact versions (no `^` or `~`).
- Bundles that include Umami code keep Umami's MIT notice.
- A service the specification does not name needs the owner's OK.
- This repository is MIT-licensed (`LICENSE`).

## Security, credentials and agent permissions

- Never read `.env*` files or print environment variables. Docs name variables, never values.
- Keys live in Vercel and GitHub secrets, one per role. A key that appears anywhere public is rotated at once, so report one immediately.
- Take no action on repositories or services outside the project without the owner's permission.
- Verify infrastructure state, URLs and endpoint behaviour with commands; never assume them.
- `.claude/settings.json` denies, for Claude Code sessions in this repository:
  - every `git push`, also with git global options (any option starting with `-`) before the subcommand;
  - `git reset --hard`, every `git clean`, and `--no-verify` or `-n` on `git commit`;
  - `gh pr` create, comment, edit, review, close and reopen; `gh issue` create, comment, edit, close and reopen; `gh api` with any explicit method (including GET; a plain `gh api` call already uses GET), a field option or `--input`;
  - Vercel deploys (a bare `vercel`, `--prod`, `deploy`, `redeploy`), `promote`, `rollback`, `remove` and `rm`, directly or through `npx`, `pnpm`, `pnpm exec` or `pnpm dlx`;
  - Neon CLI delete, reset and restore commands, `prisma migrate reset`, `prisma db push --force-reset` and `dropdb`;
  - recursive forced `rm` of `/`, `~`, `$HOME`, `.`, `./`, `..` and `.git`, and of anything under `/`, `~/`, `$HOME/` or `./` (so remove throwaway directories from a script);
  - `chmod -R 777`, `chown`, `docker push` and `docker system prune`;
  - reading `.env`, `.env.*` and `*.env` files, `printenv` and a bare `env`.
- These rules match command text as written. They do not cover, for example, `rm -rf *`, a program run by its full path (`/usr/bin/git push`), a command inside `sh -c`, a quoted subcommand, a version-pinned runner such as `npx vercel@latest deploy`, runner options such as `npx -y vercel --prod`, a git command wrapped in a package runner such as `pnpm exec git push`, or a script that runs the command itself.
- The rules prevent mistakes; they are not the publication boundary. That boundary is the container's lack of credentials plus the host helper.

## Inbox

- Discoveries (a bug, a specification gap, a surprise), questions, end-of-block reports and proposed documentation changes go to `/inbox` as `YYYYMMDD-HHMM-<source>-<slug>.md`, where the source is the work item ID.
- Each file has a title line and Summary, Evidence and Suggested action sections.
- Do not read or edit other files in the inbox, and delete nothing.
- `/inbox/publication/` belongs to the wrapper and the host helper.
