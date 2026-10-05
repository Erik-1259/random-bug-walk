import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT_ID, bigFileBytes, createWorld, printed, publish, sha256, stage, statusObject, write, writeRootRun } from "./support.ts";

describe("a late non-terminal status", () => {
  it("leaves a published status in place and reports the published outcome", async () => {
    const world = createWorld();
    stage(world.staging);
    const first = await publish(world, writeRootRun(world));
    expect(first.code).toBe(0);
    const before = readFileSync(join(world.store, "status", `${ROOT_ID}.json`), "utf8");
    expect(statusObject(world)?.publication_status).toBe("published");

    const late = await publish(world, writeRootRun(world, { status: "running" }));
    expect(late.code).toBe(0);
    expect(printed(late)).toMatchObject({ status: "published" });
    expect(late.stderr).toContain("status not written: root already terminal");
    expect(readFileSync(join(world.store, "status", `${ROOT_ID}.json`), "utf8")).toBe(before);
    expect(statusObject(world)?.publication_status).toBe("published");
  });

  it("leaves a failed status in place and reports the failed outcome", async () => {
    const world = createWorld();
    stage(world.staging);
    write(join(world.store, "sha256", sha256(bigFileBytes())), "different bytes\n");
    const failedRun = await publish(world, writeRootRun(world));
    expect(failedRun.code).toBe(2);
    expect(statusObject(world)?.publication_status).toBe("failed");
    const late = await publish(world, writeRootRun(world, { status: "running" }));
    expect(late.code).toBe(2);
    expect(statusObject(world)?.publication_status).toBe("failed");
  });
});
