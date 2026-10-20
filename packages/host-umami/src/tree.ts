// A tree is a map from relative path to the file's SHA-256. Its hash is the canonical JSON v1 hash
// of that map, the same rule the driver uses for the fixture's added-suite hash.
import { canonicalDigest } from "@rbw/schema";
import type { FileDigest } from "@rbw/factory-contract";

export type Tree = Readonly<Record<string, string>>;

const SHA256 = /^[0-9a-f]{64}$/;

export function treeSha256(tree: Tree): string {
  return canonicalDigest(tree).sha256;
}

/** A FileSet's file list as a tree; null when a path repeats or a hash is malformed. */
export function treeOf(files: readonly FileDigest[]): Record<string, string> | null {
  const tree: Record<string, string> = {};
  for (const file of files) {
    if (Object.hasOwn(tree, file.path) || !SHA256.test(file.sha256)) return null;
    tree[file.path] = file.sha256;
  }
  return tree;
}

/** The tree as a FileSet file list, sorted by path in code point order. */
export function filesOf(tree: Tree): FileDigest[] {
  return Object.keys(tree)
    .sort(byCodePoint)
    .map((path) => ({ path, sha256: tree[path] ?? "" }));
}

export function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface TreeDiff {
  /** Paths in both trees whose hashes differ, sorted. */
  changed: string[];
  /** Paths only in the base tree. */
  missing: string[];
  /** Paths only in the other tree. */
  extra: string[];
}

export function diffTrees(base: Tree, other: Tree): TreeDiff {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [path, sha256] of Object.entries(base)) {
    const found = other[path];
    if (found === undefined) missing.push(path);
    else if (found !== sha256) changed.push(path);
  }
  const extra = Object.keys(other).filter((path) => !Object.hasOwn(base, path));
  return { changed: changed.sort(byCodePoint), missing: missing.sort(byCodePoint), extra: extra.sort(byCodePoint) };
}

/** The files under a prefix ("fixture/"), with the prefix removed. */
export function subtree(tree: Tree, prefix: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [path, sha256] of Object.entries(tree)) if (path.startsWith(prefix)) found[path.slice(prefix.length)] = sha256;
  return found;
}
