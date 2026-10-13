// A time-zone release with a race symptom swapped in, made end to end as the release fixture script makes the
// time-zone one: stage with a RaceSymptom, the real publisher, build with a local private store and
// the publisher's release command; then the results site's reader reads the published directory.
// The race symptom is @rbw/schema's synthetic fixture; the committed time-zone fixture is untouched.
// Only the symptom is swapped: the run, kit, issue, recordings and judge job (built with no family
// flag, so the time-zone fixture, suite, vectors and probes) stay time-zone, so this checks the symptom's
// staging and reading, not a race-family judge job.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { RATE_SHEET_PATH } from "@rbw/controller";
import { loadRateSheet } from "@rbw/envelope";
import { candidateIdentity } from "@rbw/local-runner";
import { runCli } from "@rbw/publisher";
import { canonicalDigest, encodeCanonical, parseRecord } from "@rbw/schema";
import { isRaceSymptom, readResults } from "../../../../packages/web/src/release.ts";
import { buildRelease } from "../../src/build.ts";
import { checkRelease } from "../../src/check.ts";
import { ReleaseInputError } from "../../src/errors.ts";
import { assertSymptom, stage } from "../../src/stage.ts";
import { checkout, destination, publish } from "../support/publish.ts";
import { CONTROLLER_IMAGE, RELEASE_ID, canonical, factoryRun, generatedFiles, tempDir, world, write } from "../support/world.ts";
import type { FactoryRun, World } from "../support/world.ts";

const SOURCES = new URL("../../fixtures/sources/", import.meta.url).pathname;
const SCHEMA_RECORDS = new URL("../../../../packages/schema/fixtures/records/", import.meta.url).pathname;
const RACE_SYMPTOM = JSON.parse(readFileSync(join(SCHEMA_RECORDS, "race-symptom-valid.json"), "utf8")) as Record<string, unknown>;
const TIME_ZONE_SYMPTOM = JSON.parse(readFileSync(join(SOURCES, "symptom.json"), "utf8")) as Record<string, unknown>;

let w: World;
let factory: FactoryRun;

beforeAll(async () => {
  w = world();
  factory = await factoryRun(w, "8400");
});

/** The generated files with the race symptom in place of the time-zone one. */
function raceGenerated(dir: string, symptom: unknown = RACE_SYMPTOM): { symptom: string; card: string; novelty: string } {
  const generated = generatedFiles(dir);
  return { ...generated, symptom: write(join(dir, "generated", "race-symptom.json"), JSON.stringify(symptom)) };
}

function refusalCode(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    if (error instanceof ReleaseInputError) return error.code;
    throw error;
  }
  return null;
}

describe("assertSymptom", () => {
  it("routes by symptom_kind: a race symptom is checked as a RaceSymptom, any other as an ObservedSymptom", () => {
    expect(assertSymptom(RACE_SYMPTOM)).toEqual(RACE_SYMPTOM);
    expect(assertSymptom(TIME_ZONE_SYMPTOM)).toEqual(TIME_ZONE_SYMPTOM);
    // A race symptom whose observed counts disagree with its attempts fails the RaceSymptom rules.
    expect(() => assertSymptom({ ...RACE_SYMPTOM, observed: { accepted: 1, refused: 1 } })).toThrow();
    // A value with a symptom_kind is never let through as an ObservedSymptom.
    expect(() => assertSymptom({ ...TIME_ZONE_SYMPTOM, symptom_kind: "concurrent_double_acceptance" })).toThrow();
  });
});

describe("stage with a race symptom", () => {
  it("stages a RaceSymptom as generated/symptom.json in canonical bytes", () => {
    const dir = tempDir();
    const out = join(dir, "staging");
    const outcome = stage({ run: factory.run, rootRun: factory.rootRunFile, out, redactionsOut: join(dir, "private", "redactions.txt"), ...raceGenerated(dir) });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(out, "generated", "symptom.json"))).toEqual(Buffer.from(encodeCanonical(RACE_SYMPTOM as never)));
  });

  it("refuses an invalid race symptom as symptom_invalid and writes nothing", () => {
    const dir = tempDir();
    const out = join(dir, "staging");
    const invalid = { ...RACE_SYMPTOM, overlap_ms: 5 };
    expect(refusalCode(() => stage({ run: factory.run, rootRun: factory.rootRunFile, out, redactionsOut: join(dir, "private", "redactions.txt"), ...raceGenerated(dir, invalid) }))).toBe("symptom_invalid");
  });
});

