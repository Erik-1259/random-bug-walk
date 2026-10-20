// Export verification, second step: rebuild the three copy states from the EXPORTED buggy source, check
// both patches' results against their recorded hashes, and write each part and each state into its own
// directory of one fresh workspace. Nothing is written until both patches have checked out in memory.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyPatchText,
  CHECKS_DIRECTORY,
  compareUtf8,
  PatchError,
  sameDigests,
  SOURCE_DIRECTORY,
  type PatchMember,
} from "@rbw/case-package";
import type { CopyState, FileSet, UnpackedPair } from "@rbw/factory-contract";
import { sha256Hex } from "@rbw/schema";
import { PairRefused, type VerifiedPair } from "./verify.ts";

export interface Workspace {
  /** The fresh workspace directory; dispose() removes it. */
  root: string;
  unpacked: UnpackedPair;
  dispose(): Promise<void>;
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

function under(prefix: string, members: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  const tree = new Map<string, Uint8Array>();
  for (const [path, bytes] of members) if (path.startsWith(prefix)) tree.set(path.slice(prefix.length), bytes);
  return tree;
}

function rebuild(source: ReadonlyMap<string, Uint8Array>, members: ReadonlyMap<string, Uint8Array>, patch: PatchMember, name: string): Map<string, Uint8Array> {
  const bytes = members.get(patch.path);
  if (bytes === undefined) throw new PairRefused(`the validator package has no ${name}`);
  let text: string;
  try {
    text = strictDecoder.decode(bytes);
  } catch {
    throw new PairRefused(`the ${name} is not UTF-8 text`);
  }
  let result;
  try {
    result = applyPatchText(source, text);
  } catch (error) {
    if (error instanceof PatchError) throw new PairRefused(`the ${name} does not apply to the exported buggy source`, error.message);
    throw error;
  }
  if (!sameDigests(result.changed, patch.result_sha256)) {
    throw new PairRefused(`the ${name} does not reproduce its recorded result on the exported buggy source`, `changed ${JSON.stringify(result.changed)}`);
  }
  return result.files;
}

async function writeTree(root: string, tree: ReadonlyMap<string, Uint8Array>): Promise<FileSet> {
  const paths = [...tree.keys()].sort(compareUtf8);
  for (const path of paths) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, tree.get(path) ?? new Uint8Array(0), { flag: "wx", mode: 0o644 });
  }
  await mkdir(root, { recursive: true });
  return { root, files: paths.map((path) => ({ path, sha256: sha256Hex(tree.get(path) ?? new Uint8Array(0)) })) };
}

/**
 * Builds the workspace: clean = the clean reconstruction applied to the exported buggy source, buggy = the
 * exported source, fixed = the reference repair applied to the exported buggy source. A patch that does not
 * apply, or whose changed paths and hashes differ from its recorded result, refuses the pair.
 */
export async function buildWorkspace(verified: VerifiedPair, parent: string = tmpdir()): Promise<Workspace> {
  const { manifest, members } = verified.validator;
  const buggy = under(SOURCE_DIRECTORY, verified.bug_case.members);
  const states: Record<CopyState, Map<string, Uint8Array>> = {
    clean: rebuild(buggy, members, manifest.clean_reconstruction, "clean reconstruction"),
    buggy,
    fixed: rebuild(buggy, members, manifest.reference_repair, "reference repair"),
  };
  const root = await mkdtemp(join(parent, "rbw-validate-"));
  try {
    await writeTree(join(root, "bug-case"), verified.bug_case.members);
    await writeTree(join(root, "validator"), members);
    const trees = {
      clean: await writeTree(join(root, "states", "clean"), states.clean),
      buggy: await writeTree(join(root, "states", "buggy"), states.buggy),
      fixed: await writeTree(join(root, "states", "fixed"), states.fixed),
    };
    const evaluatorFiles = manifest.files
      .filter((file) => file.path.startsWith(CHECKS_DIRECTORY))
      .map((file) => ({ path: file.path.slice(CHECKS_DIRECTORY.length), sha256: file.sha256 }));
    const unpacked: UnpackedPair = {
      bug_case_sha256: verified.bug_case.sha256,
      validator_sha256: verified.validator.sha256,
      pair_sha256: verified.pair_sha256,
      states: trees,
      evaluator: { root: join(root, "validator", CHECKS_DIRECTORY.slice(0, -1)), files: evaluatorFiles },
      protocol: manifest.protocol,
    };
    return { root, unpacked, dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
