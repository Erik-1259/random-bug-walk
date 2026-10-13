// The judge job is built for the release's own bug family: the time-zone family's job is pinned
// byte for byte, and a second (synthetic) family's fixture package, probes and alternative fix
// build a job of their own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@rbw/schema";
import { InputsError } from "@rbw/local-runner";
import { FIXTURE_FILE, loadFixture } from "@rbw/umami-fixture";
import type { Fixture } from "@rbw/umami-fixture";
import { writeAlternativeDir, writeProbeDir } from "../../../local-runner/test/support/synthetic.ts";
import { familyFrom } from "../../src/family.ts";
import { TIME_ZONE_FAMILY, buildJudgeJob, jobContext } from "../../src/judge-job.ts";
import type { BuildSources, JudgeJob, JudgeJobFamily } from "../../src/judge-job.ts";
import { PROJECT_ID, RELEASE_ID, UC3, rootIds, tempDir, world, write } from "../support/world.ts";
import type { World } from "../support/world.ts";

// The time-zone family's judge job from the synthetic world, as the release tool built it before
// the family became an input. A change to any of these bytes changes what a released judge replays.
const TIME_ZONE_PIN = {
  index_sha256: "3a4a333dc587f61fd3681d0b5f4bb66fd2211db9f76b81415cd664727d396cc7",
  task_revision: "bf57ee5aa716e638b24f974807c4270a058d66cd70a6cea17093756f2b2bfa96",
  files: {
    "audit-policy.json": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    "expected-trials.json": "afc9d4e326d90a15889434a3fc59a64e2d7a1dc2fd26b87d4febafbaed7fc728",
    "original-suite.json": "68c27725b2fb3344a56bff8d55c3b2ec31b710c9f8aada08d458939ea83ba732",
    "projection-manifest.json": "8a3a47e7a839b1eb6ca2e5c3e82c351df28faae4cf1219df00d2fad0940ba752",
    "request.json": "b9709b28dfa5cd1601566c716a22e801b1b95b544e0f7cfcc14eacdc64fdeefe",
    "source.tar": "b94a40df299e3bf043f31ab640902508b4a3af8ddfc697a19d049f2ab5defcad",
    "strict-terms.txt": "a5f1ea57b2056207631cf7e0df024cc5a619caa4f1de22e2fdea6617e128b804",
  },
};

const SYNTHETIC_FIXTURE_ID = "synthetic-second-family-001";

async function judgeJob(w: World, sources: BuildSources): Promise<JudgeJob> {
  return buildJudgeJob(w.docker, sources, {
    releaseId: RELEASE_ID,
    projectId: PROJECT_ID,
    policy: { sha256: w.policy.sha256, policy_id: UC3 },
    issueSha256: "ab".repeat(32),
    reservationMicrousd: 600_000,
    exportDir: join(tempDir(), "source"),
  });
}

function fileHashes(job: JudgeJob): Record<string, string> {
  return Object.fromEntries(job.files.map((file) => [file.path, sha256Hex(file.bytes)]));
}

function fixtureShaOf(job: JudgeJob): string {
  return job.identity.fixture_sha256;
}

/**
 * A synthetic fixture package laid out as @rbw/umami-fixture is: data/ holds the time-zone data
 * file under another fixture ID (so its vectors agree with the synthetic probes, and its bytes and
 * hash are its own), and src/index.ts exports FIXTURE_FILE and loadFixture.
 */
function writeSyntheticFixturePackage(): string {
  const dir = tempDir("rbw-release-fixture-package-");
  const data = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as Record<string, unknown>;
  write(join(dir, "data", "synthetic.v1.json"), `${JSON.stringify({ ...data, fixture_id: SYNTHETIC_FIXTURE_ID }, null, 2)}\n`);
  const parser = pathToFileURL(new URL("../../../../packages/umami-fixture/src/index.ts", import.meta.url).pathname).href;
  write(
    join(dir, "src", "index.ts"),
    `import { readFileSync } from "node:fs";
import { parseFixture } from ${JSON.stringify(parser)};
export const FIXTURE_FILE = new URL("../data/synthetic.v1.json", import.meta.url);
export function loadFixture() { return parseFixture(readFileSync(FIXTURE_FILE, "utf8")); }
`,
  );
  return dir;
}

