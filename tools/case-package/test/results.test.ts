import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resultsSha256 } from "../src/results.ts";

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "case-package-results-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function tree(name: string, order: "forward" | "reverse"): Promise<string> {
  const root = join(workdir, name);
  await mkdir(join(root, "copy"), { recursive: true });
  const files: [string, string][] = [["copy/records.json", "{}\n"], ["summary.txt", "ok\n"], ["copy/log.txt", "line\n"]];
  for (const [path, content] of order === "forward" ? files : [...files].reverse()) {
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("resultsSha256", () => {
  it("depends on the paths and contents only, not on creation order or modification times", async () => {
    const first = await tree("a", "forward");
    const second = await tree("b", "reverse");
    await utimes(join(second, "summary.txt"), new Date(1_000_000), new Date(1_000_000));
    expect(await resultsSha256(second)).toBe(await resultsSha256(first));
  });

  it("changes when a file changes or a file is added", async () => {
    const root = await tree("a", "forward");
    const before = await resultsSha256(root);
    await writeFile(join(root, "summary.txt"), "changed\n");
    const changed = await resultsSha256(root);
    expect(changed).not.toBe(before);
    await writeFile(join(root, "extra.txt"), "");
    expect(await resultsSha256(root)).not.toBe(changed);
  });

  it("records a symbolic link by its target without following it", async () => {
    const root = await tree("a", "forward");
    await symlink("/nonexistent/target", join(root, "link"));
    const first = await resultsSha256(root);
    await rm(join(root, "link"));
    await symlink("/other/target", join(root, "link"));
    expect(await resultsSha256(root)).not.toBe(first);
  });
});
