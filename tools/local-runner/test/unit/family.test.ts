import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiff } from "@rbw/projection";
import { loadProbeSet } from "@rbw/shapes";
import { DEFAULT_FAMILY, FAMILIES, FamilyError, checkFamilyImage, checkFamilyProbes, checkKitStage, familyFor, familyRecord, raceLatency } from "../../src/family.ts";
import { JobRefusal, buildJob, expectedVectors, newRunIds } from "../../src/jobs.ts";
import { deriveCodeStates } from "../../src/code-states.ts";
import { CLEAN, stageFixtureData, tempDir, writeKitStage, writeRaceProbeDir } from "../support/synthetic.ts";

const race = FAMILIES.race;
const timeZone = FAMILIES["time-zone"];

describe("family selection", () => {
  it("defaults to the time-zone family, with its own fixture, probes and alternative fix", () => {
    expect(DEFAULT_FAMILY).toBe("time-zone");
    expect(familyFor(undefined)).toBe(timeZone);
    expect(timeZone.probesDir).toMatch(/packages\/shapes\/probes\/dt-1\.tz-arg\/$/);
    expect(timeZone.fixturePackage).toMatch(/packages\/umami-fixture$/);
    expect(timeZone.alternativeDir).not.toBeNull();
    expect(timeZone.proxy).toBe(false);
  });

  it("names the race family's fixture package, probe directory and race kit image, with no alternative fix", () => {
    expect(familyFor("race")).toBe(race);
    expect(race.fixturePackage).toMatch(/packages\/umami-fixture-rc1$/);
    expect(race.probesDir).toMatch(/packages\/shapes\/probes\/rc-1\.atomic-backup-code\/$/);
    expect(race.alternativeDir).toBeNull();
    expect(race.imageSchema).toBe("rbw-umami-race-kit-image-manifest/1");
    expect(race.proxy).toBe(true);
  });

  it("refuses an unknown family", () => {
    expect(() => familyFor("timezone")).toThrow(FamilyError);
  });
});

