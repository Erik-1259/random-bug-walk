// Copy plans: one plan per copy the protocol declares, placing the trees the harness built from
// the EXPORTED bug case (clean reconstructed, buggy as exported, fixed = the reference repair on
// the exported buggy source) in the pinned runtime image. No patch is applied here.
//
// The runtime image holds no app source and no fixture, so a plan places the state's whole tree
// at /workspace/app and the validator's fixture and frozen job under /var/lib/rbw. The clean tree
// must be the pinned source, and each state's tree may differ from it only by the entry's change
// for that state: a missing or extra file, or a change to the original suite's closure, is
// refused. The validator's fixture must be the one the pinned kit ran (its added-suite hash) and
// its job the frozen one, or the plan is refused, so a copy runs exactly the validator's checks.
import { COPY_OUTER_LIMIT_MS } from "@rbw/local-runner/shared";
import type { CatalogEntry, CopyPlan, CopyState, FileDigest, Protocol, UnpackedPair } from "@rbw/factory-contract";
import { isClosurePath } from "./closure.ts";
import { UmamiRefusal } from "./errors.ts";
import { EXPECTED_TRIALS_FILE, REQUEST_FILE } from "./job.ts";
import { CHECKS_LAYOUT } from "./inputs.ts";
import type { UmamiPins } from "./pins.ts";
import { TRIAL_OF_STATE, isUmamiProtocol } from "./protocol.ts";
import { diffTrees, filesOf, subtree, treeOf, treeSha256 } from "./tree.ts";
import type { Tree } from "./tree.ts";

/**
 * Where a copy's files go: the app tree at /workspace/app, the validator's `fixture/` and `job/`
 * directories under /var/lib/rbw (the copy script moves the fixture where the driver reads it and
 * reads the job at /var/lib/rbw/job), and the results directory the copy script writes (exit
 * statuses, and the driver's record set under `out/`).
 */
export const UMAMI_COPY_DESTINATIONS = {
  app: "/workspace/app",
  evaluator: "/var/lib/rbw",
  results: "/var/lib/rbw/results/rbw-runner",
} as const;

/**
 * What the copy script does before the local runner's steps, in the runtime image: it moves the
 * placed fixture to the driver's fixture path (/opt/rbw/verifier/kit/umami-fixture), root-only like
 * the rest of the verifier area, and readies the placed app tree with the image's
 * rbw-prepare-app. It writes the exit status to prepare.exit and stops with 92 on a failure.
 */
export const COPY_PREPARE: readonly string[] = [
  "placed=/var/lib/rbw/fixture",
  "fixture=/opt/rbw/verifier/kit/umami-fixture",
  "{",
  '  [ -d "$placed" ] && [ ! -e "$fixture" ] &&',
  '  mv "$placed" "$fixture" &&',
  '  chown -R root:root "$fixture" &&',
  '  find "$fixture" -type d -exec chmod 0700 {} + &&',
  '  find "$fixture" -type f -exec chmod 0600 {} + &&',
  "  /opt/rbw/bin/rbw-prepare-app",
  '} > "$out/prepare.stdout" 2> "$out/prepare.stderr"',
  "status=$?",
  'echo "$status" > "$out/prepare.exit"',
  '[ "$status" -eq 0 ] || exit 92',
];

/** The local runner's copy script (tools/local-runner COPY_SCRIPT), byte for byte; a test compares the two. */
const RUNNER_SCRIPT_HEAD = [
  "set -u",
  "out=/var/lib/rbw/results/rbw-runner",
  "node=/opt/rbw/verifier/node/bin/node",
  "driver=/opt/rbw/verifier/kit/umami-driver/src/cli.ts",
  'mkdir -p "$out" || exit 90',
];

