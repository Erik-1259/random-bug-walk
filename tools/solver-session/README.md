# @rbw/solver-session

One solver attempt's session on local Docker, for the paired comparison (UC1): a fresh container of the pinned kit image holding the planted app, the tools the solver agent calls, the cold-build reset between rebuilds, the log scrub, and the attempt's diff on submit. The agent loop itself is `packages/solver`; grading the submitted file is a separate step. This is part of a hackathon prototype, and everything it writes is development evidence.

## What one session does

1. **Derive and audit.** It resolves the image tag to its content digest and exports the pinned source with `tools/local-runner`'s `exportImage`, derives the planted file with its `deriveCodeStates` (the probes' hashes are checked), and audits the planted projection with its `auditCopy`, against the manifest, the term list and the policy. Anything but `pass` refuses the session (`SessionRefusal`) before any container exists. With `expectedDigest` set (a counted attempt passes the digest its case admits), an image that resolves to any other digest is refused too (`image_mismatch`); `null` accepts whatever the tag resolves to, for a smoke run. The digest the session ran is recorded in `submission.json` (`image_digest`).
2. **Container.** `docker run --detach --name rbw-solver-<id> --network none --cpus 4 --memory 8g --security-opt no-new-privileges <digest> tail -f /dev/null`, the local runner's copy resources (spec §9.4). The image's `tini` is PID 1.
3. **Build-outputs check.** The image's `/opt/rbw/etc/build-outputs.txt` must be byte-identical to `kit/umami/build-outputs.txt` (`KIT_BUILD_OUTPUTS`), which the reset is built from.
4. **Overlay.** The planted file goes in through a root-only staging file and is written over the image's file in place, so it keeps the image's owner and mode. The container's tracked files (every path in the manifest) are then read out and compared with the audited projection; any difference stops the session (`overlay_mismatch`).
5. **Snapshot.** Before the first build, the snapshot script records each build output's owner, group and mode, a copy of each `tracked` output, and the entries of each `sticky` directory, under `/var/lib/rbw/session` (root only).
6. **Start.** Both runtime logs (`umami.stderr.log`, `postgres.stderr.log`) are emptied, then `rbw-check-cold`, `rbw-build-app`, `rbw-start`: the same in both arms, and the same at every rebuild. A failed first start is an infrastructure error (`SessionError`).
7. **Tools** until submit (next section).
8. **Close.** `rbw-stop`, which waits until the Umami and Postgres launchers (the logs' writers) have exited, then `docker cp` of `/var/lib/rbw/logs` to `<work>/logs` (the harness's copy of the runtime logs, in both arms), then `docker rm --force`. When `rbw-stop` fails (a launcher is still alive), `docker stop --time 30` stops the whole container first, so no writer outlives the copy; if that fails too, nothing is copied, the container is kept and `close()` throws `container_stop_failed`. A failed copy keeps the container and throws `logs_copy_failed`; calling `close()` again retries the copy into `<work>/logs-retry-N`.

### The neutral commit

The kit image has no git (and no bash: commands run under BusyBox `sh`). The neutral commit is therefore the audited projection's: `auditCopy` makes it with `@rbw/projection`'s `commitNeutral` in `<work>/audit/projection`, over the exported source with the planted file in place. The diff on submit is computed on the host against that projection, over tracked files only: the container's tracked files are read out as one tar stream (`TRACKED_TAR_SCRIPT`), and each is compared for content, type and executable bit. No `.git` is placed in the container.

## The tool interface

`src/tools.ts` defines `SolverTools`, which `Session` implements. Every method resolves with JSON-safe data; a refusal is `ok: false` with a reason, and only an infrastructure failure throws (`SessionError`). Calls are serialized: the session runs one at a time in call order (and `end()` and `close()` with them), so a loop may issue a model's parallel tool calls at once. Each placement has its own staging file.

