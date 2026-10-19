import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackArchive } from "@rbw/case-package";
import { buildSyntheticPair } from "@rbw/case-package/synthetic";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PairRefused, verifyPair } from "../src/verify.ts";
import { buildWorkspace } from "../src/workspace.ts";
import { editManifest, replaceMember, sha, text } from "./support.ts";

let parent: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "case-validate-workspace-"));
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

async function refusal(promise: Promise<unknown>): Promise<PairRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PairRefused) return error;
    throw error;
  }
  throw new Error("the workspace was built");
}

describe("buildWorkspace", () => {
  it("unpacks each part into its own fresh directory and rebuilds clean and fixed from the exported buggy source", async () => {
    const pair = buildSyntheticPair({ evidence: null });
    const workspace = await buildWorkspace(verifyPair(pair.bug_case.bytes, pair.validator.bytes), parent);
    const { unpacked } = workspace;
    const source = unpackArchive(pair.bug_case.bytes).filter((member) => member.path.startsWith("source/"));
    // Buggy is the exported source, byte for byte.
    expect(unpacked.states.buggy.files).toEqual(source.map((member) => ({ path: member.path.slice("source/".length), sha256: sha(member.bytes) })));
    for (const file of unpacked.states.buggy.files) {
      expect(sha(await readFile(join(unpacked.states.buggy.root, file.path)))).toBe(file.sha256);
    }
    // Clean and fixed differ from buggy only at the planted target, where they hold the recorded results.
    const [target] = pair.entry.plant.targets;
    if (target === undefined) throw new Error("no target");
    for (const state of ["clean", "fixed"] as const) {
      const tree = unpacked.states[state];
      for (const file of tree.files) {
        const buggy = unpacked.states.buggy.files.find((entry) => entry.path === file.path);
        if (file.path === target.path) {
          expect(file.sha256, state).toBe(target.before_sha256);
          expect(buggy?.sha256).toBe(target.after_sha256);
        } else {
          expect(file.sha256, `${state} ${file.path}`).toBe(buggy?.sha256);
        }
        expect(sha(await readFile(join(tree.root, file.path)))).toBe(file.sha256);
      }
    }
    expect(unpacked.states.fixed.files.find((file) => file.path === target.path)?.sha256).toBe(pair.entry.reference_repair.result_sha256[0]?.sha256);
    const roots = [unpacked.states.clean.root, unpacked.states.buggy.root, unpacked.states.fixed.root, unpacked.evaluator.root];
    expect(new Set(roots).size).toBe(4);
    expect(unpacked.evaluator.files.length).toBeGreaterThan(0);
    for (const file of unpacked.evaluator.files) expect(sha(await readFile(join(unpacked.evaluator.root, file.path)))).toBe(file.sha256);
    expect(unpacked.protocol.protocol_id).toBe(pair.entry.verification.protocol_id);
    expect(unpacked.pair_sha256).toBe(pair.pair_sha256);
    await workspace.dispose();
    await expect(access(workspace.root)).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });

  it("applies the reference repair to the exported buggy source, not to a clean copy", async () => {
    // The synthetic repair's context lines hold the planted line, so it applies only to the buggy file.
    const pair = buildSyntheticPair({ evidence: null });
    expect(pair.entry.reference_repair.patch).toContain(`-${pair.entry.plant.patch.split("\n").find((line) => line.startsWith("+") && !line.startsWith("+++"))?.slice(1) ?? "?"}`);
    const workspace = await buildWorkspace(verifyPair(pair.bug_case.bytes, pair.validator.bytes), parent);
    const fixed = workspace.unpacked.states.fixed.files.find((file) => file.path === pair.entry.plant.targets[0]?.path);
    expect(fixed?.sha256).toBe(pair.entry.reference_repair.result_sha256[0]?.sha256);
    await workspace.dispose();
  });

  it("refuses a repair whose result does not match its recorded hash, and leaves no workspace behind", async () => {
    const pair = buildSyntheticPair({ evidence: null });
    const edited = editManifest(pair.validator.bytes, "validator.json", (manifest) => {
      const repair = manifest.reference_repair as { result_sha256: { path: string; sha256: string }[] };
      repair.result_sha256 = repair.result_sha256.map((item) => ({ ...item, sha256: "0".repeat(64) }));
    });
    const error = await refusal(buildWorkspace(verifyPair(pair.bug_case.bytes, edited), parent));
    expect(error.code).toBe("export_mismatch");
    expect(error.message).not.toMatch(/counter|src\//);
    expect(await readdir(parent)).toEqual([]);
  });

  it("refuses a repair that changes paths other than the recorded ones", async () => {
    const pair = buildSyntheticPair({ evidence: null });
    const edited = editManifest(pair.validator.bytes, "validator.json", (manifest) => {
      const repair = manifest.reference_repair as { result_sha256: { path: string; sha256: string }[] };
      repair.result_sha256 = [...repair.result_sha256, { path: "zzz/other.js", sha256: "0".repeat(64) }];
    });
    expect((await refusal(buildWorkspace(verifyPair(pair.bug_case.bytes, edited), parent))).code).toBe("export_mismatch");
  });

  it("refuses a clean reconstruction whose result does not match its recorded hash", async () => {
    const pair = buildSyntheticPair({ evidence: null });
    const edited = editManifest(pair.validator.bytes, "validator.json", (manifest) => {
      const reconstruction = manifest.clean_reconstruction as { result_sha256: { path: string; sha256: string }[] };
      reconstruction.result_sha256 = reconstruction.result_sha256.map((item) => ({ ...item, sha256: "0".repeat(64) }));
    });
    expect((await refusal(buildWorkspace(verifyPair(pair.bug_case.bytes, edited), parent))).code).toBe("export_mismatch");
  });

  it("refuses a repair that does not apply to the exported buggy source", async () => {
    const pair = buildSyntheticPair({ evidence: null });
    const patch = "diff --git a/src/counter.js b/src/counter.js\n--- a/src/counter.js\n+++ b/src/counter.js\n@@ -1,1 +1,1 @@\n-no such line\n+other line\n";
    const replaced = replaceMember(pair.validator.bytes, "validator.json", "repair/reference.patch", text(patch));
    const edited = editManifest(replaced, "validator.json", (manifest) => {
      (manifest.reference_repair as { patch_sha256: string }).patch_sha256 = sha(text(patch));
    });
    expect((await refusal(buildWorkspace(verifyPair(pair.bug_case.bytes, edited), parent))).code).toBe("export_mismatch");
  });
});
