// Applies a git-style, modify-only patch to an in-memory tree with the repository's strict applier
// (@rbw/projection: exact hunk positions, no fuzz; new, deleted, renamed, mode-change and binary sections
// are refused). Paths in the patch are relative to the tree's root.
import type { FileDigest } from "@rbw/factory-contract";
import { applyPatch, InputError, parseDiff } from "@rbw/projection";
import { sha256Hex } from "@rbw/schema";
import { compareUtf8 } from "./archive.ts";

/** Raised when a patch is malformed, names a missing file or does not apply. The message names no path. */
export class PatchError extends Error {
  constructor(reason: string) {
    super(`patch: ${reason}`);
    this.name = "PatchError";
  }
}

export interface PatchedTree {
  files: Map<string, Uint8Array>;
  /** Every path the patch changed, with its new SHA-256, by UTF-8 path order. */
  changed: FileDigest[];
}

export function applyPatchText(tree: ReadonlyMap<string, Uint8Array>, patch: string): PatchedTree {
  let sections;
  try {
    sections = parseDiff(patch);
  } catch (error) {
    if (error instanceof InputError) throw new PatchError("not a git-style patch that only modifies files");
    throw error;
  }
  const files = new Map(tree);
  const changed: FileDigest[] = [];
  for (const section of sections) {
    const original = files.get(section.path);
    if (original === undefined) throw new PatchError("names a file the tree does not have");
    const result = applyPatch(Buffer.from(original), section, "forward");
    if (result === null) throw new PatchError("does not apply to the tree");
    const bytes = new Uint8Array(result);
    files.set(section.path, bytes);
    changed.push({ path: section.path, sha256: sha256Hex(bytes) });
  }
  changed.sort((a, b) => compareUtf8(a.path, b.path));
  return { files, changed };
}

/** True when the changed paths and hashes equal the recorded result exactly (both in path order). */
export function sameDigests(a: readonly FileDigest[], b: readonly FileDigest[]): boolean {
  const sorted = (list: readonly FileDigest[]) => [...list].sort((x, y) => compareUtf8(x.path, y.path));
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((item, index) => item.path === right[index]?.path && item.sha256 === right[index].sha256);
}