| Method | What it does |
|---|---|
| `run(cmd)` | `sh -c <cmd>` as `rbw-app` through the kit's `rbw-launch` (clean environment, its own process group, cleaned up when it ends), in `/workspace/app`; 120 s timeout (exit 124), 64 KiB kept per stream |
| `readFile(path)` | `head -c` as `rbw-app`, so the app user's permissions apply; a path relative to `/workspace/app` only: an absolute path, a `..` segment or a symlink that resolves outside the app tree is refused as `outside_app_tree`; 256 KiB returned |
| `writeFile(path, content)` | Only a tracked path (in the manifest), relative to `/workspace/app` (an absolute path, a `..` segment or a directory symlinked out of the app tree is refused as `outside_app_tree`), and not one of the build's `tracked` outputs; written as root in place, keeping the owner and mode; 1 MiB at most (`too_large`) |
| `rebuildRestart()` | `rbw-stop`, then `KILL_APP_SCRIPT` (every `rbw-app` process is killed, so nothing the agent started under `setsid` or `tmux` survives to serve old code or write build outputs), the reset script, `rbw-check-cold`, `rbw-build-app`, then `rbw-start` when the build passed; at most 8 calls per attempt (`rebuild_cap`). A tree still warm after the reset is the agent's failed rebuild (`ok: false`, `refused: "not_cold"`, the findings in `build.output`), not an error |
| `serverLogs(cursor?)` | The on arm only (`serverLogs: true`); the off arm gets `server_logs_unavailable` without any read. A 16 KiB slice of `umami.stderr.log` and `postgres.stderr.log`: the tail with no cursor, otherwise forward from the cursor. Both logs are emptied at every build boundary, before the build, while their launchers are stopped, so a start that fails at any point (even before the Umami launcher runs) never serves an earlier start's output. A cursor carries the build boundary it belongs to (`generation`); a cursor from before the last boundary reads the new logs from byte 0, with `restarted: true`. After a rebuild whose build failed (or whose tree was not cold), the app is not started and both slices are empty (size 0) until the next start, so an earlier start's logs never read as current. `restarted` is also set when a log is shorter than its cursor |
| `submit()` | The diff against the neutral commit; the session takes no further tool calls |

`Session.end("cap")` does the same extraction when the solver stops the attempt at a cap. The submission is `in_scope` when nothing but the target file changed (or nothing did) and `out_of_scope` otherwise. The build's own `tracked` outputs (`kit/umami/build-outputs.txt`) are left out of that comparison: the build regenerates them from other sources, so a fix upstream of a generator could change them, and the reset restores them before every build. The overlay check still covers them, before the first build; the files are `<work>/submission/{submission.json,target.bin,target.patch}`, and `target.bin` holds the bytes the grade step reads.

## Running the solver loop

`solverSession(session)` (`src/solver.ts`) returns the session as `packages/solver`'s `SolverSession`, the interface `runAttempt` takes. The solver keeps its own tool layer (input checks, byte caps, the rebuild cap and its runtime-log scrub); the adapter only maps calls and results:

- `bash(command, { timeoutMs })` is `run(command, timeoutMs)`; the timeout can only shorten the session's own.
- `readFile` and `writeFile` pass the session's refusal reason as the solver's `error`.
- `rebuildRestart()` returns `rbw-build-app`'s own stdout and stderr (from `rebuildRestartWithBuild()`), which the solver cuts into its build sections, and the session's scrubbed `rbw-start` lines as the start's output, so no runtime log line reaches the solver. A tree still warm after the reset, or the session's own rebuild cap, comes back as a failed build (exit 1) with the reason as `rbw-build-app`'s message.
- `serverLogs({ cursor, maxBytes })` reads both logs, each at most half of `maxBytes` less 256 bytes for the two headers, as one page with a `--- umami.stderr.log` and a `--- postgres.stderr.log` section. `next_cursor` is `<generation>.<umami offset>.<postgres offset>`; a cursor that does not parse reads the tail. `truncated` is set when either log restarted since the cursor. The session must be opened with `serverLogs` matching the solver's arm.

