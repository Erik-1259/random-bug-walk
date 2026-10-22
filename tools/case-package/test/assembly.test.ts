import { createHash } from "node:crypto";
import { encodeCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { packArchive, unpackArchive } from "../src/archive.ts";
import { assembleFinalValidator, AssemblyError, inspectValidator } from "../src/assembly.ts";
import { EVIDENCE_PATH } from "../src/format.ts";
import { buildSyntheticPair } from "../src/synthetic.ts";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// The evidence value is illustrative; any canonical JSON value works.
const EVIDENCE = { case_id: "c".repeat(64), copies: [{ copy_id: "synthetic-clean-1", evidence_sha256: "e".repeat(64) }], verdict: "accepted" };

describe("assembleFinalValidator", () => {
  it("adds the evidence member as canonical JSON and keeps every core member byte for byte", () => {
    const { validator_core: core } = buildSyntheticPair({ evidence: null });
    const final = assembleFinalValidator(core.bytes, EVIDENCE);
    const coreMembers = unpackArchive(core.bytes);
    const finalMembers = unpackArchive(final);
    expect(finalMembers.map((member) => member.path).sort()).toEqual([...coreMembers.map((member) => member.path), EVIDENCE_PATH].sort());
    for (const member of coreMembers) {
      const copy = finalMembers.find((entry) => entry.path === member.path);
      expect(copy && Buffer.from(copy.bytes).equals(Buffer.from(member.bytes)), member.path).toBe(true);
    }
    const evidence = finalMembers.find((member) => member.path === EVIDENCE_PATH);
    expect(evidence && Buffer.from(evidence.bytes).equals(Buffer.from(encodeCanonical(EVIDENCE)))).toBe(true);
  });

  it("gives the same bytes when the evidence comes back with its keys reordered", () => {
    const { validator_core: core } = buildSyntheticPair({ evidence: null });
    const reordered = JSON.parse(JSON.stringify({ verdict: EVIDENCE.verdict, copies: EVIDENCE.copies, case_id: EVIDENCE.case_id })) as unknown;
    expect(sha(assembleFinalValidator(core.bytes, reordered))).toBe(sha(assembleFinalValidator(core.bytes, EVIDENCE)));
  });

  it("matches the recorded golden hash, so every platform assembles the same bytes", () => {
    const { validator_core: core } = buildSyntheticPair({ host_id: "task-report", seed: "golden", evidence: null });
    expect(core.sha256).toBe(GOLDEN.core);
    expect(sha(assembleFinalValidator(core.bytes, EVIDENCE))).toBe(GOLDEN.final);
  });

  it("refuses a core that already holds evidence, a bug case and a core whose files do not match its manifest", () => {
    const pair = buildSyntheticPair({ evidence: EVIDENCE });
    expect(() => assembleFinalValidator(pair.validator.bytes, EVIDENCE)).toThrow(AssemblyError);
    expect(() => assembleFinalValidator(pair.bug_case.bytes, EVIDENCE)).toThrow(AssemblyError);
    const tampered = unpackArchive(pair.validator_core.bytes).map((member) =>
      member.path.startsWith("checks/") ? { path: member.path, bytes: new TextEncoder().encode("changed") } : member,
    );
    expect(() => assembleFinalValidator(packArchive(tampered), EVIDENCE)).toThrow(AssemblyError);
  });

  it("refuses evidence outside canonical JSON", () => {
    const { validator_core: core } = buildSyntheticPair({ evidence: null });
    expect(() => assembleFinalValidator(core.bytes, { ratio: 0.5 })).toThrow(AssemblyError);
    expect(() => assembleFinalValidator(core.bytes, undefined)).toThrow(AssemblyError);
  });
});

describe("inspectValidator", () => {
  it("reads back the core and the evidence member of a final validator", () => {
    const { validator_core: core } = buildSyntheticPair({ evidence: null });
    const final = assembleFinalValidator(core.bytes, EVIDENCE);
    expect(inspectValidator(final)).toEqual({ core_sha256: sha(core.bytes), evidence_sha256: sha(encodeCanonical(EVIDENCE)) });
  });

  it("reports a core as its own hash with no evidence", () => {
    const { validator_core: core } = buildSyntheticPair({ evidence: null });
    expect(inspectValidator(core.bytes)).toEqual({ core_sha256: core.sha256, evidence_sha256: null });
  });

  it("gives the recorded golden core back from the golden final validator", () => {
    const { validator_core: core } = buildSyntheticPair({ host_id: "task-report", seed: "golden", evidence: null });
    expect(inspectValidator(assembleFinalValidator(core.bytes, EVIDENCE)).core_sha256).toBe(GOLDEN.core);
  });

  it("gives another core hash when a core member changed, and another evidence hash for other evidence", () => {
    const { validator_core: core } = buildSyntheticPair({ evidence: null });
    const final = unpackArchive(assembleFinalValidator(core.bytes, EVIDENCE));
    const changedCheck = final.map((member) => (member.path.startsWith("checks/") ? { path: member.path, bytes: new TextEncoder().encode("changed") } : member));
    const read = inspectValidator(packArchive(changedCheck));
    expect(read.core_sha256).not.toBeNull();
    expect(read.core_sha256).not.toBe(core.sha256);
    expect(read.evidence_sha256).toBe(sha(encodeCanonical(EVIDENCE)));
    const otherEvidence = inspectValidator(assembleFinalValidator(core.bytes, { ...EVIDENCE, verdict: "rejected" }));
    expect(otherEvidence.core_sha256).toBe(core.sha256);
    expect(otherEvidence.evidence_sha256).not.toBe(sha(encodeCanonical(EVIDENCE)));
  });

  it("answers null for a bug case, an archive without a validator manifest and bytes that are not an archive", () => {
    const pair = buildSyntheticPair({ evidence: EVIDENCE });
    expect(inspectValidator(pair.bug_case.bytes)).toEqual({ core_sha256: null, evidence_sha256: null });
    const evidenceOnly = packArchive([{ path: EVIDENCE_PATH, bytes: encodeCanonical(EVIDENCE) }]);
    expect(inspectValidator(evidenceOnly)).toEqual({ core_sha256: null, evidence_sha256: sha(encodeCanonical(EVIDENCE)) });
    const otherFormat = packArchive([{ path: "validator.json", bytes: encodeCanonical({ format: "rbw-bug-case/1", files: [] }) }]);
    expect(inspectValidator(otherFormat).core_sha256).toBeNull();
    const notJson = packArchive([{ path: "validator.json", bytes: new TextEncoder().encode("{ synthetic: not json") }]);
    expect(inspectValidator(notJson).core_sha256).toBeNull();
    expect(inspectValidator(new TextEncoder().encode("not an archive"))).toEqual({ core_sha256: null, evidence_sha256: null });
  });
});

// Recorded once from the synthetic builder; a change here means the archive bytes changed on this platform.
const GOLDEN = {
  core: "db8981f0cab3c0b46751df31fbeb7043f6d8dd07cdcf63c1c8b3ca6a746907bb",
  final: "91b64ff3919e6d60fc7c8d3d542697d3575e62a6858e5bb29b53cdf351b9464f",
};
