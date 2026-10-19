import { createHash } from "node:crypto";
import { canonicalDigest } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { unpackArchive } from "../src/archive.ts";
import { BUG_CASE_MANIFEST, packageFilename, pairSha256, VALIDATOR_MANIFEST } from "../src/format.ts";
import { packPair, PackRefused, type PairInput } from "../src/pack.ts";
import { buildMismatchedSyntheticPair, buildSyntheticPair, syntheticPairInput } from "../src/synthetic.ts";

const encoder = new TextEncoder();
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function manifestOf(archive: Uint8Array, name: string): Record<string, unknown> {
  const member = unpackArchive(archive).find((entry) => entry.path === name);
  if (member === undefined) throw new Error(`no ${name}`);
  return JSON.parse(new TextDecoder().decode(member.bytes)) as Record<string, unknown>;
}

function refusal(input: PairInput): PackRefused {
  try {
    packPair(input);
  } catch (error) {
    if (error instanceof PackRefused) return error;
    throw error;
  }
  throw new Error("packPair accepted the input");
}

describe("packPair", () => {
  it("binds the validator core to the exact bug case bytes and both parts to one case", () => {
    const packed = packPair(syntheticPairInput());
    const bugCase = manifestOf(packed.bug_case.bytes, BUG_CASE_MANIFEST);
    const validator = manifestOf(packed.validator_core.bytes, VALIDATOR_MANIFEST);
    expect(validator.bug_case_sha256).toBe(sha(packed.bug_case.bytes));
    expect(packed.bug_case.sha256).toBe(sha(packed.bug_case.bytes));
    expect(packed.validator_core.sha256).toBe(sha(packed.validator_core.bytes));
    for (const key of ["case_id", "defect_id", "package_version", "host_id", "baseline"]) {
      expect(validator[key], key).toEqual(bugCase[key]);
    }
    expect(bugCase.format).toBe("rbw-bug-case/1");
    expect(validator.format).toBe("rbw-validator/1");
  });

  it("puts only the bug case manifest, the source and the incident in the bug case", () => {
    const input = syntheticPairInput();
    const packed = packPair(input);
    const paths = unpackArchive(packed.bug_case.bytes).map((member) => member.path);
    expect(paths.every((path) => path === BUG_CASE_MANIFEST || path.startsWith("source/") || path.startsWith("incident/"))).toBe(true);
    const bugCaseHashes = new Set(unpackArchive(packed.bug_case.bytes).map((member) => sha(member.bytes)));
    for (const check of input.validator.checks) expect(bugCaseHashes.has(sha(check.bytes)), check.path).toBe(false);
    for (const target of input.entry.plant.targets) expect(bugCaseHashes.has(target.before_sha256)).toBe(false);
    for (const result of input.validator.reference_repair.result_sha256) expect(bugCaseHashes.has(result.sha256)).toBe(false);
    const validatorPaths = unpackArchive(packed.validator_core.bytes).map((member) => member.path);
    expect(validatorPaths).toContain("repair/reference.patch");
    expect(validatorPaths).toContain("reconstruction/clean.patch");
    expect(validatorPaths.some((path) => path.startsWith("evidence/"))).toBe(false);
  });

  it("records the clean reconstruction's result as the planted targets' original hashes", () => {
    const input = syntheticPairInput();
    const validator = manifestOf(packPair(input).validator_core.bytes, VALIDATOR_MANIFEST) as {
      clean_reconstruction: { result_sha256: { path: string; sha256: string }[] };
    };
    expect(validator.clean_reconstruction.result_sha256).toEqual(
      input.entry.plant.targets.map((target) => ({ path: target.path, sha256: target.before_sha256 })),
    );
  });

  it("refuses version-control history and evaluator locations in the bug case", () => {
    for (const path of [".git/HEAD", "sub/.git/config", ".hg/store", "evaluator/run.js", "validator/x.json", ".rbw/notes"]) {
      const input = syntheticPairInput();
      input.bug_case.source.push({ path, bytes: encoder.encode(`synthetic ${path}\n`) });
      const error = refusal(input);
      expect(error.code, path).toBe("separation");
    }
  });

  it("refuses a bug case file that is a copy of a validator file", () => {
    const input = syntheticPairInput();
    const check = input.validator.checks[0];
    if (check === undefined) throw new Error("no check");
    input.bug_case.source.push({ path: "docs/notes.js", bytes: check.bytes });
    expect(refusal(input).code).toBe("separation");
  });

  it("refuses a pristine copy of a planted target anywhere in the bug case", () => {
    const input = syntheticPairInput();
    const pristine = input.validator.reference_repair.result_sha256[0];
    if (pristine === undefined) throw new Error("no result");
    // The synthetic repair is a revert, so its result is the original file; ship it under another name.
    const original = cleanBytes(input);
    expect(sha(original)).toBe(pristine.sha256);
    input.bug_case.incident.push({ path: "original.js", bytes: original });
    expect(refusal(input).code).toBe("separation");
  });

  it("refuses verbatim patch text in the bug case", () => {
    for (const patch of ["plant", "repair", "reconstruction"] as const) {
      const input = syntheticPairInput();
      const textOf = patch === "plant" ? input.entry.plant.patch
        : patch === "repair" ? input.validator.reference_repair.patch
        : input.validator.clean_reconstruction.patch;
      input.bug_case.source.push({ path: "notes/changes.txt", bytes: encoder.encode(`before\n${textOf}after\n`) });
      expect(refusal(input).code, patch).toBe("separation");
    }
  });

  it("refuses a source tree that could not be unpacked on every file system", () => {
    const folded = syntheticPairInput();
    folded.bug_case.source.push({ path: "readme.md", bytes: encoder.encode("lower case\n") });
    expect(refusal(folded).code).toBe("inconsistent_inputs");
    const nested = syntheticPairInput();
    nested.bug_case.source.push({ path: "src/counter.js/extra.js", bytes: encoder.encode("nested\n") });
    expect(refusal(nested).code).toBe("inconsistent_inputs");
  });

  it("refuses inputs that disagree with the catalog entry", () => {
    const runtime = syntheticPairInput();
    runtime.bug_case.runtime = { ...runtime.bug_case.runtime, kit_image_digest: `sha256:${"0".repeat(64)}` };
    expect(refusal(runtime).code).toBe("inconsistent_inputs");

    const expected = syntheticPairInput();
    expected.validator.expected = { ...expected.validator.expected, verification: { clean: "pass", buggy: "pass", fixed: "pass" } };
    expect(refusal(expected).code).toBe("inconsistent_inputs");

    const repair = syntheticPairInput();
    repair.validator.reference_repair = { ...repair.validator.reference_repair, patch_sha256: "0".repeat(64) };
    expect(refusal(repair).code).toBe("inconsistent_inputs");

    const reconstruction = syntheticPairInput();
    reconstruction.validator.clean_reconstruction = { ...reconstruction.validator.clean_reconstruction, patch_sha256: "0".repeat(64) };
    expect(refusal(reconstruction).code).toBe("inconsistent_inputs");

    const target = syntheticPairInput();
    target.bug_case.source = target.bug_case.source.map((member) =>
      target.entry.plant.targets.some((entry) => entry.path === member.path) ? { path: member.path, bytes: encoder.encode("changed\n") } : member,
    );
    expect(refusal(target).code).toBe("inconsistent_inputs");

    const protocol = syntheticPairInput();
    protocol.validator.protocol = { ...protocol.validator.protocol, sha256: "0".repeat(64) };
    expect(refusal(protocol).code).toBe("inconsistent_inputs");

    const baseline = syntheticPairInput();
    baseline.baseline = { ...baseline.baseline, host_id: "umami" };
    expect(refusal(baseline).code).toBe("inconsistent_inputs");
  });
});

