import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProbeSet } from "@rbw/shapes";
import { CodeStateRefusal, applyPatchChecked, deriveCodeStates, loadAlternativeFix, stateForPatch } from "../../src/code-states.ts";
import {
  ALTERNATIVE,
  CLEAN,
  MUTATION_PATCH,
  PARTIAL,
  PLANTED,
  STUB,
  TARGET,
  sha256,
  writeAlternativeDir,
  writeProbeDir,
} from "../support/synthetic.ts";

function derive(probeDir = writeProbeDir(), alternativeDir = writeAlternativeDir()) {
  return deriveCodeStates(Buffer.from(CLEAN), loadProbeSet(probeDir), loadAlternativeFix(alternativeDir));
}

function refusal(run: () => unknown): CodeStateRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof CodeStateRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("code states applied on the trusted side", () => {
  it("derives every state's bytes and hashes from the clean file and the probe patches", () => {
    const states = derive();
    expect(states.get("clean")?.bytes.toString()).toBe(CLEAN);
    expect(states.get("planted")?.bytes.toString()).toBe(PLANTED);
    expect(states.get("partial")?.bytes.toString()).toBe(PARTIAL);
    expect(states.get("stub")?.bytes.toString()).toBe(STUB);
    expect(states.get("alternative_fix")?.bytes.toString()).toBe(ALTERNATIVE);
    expect(states.get("planted")?.sha256).toBe(sha256(PLANTED));
    expect(states.get("planted")?.patch_sha256).toBe(sha256(MUTATION_PATCH));
    expect(states.get("clean")?.patch_sha256).toBeNull();
    expect(states.get("alternative_fix")?.code_state).toBe("fixed");
  });

  it("gives the fixed state the clean file's exact bytes, by reversing the mutation on the planted file", () => {
    const states = derive();
    const fixed = states.get("fixed");
    expect(fixed?.bytes.equals(Buffer.from(CLEAN))).toBe(true);
    expect(fixed?.sha256).toBe(sha256(CLEAN));
    expect(fixed?.patch_text).toContain(`-  return range(unit);\n+  return range(unit, zone);`);
    expect(fixed?.declared_mutation).toBeNull();
  });

  it("refuses when the reversed mutation does not reproduce the recorded clean file", () => {
    const error = refusal(() => derive(writeProbeDir({ fixedResultSha256: sha256("not the clean file") })));
    expect(error.reason).toBe("fixed_not_clean");
  });

  it("refuses a clean file whose hash is not the recorded base", () => {
    const error = refusal(() => deriveCodeStates(Buffer.from(`${CLEAN}// changed\n`), loadProbeSet(writeProbeDir()), loadAlternativeFix(writeAlternativeDir())));
    expect(error.reason).toBe("base_hash_mismatch");
  });

  it("refuses a patch applied to a base with the wrong hash", () => {
    const error = refusal(() =>
      applyPatchChecked(Buffer.from(CLEAN), MUTATION_PATCH, { target: TARGET, base_sha256: sha256("another base"), result_sha256: sha256(PLANTED) }),
    );
    expect(error.reason).toBe("base_hash_mismatch");
  });

  it("refuses a patch whose result does not have the recorded hash", () => {
    const error = refusal(() => derive(writeProbeDir({ partialResultSha256: sha256("another result") })));
    expect(error.reason).toBe("result_hash_mismatch");
  });

  it("refuses a patch that touches another file, before applying anything", () => {
    const other = MUTATION_PATCH.replaceAll(TARGET, "src/other.ts");
    const error = refusal(() => applyPatchChecked(Buffer.from(CLEAN), other, { target: TARGET, base_sha256: sha256(CLEAN), result_sha256: sha256(PLANTED) }));
    expect(error.reason).toBe("patch_scope");
  });

  it("refuses a patch that also changes a second file", () => {
    const second = `${MUTATION_PATCH}${MUTATION_PATCH.replaceAll(TARGET, "src/other.ts")}`;
    const error = refusal(() => derive(writeProbeDir({ mutationPatch: second })));
    expect(error.reason).toBe("patch_scope");
  });

  it("declares each changed state's mutation against the clean file, for the projection audit", () => {
    const states = derive();
    const partial = JSON.parse(states.get("partial")?.declared_mutation ?? "null") as {
      diff: string;
      files: { mode: string; original_sha256: string; path: string; result_sha256: string }[];
      host_commit: string;
    };
    expect(partial.files).toEqual([{ mode: "100644", original_sha256: sha256(CLEAN), path: TARGET, result_sha256: sha256(PARTIAL) }]);
    expect(partial.diff.startsWith(`diff --git a/${TARGET} b/${TARGET}\n--- a/${TARGET}\n+++ b/${TARGET}\n@@ `)).toBe(true);
    expect(partial.diff).toContain("-  return range(unit, zone);\n+  return range(unit, zone === 'Pacific/Auckland' ? zone : 'UTC');");
    const planted = JSON.parse(states.get("planted")?.declared_mutation ?? "null") as { diff: string };
    expect(planted.diff).toBe(MUTATION_PATCH);
    expect(states.get("clean")?.declared_mutation).toBeNull();
  });

  it("maps a trial's code state and patch hash to exactly one derived state", () => {
    const states = derive();
    expect(stateForPatch(states, "clean", null)?.key).toBe("clean");
    expect(stateForPatch(states, "fixed", states.get("fixed")?.patch_sha256 ?? null)?.key).toBe("fixed");
    expect(stateForPatch(states, "fixed", states.get("alternative_fix")?.patch_sha256 ?? null)?.key).toBe("alternative_fix");
    expect(stateForPatch(states, "planted", sha256("unknown patch"))).toBeNull();
    expect(stateForPatch(states, "partial", states.get("stub")?.patch_sha256 ?? null)).toBeNull();
  });
});

describe("the committed alternative fix", () => {
  const dir = join(import.meta.dirname, "..", "..", "probes");

  it("is one hunk on the target file, based on the planted file the shapes package records", () => {
    const alternative = loadAlternativeFix(dir);
    const probes = loadProbeSet(join(import.meta.dirname, "..", "..", "..", "..", "packages", "shapes", "probes", "dt-1.tz-arg"));
    expect(alternative.target_path).toBe(probes.data.target_path);
    expect(alternative.base_sha256).toBe(probes.data.planted_sha256);
    expect(alternative.result_sha256).not.toBe(probes.data.clean_sha256);
    const patch = readFileSync(join(dir, "alternative-fix.patch"), "utf8");
    const mutation = probes.patches.get("mutation") ?? "";
    const plantedLine = mutation.split("\n").find((line) => line.startsWith("+ ") || line.startsWith("+\t") || /^\+\s/.test(line));
    expect(patch).toContain(`-${plantedLine?.slice(1) ?? "missing"}`);
    expect(patch.match(/^@@ /gm)).toHaveLength(1);
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
  });
});