const RUNNER_SCRIPT_TAIL = [
  'if [ "$#" -ge 3 ]; then',
  '  /opt/rbw/bin/rbw-proxy set-latency "$3" > "$out/proxy.stdout" 2> "$out/proxy.stderr"',
  "  status=$?",
  '  echo "$status" > "$out/proxy.exit"',
  '  [ "$status" -eq 0 ] || exit 91',
  "fi",
  'if [ "$1" = freeze ]; then',
  '  "$node" "$driver" freeze --out "$out/original-suite.json" > "$out/freeze.stdout" 2> "$out/freeze.stderr"',
  "  status=$?",
  '  echo "$status" > "$out/freeze.exit"',
  '  exit "$status"',
  "fi",
  '"$node" "$driver" freeze > "$out/freeze.stdout" 2> "$out/freeze.stderr"',
  "status=$?",
  'echo "$status" > "$out/freeze.exit"',
  '[ "$status" -eq 0 ] || exit 90',
  '"$node" "$driver" run --job /var/lib/rbw/job --trial "$2" --out "$out/out" > "$out/run.stdout" 2> "$out/run.stderr"',
  "status=$?",
  'echo "$status" > "$out/run.exit"',
  'exit "$status"',
];

/**
 * The copy script: the fixture placement and app preparation (COPY_PREPARE) after the local
 * runner's output directory is made, then the local runner's own steps unchanged. It runs only the
 * image's preparation script, the verifier's Node and the protected driver: `freeze`, then `run`
 * of the job's trial, writing each exit status beside the output.
 */
export const COPY_SCRIPT = [...RUNNER_SCRIPT_HEAD, ...COPY_PREPARE, ...RUNNER_SCRIPT_TAIL].join("\n");

/** The kit's copy resources (4 vCPU, 8 GB, no network) and its outer limit: the driver's 600 s plus 120 s. */
export const COPY_LIMITS = { timeout_s: COPY_OUTER_LIMIT_MS / 1000, vcpus: 4, memory_mb: 8192, network: "none" } as const;

/** The copy script run as the local runner runs it for one trial of the frozen job. */
export function copyCommand(trialId: string): string[] {
  return ["/bin/sh", "-c", COPY_SCRIPT, "rbw-copy", "trial", trialId];
}

/** The refusal code for a malformed tree: the clean tree, the validator's or a state's. */
const MALFORMED_CODE = { clean: "clean_tree_mismatch", evaluator: "evaluator_mismatch" } as const;

function treeOrRefuse(files: readonly FileDigest[], what: CopyState | "evaluator"): Tree {
  const tree = treeOf(files);
  const code = what === "clean" || what === "evaluator" ? MALFORMED_CODE[what] : "state_tree_mismatch";
  if (tree === null) throw new UmamiRefusal(code, `the ${what} tree repeats a path or has a malformed hash`);
  return tree;
}

/** The files of a state's tree that differ from the pinned source; refuses missing, extra and closure files. */
function changesFrom(source: Tree, state: Tree, what: string): Record<string, string> {
  const diff = diffTrees(source, state);
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    throw new UmamiRefusal("state_tree_mismatch", `the ${what} tree differs from the pinned source's file list (missing ${String(diff.missing.length)}, extra ${String(diff.extra.length)})`);
  }
  const closure = diff.changed.filter(isClosurePath);
  if (closure.length > 0) throw new UmamiRefusal("closure_target", `the ${what} tree changes ${closure.join(", ")}, which the original suite runs from its pristine copy`);
  const changed: Record<string, string> = {};
  for (const path of diff.changed) changed[path] = state[path] ?? "";
  return changed;
}

const sameTree = (left: Tree, right: Tree): boolean => treeSha256(left) === treeSha256(right);

/** The changes each state's tree must make to the pinned source, for this entry. */
function expectedChanges(entry: CatalogEntry, source: Tree): Record<CopyState, Tree> {
  const buggy: Record<string, string> = {};
  for (const target of entry.plant.targets) buggy[target.path] = target.after_sha256;
  const fixed: Record<string, string> = {};
  for (const file of entry.reference_repair.result_sha256) if (source[file.path] !== file.sha256) fixed[file.path] = file.sha256;
  return { clean: {}, buggy, fixed };
}

