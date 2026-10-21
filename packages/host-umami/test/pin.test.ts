// runtimePins: the runtime pin and the frozen job's hashes for a runtime image, read from a prepared store.
import { describe, expect, it, afterEach } from "vitest";
import { buildUmamiAdapter } from "../src/adapter.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { buildFrozenJob } from "../src/job.ts";
import { runtimePins } from "../src/pin-cli.ts";
import { SYNTHETIC_TEST_IDS, cleanupTemp, syntheticWorld, writeSyntheticStore } from "./support.ts";

afterEach(cleanupTemp);

const ARM64 = { image: "synthetic/umami-runtime-arm64", digest: `sha256:${"d".repeat(64)}`, architecture: "arm64" } as const;

describe("runtimePins", () => {
  it("gives the frozen job's hashes for the runtime image, from the store's frozen suite", async () => {
    const world = syntheticWorld();
    const store = await writeSyntheticStore(world);
    const pinned = await runtimePins(world.pins, store, ARM64);
    const job = buildFrozenJob({ ...world.pins, runtime: ARM64 }, SYNTHETIC_TEST_IDS);
    expect(pinned).toEqual({ runtime: ARM64, job: { request_sha256: job.requestSha256, expected_trials_sha256: job.expectedSha256 } });
    // The job names the runtime digest, so another runtime gives another job.
    expect(pinned.job.request_sha256).not.toBe(world.pins.job.request_sha256);
    expect(await runtimePins(world.pins, store, world.pins.runtime)).toEqual({ runtime: world.pins.runtime, job: world.pins.job });
  });

  it("gives pins the adapter accepts: the validator's job is the pinned frozen job", async () => {
    const world = syntheticWorld();
    const store = await writeSyntheticStore(world);
    const pinned = await runtimePins(world.pins, store, ARM64);
    const adapter = buildUmamiAdapter({ ...world.pins, ...pinned }, { store });
    const [entry] = adapter.catalog();
    if (entry === undefined) throw new Error("the catalog is empty");
    expect(entry.environment.kit_image_digest).toBe(ARM64.digest);
    await expect(adapter.validatorInputs(entry)).resolves.toMatchObject({ host_id: "umami" });
    await expect(buildUmamiAdapter({ ...world.pins, runtime: ARM64 }, { store }).validatorInputs(entry)).rejects.toThrow(/evaluator_mismatch/);
  });

  it("refuses a store that is not the pins' kit image's", async () => {
    const world = syntheticWorld();
    const store = await writeSyntheticStore(world);
    const other = { ...world.pins, kit: { ...world.pins.kit, digest: `sha256:${"9".repeat(64)}` } };
    await expect(runtimePins(other, store, ARM64)).rejects.toThrow(UmamiRefusal);
  });
});
