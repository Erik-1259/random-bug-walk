# Task-report host: vendored baseline

`app/` is the task-report host, a synthetic task-and-report HTTP service built for experiments:
Node 24 with type stripping, `pg` 8.23.1 and PostgreSQL 15, six JSON routes and two tables. Its
`README.md` holds the service's full contract, and its `test/` tree is the original suite: 193
Playwright HTTP tests.

This copy is the pinned baseline the bug factory uses for the task-report host, baseline ID
`task-report@ca4a71f`. Every code state of a task-report case starts from these bytes: the clean
state is this tree, a buggy state is this tree with one catalog patch, and a fixed state is the
buggy tree with its pinned reference repair, which gives back these exact bytes.

| Identity | Value |
| --- | --- |
| Source commit | `ca4a71fc4486ba68fda9fd9f5c13a5664edb36fa` |
| Git tree of `app/` | `f281f20356277e5f6bdbf0c7f4be6bac2fafa33a` |
| Files | 40 |
| Tree digest (SHA-256 of the canonical JSON of every file's SHA-256 by path) | `22e67f24fdc4e2edffe357d10572ed3a799b7ddbeb8b8176a29d6f7581c3eedd` |
| Original suite (`package.json`, `playwright.config.ts`, `tsconfig.json`, `test/`) | 12 files, tree digest `8ec1e3d58c3fb62e6de601c4b726201e38c11d697a15e0e86fc1808bd93812fc`, 193 tests |

The tree was copied with `git archive` of the source commit, without git history. The copy's git
tree equals the source commit's tree, and every file's SHA-256 is recorded in
`packages/host-task-report/baseline/task-report-ca4a71f.json`, with the original suite's test IDs.
A unit test of `@rbw/host-task-report` recomputes the hashes of this directory and fails on any
difference.

## Rules

- The copy stays byte-identical. Any change, even whitespace, is a new baseline with a new ID, a
  new manifest and new qualification runs.
- It is not part of the pnpm workspace, and eslint and the prose check skip it, so no tool rewrites
  it.
- `compose.yaml` and `scripts/init-db.sql` carry the service's own dev-only placeholder passwords.
  The task-report kit (`kit/task-report`) does not use them; it provisions its own roles.

## License

Covered by this repository's MIT license (`LICENSE` at the repository root).
