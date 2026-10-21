import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRecord, sha256Hex } from "@rbw/schema";
import { validateContract } from "@rbw/factory-contract/validate";
import { afterEach, describe, expect, it } from "vitest";
import { buildUmamiAdapter } from "../src/adapter.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { EXPECTED_TRIALS_FILE, FROZEN_JOB_IDS, REQUEST_FILE } from "../src/job.ts";
import { OBJECTS_DIR } from "../src/store.ts";
import { treeSha256 } from "../src/tree.ts";
import { SYNTHETIC_PLANTED_TARGET, cleanupTemp, hashTree, recordingNewDir, syntheticWorld, writeSyntheticStore } from "./support.ts";

afterEach(cleanupTemp);

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UmamiRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

async function setup() {
  const world = syntheticWorld();
  const store = await writeSyntheticStore(world);
  const out = recordingNewDir();
  const adapter = buildUmamiAdapter(world.pins, { store, newDir: out.newDir });
  const [entry] = adapter.catalog();
  if (entry === undefined) throw new Error("the catalog is empty");
  return { world, store, out, adapter, entry };
}

describe("bugCaseInputs", () => {
  it("hands out the buggy source (the image's source with the planted target) and the incident, from the store", async () => {
    const { world, out, adapter, entry } = await setup();
    const inputs = await adapter.bugCaseInputs(entry);
    expect(validateContract("BugCaseInputs", inputs)).toEqual([]);
    expect(inputs.host_id).toBe("umami");
    expect(inputs.entry_id).toBe(entry.entry_id);
    expect(inputs.baseline).toEqual(adapter.baseline());
    const expected = { ...world.source, [world.pins.target.path]: world.pins.target.after_sha256 };
    expect(Object.fromEntries(inputs.source.files.map((file) => [file.path, file.sha256]))).toEqual(expected);
    // The files on disk are exactly the listed ones, with the listed bytes.
    expect(hashTree(inputs.source.root)).toEqual(expected);
    expect(readFileSync(join(inputs.source.root, ...world.pins.target.path.split("/")), "utf8")).toBe(SYNTHETIC_PLANTED_TARGET);
    expect(inputs.incident.files).toEqual([{ path: "issue.json", sha256: world.pins.incident.sha256 }]);
    expect(readFileSync(join(inputs.incident.root, "issue.json"))).toEqual(world.incidentBytes);
    expect(out.dirs).toEqual([inputs.source.root, inputs.incident.root]);
  });

  it("gives the pinned runtime image, not the kit image, and the setup steps, with no answer material", async () => {
    const { world, adapter, entry } = await setup();
    const inputs = await adapter.bugCaseInputs(entry);
    expect(inputs.runtime.kit_image).toBe(world.pins.runtime.image);
    expect(inputs.runtime.kit_image_digest).toBe(world.pins.runtime.digest);
    expect(inputs.runtime.kit_image_digest).not.toBe(world.pins.kit.digest);
    const setupText = inputs.runtime.setup.join("\n");
    expect(setupText).toContain("linux/amd64 container of the runtime image");
    // The tree is prepared once before the cold build, and the build and start commands follow.
    expect(setupText.indexOf("/opt/rbw/bin/rbw-prepare-app")).toBeGreaterThan(-1);
    expect(setupText.indexOf("/opt/rbw/bin/rbw-prepare-app")).toBeLessThan(setupText.indexOf("/opt/rbw/bin/rbw-build-app"));
    for (const term of ["tzarg", "getPageviewStats", "getDateSQL", "pageviews", "planted", "clean source", "fixture", "kit image"]) expect(setupText).not.toContain(term);
  });

  it("names the runtime pin's architecture in the setup steps", async () => {
    const world = syntheticWorld({ runtime: { image: "synthetic/umami-runtime-arm64", digest: `sha256:${"d".repeat(64)}`, architecture: "arm64" } });
    const adapter = buildUmamiAdapter(world.pins, { store: await writeSyntheticStore(world), newDir: recordingNewDir().newDir });
    const [entry] = adapter.catalog();
    if (entry === undefined) throw new Error("the catalog is empty");
    const inputs = await adapter.bugCaseInputs(entry);
    expect(inputs.runtime).toMatchObject({ kit_image: "synthetic/umami-runtime-arm64", kit_image_digest: `sha256:${"d".repeat(64)}` });
    expect(inputs.runtime.setup[0]).toContain("linux/arm64 container of the runtime image");
  });

  it("refuses without a store, with a store of other pins, and with an object whose bytes changed", async () => {
    const { world, store, entry } = await setup();
    expect(await refusal(() => buildUmamiAdapter(world.pins).bugCaseInputs(entry))).toBe("store_missing");
    const otherPins = { ...world.pins, kit: { ...world.pins.kit, source_tree_sha256: "f".repeat(64) } };
    const other = buildUmamiAdapter(otherPins, { store });
    const [otherEntry] = other.catalog();
    if (otherEntry === undefined) throw new Error("the catalog is empty");
    expect(await refusal(() => other.bugCaseInputs(otherEntry))).toBe("store_tree_mismatch");
    writeFileSync(join(store, OBJECTS_DIR, world.pins.target.after_sha256), "tampered\n");
    expect(await refusal(() => buildUmamiAdapter(world.pins, { store }).bugCaseInputs(entry))).toBe("store_object_mismatch");
  });

  it("refuses an entry that is not in the catalog", async () => {
    const { adapter, entry } = await setup();
    expect(await refusal(() => adapter.bugCaseInputs({ ...entry, entry_id: "other" }))).toBe("unknown_entry");
  });
});