describe("pairSha256", () => {
  it("is the canonical hash of the two parts' SHA-256 values and the case ID", () => {
    const input = { bug_case_sha256: "1".repeat(64), validator_sha256: "2".repeat(64), case_id: "3".repeat(64) };
    expect(pairSha256(input)).toBe(canonicalDigest(input).sha256);
    expect(pairSha256({ ...input, validator_sha256: "4".repeat(64) })).not.toBe(pairSha256(input));
  });
});

describe("packageFilename", () => {
  it("names a part by its kind, the case ID's first 12 hex digits and the package version, as the contract's fixtures do", () => {
    const caseId = `${"ca".repeat(6)}${"0".repeat(52)}`;
    expect(packageFilename("bug_case", caseId, 1)).toBe("rbw-bug-case-cacacacacaca-v1.tar.gz");
    expect(packageFilename("validator", caseId, 1)).toBe("rbw-validator-cacacacacaca-v1.tar.gz");
    expect(packageFilename("bug_case", caseId, 2)).not.toBe(packageFilename("bug_case", caseId, 1));
  });

  it("gives the synthetic pair's parts those names", () => {
    const pair = buildSyntheticPair({ seed: "01" });
    expect(pair.bug_case.filename).toBe(`rbw-bug-case-${pair.case_id.slice(0, 12)}-v${String(pair.package_version)}.tar.gz`);
    expect(pair.validator.filename).toBe(`rbw-validator-${pair.case_id.slice(0, 12)}-v${String(pair.package_version)}.tar.gz`);
    expect(pair.validator_core.filename).toBe(pair.validator.filename);
  });
});

