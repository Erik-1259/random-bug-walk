// The real pins against their sources in the repository: the probe set, the alternative fix, the
// fixture package the image runs, the local runner's copy script and profile, the driver's commit
// and limits, and the released case's recorded identities.
import { readFileSync } from "node:fs";
import { COPY_SCRIPT as RUNNER_COPY_SCRIPT, profileSha256 } from "@rbw/local-runner";
import { canonicalDigest, sha256Hex, taskRevision } from "@rbw/schema";
import { UMAMI_COMMIT, parseClosureList } from "@rbw/umami-driver";
import { DEFAULT_PHASE_LIMITS } from "@rbw/umami-driver/limits";
import { describe, expect, it } from "vitest";
import { COPY_LIMITS, COPY_SCRIPT } from "../src/copy-plans.ts";
import { isClosurePath } from "../src/closure.ts";
import { fixtureVectors } from "../src/inputs.ts";
import { frozenTaskIdentity, mutationIdOf } from "../src/job.ts";
import { RELEASED_CASE } from "../src/mapping.ts";
import { UMAMI_PINS } from "../src/pins.ts";
import { treeSha256 } from "../src/tree.ts";
import { repoFixture, repoPath } from "./support.ts";

const read = (...parts: string[]): Buffer => readFileSync(repoPath(...parts));

describe("the planted change and the repairs", () => {
  it("plants the probe set's mutation patch, byte for byte, with its recorded hashes", () => {
    const probes = JSON.parse(read("packages", "shapes", "probes", "dt-1.tz-arg", "probes.json").toString("utf8")) as {
      target_path: string;
      clean_sha256: string;
      planted_sha256: string;
    };
    const patch = read("packages", "shapes", "probes", "dt-1.tz-arg", "mutation.patch");
    expect(UMAMI_PINS.plant.patch).toBe(patch.toString("utf8"));
    expect(UMAMI_PINS.plant.patch_sha256).toBe(sha256Hex(patch));
    expect(UMAMI_PINS.target).toEqual({ path: probes.target_path, before_sha256: probes.clean_sha256, after_sha256: probes.planted_sha256 });
  });

  it("repairs with the mutation reversed: the local runner's fixed-state patch, as the release's judge job grades it", () => {
    expect(sha256Hex(Buffer.from(UMAMI_PINS.repair.patch))).toBe(UMAMI_PINS.repair.patch_sha256);
    expect(UMAMI_PINS.repair.patch_sha256).toBe("97c3ddce96442badb0c3b1f6ae6ba8dc24b4d50e161561091b96860dc6853b84");
    const swapped = UMAMI_PINS.plant.patch.split("\n").map((line) => (line.startsWith("-  ") ? `+${line.slice(1)}` : line.startsWith("+  ") ? `-${line.slice(1)}` : line));
    const removed = swapped.findIndex((line) => line.startsWith("+  "));
    const added = swapped.findIndex((line) => line.startsWith("-  "));
    [swapped[removed], swapped[added]] = [swapped[added] ?? "", swapped[removed] ?? ""];
    expect(UMAMI_PINS.repair.patch).toBe(swapped.join("\n"));
  });

  it("keeps the local runner's alternative fix, byte for byte, as extra evidence", () => {
    const patch = read("tools", "local-runner", "probes", "alternative-fix.patch");
    const record = JSON.parse(read("tools", "local-runner", "probes", "alternative-fix.json").toString("utf8")) as { base_sha256: string; result_sha256: string };
    expect(UMAMI_PINS.alternative_repair.patch).toBe(patch.toString("utf8"));
    expect(UMAMI_PINS.alternative_repair.patch_sha256).toBe(sha256Hex(patch));
    expect(record.base_sha256).toBe(UMAMI_PINS.target.after_sha256);
    expect(UMAMI_PINS.alternative_repair.result_sha256).toBe(record.result_sha256);
    expect(UMAMI_PINS.alternative_repair.result_sha256).not.toBe(UMAMI_PINS.target.before_sha256);
  });
});