describe("validatorInputs", () => {
  it("carries the image's fixture by content, the frozen judge_verify job, the vectors and the alternative repair", async () => {
    const { world, out, adapter, entry } = await setup();
    const inputs = await adapter.validatorInputs(entry);
    expect(validateContract("ValidatorInputs", inputs)).toEqual([]);
    expect(out.dirs).toEqual([inputs.checks.root]);
    const tree = Object.fromEntries(inputs.checks.files.map((file) => [file.path, file.sha256]));
    expect(hashTree(inputs.checks.root)).toEqual(tree);
    const fixture: Record<string, string> = {};
    for (const [path, sha] of Object.entries(tree)) if (path.startsWith("fixture/")) fixture[path.slice("fixture/".length)] = sha;
    expect(treeSha256(fixture)).toBe(entry.verification.check_set_sha256);
    expect(tree[REQUEST_FILE]).toBe(world.pins.job.request_sha256);
    expect(tree[EXPECTED_TRIALS_FILE]).toBe(world.pins.job.expected_trials_sha256);
    expect(tree["expected-vectors.json"]).toBe(entry.verification.expected_vectors_sha256);
    expect(tree["evidence/alternative-repair.patch"]).toBe(world.pins.alternative_repair.patch_sha256);
    expect(Object.keys(tree).filter((path) => !path.startsWith("fixture/")).sort()).toEqual(
      ["evidence/alternative-repair.json", "evidence/alternative-repair.patch", "expected-vectors.json", EXPECTED_TRIALS_FILE, REQUEST_FILE].sort(),
    );
  });

  it("writes a judge_verify job the driver reads: placeholder identities, the pinned suite, added suite, runtime image, patches and vectors", async () => {
    const { world, adapter, entry } = await setup();
    const inputs = await adapter.validatorInputs(entry);
    const requestBytes = readFileSync(join(inputs.checks.root, REQUEST_FILE));
    const request = parseRecord("JobRequest", requestBytes);
    const expected = parseRecord("ExpectedTrials", readFileSync(join(inputs.checks.root, EXPECTED_TRIALS_FILE)), { request });
    expect(request).toMatchObject({
      kind: "judge_verify",
      project_id: FROZEN_JOB_IDS.project_id,
      execution_id: FROZEN_JOB_IDS.execution_id,
      release_id: FROZEN_JOB_IDS.release_id,
      image_digest: world.pins.runtime.digest,
      runtime_profile_sha256: world.pins.kit.profile_sha256,
      expected_trials_key: `jobs/${FROZEN_JOB_IDS.execution_id}/expected-trials.json`,
    });
    expect(expected.trials.map((trial) => [trial.trial_id, trial.patch_sha256])).toEqual([
      ["clean-01", null],
      ["planted-01", world.pins.plant.patch_sha256],
      ["fixed-01", world.pins.repair.patch_sha256],
    ]);
    for (const trial of expected.trials) {
      expect(trial.original_suite_sha256).toBe(world.pins.original_suite.sha256);
      expect(trial.original_test_ids).toHaveLength(world.pins.original_suite.test_count);
      expect(trial.added_suite_sha256).toBe(world.pins.kit.added_suite_sha256);
      expect(trial.added_repeat_count).toBe(1);
    }
    expect(expected.trials[1]?.expected_checks).toEqual(world.pins.vectors.buggy);
    expect(expected.trials[0]?.expected_checks).toEqual(world.pins.vectors.clean);
    expect(sha256Hex(requestBytes)).toBe(world.pins.job.request_sha256);
  });

  it("gives the expected matrix, the clean reconstruction, the reference repair and the protocol", async () => {
    const { world, adapter, entry } = await setup();
    const inputs = await adapter.validatorInputs(entry);
    expect(inputs.expected).toEqual({
      original_suite: { clean: "pass", buggy: "pass", fixed: "pass" },
      verification: { clean: "pass", buggy: "fail", fixed: "pass" },
    });
    expect(inputs.clean_reconstruction).toEqual({ patch: world.pins.repair.patch, patch_sha256: world.pins.repair.patch_sha256 });
    expect(inputs.reference_repair).toEqual(entry.reference_repair);
    expect(inputs.protocol).toEqual(adapter.protocol(entry));
  });

  it("refuses a store whose frozen suite is not the pinned one", async () => {
    const { world } = await setup();
    const pins = { ...world.pins, original_suite: { ...world.pins.original_suite, test_ids_sha256: "e".repeat(64) } };
    const store = await writeSyntheticStore(world);
    const adapter = buildUmamiAdapter(pins, { store });
    const [entry] = adapter.catalog();
    if (entry === undefined) throw new Error("the catalog is empty");
    expect(await refusal(() => adapter.validatorInputs(entry))).toBe("suite_mismatch");
  });

  it("refuses vectors that differ from the entry's", async () => {
    const { world, store } = await setup();
    const vectors = { ...world.pins.vectors, buggy: world.pins.vectors.clean };
    const adapter = buildUmamiAdapter({ ...world.pins, vectors }, { store });
    const [entry] = adapter.catalog();
    if (entry === undefined) throw new Error("the catalog is empty");
    expect(await refusal(() => adapter.validatorInputs(entry))).toBe("vectors_mismatch");
  });

  it("never writes into the store", async () => {
    const { store, adapter, entry } = await setup();
    const before = hashTree(store);
    await adapter.bugCaseInputs(entry);
    await adapter.validatorInputs(entry);
    expect(hashTree(store)).toEqual(before);
  });
});
