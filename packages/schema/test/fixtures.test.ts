import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { CanonicalError, encodeCanonical, parseCanonical, sha256Hex } from "../src/canonical.ts";
import { fixtureReport, recordErrors, recordVerdict } from "../src/fixtures.ts";
import { fixtureBytes, fixturesDir, fixtureText, readManifest } from "./support.ts";

const manifest = readManifest();

describe("canonical fixtures", () => {
  it("marks every fixture file as binary", () => {
    expect(fixtureText(".gitattributes")).toBe("* -text\n");
  });

  it("covers the required cases", () => {
    const names = manifest.canonical.map((item) => item.name);
    for (const name of ["key-order-nested", "whitespace-crlf", "escapes", "unicode-preserved", "surrogate-pair-emoji", "integer-bounds", "empty-values", "literals"]) {
      expect(names).toContain(name);
    }
    for (const name of ["duplicate-key-top", "duplicate-key-nested", "fraction", "exponent", "nan", "above-max-integer", "non-ascii-key", "lone-high-surrogate", "invalid-utf8", "bom", "trailing-content"]) {
      expect(names).toContain(name);
    }
  });

  for (const item of manifest.canonical) {
    if (item.expect === "valid") {
      it(`reproduces ${item.name}`, () => {
        const expected = fixtureBytes("canonical", `${item.name}.canonical`);
        const output = encodeCanonical(parseCanonical(fixtureBytes("canonical", `${item.name}.input`)));
        expect(Buffer.from(output).equals(expected)).toBe(true);
        expect(sha256Hex(output)).toBe(fixtureText("canonical", `${item.name}.sha256`));
      });
      it(`agrees with the RFC 8785 oracle on ${item.name}`, () => {
        const parsed: unknown = JSON.parse(fixtureText("canonical", `${item.name}.input`));
        expect(canonicalize(parsed)).toBe(fixtureText("canonical", `${item.name}.canonical`));
      });
    } else {
      it(`rejects ${item.name}`, () => {
        expect(() => parseCanonical(fixtureBytes("canonical", `${item.name}.input`))).toThrow(CanonicalError);
      });
    }
  }
});

describe("record fixtures", () => {
  for (const item of manifest.records) {
    it(`${item.name} is ${item.expect} (${item.rule})`, () => {
      const verdict = recordVerdict(fixturesDir, item.name);
      expect(verdict.verdict).toBe(item.expect);
      if (item.expect === "valid") {
        const expected = fixtureBytes("records", `${item.name}.canonical`);
        expect(verdict.canonical === null ? null : Buffer.from(verdict.canonical).equals(expected)).toBe(true);
        expect(verdict.sha256).toBe(fixtureText("records", `${item.name}.sha256`));
        expect(canonicalize(JSON.parse(fixtureText("records", `${item.name}.json`)))).toBe(expected.toString("utf8"));
      } else {
        expect(verdict.sha256).toBeNull();
      }
    });

    if (item.expect === "invalid") {
      // An invalid fixture proves its rule only when nothing else is wrong with it.
      it(`${item.name} fails only its own rule`, () => {
        const { errors } = recordErrors(fixturesDir, item.name);
        if (item.error === undefined) {
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.filter((error) => !error.startsWith("schema:"))).toEqual([]);
        } else {
          expect(errors).toEqual([item.error]);
        }
      });
    }
  }

  it("has at least one valid fixture per record type", () => {
    const records = [
      "ProjectPolicy",
      "FamilyRegistry",
      "HeldOutIdentityList",
      "RootRun",
      "ArtifactManifest",
      "PublicationRecord",
      "RunManifest",
      "PublicRunStatus",
      "StagingOmissions",
      "JobRequest",
      "ExpectedTrials",
      "CheckObservation",
      "TrialObservations",
      "TrialResult",
      "ObservedSymptom",
      "OperationIdentity",
      "MutationIdentity",
      "TaskRevisionIdentity",
    ];
    for (const type of records) {
      expect(manifest.records.some((item) => item.type === type && item.expect === "valid")).toBe(true);
    }
  });
});

describe("fixture report", () => {
  it("prints one line per fixture in manifest order, then the IDs of the valid identity fixtures", () => {
    const lines = fixtureReport(fixturesDir);
    const expected = [...manifest.canonical, ...manifest.records].map((item) => {
      const folder = "type" in item ? "records" : "canonical";
      const hash = item.expect === "valid" ? fixtureText(folder, `${item.name}.sha256`) : "-";
      return `${item.name} ${item.expect} ${hash}`;
    });
    const ids = { OperationIdentity: "operation_id", MutationIdentity: "mutation_id", TaskRevisionIdentity: "task_revision" } as Record<string, string>;
    for (const item of manifest.records.filter((entry) => entry.expect === "valid")) {
      if (item.type === "JobRequest") {
        const request = JSON.parse(fixtureText("records", `${item.name}.json`)) as { operation_id: string; payload_hash: string };
        expected.push(`${item.name} operation_id ${request.operation_id}`, `${item.name} payload_hash ${request.payload_hash}`);
      } else if (ids[item.type] !== undefined) {
        expected.push(`${item.name} ${ids[item.type] ?? ""} ${fixtureText("records", `${item.name}.sha256`)}`);
      }
    }
    expect(lines).toEqual(expected);
  });
});