describe("the fixture the image runs", () => {
  it("is the repository's fixture package: its staged parts hash to the pinned added-suite hash", () => {
    expect(treeSha256(repoFixture().tree)).toBe(UMAMI_PINS.kit.added_suite_sha256);
  });

  it("pins the fixture data file's hash and its clean, planted and fixed vectors", () => {
    const data = read("packages", "umami-fixture", "data", "umami-tz-arg-001.v1.json");
    expect(sha256Hex(data)).toBe(UMAMI_PINS.kit.fixture_sha256);
    expect(fixtureVectors(data)).toEqual(UMAMI_PINS.vectors);
  });
});

describe("the copy", () => {
  it("runs the local runner's copy script, byte for byte", () => {
    expect(COPY_SCRIPT).toBe(RUNNER_COPY_SCRIPT);
  });

  it("names the local runner's copy profile and its outer limit (720 s), 4 vCPU, 8 GB and no network", () => {
    expect(UMAMI_PINS.kit.profile_sha256).toBe(profileSha256());
    expect(COPY_LIMITS).toEqual({ timeout_s: 720, vcpus: 4, memory_mb: 8192, network: "none" });
    expect(DEFAULT_PHASE_LIMITS.tests_ms).toBe(240_000);
  });

  it("is of the driver's pinned Umami commit", () => {
    expect(UMAMI_PINS.app_commit).toBe(UMAMI_COMMIT);
    expect(UMAMI_PINS.baseline_id).toBe(`umami@${UMAMI_COMMIT.slice(0, 8)}`);
  });
});

describe("the released case's identities", () => {
  it("gives the release's mutation_id for the planted change", () => {
    expect(mutationIdOf(UMAMI_PINS.app_commit, [UMAMI_PINS.target])).toBe(RELEASED_CASE.mutation_id);
  });

  it("gives the release's task revision under the release's policy: every content pin agrees with the release record", () => {
    const identity = { ...frozenTaskIdentity(UMAMI_PINS), grading_policy_id: RELEASED_CASE.grading_policy_id };
    expect(taskRevision(identity).sha256).toBe(RELEASED_CASE.task_revision);
    expect(UMAMI_PINS.incident.sha256).toBe(RELEASED_CASE.issue_sha256);
    expect(UMAMI_PINS.kit.digest).toBe(RELEASED_CASE.kit_image_digest);
  });

  it("pins the frozen suite's identity: 271 tests, hash 8162af64…, the sorted IDs' hash", () => {
    expect(UMAMI_PINS.original_suite).toEqual({
      suite_id: "umami-api@ec0ff503",
      sha256: "8162af64ef63b82717afa6f9420745df3ccc3fb85f81adf4d47352af1b8ecbcd",
      test_count: 271,
      test_ids_sha256: "a0454b85b0efe07272f650b9d70ce8ff1322fbe68becf1fd7dbfc9eb5af171a5",
    });
  });

  it("pins the image's source tree (2026 files) and the frozen job read once from the prepared store", () => {
    expect(UMAMI_PINS.kit.source_tree_sha256).toBe("712ebd687ed85386d3c1bea26204f120d18260aa03ad8fc6b15737afadd8fd2d");
    expect(UMAMI_PINS.kit.source_file_count).toBe(2026);
    expect(UMAMI_PINS.job).toEqual({
      request_sha256: "89db318ca3898483a419057501992e2c5c9d21bf5b7a1205b0ee4bb65ebfceac",
      expected_trials_sha256: "f14185dc7dd0c71b59e1ee72a0cc16fa4caf68dfc73505696f09832f5a4cd10c",
    });
  });
});

describe("the original suite's closure", () => {
  it("covers every file of the kit's closure list, and the planted target is not one", () => {
    const closure = parseClosureList(read("kit", "umami", "closure.sha256").toString("utf8"));
    const paths = Object.keys(closure);
    expect(paths.length).toBe(49);
    expect(paths.filter((path) => !isClosurePath(path))).toEqual([]);
    expect(isClosurePath(UMAMI_PINS.target.path)).toBe(false);
    expect(canonicalDigest(paths.sort()).sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
