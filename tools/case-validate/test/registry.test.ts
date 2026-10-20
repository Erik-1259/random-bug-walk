import { syntheticAdapter } from "@rbw/case-package/synthetic";
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

  it("starts with no real hosts; their lines are added when the host packages land", () => {
    expect(HOST_REGISTRY.list()).toEqual([]);
  });
});
