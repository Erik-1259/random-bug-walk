# @rbw/solver-session

One solver attempt's session on local Docker, for the paired comparison (UC1): a fresh container of the pinned kit image holding the planted app, the tools the solver agent calls, the cold-build reset between rebuilds, the log scrub, and the attempt's diff on submit. The agent loop itself is `packages/solver`; grading the submitted file is a separate step. This is part of a hackathon prototype, and everything it writes is development evidence.

## What one session does

1. **Derive and audit.** It resolves the image tag to its content digest and exports the pinned source with `tools/local-runner`'s `exportImage`, derives the planted file with its `deriveCodeStates` (the probes' hashes are checked), and audits the planted projection with its `auditCopy`, against the manifest, the term list and the policy. Anything but `pass` refuses the session (`SessionRefusal`) before any container exists.
2. **Container.** `docker run --detach --name rbw-solver-<id> --network none --cpus 4 --memory 8g --security-opt no-new-privileges <digest> tail -f /dev/null`, the local runner's copy resources (spec §9.4). The image's `tini` is PID 1.
3. **Build-outputs check.** The image's `/opt/rbw/etc/build-outputs.txt` must be byte-identical to `kit/umami/build-outputs.txt` (`KIT_BUILD_OUTPUTS`), which the reset is built from.
4. **Overlay.** The planted file goes in through a root-only staging file and is written over the image's file in place, so it keeps the image's owner and mode. The container's tracked files (every path in the manifest) are then read out and compared with the audited projection; any difference stops the session (`overlay_mismatch`).
5. **Snapshot.** Before the first build, the snapshot script records each build output's owner, group and mode, a copy of each `tracked` output, and the entries of each `sticky` directory, under `/var/lib/rbw/session` (root only).
6. **Start.** `rbw-check-cold`, `rbw-build-app`, `rbw-start`: the same in both arms. A failed first start is an infrastructure error (`SessionError`).
7. **Tools** until submit (next section).
8. **Close.** `docker cp` of `/var/lib/rbw/logs` to `<work>/logs` (the harness's copy of the runtime logs, in both arms), then `docker rm --force`.

### The neutral commit

The kit image has no git (and no bash: commands run under BusyBox `sh`). The neutral commit is therefore the audited projection's: `auditCopy` makes it with `@rbw/projection`'s `commitNeutral` in `<work>/audit/projection`, over the exported source with the planted file in place. The diff on submit is computed on the host against that projection, over tracked files only: the container's tracked files are read out as one tar stream (`TRACKED_TAR_SCRIPT`), and each is compared for content, type and executable bit. No `.git` is placed in the container.

## The tool interface

`src/tools.ts` defines `SolverTools`, which `Session` implements. Every method resolves with JSON-safe data; a refusal is `ok: false` with a reason, and only an infrastructure failure throws (`SessionError`).

| Method | What it does |
|---|---|
| `run(cmd)` | `sh -c <cmd>` as `rbw-app` through the kit's `rbw-launch` (clean environment, its own process group, cleaned up when it ends), in `/workspace/app`; 120 s timeout (exit 124), 64 KiB kept per stream |
| `readFile(path)` | `head -c` as `rbw-app`, so the app user's permissions apply; a relative path is under `/workspace/app`; 256 KiB returned |
| `writeFile(path, content)` | Only a tracked path (in the manifest), relative or under `/workspace/app`; written as root in place, keeping the owner and mode; 1 MiB at most |
| `rebuildRestart()` | `rbw-stop`, the reset script, `rbw-check-cold` (must pass, or `SessionError`), `rbw-build-app`, then `rbw-start` when the build passed; at most 8 calls per attempt (`rebuild_cap`) |
| `serverLogs(cursor?)` | The on arm only (`serverLogs: true`); the off arm gets `server_logs_unavailable` without any read. A 16 KiB slice of `umami.stderr.log` and `postgres.stderr.log`: the tail with no cursor, otherwise forward from the cursor; `restarted` when a log is shorter than its cursor (each start truncates it) |
| `submit()` | The diff against the neutral commit; the session takes no further tool calls |

`Session.end("cap")` does the same extraction when the solver stops the attempt at a cap. The submission is `in_scope` when nothing but the target file changed (or nothing did) and `out_of_scope` otherwise; the files are `<work>/submission/{submission.json,target.bin,target.patch}`, and `target.bin` holds the bytes the grade step reads.

## The cold-build reset

`rbw-build-app` refuses a warm build. Before each rebuild, `RESET_SCRIPT` (in `src/reset.ts`) restores every entry of `kit/umami/build-outputs.txt`:

| Kind | Reset |
|---|---|
| `dir` | removed and recreated empty |
| `file` | removed and recreated empty |
| `tracked` | the snapshot's copy put back |
| `sticky` | every entry the snapshot did not list removed (for example tsup's `tsup.config.bundled_*.mjs`) |

Each gets its recorded owner, group and mode back. The script then empties `/var/tmp/rbw-app` and `/var/tmp/rbw-db` and removes `.turbo` and `node_modules/.cache`, the other things `rbw-check-cold` looks for. The database in `/var/lib/rbw/pgdata` is kept across rebuilds. `parseBuildOutputs` reads the list and refuses an unknown kind or an unsafe path.

The tests run the snapshot and reset scripts and the kit's own `rbw-check-cold` (each absolute path moved under a temporary root) with `/bin/sh`, against a tree laid out from `build-outputs.txt`; after a simulated build, the reset makes `rbw-check-cold` pass again, twice.

## The log scrub

`rebuild_restart` never returns runtime output. `rbw-start` prints the last 50 lines of the Umami and Postgres logs when it fails, and copies what `check-db.js` and `update-tracker.js` print. `scrubStartOutput` keeps only `rbw-start`'s own lines, each on the stream it writes it to: `postgres_ready_ms=`, `ready_ms=` and `listening` on stdout, the `rbw-start:` message on stderr. Every other line is dropped and counted (`[N lines of runtime output withheld]`). The scrub is the same in both arms; the unscrubbed output is kept in `<work>/rebuilds/<label>.json` for the harness. The build's own output (`rbw-build-app`) is returned, its last 64 KiB.

## Files a session writes

| Path under `<work>` | What |
|---|---|
| `source/`, `audit/` | the export, the audited projection with its neutral commit, the audit report |
| `events.jsonl` | one line per step and tool call (a command is recorded by its SHA-256) |
| `rebuilds/initial.json`, `rebuilds/rebuild-NN.json` | each build and start's full output |
| `submission/` | the submission and the target file's bytes |
| `logs/` | `/var/lib/rbw/logs` copied out at close |

## Host command

A smoke run of one session with no model: it opens the session, runs one command, reads a file, runs `--rebuilds` rebuilds, reads the server logs (on arm) and submits with no change.

```sh
node tools/solver-session/src/cli.ts smoke --id smoke-01 --image rbw-umami-kit:local --manifest <manifest> --terms <terms> --work <work> [--arm on|off] [--rebuilds <n>]
```

`<manifest>` and `<terms>` are as in `tools/local-runner`'s README (a synthetic term list works for a development run). It prints one JSON line per step. Exit codes: 0 every step ran and every build started; 1 a step failed; 2 a usage error or a refusal before any container.

Each session holds a 4 vCPU, 8 GB container and runs a cold Next build per rebuild. The paired run's plan is at most 3 sessions at a time, with `host-health.sh` between batches; the caller enforces that.
