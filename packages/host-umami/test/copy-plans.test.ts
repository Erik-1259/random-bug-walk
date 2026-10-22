import { validateContract } from "@rbw/factory-contract/validate";
import { APP_DIR } from "@rbw/local-runner";
import type { CopyState, UnpackedPair } from "@rbw/factory-contract";
import { afterEach, describe, expect, it } from "vitest";
import { buildUmamiAdapter } from "../src/adapter.ts";
import { COPY_SCRIPT } from "../src/copy-plans.ts";
import { UmamiRefusal } from "../src/errors.ts";
import { EXPECTED_TRIALS_FILE, REQUEST_FILE } from "../src/job.ts";
import { UMAMI_PROTOCOL } from "../src/protocol.ts";
import { filesOf } from "../src/tree.ts";
import { cleanupTemp, evaluatorTree, syntheticWorld, unpackedPair } from "./support.ts";

afterEach(cleanupTemp);

function setup() {
  const world = syntheticWorld();
  const adapter = buildUmamiAdapter(world.pins);
  const evaluator = evaluatorTree(world);
  return { world, adapter, evaluator, pair: unpackedPair(world, evaluator) };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UmamiRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

const STATES: CopyState[] = ["clean", "buggy", "fixed"];

describe("copyPlans", () => {
  it("plans one schema-valid copy per state on the pinned runtime image, running the copy script for that state's trial", () => {
    const { world, adapter, pair } = setup();
    for (const state of STATES) {
      const plans = adapter.copyPlans(state, pair, UMAMI_PROTOCOL);
      expect(plans).toHaveLength(1);
      const [plan] = plans;
      expect(validateContract("CopyPlan", plan)).toEqual([]);
      expect(plan).toMatchObject({ copy_id: `${state}-01`, host_id: "umami", state, image: { reference: world.pins.runtime.image, digest: world.pins.runtime.digest } });
      expect(plan?.image.digest).not.toBe(world.pins.kit.digest);
      expect(plan?.command).toEqual(["/bin/sh", "-c", COPY_SCRIPT, "rbw-copy", "trial", { clean: "clean-01", buggy: "planted-01", fixed: "fixed-01" }[state]]);
      expect(plan?.limits).toEqual({ timeout_s: 720, vcpus: 4, memory_mb: 8192, network: "none" });
    }
  });

  it("places each state's whole source tree, because the runtime image holds no app source", () => {
    const { world, adapter, pair } = setup();
    const buggy = { ...world.source, [world.pins.target.path]: world.pins.target.after_sha256 };
    expect(adapter.copyPlans("clean", pair, UMAMI_PROTOCOL)[0]?.files).toEqual(filesOf(world.source));
    expect(adapter.copyPlans("buggy", pair, UMAMI_PROTOCOL)[0]?.files).toEqual(filesOf(buggy));
    expect(adapter.copyPlans("fixed", pair, UMAMI_PROTOCOL)[0]?.files).toEqual(filesOf(world.source));
  });

  it("declares where the copy script finds the app, the fixture and the job, and writes its record set", () => {
    const { adapter, pair } = setup();
    for (const state of STATES) {
      const [plan] = adapter.copyPlans(state, pair, UMAMI_PROTOCOL);
      expect(plan?.destinations).toEqual({ app: "/workspace/app", evaluator: "/var/lib/rbw", results: "/var/lib/rbw/results/rbw-runner" });
      // The script's own paths: its output directory, and the fixture and the job under the evaluator destination.
      expect(COPY_SCRIPT).toContain(`out=${plan?.destinations.results ?? ""}\n`);
      expect(COPY_SCRIPT).toContain(`placed=${plan?.destinations.evaluator ?? ""}/fixture\n`);
      expect(COPY_SCRIPT).toContain(`run --job ${plan?.destinations.evaluator ?? ""}/job --trial`);
      expect(plan?.evaluator_files.every((file) => file.path.startsWith("fixture/") || file.path.startsWith("job/"))).toBe(true);
    }
  });

  it("places the validator's fixture and the frozen job as evaluator files, and no other validator material", () => {
    const { world, adapter, pair } = setup();
    const fixture = Object.entries(world.fixtureTree).map(([path, sha256]) => ({ path: `fixture/${path}`, sha256 }));
    const job = [
      { path: REQUEST_FILE, sha256: world.pins.job.request_sha256 },
      { path: EXPECTED_TRIALS_FILE, sha256: world.pins.job.expected_trials_sha256 },
    ];
    for (const state of STATES) {
      const files = adapter.copyPlans(state, pair, UMAMI_PROTOCOL)[0]?.evaluator_files ?? [];
      expect(files).toEqual(filesOf(Object.fromEntries([...fixture, ...job].map((file) => [file.path, file.sha256]))));
      expect(files.filter((file) => file.path.startsWith("fixture/"))).toHaveLength(Object.keys(world.fixtureTree).length);
      expect(files.map((file) => file.path)).not.toContain("expected-vectors.json");
    }
  });

  it("moves the fixture where the driver reads it and prepares the app tree before the local runner's freeze and run", () => {
    const lines = COPY_SCRIPT.split("\n");
    const at = (line: string): number => {
      const index = lines.indexOf(line);
      expect(index, line).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at("fixture=/opt/rbw/verifier/kit/umami-fixture")).toBeLessThan(at('  mv "$placed" "$fixture" &&'));
    expect(at('  mv "$placed" "$fixture" &&')).toBeLessThan(at("  /opt/rbw/bin/rbw-prepare-app"));
    // The placed fixture becomes root-only, like the rest of the verifier area.
    expect(lines).toContain('  find "$fixture" -type d -exec chmod 0700 {} + &&');
    expect(lines).toContain('  find "$fixture" -type f -exec chmod 0600 {} + &&');
    expect(at('echo "$status" > "$out/prepare.exit"')).toBeLessThan(at('[ "$status" -eq 0 ] || exit 92'));
    expect(at('[ "$status" -eq 0 ] || exit 92')).toBeLessThan(at('"$node" "$driver" freeze > "$out/freeze.stdout" 2> "$out/freeze.stderr"'));
  });

  it("applies no patch and reads no file: it maps the harness's trees as listed, whatever the roots", () => {
    const { world, adapter, evaluator } = setup();
    // The roots do not exist: the plan comes from the listed trees alone.
    const pair = unpackedPair(world, evaluator);
    expect(pair.states.buggy.root).toBe("/nonexistent/buggy");
    const plan = adapter.copyPlans("buggy", pair, UMAMI_PROTOCOL)[0];
    expect(plan?.files.find((file) => file.path === world.pins.target.path)?.sha256).toBe(world.pins.target.after_sha256);
    // A fixed tree that is not the reference repair's result is refused, never repaired here.
    const tampered = unpackedPair(world, evaluator, { fixed: { ...world.source, [world.pins.target.path]: "c".repeat(64) } });
    expect(refusal(() => adapter.copyPlans("fixed", tampered, UMAMI_PROTOCOL))).toBe("state_tree_mismatch");
  });

  it("refuses a clean reconstruction that is not the pinned source", () => {
    const { world, adapter, evaluator } = setup();
    const pair = unpackedPair(world, evaluator, { clean: { ...world.source, "README.md": "d".repeat(64) } });
    expect(refusal(() => adapter.copyPlans("clean", pair, UMAMI_PROTOCOL))).toBe("clean_tree_mismatch");
  });

  it("refuses a state tree with a missing or an extra file", () => {
    const { world, adapter, evaluator } = setup();
    const withExtra = { ...world.source, [world.pins.target.path]: world.pins.target.after_sha256, "src/extra.ts": "e".repeat(64) };
    expect(refusal(() => adapter.copyPlans("buggy", unpackedPair(world, evaluator, { buggy: withExtra }), UMAMI_PROTOCOL))).toBe("state_tree_mismatch");
    const missing: Record<string, string> = { ...world.source };
    delete missing["README.md"];
    expect(refusal(() => adapter.copyPlans("fixed", unpackedPair(world, evaluator, { fixed: missing }), UMAMI_PROTOCOL))).toBe("state_tree_mismatch");
  });

  it("refuses a buggy tree that changes another file than the entry's target", () => {
    const { world, adapter, evaluator } = setup();
    const other = { ...world.source, "README.md": "f".repeat(64) };
    expect(refusal(() => adapter.copyPlans("buggy", unpackedPair(world, evaluator, { buggy: other }), UMAMI_PROTOCOL))).toBe("state_tree_mismatch");
  });

  it("refuses a tree that changes a closure file, which the original suite runs from its pristine copy", () => {
    const { world, adapter, evaluator } = setup();
    const closure = { ...world.source, [world.pins.target.path]: world.pins.target.after_sha256, "src/lib/analytics-query.ts": "0".repeat(64) };
    expect(refusal(() => adapter.copyPlans("buggy", unpackedPair(world, evaluator, { buggy: closure }), UMAMI_PROTOCOL))).toBe("closure_target");
    const spec = { ...world.source, "tests/api/synthetic.spec.ts": "1".repeat(64) };
    expect(refusal(() => adapter.copyPlans("fixed", unpackedPair(world, evaluator, { fixed: spec }), UMAMI_PROTOCOL))).toBe("closure_target");
  });

  it("refuses validator checks that are not the fixture the pinned kit ran", () => {
    const { world, adapter, evaluator } = setup();
    const [first] = Object.keys(evaluator).filter((path) => path.startsWith("fixture/checks/"));
    if (first === undefined) throw new Error("no check file");
    const changed = { ...evaluator, [first]: "2".repeat(64) };
    expect(refusal(() => adapter.copyPlans("buggy", unpackedPair(world, changed), UMAMI_PROTOCOL))).toBe("checks_not_kit");
    const added = { ...evaluator, "fixture/checks/extra.check.ts": "3".repeat(64) };
    expect(refusal(() => adapter.copyPlans("buggy", unpackedPair(world, added), UMAMI_PROTOCOL))).toBe("checks_not_kit");
  });

  it("refuses a validator whose job or vectors are not the frozen ones", () => {
    const { world, adapter, evaluator } = setup();
    expect(refusal(() => adapter.copyPlans("clean", unpackedPair(world, { ...evaluator, [REQUEST_FILE]: "4".repeat(64) }), UMAMI_PROTOCOL))).toBe("evaluator_mismatch");
    const noTrials = Object.fromEntries(Object.entries(evaluator).filter(([path]) => path !== EXPECTED_TRIALS_FILE));
    expect(refusal(() => adapter.copyPlans("clean", unpackedPair(world, noTrials), UMAMI_PROTOCOL))).toBe("evaluator_mismatch");
    expect(refusal(() => adapter.copyPlans("clean", unpackedPair(world, { ...evaluator, "expected-vectors.json": "5".repeat(64) }), UMAMI_PROTOCOL))).toBe("evaluator_mismatch");
  });

  it("names the malformed tree in its refusal: clean, a state or the validator", () => {
    const { world, adapter, evaluator } = setup();
    const repeat = (pair: UnpackedPair, key: "clean" | "fixed" | "evaluator"): UnpackedPair => {
      const set = key === "evaluator" ? pair.evaluator : pair.states[key];
      const files = [...set.files, ...set.files.slice(0, 1)];
      return key === "evaluator" ? { ...pair, evaluator: { ...set, files } } : { ...pair, states: { ...pair.states, [key]: { ...set, files } } };
    };
    const pair = unpackedPair(world, evaluator);
    expect(refusal(() => adapter.copyPlans("buggy", repeat(pair, "clean"), UMAMI_PROTOCOL))).toBe("clean_tree_mismatch");
    expect(refusal(() => adapter.copyPlans("fixed", repeat(pair, "fixed"), UMAMI_PROTOCOL))).toBe("state_tree_mismatch");
    expect(refusal(() => adapter.copyPlans("buggy", repeat(pair, "evaluator"), UMAMI_PROTOCOL))).toBe("evaluator_mismatch");
  });

  it("uses the local runner's app directory, the one its copies place files in", () => {
    const { adapter, pair } = setup();
    expect(adapter.copyPlans("buggy", pair, UMAMI_PROTOCOL)[0]?.destinations.app).toBe(APP_DIR);
  });

  it("refuses another protocol, given or unpacked", () => {
    const { world, adapter, evaluator, pair } = setup();
    const other = { ...UMAMI_PROTOCOL, valid_trial_rules: [] };
    expect(refusal(() => adapter.copyPlans("clean", pair, other))).toBe("protocol_mismatch");
    const unpacked: UnpackedPair = { ...unpackedPair(world, evaluator), protocol: other };
    expect(refusal(() => adapter.copyPlans("clean", unpacked, UMAMI_PROTOCOL))).toBe("protocol_mismatch");
  });
});
