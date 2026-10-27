// The modules live mode calls at run time. A deployment's function holds only the files the build
// traced, so the host registry and the package tooling are imports the bundler sees and builds into
// the factory routes, never modules that Node would resolve by name:
// - the host registry, loaded on first use, so a registry that fails to load leaves live mode without
//   hosts instead of failing every route. Its task-report adapter reads its catalog, baseline and
//   protocol files next to its sources, which a bundled copy cannot do, so the build replaces that
//   adapter with its read-only part frozen at build time (next.config.ts, task-report-frozen.ts),
//   which is all the web calls;
// - the package tooling's prepared directory reads, archive reader and manifest parser, through
//   their own subpath entries (the root entry also holds the exporter's process code).
// The controller's local worker backend runs only in a local server, so it stays loaded by name and
// the bundler leaves it to Node. It is also kept out of this app's type check: its process code (the
// local runner's drivers) passes child environments that the Next.js ProcessEnv type rejects. The
// interface below is the part live mode calls, and the live test's own type check (test/factory-live)
// holds the real module to it.
import { unpackArchive } from "@rbw/case-package/archive";
import type { PreparedIndex } from "@rbw/case-package/format";
import { parseValidatorManifest } from "@rbw/case-package/manifest";
import type { HostRegistry } from "@rbw/case-validate/registry";
import type { FactoryLog, WorkerSandboxSdk } from "@rbw/controller/factory-web";
import type { Protocol } from "@rbw/factory-contract";

/** The package tooling's calls, as live mode makes them. */
export interface PackageTools {
  readPreparedIndex: (dir: string) => Promise<PreparedIndex>;
  /** Checks the bytes against the object's name. */
  readPreparedObject: (dir: string, sha256: string) => Promise<Uint8Array>;
  unpackArchive: (bytes: Uint8Array) => { path: string; bytes: Uint8Array }[];
  parseValidatorManifest: (bytes: Uint8Array) => { protocol: Protocol };
}

/** The controller's local worker backend: worker sandboxes as child processes of this server. */
export interface LocalBackend {
  LOCAL_WORKER_IMAGE: string;
  PACKAGES_DIR_VARIABLE: string;
  localWorkerSandbox: (input: { repoRoot: string; env: Record<string, string>; log: FactoryLog }) => WorkerSandboxSdk;
}

export const LOCAL_BACKEND = "@rbw/controller/factory-local";

type PreparedReads = Pick<PackageTools, "readPreparedIndex" | "readPreparedObject">;
const PREPARED_READS = "@rbw/case-package/prepared";

export async function hostRegistry(): Promise<HostRegistry> {
  return (await import("@rbw/case-validate/registry")).HOST_REGISTRY;
}

export async function packageTools(): Promise<PackageTools> {
  // Named through a constant, so this app's type check does not follow it into the prepared directory
  // module, whose exporter types reach process code that the Next.js ProcessEnv type rejects; the
  // bundler resolves the constant and builds the module in.
  const { readPreparedIndex, readPreparedObject } = (await import(PREPARED_READS)) as PreparedReads;
  return { readPreparedIndex, readPreparedObject, unpackArchive, parseValidatorManifest };
}

export async function localBackend(): Promise<LocalBackend> {
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ LOCAL_BACKEND)) as LocalBackend;
}
