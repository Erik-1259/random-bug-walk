// The Node modules live mode loads by name at run time, so the bundler leaves them to Node (as
// src/records.ts does for the record packages): the host registry, whose task-report adapter reads
// its catalog and baseline files next to its sources; the package tooling's root entry (the prepared
// directory reads, the archive reader and the manifest parser); and the controller's local worker
// backend, which runs only in a local server. The last two are also kept out of this app's type
// check: their process code (the package tooling's git patching, the local runner's drivers) passes
// child environments that the Next.js ProcessEnv type rejects. The interfaces below are the parts
// live mode calls, and the live test's own type check (test/factory-live) holds the real modules to
// them.
import type { PreparedIndex } from "@rbw/case-package/format";
import type { FactoryLog, WorkerSandboxSdk } from "@rbw/controller/factory-web";
import type { Protocol } from "@rbw/factory-contract";
import type { HostRegistry } from "@rbw/case-validate/registry";

/** The package tooling's root entry, as live mode calls it. */
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

export const PACKAGE_TOOLS = "@rbw/case-package";
export const LOCAL_BACKEND = "@rbw/controller/factory-local";

export async function hostRegistry(): Promise<HostRegistry> {
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "@rbw/case-validate/registry")).HOST_REGISTRY;
}

export async function packageTools(): Promise<PackageTools> {
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ PACKAGE_TOOLS)) as PackageTools;
}

export async function localBackend(): Promise<LocalBackend> {
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ LOCAL_BACKEND)) as LocalBackend;
}