describe("the judge job's family", () => {
  it("builds the time-zone family's judge job byte for byte as before", async () => {
    const w = world();
    // The world's family is the time-zone one with the synthetic kit's probes and fix swapped in.
    expect({ ...w.sources.family, probesDir: TIME_ZONE_FAMILY.probesDir, alternativeDir: TIME_ZONE_FAMILY.alternativeDir }).toEqual(TIME_ZONE_FAMILY);
    const job = await judgeJob(w, w.sources);
    expect(job.indexSha256).toBe(TIME_ZONE_PIN.index_sha256);
    expect(job.built.request.task_revision).toBe(TIME_ZONE_PIN.task_revision);
    expect(fileHashes(job)).toEqual(TIME_ZONE_PIN.files);
    expect(fixtureShaOf(job)).toBe(sha256Hex(readFileSync(FIXTURE_FILE)));
  });

  it("reads the time-zone family's real probes when the family is left out, which the synthetic kit's manifest does not match", async () => {
    const w = world();
    const withoutFamily: BuildSources = { ...w.sources };
    delete withoutFamily.family;
    const built = jobContext(w.docker, withoutFamily, { ids: rootIds("8700"), deadlineAt: "2026-10-06T12:00:00Z", exportDir: join(tempDir(), "source") });
    await expect(built).rejects.toThrow(InputsError);
    await expect(built).rejects.toThrow(/is not the probes' clean file/);
  });

  it("names the shapes package's probes, the local runner's alternative fix and @rbw/umami-fixture as the default family", () => {
    expect(TIME_ZONE_FAMILY.fixtureFile).toBe(FIXTURE_FILE);
    expect(TIME_ZONE_FAMILY.loadFixture).toBe(loadFixture);
    expect(TIME_ZONE_FAMILY.probesDir).toMatch(/packages\/shapes\/probes\//);
    expect(TIME_ZONE_FAMILY.alternativeDir).toMatch(/tools\/local-runner\/probes\/$/);
  });

  it("builds a second family's own judge job from its fixture package, probes and alternative fix", async () => {
    const w = world();
    const pkg = writeSyntheticFixturePackage();
    const family = await familyFrom({ fixturePackage: pkg, probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() });
    expect(family.loadFixture().fixture_id).toBe(SYNTHETIC_FIXTURE_ID);
    const job = await judgeJob(w, { ...w.sources, family });
    const syntheticSha = sha256Hex(readFileSync(join(pkg, "data", "synthetic.v1.json")));
    expect(syntheticSha).not.toBe(sha256Hex(readFileSync(FIXTURE_FILE)));
    expect(fixtureShaOf(job)).toBe(syntheticSha);
    expect(job.indexSha256).not.toBe(TIME_ZONE_PIN.index_sha256);
    expect(job.built.request.task_revision).not.toBe(TIME_ZONE_PIN.task_revision);
    // Only the fixture differs from the time-zone job: the same kit, inputs and source.
    const hashes = fileHashes(job);
    expect(hashes["source.tar"]).toBe(TIME_ZONE_PIN.files["source.tar"]);
    expect(hashes["request.json"]).not.toBe(TIME_ZONE_PIN.files["request.json"]);
    expect(hashes["expected-trials.json"]).not.toBe(TIME_ZONE_PIN.files["expected-trials.json"]);
  });

  it("refuses a family whose fixture has no vector for some code state (fixture_vectors_incomplete)", async () => {
    const w = world();
    const threeStates = (): Fixture => {
      const fixture = structuredClone(loadFixture());
      const vectors = fixture.outcome_vectors as Partial<Fixture["outcome_vectors"]>;
      delete vectors.partial;
      delete vectors.stub;
      return fixture;
    };
    const family: JudgeJobFamily = { ...w.sources.family, loadFixture: threeStates };
    await expect(judgeJob(w, { ...w.sources, family })).rejects.toMatchObject({ code: "fixture_vectors_incomplete", message: "fixture_vectors_incomplete: partial,stub" });
  });
});

describe("familyFrom: the build command's family flags", () => {
  it("is the time-zone family when no family flag is given", async () => {
    expect(await familyFrom({})).toBe(TIME_ZONE_FAMILY);
  });

  it("refuses a fixture package without its own probes and alternative fix, or probes without a package (family_incomplete)", async () => {
    const pkg = writeSyntheticFixturePackage();
    await expect(familyFrom({ fixturePackage: pkg })).rejects.toMatchObject({ code: "family_incomplete" });
    await expect(familyFrom({ fixturePackage: pkg, probesDir: writeProbeDir() })).rejects.toMatchObject({ code: "family_incomplete" });
    await expect(familyFrom({ probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() })).rejects.toMatchObject({ code: "family_incomplete" });
  });

  it("refuses a directory that is not a fixture package (fixture_package_invalid)", async () => {
    const extra = { probesDir: writeProbeDir(), alternativeDir: writeAlternativeDir() };
    await expect(familyFrom({ fixturePackage: tempDir(), ...extra })).rejects.toMatchObject({ code: "fixture_package_invalid" });
    const noLoader = tempDir();
    write(join(noLoader, "src", "index.ts"), 'export const FIXTURE_FILE = "synthetic.json";\n');
    await expect(familyFrom({ fixturePackage: noLoader, ...extra })).rejects.toMatchObject({ code: "fixture_package_invalid" });
  });
});
