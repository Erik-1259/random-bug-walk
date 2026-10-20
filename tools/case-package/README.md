# @rbw/case-package

The exporter for a case's two package parts, the bug case (`rbw-bug-case/1`) and the validator package (`rbw-validator/1`), defined in [`docs/product/bug-package-v1.md`](../../docs/product/bug-package-v1.md). It runs under Node 24 directly, with no build step.

## Entry points

| Import | Contents | File system or processes |
|---|---|---|
| `@rbw/case-package` | `exportCase`, the prepared directory (`writePrepared`, `readPreparedIndex`, `readPreparedObject`), manifest readers, patch application, `resultsSha256`, `runPrepareCli`, and everything below | yes (Node) |
| `@rbw/case-package/format` | Format constants, manifest shapes, `pairSha256`, `packageFilename`, the prepared index shape, `CaseIdentity` | no |
| `@rbw/case-package/assembly` | `assembleFinalValidator(core, evidence)`: the final validator archive, in memory | no |
| `@rbw/case-package/synthetic` | The synthetic host: `buildSyntheticPair`, `buildMismatchedSyntheticPair`, `syntheticAdapter`, `syntheticEntry`, `syntheticIdentity`, `syntheticPairInput` | only the adapter's input methods and `collect` |

The format, assembly and synthetic pair builder import no runner, no child process and no Docker code, so the web routes and the test mode can use them.

## Exporting

```ts
import { exportCase, writePrepared } from "@rbw/case-package";

const prepared = await exportCase({ adapter, entry, identity, license: "MIT", scan });
await writePrepared(outDir, [prepared]);
```

`identity` is the factory's identity functions (`CaseIdentity`: `defectId(baseline, entry)` and `caseId(defectId, entry)`); the exporter writes the IDs they return. `scan` is the pre-write scan hook: it receives every member of each part, manifests included, and answers `clean`, `blocked` or `unavailable` (the publication scanner's result shape); `null` exports without a scan and records `scanned: false`. An export is refused (`ExportRefused`, with a code) for inputs that disagree with the entry, unreadable or changed input files, patches that do not reproduce their recorded results on the exported buggy source, a bug case that would carry evaluator material, or a scan that is not clean.

From the command line:

```
node tools/case-package/src/cli.ts prepare --registry <module> --identity <module> --out <dir>
     (--scan-hook <module> | --no-scan) [--host <host_id>]... [--entry <entry_id>]... [--package-version <n>]
```

The registry module exports `HOST_REGISTRY` (`tools/case-validate/src/registry.ts` does), the identity module exports `CASE_IDENTITY`, and the scan hook module exports `SCAN_HOOK`. Exit codes: 0 prepared, 1 refused, 2 error, 64 usage.

## Synthetic host

`buildSyntheticPair({ host_id, seed, defect_seed, failure_code, identity, evidence })` builds one matching pair deterministically: a small synthetic application whose buggy copy undercounts acknowledged changes, its original tests (which miss the bug), a verification check and a copy driver. Entries with the same `defect_seed` share one defect. Without `identity` it uses `syntheticIdentity`, which is a stand-in and not the factory's formula. `buildMismatchedSyntheticPair` returns a bug case with a validator bound to another bug case. Everything it builds is labeled synthetic.

## Tests

```
pnpm --filter @rbw/case-package test
```

The tests build archives in memory or in their own temporary directories; they start no container and use no network.