describe("the committed race probe set and the race fixture", () => {
  const probes = loadProbeSet(race.probesDir);

  it("agree on both checks: the planted copy passes the serial control and fails the race with double_spend", () => {
    checkFamilyProbes(race, probes);
    const vectors = expectedVectors(race.loadFixture(), probes);
    expect(Object.keys(vectors).sort()).toEqual(["clean", "fixed", "planted"]);
    expect(vectors.planted).toEqual([
      { check_id: "rc1.backup-code-serial-reuse", expected: "pass", failure_code: null },
      { check_id: "rc1.backup-code-concurrent-double-spend", expected: "assertion_fail", failure_code: "double_spend" },
    ]);
  });

  it("record ADM-06 as not applicable, with the reason, and 11 admission copies", () => {
    expect(familyRecord(race, probes)).toMatchObject({ id: "race", adm06: { status: "not_applicable" }, admission_copies: 11 });
    expect(familyRecord(race, probes).adm06.reason).toMatch(/not applicable/);
  });

  it("give a reason that run summaries can carry: no role credit and no decision date", () => {
    const reason = familyRecord(race, probes).adm06.reason ?? "";
    expect(reason).toMatch(/^This race family is admitted on its clean, fixed and planted copies only/);
    expect(reason).not.toMatch(/owner|decision|\b20\d\d\b/i);
  });

  it("are refused when the race probe set's recorded mutation vector disagrees with the race fixture", () => {
    const dir = writeRaceProbeDir();
    const file = join(dir, "probes.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { checks: string[]; probes: { expected: Record<string, unknown> }[] };
    const mutation = data.probes[0];
    if (mutation === undefined) throw new Error("synthetic race probe set has no mutation probe");
    // An old check ID the race fixture does not declare.
    data.checks = ["rc1.backup-code-serial-reuse", "rc1.backup-code-single-use"];
    mutation.expected = { "rc1.backup-code-single-use": { outcome: "assertion_fail", reason: "double_spend" }, "rc1.backup-code-serial-reuse": { outcome: "pass" } };
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    expect(() => expectedVectors(race.loadFixture(), loadProbeSet(dir))).toThrow(JobRefusal);
    // The right check IDs, but the race check's reason is the serial check's failure code.
    data.checks = ["rc1.backup-code-serial-reuse", "rc1.backup-code-concurrent-double-spend"];
    mutation.expected = { "rc1.backup-code-concurrent-double-spend": { outcome: "assertion_fail", reason: "backup_code_reused" }, "rc1.backup-code-serial-reuse": { outcome: "pass" } };
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    expect(() => expectedVectors(race.loadFixture(), loadProbeSet(dir))).toThrow(JobRefusal);
  });

  it("are refused against the time-zone fixture, and the time-zone probes against the race fixture", () => {
    expect(() => {
      checkFamilyProbes(timeZone, probes);
    }).toThrow(/needs clean,fixed,planted/);
    expect(() => {
      checkFamilyProbes(race, loadProbeSet(timeZone.probesDir));
    }).toThrow(/needs clean,fixed,partial,planted,stub/);
  });

  it("keep the time-zone family at 13 admission copies with ADM-06 required", () => {
    const tz = loadProbeSet(timeZone.probesDir);
    checkFamilyProbes(timeZone, tz);
    expect(familyRecord(timeZone, tz)).toEqual({ id: "time-zone", adm06: { status: "required", reason: null }, admission_copies: 13 });
    expect(Object.keys(expectedVectors(timeZone.loadFixture(), tz)).sort()).toEqual(["clean", "fixed", "partial", "planted", "stub"]);
  });
});

describe("building the race family's jobs", () => {
  const probes = loadProbeSet(writeRaceProbeDir());
  let counter = 0;
  const ctx = {
    ids: newRunIds(() => {
      counter += 1;
      return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
    }),
    imageDigest: `sha256:${"9".repeat(64)}`,
    kitSha256: "d".repeat(64),
    fixtureSha256: "e".repeat(64),
    addedSuiteSha256: "f".repeat(64),
    originalSuite: { sha256: "a".repeat(64), testIds: ["synthetic-spec-0001"] },
    states: deriveCodeStates(Buffer.from(CLEAN), probes, null),
    vectors: expectedVectors(race.loadFixture(), probes),
    profileSha256: "b".repeat(64),
    deadlineAt: "2026-10-14T00:00:00Z",
  };

  it("builds an 11-trial admission job when ADM-06 is not applicable", () => {
    const admission = buildJob("admission", { ...ctx, adm06: "not_applicable" });
    expect(admission.expected.trials.map((trial) => trial.trial_id)).toEqual([
      "clean-01",
      "fixed-01",
      "fixed-02",
      "fixed-03",
      "fixed-04",
      "fixed-05",
      "planted-01",
      "planted-02",
      "planted-03",
      "planted-04",
      "planted-05",
    ]);
    expect(admission.expected.trials.find((trial) => trial.trial_id === "planted-01")?.expected_checks[1]).toEqual({
      check_id: "rc1.backup-code-concurrent-double-spend",
      expected: "assertion_fail",
      failure_code: "double_spend",
    });
  });

  it("refuses to build the 13-trial admission job when no partial or stub state was derived", () => {
    expect(() => buildJob("admission", ctx)).toThrow(/the partial code state was not derived/);
  });

  it("builds the kit check and the observation unchanged by the ADM-06 choice", () => {
    expect(buildJob("kit-check", { ...ctx, adm06: "not_applicable" }).expected.trials).toHaveLength(5);
  });
});

describe("the race latency", () => {
  it("accepts whole milliseconds from 0 to 10000 for the race family, and no latency", () => {
    expect(raceLatency(race, 0)).toBe(0);
    expect(raceLatency(race, "250")).toBe(250);
    expect(raceLatency(race, 10_000)).toBe(10_000);
    expect(raceLatency(race, null)).toBeNull();
    expect(raceLatency(race, undefined)).toBeNull();
  });

  it.each([-1, 10_001, 1.5, "50ms", "", "007"])("refuses %s", (value) => {
    expect(() => raceLatency(race, value)).toThrow(FamilyError);
  });

  it("refuses any latency for the time-zone family, whose image has no proxy", () => {
    expect(() => raceLatency(timeZone, 0)).toThrow(/no database proxy/);
    expect(raceLatency(timeZone, null)).toBeNull();
  });
});

describe("the kit image and the kit stage", () => {
  it("accepts an image whose manifest schema is the family's, and refuses another or none", () => {
    checkFamilyImage(race, Buffer.from('{"schema":"rbw-umami-race-kit-image-manifest/1"}'));
    checkFamilyImage(timeZone, Buffer.from('{"schema":"rbw-umami-kit-image-manifest/1"}'));
    expect(() => {
      checkFamilyImage(race, Buffer.from('{"schema":"rbw-umami-kit-image-manifest/1"}'));
    }).toThrow(FamilyError);
    expect(() => {
      checkFamilyImage(timeZone, Buffer.from('{"schema":"rbw-umami-race-kit-image-manifest/1"}'));
    }).toThrow(FamilyError);
    expect(() => {
      checkFamilyImage(race, Buffer.from("not json"));
    }).toThrow(/has none/);
  });

  it("accepts every image the time-zone family accepted before: any manifest that does not name another family's schema", () => {
    checkFamilyImage(timeZone, Buffer.from('{"synthetic":"image manifest"}'));
    checkFamilyImage(timeZone, Buffer.from("not json"));
    expect(() => {
      checkFamilyImage(race, Buffer.from('{"synthetic":"image manifest"}'));
    }).toThrow(/has none/);
  });

  it("requires the race fixture's data file in a race kit stage, and refuses another family's", () => {
    const raceStage = writeKitStage(tempDir(), "race");
    checkKitStage(race, raceStage);
    expect(() => {
      checkKitStage(timeZone, raceStage);
    }).toThrow(/holds the race fixture \(rc-1-backup-code-001\.v1\.json\), not the time-zone fixture/);
    const tzStage = writeKitStage(tempDir());
    expect(() => {
      checkKitStage(race, tzStage);
    }).toThrow(/holds no rc-1-backup-code-001\.v1\.json/);
    stageFixtureData(tzStage, "time-zone");
    expect(() => {
      checkKitStage(race, tzStage);
    }).toThrow(/holds the time-zone fixture/);
  });

  it("accepts every time-zone kit stage it accepted before, and refuses one whose time-zone data file was changed", () => {
    const tzStage = writeKitStage(tempDir());
    checkKitStage(timeZone, tzStage);
    stageFixtureData(tzStage, "time-zone");
    checkKitStage(timeZone, tzStage);
    writeFileSync(join(tzStage, "umami-fixture", "data", "umami-tz-arg-001.v1.json"), "{}\n");
    expect(() => {
      checkKitStage(timeZone, tzStage);
    }).toThrow(/differs from the time-zone fixture's data file/);
  });
});

describe("every family's committed probe patches", () => {
  it("are standard unified diffs that the projection audit parses, empty context lines included", () => {
    for (const family of Object.values(FAMILIES)) {
      for (const [id, text] of loadProbeSet(family.probesDir).patches) {
        expect(() => parseDiff(text), `${family.id} ${id}`).not.toThrow();
      }
    }
  });
});
