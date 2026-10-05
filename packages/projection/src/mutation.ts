import { parseDiff, type FilePatch } from "./diff.ts";
import { HEX40, HEX64, InputError, arrayField, parseJson, repoPath, strictObject, stringField } from "./input.ts";
import type { Manifest } from "./manifest.ts";

export interface MutatedFile {
  path: string;
  mode: "100644" | "100755";
  original_sha256: string;
  result_sha256: string;
  patch: FilePatch;
}

const MUTATION = "malformed_mutation";

/**
 * ADM-01: the one permitted source change. This item supports modifications only: each file
 * is in the manifest, not excluded, keeps its mode and starts from its pinned hash, and the
 * diff touches exactly the listed files.
 */
export function parseMutation(text: string, manifest: Manifest, excluded: ReadonlyMap<string, unknown>): Map<string, MutatedFile> {
  const top = strictObject(parseJson(text, MUTATION), ["diff", "files", "host_commit"], [], MUTATION);
  const hostCommit = stringField(top, "host_commit", MUTATION);
  if (!HEX40.test(hostCommit) || hostCommit !== manifest.host_commit) throw new InputError(MUTATION);
  const pinned = new Map(manifest.files.map((file) => [file.path, file]));
  const patches = new Map(parseDiff(stringField(top, "diff", MUTATION)).map((patch) => [patch.path, patch]));
  const files = new Map<string, MutatedFile>();
  for (const item of arrayField(top, "files", MUTATION)) {
    const entry = strictObject(item, ["mode", "original_sha256", "path", "result_sha256"], [], MUTATION);
    const path = repoPath(entry.path, MUTATION);
    const mode = stringField(entry, "mode", MUTATION);
    const original = stringField(entry, "original_sha256", MUTATION);
    const result = stringField(entry, "result_sha256", MUTATION);
    const file = pinned.get(path);
    const patch = patches.get(path);
    if (file === undefined || excluded.has(path) || files.has(path) || patch === undefined) throw new InputError(MUTATION);
    if (mode !== file.mode || !HEX64.test(original) || !HEX64.test(result) || original !== file.sha256 || result === original) throw new InputError(MUTATION);
    files.set(path, { path, mode: file.mode, original_sha256: original, result_sha256: result, patch });
  }
  if (files.size === 0 || files.size !== patches.size) throw new InputError(MUTATION);
  return files;
}