/** The catalog entry whose planted change the buggy tree carries. */
function entryOf(catalog: readonly CatalogEntry[], source: Tree, buggy: Tree): CatalogEntry {
  const changes = changesFrom(source, buggy, "buggy");
  const entry = catalog.find((item) => item.plant.targets.every((target) => source[target.path] === target.before_sha256) && sameTree(expectedChanges(item, source).buggy, changes));
  if (entry === undefined) throw new UmamiRefusal("state_tree_mismatch", "the buggy tree carries no catalog entry's planted change");
  return entry;
}

/** The evaluator files a copy gets, the validator's fixture and frozen job; refuses any other fixture, vectors or job. */
function checkEvaluator(pins: UmamiPins, entry: CatalogEntry, evaluator: Tree): FileDigest[] {
  const fixture = subtree(evaluator, CHECKS_LAYOUT.fixture);
  const fixtureSha256 = treeSha256(fixture);
  if (fixtureSha256 !== pins.kit.added_suite_sha256 || fixtureSha256 !== entry.verification.check_set_sha256) {
    throw new UmamiRefusal("checks_not_kit", "the validator's fixture is not the one the pinned kit image ran");
  }
  if (evaluator[CHECKS_LAYOUT.vectors] !== entry.verification.expected_vectors_sha256) throw new UmamiRefusal("evaluator_mismatch", "the validator's expected vectors are not the entry's");
  const job = [
    { path: REQUEST_FILE, sha256: pins.job.request_sha256 },
    { path: EXPECTED_TRIALS_FILE, sha256: pins.job.expected_trials_sha256 },
  ];
  for (const file of job) if (evaluator[file.path] !== file.sha256) throw new UmamiRefusal("evaluator_mismatch", `the validator's ${file.path} is not the frozen job`);
  const placed: Record<string, string> = {};
  for (const [path, sha256] of Object.entries(fixture)) placed[`${CHECKS_LAYOUT.fixture}${path}`] = sha256;
  for (const file of job) placed[file.path] = file.sha256;
  return filesOf(placed);
}

export function copyPlans(pins: UmamiPins, catalog: readonly CatalogEntry[], state: CopyState, unpacked: UnpackedPair, protocol: Protocol): CopyPlan[] {
  if (!isUmamiProtocol(protocol) || !isUmamiProtocol(unpacked.protocol)) throw new UmamiRefusal("protocol_mismatch", "the protocol is not the Umami catalog's");
  const source = treeOrRefuse(unpacked.states.clean.files, "clean");
  if (treeSha256(source) !== pins.kit.source_tree_sha256) throw new UmamiRefusal("clean_tree_mismatch", "the clean reconstruction is not the pinned source");
  const entry = entryOf(catalog, source, treeOrRefuse(unpacked.states.buggy.files, "buggy"));
  const tree = treeOrRefuse(unpacked.states[state].files, state);
  if (!sameTree(changesFrom(source, tree, state), expectedChanges(entry, source)[state])) throw new UmamiRefusal("state_tree_mismatch", `the ${state} tree is not the entry's ${state} state`);
  const evaluatorFiles = checkEvaluator(pins, entry, treeOrRefuse(unpacked.evaluator.files, "evaluator"));
  const { copies } = protocol.per_state[state];
  if (copies !== 1) throw new UmamiRefusal("protocol_mismatch", "the judge_verify profile runs one copy per state");
  return [
    {
      copy_id: `${state}-01`,
      host_id: "umami",
      state,
      image: { reference: pins.runtime.image, digest: pins.runtime.digest },
      // The whole tree: the runtime image holds no app source.
      files: filesOf(tree),
      evaluator_files: evaluatorFiles,
      destinations: { ...UMAMI_COPY_DESTINATIONS },
      command: copyCommand(TRIAL_OF_STATE[state]),
      limits: { ...COPY_LIMITS },
    },
  ];
}