describe("a release carrying a race symptom, staged, published, built and read by the results site", () => {
  it("passes every release check, and the site reads the released run's RaceSymptom", async () => {
    const dir = tempDir();
    const staging = join(dir, "staging");
    const redactions = join(dir, "private", "redactions.txt");
    expect(stage({ run: factory.run, rootRun: factory.rootRunFile, out: staging, redactionsOut: redactions, ...raceGenerated(dir) }).ok).toBe(true);
    const d = destination(w);
    const published = await publish(w, d, { rootRun: factory.rootRunFile, staging, redactions });
    expect(published.result.code).toBe(0);
    if (published.record === null) throw new Error("synthetic: no publication record");
    const publication = write(join(dir, "inputs", "publication.json"), canonical(published.record));
    const runDir = checkout(d.remote, `runs/${factory.ids.root_execution_id}`);

    const issueSha256 = canonicalDigest(JSON.parse(readFileSync(join(SOURCES, "issue.json"), "utf8")) as never).sha256;
    const mutationId = candidateIdentity(factory.ctx).mutation_id ?? "";
    const releaseDir = join(dir, "release");
    const built = await buildRelease(
      {
        releaseId: RELEASE_ID,
        run: runDir,
        publication,
        policy: w.policy.file,
        rootRun: factory.rootRunFile,
        issue: join(SOURCES, "issue.json"),
        issueCheck: join(SOURCES, "issue-check.json"),
        recordings: join(SOURCES, "recordings"),
        approval: write(join(dir, "inputs", "approval.json"), canonical({ decision: "approved", issue_sha256: issueSha256, reviewed_at: "2026-10-14T10:00:00Z" })),
        registry: write(
          join(dir, "inputs", "families.json"),
          canonical({ schema_version: 1, families: [{ family_id: "synthetic-race-family-1", exposure: "public", held_out_eligible: false, source_fixes: [{ upstream: "synthetic-upstream", commit: "b".repeat(40) }], mutation_ids: [mutationId] }] }),
        ),
        heldOut: write(join(dir, "inputs", "held-out.json"), canonical({ schema_version: 1, family_ids: [], source_fixes: [], mutation_ids: [] })),
        sources: w.sources,
        controllerImage: CONTROLLER_IMAGE,
        localStore: join(dir, "private-store"),
        out: releaseDir,
      },
      {
        docker: w.docker,
        clock: w.clock,
        rates: await loadRateSheet(RATE_SHEET_PATH),
        env: {},
        privateStoreFromEnv: () => {
          throw new Error("synthetic: local mode must not ask for the real store");
        },
        log: () => undefined,
      },
    );
    if (!built.ok) throw new Error(`synthetic: build refused: ${built.codes.join(",")}`);
    const release = parseRecord("Release", readFileSync(join(releaseDir, "release.json")));
    expect(checkRelease(release, { dir: runDir, policyBytes: w.policy.bytes, publication: published.record, rootRun: factory.rootRun }, releaseDir)).toEqual([]);
    const released = await runCli(["release", "--policy", w.policy.file, "--release-dir", releaseDir, "--state", d.state, "--patterns", w.patterns, ...d.flags]);
    expect(released.code).toBe(0);

    // The results directory as the site's build reads it: the results branch's runs and releases, and the public store.
    const results = tempDir();
    checkout(d.remote, "runs", join(results, "repository", "runs"));
    checkout(d.remote, "releases", join(results, "repository", "releases"));
    const read = await readResults(results);
    expect(read.release?.record.release_id).toBe(RELEASE_ID);
    expect(read.caseRun?.rootExecutionId).toBe(factory.ids.root_execution_id);
    const symptom = read.caseRun?.symptom;
    if (symptom == null || !isRaceSymptom(symptom)) throw new Error("expected the race family's symptom");
    expect(symptom.observed).toEqual({ accepted: 2, refused: 0 });
    expect(symptom.concurrent_attempts.map((attempt) => attempt.label)).toEqual(["request a", "request b"]);
  });
});
