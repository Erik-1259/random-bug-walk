import { syntheticAdapter } from "@rbw/case-package/synthetic";
import { HOST_PRESENTATION } from "@rbw/factory";
import { taskReportAdapter } from "@rbw/host-task-report/adapter";
import { createUmamiAdapter } from "@rbw/host-umami";
import { describe, expect, it } from "vitest";
import { createHostRegistry, HOST_REGISTRY, RegistryError } from "../src/registry.ts";

const registration = (host_id: "task-report" | "umami") => ({
  host_id,
  label: `Synthetic ${host_id}`,
  description: "A synthetic host for tests.",
  license: "MIT",
  adapter: syntheticAdapter({ host_id, workdir: "/synthetic/unused" }),
});

describe("createHostRegistry", () => {
  it("resolves a host ID to its registration and lists hosts in a fixed order", () => {
    const registry = createHostRegistry([registration("umami"), registration("task-report")]);
    expect(registry.get("umami")?.adapter.host_id).toBe("umami");
    expect(registry.list().map((item) => item.host_id)).toEqual(["task-report", "umami"]);
    expect(Object.keys(registry.adapters()).sort()).toEqual(["task-report", "umami"]);
  });

  it("answers null for a host that is not registered", () => {
    expect(createHostRegistry([registration("task-report")]).get("umami")).toBeNull();
  });

  it("refuses a host registered twice or an adapter for another host", () => {
    expect(() => createHostRegistry([registration("umami"), registration("umami")])).toThrow(RegistryError);
    expect(() => createHostRegistry([{ ...registration("umami"), host_id: "task-report" }])).toThrow(RegistryError);
  });

  it("registers the task-report host with the factory's presentation text, its license and its adapter", () => {
    expect(HOST_REGISTRY.list().map((item) => item.host_id)).toEqual(["task-report", "umami"]);
    const taskReport = HOST_REGISTRY.get("task-report");
    expect(taskReport?.adapter).toBe(taskReportAdapter);
    expect(taskReport?.label).toBe(HOST_PRESENTATION["task-report"].label);
    expect(taskReport?.description).toBe(HOST_PRESENTATION["task-report"].description);
    expect(taskReport?.license).toBe("MIT");
    expect(HOST_REGISTRY.adapters()["task-report"]).toBe(taskReportAdapter);
  });

  it("registers the umami host with the factory's presentation text, its license and the adapter on the real pins", () => {
    const umami = HOST_REGISTRY.get("umami");
    expect(umami?.adapter.host_id).toBe("umami");
    expect(umami?.label).toBe(HOST_PRESENTATION.umami.label);
    expect(umami?.description).toBe(HOST_PRESENTATION.umami.description);
    expect(umami?.license).toBe("MIT");
    expect(umami?.adapter.catalog()).toEqual(createUmamiAdapter().catalog());
    expect(HOST_REGISTRY.adapters().umami).toBe(umami?.adapter);
  });
});
