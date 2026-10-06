// The code state of each copy, made on the trusted side before the build. Patches are applied as
// data with the diff library, never by running anything; each base, result and scope is checked
// against the hashes recorded in the shapes package's probes.json (or this package's record for
// the alternative fix), and only the target file ever changes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, parsePatch, reversePatch, structuredPatch } from "diff";
import type { StructuredPatch, StructuredPatchHunk } from "diff";
import { canonicalJson } from "@rbw/projection";
import { sha256Hex } from "@rbw/schema";
import type { CodeState } from "@rbw/schema";
import { DT1_TARGET } from "@rbw/shapes";
import type { ProbeSet } from "@rbw/shapes";

/** This package's alternative fix: `alternative-fix.json` and the patch it names. */
export const ALTERNATIVE_FIX_DIR = fileURLToPath(new URL("../probes/", import.meta.url));

export type StateKey = CodeState | "alternative_fix";

export const STATE_KEYS: readonly StateKey[] = ["clean", "planted", "fixed", "partial", "stub", "alternative_fix"];

export interface StateFile {
  key: StateKey;
  /** The code state a trial records for this file; the alternative fix is a fixed state. */
  code_state: CodeState;
  path: string;
  bytes: Buffer;
  sha256: string;
  /** The patch that makes this file from its base (the clean or the planted file); null for clean. */
  patch_text: string | null;
  patch_sha256: string | null;
  /** The projection audit's declared mutation against the clean file; null when the bytes are the clean file's. */
  declared_mutation: string | null;
}

export type CodeStates = ReadonlyMap<StateKey, StateFile>;

export type CodeStateRefusalReason =
  | "base_hash_mismatch"
  | "result_hash_mismatch"
  | "patch_scope"
  | "patch_does_not_apply"
  | "fixed_not_clean"
  | "not_utf8"
  | "alternative_fix_invalid";

export class CodeStateRefusal extends Error {
  override name = "CodeStateRefusal";
  readonly reason: CodeStateRefusalReason;

