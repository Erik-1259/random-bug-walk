import { describe, expect, it } from "vitest";
import { createWorld, publish, stage, writeRootRun } from "./support.ts";

describe("branch name components", () => {
  async function withBranch(branch: string): Promise<number> {
    const world = createWorld();
    stage(world.staging);
    return (await publish(world, writeRootRun(world), ["--branch", branch])).code;
  }

  for (const branch of ["foo.lock/bar", ".hidden/x", "a//b", "a/./b", "a/.b/c", "a/b.lock/c"]) {
    it(`rejects ${branch} with exit 4`, async () => {
      expect(await withBranch(branch)).toBe(4);
    });
  }

  for (const branch of ["main", "feat/public-demo", "release-1.2/x.y", "a/b.locked/c"]) {
    it(`accepts ${branch}`, async () => {
      expect(await withBranch(branch)).toBe(0);
    });
  }
});