describe("buildSyntheticPair", () => {
  it("is deterministic: the same options give the same bytes and IDs", () => {
    const first = buildSyntheticPair({ host_id: "umami", seed: "a" });
    const second = buildSyntheticPair({ host_id: "umami", seed: "a" });
    expect(Buffer.from(second.bug_case.bytes).equals(Buffer.from(first.bug_case.bytes))).toBe(true);
    expect(Buffer.from(second.validator.bytes).equals(Buffer.from(first.validator.bytes))).toBe(true);
    expect(second.case_id).toBe(first.case_id);
    expect(first.pair_sha256).toBe(pairSha256({ bug_case_sha256: first.bug_case.sha256, validator_sha256: first.validator.sha256, case_id: first.case_id }));
  });

  it("gives each host and seed its own entry, case and defect", () => {
    const pairs = [
      buildSyntheticPair({ host_id: "task-report", seed: "01" }),
      buildSyntheticPair({ host_id: "task-report", seed: "02" }),
      buildSyntheticPair({ host_id: "umami", seed: "01" }),
    ];
    expect(new Set(pairs.map((pair) => pair.case_id)).size).toBe(3);
    expect(new Set(pairs.map((pair) => pair.defect_id)).size).toBe(3);
    expect(new Set(pairs.map((pair) => pair.bug_case.sha256)).size).toBe(3);
    expect(pairs.map((pair) => pair.host_id)).toEqual(["task-report", "task-report", "umami"]);
  });

  it("shares one defect between two entries built from the same defect seed", () => {
    const first = buildSyntheticPair({ host_id: "task-report", seed: "01", defect_seed: "shared" });
    const second = buildSyntheticPair({ host_id: "task-report", seed: "02", defect_seed: "shared" });
    expect(second.entry_id).not.toBe(first.entry_id);
    expect(second.defect_id).toBe(first.defect_id);
  });

  it("uses the identity functions it is given", () => {
    const pair = buildSyntheticPair({
      identity: { defectId: () => "d".repeat(64), caseId: (defect) => (defect === "d".repeat(64) ? "c".repeat(64) : "0".repeat(64)) },
    });
    expect(pair.defect_id).toBe("d".repeat(64));
    expect(pair.case_id).toBe("c".repeat(64));
    expect(manifestOf(pair.bug_case.bytes, BUG_CASE_MANIFEST).case_id).toBe("c".repeat(64));
  });

  it("delivers a final validator with the evidence member and keeps the core", () => {
    const pair = buildSyntheticPair({ evidence: { synthetic: true } });
    const paths = unpackArchive(pair.validator.bytes).map((member) => member.path);
    expect(paths).toContain("evidence/qualification.json");
    expect(unpackArchive(pair.validator_core.bytes).map((member) => member.path)).not.toContain("evidence/qualification.json");
    const bare = buildSyntheticPair({ evidence: null });
    expect(Buffer.from(bare.validator.bytes).equals(Buffer.from(bare.validator_core.bytes))).toBe(true);
  });
});

describe("buildMismatchedSyntheticPair", () => {
  it("returns a validator that belongs to another bug case", () => {
    const mismatched = buildMismatchedSyntheticPair({ host_id: "task-report", seed: "01" });
    const validator = manifestOf(mismatched.validator.bytes, VALIDATOR_MANIFEST);
    expect(validator.bug_case_sha256).not.toBe(mismatched.bug_case.sha256);
  });
});

function cleanBytes(input: PairInput): Uint8Array {
  // Undo the synthetic plant: the only target's buggy line is replaced by the original line.
  const target = input.entry.plant.targets[0];
  const buggy = input.bug_case.source.find((member) => member.path === target?.path);
  if (buggy === undefined) throw new Error("no buggy target");
  const lines = input.entry.plant.patch.split("\n");
  const removed = lines.find((line) => line.startsWith("-") && !line.startsWith("---"))?.slice(1);
  const added = lines.find((line) => line.startsWith("+") && !line.startsWith("+++"))?.slice(1);
  if (removed === undefined || added === undefined) throw new Error("unexpected synthetic patch");
  return encoder.encode(new TextDecoder().decode(buggy.bytes).replace(added, removed));
}