  constructor(reason: CodeStateRefusalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

export interface AlternativeFix {
  target_path: string;
  base_sha256: string;
  result_sha256: string;
  patch: string;
  patch_sha256: string;
  record_sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function loadAlternativeFix(dir = ALTERNATIVE_FIX_DIR): AlternativeFix {
  const recordBytes = readFileSync(join(dir, "alternative-fix.json"));
  const record = JSON.parse(recordBytes.toString("utf8")) as Record<string, unknown>;
  const { base_sha256: base, result_sha256: result, target_path: target, patch } = record;
  if (typeof base !== "string" || !SHA256.test(base) || typeof result !== "string" || !SHA256.test(result) || typeof target !== "string") {
    throw new CodeStateRefusal("alternative_fix_invalid", "alternative-fix.json needs base_sha256, result_sha256 and target_path");
  }
  if (typeof patch !== "string" || patch.includes("/") || patch.startsWith(".")) {
    throw new CodeStateRefusal("alternative_fix_invalid", "alternative-fix.json must name a patch file beside it");
  }
  const text = readFileSync(join(dir, patch), "utf8");
  return { target_path: target, base_sha256: base, result_sha256: result, patch: text, patch_sha256: sha256Hex(Buffer.from(text)), record_sha256: sha256Hex(recordBytes) };
}

function utf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new CodeStateRefusal("not_utf8", `${what} is not valid UTF-8`);
    throw error;
  }
}

/** Parses a patch and requires it to change only the target file. */
function targetPatch(patchText: string, target: string): StructuredPatch {
  const patches = parsePatch(patchText);
  const [patch] = patches;
  if (patches.length !== 1 || patch?.oldFileName !== `a/${target}` || patch.newFileName !== `b/${target}` || patch.hunks.length === 0) {
    throw new CodeStateRefusal("patch_scope", `the patch must change only ${target}`);
  }
  return patch;
}

function hunkText(hunk: StructuredPatchHunk): string {
  return `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@\n${hunk.lines.map((line) => `${line}\n`).join("")}`;
}

/** A git-style diff of one file, in the form the projection audit and the probe patches use. */
export function gitDiff(path: string, hunks: readonly StructuredPatchHunk[]): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.map(hunkText).join("")}`;
}

export interface PatchExpectation {
  target: string;
  base_sha256: string;
  result_sha256: string;
}

/** Applies a patch to its recorded base, checking the base hash, the scope and the result hash. */
export function applyPatchChecked(base: Uint8Array, patchText: string, expected: PatchExpectation): Buffer {
  const baseSha = sha256Hex(base);
  if (baseSha !== expected.base_sha256) {
    throw new CodeStateRefusal("base_hash_mismatch", `the base hashes to ${baseSha}, expected ${expected.base_sha256}`);
  }
  const patch = targetPatch(patchText, expected.target);
  const result = applyPatch(utf8(base, "the base"), patch);
  if (result === false) throw new CodeStateRefusal("patch_does_not_apply", "the patch does not apply to its base");
  const bytes = Buffer.from(result, "utf8");
  const resultSha = sha256Hex(bytes);
  if (resultSha !== expected.result_sha256) {
    throw new CodeStateRefusal("result_hash_mismatch", `the result hashes to ${resultSha}, expected ${expected.result_sha256}`);
  }
  return bytes;
}

/** The line hunks from one file to another, with three lines of context. */
function lineHunks(before: Buffer, after: Buffer): StructuredPatchHunk[] {
  return structuredPatch("a", "b", before.toString("utf8"), after.toString("utf8"), undefined, undefined, { context: 3 }).hunks;
}

function declaredMutation(path: string, hostCommit: string, clean: Buffer, result: Buffer, diff: string | null): string {
  return canonicalJson({
    diff: diff ?? gitDiff(path, lineHunks(clean, result)),
    files: [{ mode: DT1_TARGET.mode, original_sha256: sha256Hex(clean), path, result_sha256: sha256Hex(result) }],
    host_commit: hostCommit,
  });
}

/**
 * Every code state's target file, from the clean file the image holds:
 * planted by the mutation patch; fixed by reversing it on the planted file, which must give the
 * clean bytes; partial and stub by their probe patches on their recorded bases; the alternative
 * fix by this package's patch on the planted file.
 */
export function deriveCodeStates(clean: Buffer, probes: ProbeSet, alternative: AlternativeFix): Map<StateKey, StateFile> {
  const { data } = probes;
  const target = data.target_path;
  const cleanSha = sha256Hex(clean);
  if (cleanSha !== data.clean_sha256) {
    throw new CodeStateRefusal("base_hash_mismatch", `the image's ${target} hashes to ${cleanSha}, expected ${data.clean_sha256}`);
  }
  const probe = (id: string) => {
    const entry = data.probes.find((item) => item.id === id);
    const text = probes.patches.get(id);
    if (entry === undefined || text === undefined) throw new CodeStateRefusal("patch_scope", `probes.json has no ${id} probe`);
    return { entry, text };
  };
  const states = new Map<StateKey, StateFile>();
  const add = (key: StateKey, codeState: CodeState, bytes: Buffer, patchText: string | null, diff: string | null = null): Buffer => {
    const same = bytes.equals(clean);
    states.set(key, {
      key,
      code_state: codeState,
      path: target,
      bytes,
      sha256: sha256Hex(bytes),
      patch_text: patchText,
      patch_sha256: patchText === null ? null : sha256Hex(Buffer.from(patchText)),
      declared_mutation: same ? null : declaredMutation(target, data.host_commit, clean, bytes, diff),
    });
    return bytes;
  };

  add("clean", "clean", clean, null);
  const mutation = probe("mutation");
  if (mutation.entry.result_sha256 !== data.planted_sha256) {
    throw new CodeStateRefusal("result_hash_mismatch", "the mutation probe's result is not the recorded planted file");
  }
  const planted = add(
    "planted",
    "planted",
    applyPatchChecked(clean, mutation.text, { target, base_sha256: mutation.entry.base_sha256, result_sha256: mutation.entry.result_sha256 }),
    mutation.text,
    mutation.text,
  );

  const reversed = reversePatch(targetPatch(mutation.text, target));
  const reference = data.fixed_reference;
  if (sha256Hex(planted) !== reference.base_sha256) {
    throw new CodeStateRefusal("base_hash_mismatch", "the fixed reference's base is not the planted file");
  }
  const restored = applyPatch(utf8(planted, "the planted file"), reversed);
  const fixed = restored === false ? null : Buffer.from(restored, "utf8");
  if (fixed?.equals(clean) !== true || reference.result_sha256 !== cleanSha || data.clean_sha256 !== cleanSha) {
    throw new CodeStateRefusal("fixed_not_clean", "reversing the mutation on the planted file must give the clean file's exact bytes");
  }
  add("fixed", "fixed", fixed, gitDiff(target, lineHunks(planted, fixed)));

  const bases = new Map([
    [cleanSha, clean],
    [sha256Hex(planted), planted],
  ]);
  for (const id of ["partial", "stub"] as const) {
    const { entry, text } = probe(id);
    const base = bases.get(entry.base_sha256);
    if (base === undefined) throw new CodeStateRefusal("base_hash_mismatch", `probe ${id} names a base that is neither the clean nor the planted file`);
    add(id, id, applyPatchChecked(base, text, { target, base_sha256: entry.base_sha256, result_sha256: entry.result_sha256 }), text);
  }

  if (alternative.target_path !== target) throw new CodeStateRefusal("patch_scope", `the alternative fix must change only ${target}`);
  const alternativeBytes = applyPatchChecked(planted, alternative.patch, {
    target,
    base_sha256: alternative.base_sha256,
    result_sha256: alternative.result_sha256,
  });
  if (alternativeBytes.equals(clean)) throw new CodeStateRefusal("alternative_fix_invalid", "the alternative fix must differ from the clean file");
  add("alternative_fix", "fixed", alternativeBytes, alternative.patch);
  return states;
}

/** The derived state a trial names by its code state and patch hash, or null when none matches. */
export function stateForPatch(states: CodeStates, codeState: CodeState, patchSha256: string | null): StateFile | null {
  for (const state of states.values()) {
    if (state.code_state === codeState && state.patch_sha256 === patchSha256) return state;
  }
  return null;
}
