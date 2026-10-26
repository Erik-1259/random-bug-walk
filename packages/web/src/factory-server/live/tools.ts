// Two Node modules live mode loads by name at run time: the package tooling's root entry (the
// prepared directory reads, the archive reader and the manifest parser) and the controller's local
// worker backend. Their own process code (the package tooling's git patching, the local runner's
// drivers) passes child environments that the Next.js ProcessEnv type rejects, so this app's type
// check must not take them in; the interfaces below are the parts live mode calls, and the live
// test's own type check (test/factory-live) holds the real modules to them. The bundler leaves both
// imports to Node: the package tooling is a server external package, and the local backend runs only
// in a local server, never on a deployment.
import type { PreparedIndex } from "@rbw/case-package/format";
import type { FactoryLog, WorkerSandboxSdk } from "@rbw/controller/factory-web";
import type { Protocol } from "@rbw/factory-contract";

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

export async function packageTools(): Promise<PackageTools> {
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ PACKAGE_TOOLS)) as PackageTools;
}

export async function localBackend(): Promise<LocalBackend> {
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ LOCAL_BACKEND)) as LocalBackend;
}
