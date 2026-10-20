// The host registry: the one place that maps a host_id to its adapter. The harness CLI, the worker and the
// web routes (capabilities, interpretation) read it; it imports no runner, so web routes can import it.
import { HOST_PRESENTATION } from "@rbw/factory";
import type { HostAdapter, HostId } from "@rbw/factory-contract";
import { taskReportAdapter } from "@rbw/host-task-report/adapter";
import { createUmamiAdapter } from "@rbw/host-umami";

export interface HostRegistration {
  host_id: HostId;
  /** The host's label and description, as Capabilities.hosts shows them. */
  label: string;
  description: string;
  /** The host application's license (SPDX identifier), recorded in both package manifests. */
  license: string;
  adapter: HostAdapter;
}

export interface HostRegistry {
  /** Every registration, ordered by host_id. */
  list(): HostRegistration[];
  get(hostId: HostId): HostRegistration | null;
  /** The adapter map validatePair takes. */
  adapters(): Partial<Record<HostId, HostAdapter>>;
}

export class RegistryError extends Error {
  constructor(reason: string) {
    super(`host registry: ${reason}`);
    this.name = "RegistryError";
  }
}

export function createHostRegistry(registrations: readonly HostRegistration[]): HostRegistry {
  const byHost = new Map<HostId, HostRegistration>();
  for (const registration of registrations) {
    if (registration.adapter.host_id !== registration.host_id) throw new RegistryError(`the adapter registered for ${registration.host_id} serves another host`);
    if (byHost.has(registration.host_id)) throw new RegistryError(`${registration.host_id} is registered twice`);
    byHost.set(registration.host_id, registration);
  }
  const ordered = [...byHost.values()].sort((a, b) => (a.host_id < b.host_id ? -1 : 1));
  return {
    list: () => [...ordered],
    get: (hostId) => byHost.get(hostId) ?? null,
    adapters: () => Object.fromEntries(ordered.map((registration) => [registration.host_id, registration.adapter])),
  };
}

/**
 * The real hosts, one line each (see docs/product/adding-a-host.md). The label and description are the
 * factory's presentation text, so capabilities and the registry cannot drift apart. The Umami adapter runs
 * the bug case and every copy on its runtime image (kit/umami-runtime), which holds no app source and no
 * fixture.
 */
const REGISTRATIONS: readonly HostRegistration[] = [
  {
    host_id: "task-report",
    label: HOST_PRESENTATION["task-report"].label,
    description: HOST_PRESENTATION["task-report"].description,
    license: "MIT",
    adapter: taskReportAdapter,
  },
  {
    host_id: "umami",
    label: HOST_PRESENTATION.umami.label,
    description: HOST_PRESENTATION.umami.description,
    license: "MIT",
    adapter: createUmamiAdapter(),
  },
];

export const HOST_REGISTRY: HostRegistry = createHostRegistry(REGISTRATIONS);
