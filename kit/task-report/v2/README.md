# Task-report kit, version 2

The copy image of evaluator version 2 for the task-report host. It is version 1's runtime (Node
24, PostgreSQL 15, the baseline's dependencies from the vendored lockfile, the original suite,
the launcher and `etc/`) without any check: the checks come from the validator. The image keeps
`etc/` without its comment lines, which describe how the checks work, and only root can read it.
A copy is one container, or one Sandbox microVM, with no network, 4 CPUs and 8 GB.

| Path | Owner and mode | Content |
| --- | --- | --- |
| `/workspace/app` | root, read-only to all | the copy's app tree, placed by the runner; `node_modules` came with the image |
| `/opt/rbw/evaluator/pkg` | root only (0700) | the validator's check package, placed by the runner; the image adds only a `package.json` that marks the directory as ES modules |
| `/opt/rbw/evaluator` (rest) | root only (0700) | the original suite and the evaluator's copy of the dependencies (pg 8.23.1, Playwright 1.63.0) |
| `/opt/rbw/bin` | root, 0755 | `rbw-launch` (the Umami kit's launcher, copied at build time) and `rbw-copy-v2` |
| `/opt/rbw/etc` | root only (0700, files 0600) | `etc/` without comment lines: the PostgreSQL settings and client authentication, the provisioning SQL and the environment files; read by the copy driver and by `rbw-launch` before it drops privileges |
| `/var/lib/rbw/results/copy` | root only | the copy's record set, which the runner copies back |

`rbw-copy-v2` runs as root: it makes the placed check package root-only again (the placement may
change owners or modes), then starts `v2/copy.ts` from it with the image's Node. See
`packages/host-task-report/README.md` for the driver and the evaluation.

```sh
node packages/host-task-report/adapter/qualify.ts build --tag rbw-task-report:<name>
```

builds this image from `kit/task-report/v2/Dockerfile` with the vendored app and the Umami kit's
launcher as named build contexts. Version 1's image (`kit/task-report/Dockerfile`) is unchanged.
