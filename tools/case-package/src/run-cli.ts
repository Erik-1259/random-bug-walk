// `case-package prepare`: exports catalog entries from a host registry into a prepared directory.
// The registry, the identity functions and the scan hook are modules named on the command line, so this
// package depends on none of them (the registry lives with the harness, the identity with the factory).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CatalogEntry, HostAdapter, HostId } from "@rbw/factory-contract";
import { exportCase, ExportRefused, type PreparedCase, type ScanHook } from "./export.ts";
import type { CaseIdentity } from "./format.ts";
import { writePrepared } from "./prepared.ts";

export const PREPARE_EXIT_CODES = { prepared: 0, refused: 1, error: 2, usage: 64 } as const;

export const PREPARE_USAGE = `usage: case-package prepare --registry <module> --identity <module> --out <dir>
                            (--scan-hook <module> | --no-scan) [--host <host_id>]... [--entry <entry_id>]...
                            [--package-version <n>]
  --registry   a module exporting HOST_REGISTRY (list() of { host_id, license, adapter })
  --identity   a module exporting CASE_IDENTITY ({ defectId, caseId }), the factory's identity functions
  --scan-hook  a module exporting SCAN_HOOK, run on every member before anything is written
  --no-scan    export without a scan; the index records scanned: false
`;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

const defaultLoader: ModuleLoader = async (specifier) => (await import(pathToFileURL(resolve(specifier)).href)) as Record<string, unknown>;

interface ExportHost {
  host_id: HostId;
  license: string;
  adapter: HostAdapter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hostsOf(module: Record<string, unknown>): ExportHost[] {
  const registry = module.HOST_REGISTRY;
  if (!isRecord(registry) || typeof registry.list !== "function") throw new Error("the registry module does not export HOST_REGISTRY with list()");
  const hosts = (registry.list as () => unknown)();
  if (!Array.isArray(hosts)) throw new Error("HOST_REGISTRY.list() did not return a list");
  return hosts.map((host: unknown) => {
    if (!isRecord(host) || typeof host.host_id !== "string" || typeof host.license !== "string" || !isRecord(host.adapter)) {
      throw new Error("HOST_REGISTRY lists a malformed host");
    }
    return host as unknown as ExportHost;
  });
}

function identityOf(module: Record<string, unknown>): CaseIdentity {
  const identity = module.CASE_IDENTITY;
  if (!isRecord(identity) || typeof identity.defectId !== "function" || typeof identity.caseId !== "function") {
    throw new Error("the identity module does not export CASE_IDENTITY with defectId and caseId");
  }
  return identity as unknown as CaseIdentity;
}

function scanHookOf(module: Record<string, unknown>): ScanHook {
  const hook = module.SCAN_HOOK;
  if (typeof hook !== "function") throw new Error("the scan hook module does not export SCAN_HOOK");
  return hook as ScanHook;
}

export async function runPrepareCli(argv: readonly string[], io: Io, load: ModuleLoader = defaultLoader): Promise<number> {
  let values;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        registry: { type: "string" },
        identity: { type: "string" },
        out: { type: "string" },
        "scan-hook": { type: "string" },
        "no-scan": { type: "boolean" },
        host: { type: "string", multiple: true },
        entry: { type: "string", multiple: true },
        "package-version": { type: "string" },
      },
    });
    values = parsed.values;
    const [command, ...rest] = parsed.positionals;
    const scanChoices = Number(values["scan-hook"] !== undefined) + Number(values["no-scan"] === true);
    if (command !== "prepare" || rest.length > 0 || values.registry === undefined || values.identity === undefined || values.out === undefined || scanChoices !== 1) {
      throw new Error("usage");
    }
    if (values["package-version"] !== undefined && !/^[1-9][0-9]*$/.test(values["package-version"])) throw new Error("usage");
  } catch {
    io.stderr(PREPARE_USAGE);
    return PREPARE_EXIT_CODES.usage;
  }
  const out = values.out;
  try {
    const hosts = hostsOf(await load(values.registry));
    const identity = identityOf(await load(values.identity));
    const scan = values["scan-hook"] === undefined ? null : scanHookOf(await load(values["scan-hook"]));
    const wantedHosts = new Set(values.host ?? hosts.map((host) => host.host_id));
    const wantedEntries = values.entry === undefined ? null : new Set(values.entry);
    const selected: { host: ExportHost; entry: CatalogEntry }[] = [];
    for (const host of hosts.filter((item) => wantedHosts.has(item.host_id))) {
      for (const entry of host.adapter.catalog()) {
        if (wantedEntries === null || wantedEntries.has(entry.entry_id)) selected.push({ host, entry });
      }
    }
    const missingHosts = [...wantedHosts].filter((id) => !hosts.some((host) => host.host_id === id));
    const missingEntries = wantedEntries === null ? [] : [...wantedEntries].filter((id) => !selected.some((item) => item.entry.entry_id === id));
    if (missingHosts.length > 0 || missingEntries.length > 0 || selected.length === 0) {
      io.stderr(`nothing to prepare: unknown hosts [${missingHosts.join(", ")}], unknown entries [${missingEntries.join(", ")}]\n`);
      return PREPARE_EXIT_CODES.usage;
    }
    const cases: PreparedCase[] = [];
    for (const { host, entry } of selected) {
      cases.push(await exportCase({
        adapter: host.adapter,
        entry,
        identity,
        license: host.license,
        scan,
        ...(values["package-version"] === undefined ? {} : { package_version: Number(values["package-version"]) }),
      }));
    }
    const index = await writePrepared(out, cases);
    for (const item of cases) {
      io.stdout(`${item.host_id} ${item.entry_id} case ${item.case_id} bug-case ${item.bug_case.sha256} validator-core ${item.validator_core.sha256}${item.scanned ? "" : " (not scanned)"}\n`);
    }
    io.stdout(`index: ${String(index.entries.length)} entries in ${out}\n`);
    return PREPARE_EXIT_CODES.prepared;
  } catch (error) {
    if (error instanceof ExportRefused) {
      io.stderr(`${error.message}\n`);
      return PREPARE_EXIT_CODES.refused;
    }
    io.stderr(`case-package: ${error instanceof Error ? error.message : String(error)}\n`);
    return PREPARE_EXIT_CODES.error;
  }
}
