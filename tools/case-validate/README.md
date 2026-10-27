# @rbw/case-validate

The standalone validation harness `rbw-validate`, its library entry point `validatePair`, the `docker` copy runner and the host registry. The harness checks a case's two package parts ([`docs/product/bug-package-v1.md`](../../docs/product/bug-package-v1.md)) on their own: it verifies both archives and their binding, rebuilds the clean, buggy and fixed copies from the exported buggy source in a fresh workspace, runs the copies through a host adapter and a copy runner, and reports the six cells. It runs under Node 24 directly, with no build step.

## Command

```
node tools/case-validate/src/cli.ts <bug-case.tar.gz> <validator.tar.gz> [--out <dir>]
```

The host comes from the manifests' `host_id` through the host registry, and copies run on the local Docker daemon. The command prints the package hashes, `pair_sha256`, the matrix and the result, and exits 0 for `passed`, 1 for `failed`, 2 for `error` and 64 for a usage error. With `--out`, it writes `validation.json` and keeps each copy's results under `<dir>/copies/`. A temporary results directory it cannot create, or a report it cannot write, answers `error` with exit 2, whatever the run answered.

## Entry points

| Import | Contents |
|---|---|
| `@rbw/case-validate` | `validatePair`, `verifyPair`, `buildWorkspace`, `evaluateMatrix`, `dockerRunner`, `runValidateCli`, `resultsSha256`, and the entries below |
| `@rbw/case-validate/registry` | `HOST_REGISTRY`, `createHostRegistry`, `HostRegistration`; imports no runner |
| `@rbw/case-validate/version` | `HARNESS_IDENTITY` (`{ name: "rbw-validate", version }`) and `HARNESS_VERSION`; imports nothing with behavior |
| `@rbw/case-validate/docker` | `dockerRunner` alone |

## validatePair

```ts
const outcome = await validatePair({
  bug_case, validator,            // the two archives' bytes
  adapters: HOST_REGISTRY.adapters(),
  runner,                         // any CopyRunner of @rbw/factory-contract
  now: () => new Date(),
  until,                          // optional planned end for the availability check
  beforeCopy, onCopy, onCells,    // optional: stop check, per-copy settlement, per-state cells
});
```

It resolves `{ result, stopped, package_sha256, pair_sha256, matrix, records, message, diagnostic, error_code }`. `result` follows contract section 11: `error` whenever the pair is refused, the host has no adapter or is unavailable, the harness cannot write its workspace (`workspace_error`), or any cell is `error` or `incomplete`; a state with an invalid or incomplete copy record never observes a pass or a fail, whatever the adapter's `interpret` returns. `message` is safe to show a client; `diagnostic` may name validator members and is evaluator material. `pair_sha256` covers the validator bytes the run was given: it is the contract's binding only for the final archive, so a run on the validator core does not give the delivered value. Every copy plan must run the bug case's `runtime` image (`kit_image` at `kit_image_digest`); a plan for another image, such as an adapter's newer kit, answers `adapter_error` before any copy runs. Copies run one at a time in the order clean, buggy, fixed. `validatePair` rejects only when the runner rejects (an uncertain provider outcome, which the caller turns into `needs_reconciliation`) or a callback throws; the records before it have reached `onCopy`, and no further copy runs. A workspace that cannot be removed afterwards changes neither the result nor the rejection: a result names the leftover in `diagnostic`, and a rejection reports it as a Node process warning. The command likewise reports, on stderr, temporary copy results it could not remove, and still prints the result and exits with its code.

## docker runner

`dockerRunner({ resultsDir, image, docker })` creates one container per copy with no network and the plan's CPU and memory limits, places the plan's files at its destinations through `docker cp` from a tar stream (each file's hash checked first; a mismatch is `setup_failed`), runs the command, kills it at the time limit (`timed_out`), and copies the results directory back into a fresh directory under `resultsDir` with its `results_sha256`. A plan with a pinned digest runs only that digest and its copy reports the pin as `image_digest`: the daemon's `reference@digest` when it resolves, otherwise the image under the reference when its image ID is the pin (a locally built kit) or one of its repository digests is; any other image is `setup_failed`. A plan without a pin runs its reference. `image` names a local image to run in place of the reference: for a pinned plan it runs only when that image's ID or one of its repository digests is the pin (any other image is `setup_failed`, so an override cannot run another runtime than the bug case's), and for a plan without a pin the copy reports the image ID that ran. It needs no bind mount, so it works from inside a container that can reach a Docker daemon.

## Host registry

`REGISTRATIONS` in `src/registry.ts` lists the real hosts as `{ host_id, label, description, license, adapter }`, one line each (see [`docs/product/adding-a-host.md`](../../docs/product/adding-a-host.md)); the label and description are the factory's `HOST_PRESENTATION` text. It holds `task-report` (`taskReportAdapter` from `@rbw/host-task-report/adapter`, MIT) and `umami` (`createUmamiAdapter()` from `@rbw/host-umami` on the real pins, which runs the bug case and every copy on its runtime image, MIT).

`@rbw/case-validate/factory-prepare` (`src/factory-prepare.ts`) is the module `case-package prepare` loads for both `--registry` and `--identity`: it exports `HOST_REGISTRY` and `CASE_IDENTITY`, the factory core's `defectId` and `caseId` bound to the criteria catalog version, so a prepared index's `case_id` is the core's. Its `HOST_REGISTRY` is the harness's registry, except that when `RBW_UMAMI_STORE` names a prepared Umami store (see `packages/host-umami/README.md`), its Umami adapter is `createUmamiAdapter({ store })` (`createRealHostRegistry` in `src/registry.ts`). Exporting an Umami case reads that store; without it the export refuses with `store_missing`. Validating exported archives reads no store, so the harness and the worker use the registry without one.

```
[RBW_UMAMI_STORE=<prepared store>] node tools/case-package/src/cli.ts prepare \
  --registry tools/case-validate/src/factory-prepare.ts --identity tools/case-validate/src/factory-prepare.ts \
  (--scan-hook <module> | --no-scan) [--host task-report] --out <dir>
```

## Tests

```
pnpm --filter @rbw/case-validate test
```

The tests use synthetic pairs and the synthetic host, plus one in-memory export of the task-report catalog entry from this repository's files, which checks that `CASE_IDENTITY` gives the factory core's case ID, and a check that `RBW_UMAMI_STORE` gives the prepare registry's Umami adapter its store. The end-to-end test runs the synthetic copy driver as local Node processes; the docker runner's tests use a fake docker command. No test starts a container or uses the network.