The attempt's diff is taken after `runAttempt` returns, with `session.submit()` or `session.end("cap")`, and `close()` stays with the caller. `test/unit/solver.test.ts` drives each tool through the solver's own `runTool` over a session.

## The cold-build reset

`rbw-build-app` refuses a warm build. Before each rebuild, `RESET_SCRIPT` (in `src/reset.ts`) restores every entry of `kit/umami/build-outputs.txt`:

| Kind | Reset |
|---|---|
| `dir` | removed and recreated empty |
| `file` | removed and recreated empty |
| `tracked` | the snapshot's copy put back |
| `sticky` | every entry the snapshot did not list removed (for example tsup's `tsup.config.bundled_*.mjs`) |

Each gets its recorded owner, group and mode back (the tests check the `chown` with a logging stand-in, since they cannot run as root). The script then empties `/var/tmp/rbw-app` and `/var/tmp/rbw-db` and removes `.turbo` and `node_modules/.cache`, the other things `rbw-check-cold` looks for. The database in `/var/lib/rbw/pgdata` is kept across rebuilds. `parseBuildOutputs` reads the list and refuses an unknown kind or an unsafe path.

The session's other in-container scripts (the placement, the log slice, the log clearing, the tracked-file archive and `KILL_APP_SCRIPT`) take their paths as arguments, and `test/unit/scripts.test.ts` runs each for real with `/bin/sh` against a temporary tree. The tests run the snapshot and reset scripts and the kit's own `rbw-check-cold` (each absolute path moved under a temporary root) with `/bin/sh`, against a tree laid out from `build-outputs.txt`; after a simulated build, the reset makes `rbw-check-cold` pass again, twice.

## The log scrub

`rebuild_restart` never returns runtime output. `rbw-start` prints the last 50 lines of the Umami and Postgres logs when it fails, and copies what `check-db.js` and `update-tracker.js` print. `scrubStartOutput` keeps only `rbw-start`'s own lines, each on the stream it writes it to: `postgres_ready_ms=`, `ready_ms=` and `listening` on stdout, the `rbw-start:` message on stderr. Every other line is dropped and counted (`[N lines of runtime output withheld]`). The scrub is the same in both arms; the unscrubbed output is kept in `<work>/rebuilds/<label>.json` for the harness. The build's own output (`rbw-build-app`) is returned, its last 64 KiB.

## Files a session writes

| Path under `<work>` | What |
|---|---|
| `source/`, `audit/` | the export, the audited projection with its neutral commit, the audit report |
| `events.jsonl` | one line per step and tool call (a command is recorded by its SHA-256) |
| `rebuilds/initial.json`, `rebuilds/rebuild-NN.json` | each build and start's full output |
| `submission/` | the submission and the target file's bytes |
| `logs/` | `/var/lib/rbw/logs` copied out at close (`logs-retry-N/` when an earlier copy failed) |

## Host command

A smoke run of one session with no model: it opens the session, runs one command, reads a file, runs `--rebuilds` rebuilds, reads the server logs (on arm) and submits with no change.

```sh
node tools/solver-session/src/cli.ts smoke --id smoke-01 --image rbw-umami-kit:local --manifest <manifest> --terms <terms> --work <work> [--digest <sha256:...>] [--arm on|off] [--rebuilds <n>]
```

`--digest` refuses the run unless the image resolves to that digest.

`<manifest>` and `<terms>` are as in `tools/local-runner`'s README (a synthetic term list works for a development run). It prints one JSON line per step. Exit codes: 0 every step ran and every build started; 1 a step failed; 2 a usage error or a refusal before any container.

Each session holds a 4 vCPU, 8 GB container and runs a cold Next build per rebuild. The paired run's plan is at most 3 sessions at a time, with `host-health.sh` between batches; the caller enforces that.
