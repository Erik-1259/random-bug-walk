import { createHash } from "node:crypto";
import { encodeCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { packArchive, unpackArchive } from "../src/archive.ts";
import { assembleFinalValidator, AssemblyError } from "../src/assembly.ts";
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

// Recorded once from the synthetic builder; a change here means the archive bytes changed on this platform.
const GOLDEN = {
  core: "96e0abdd37a4de176c53910c5305729f412b899845a11990f2a6b9f765f167b4",
  final: "9ed383fc855f71a47f2efb31aed53bb2eabd16b8bb1f165a6ec9dd96fdaf444e",
};
