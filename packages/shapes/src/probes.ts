// Deterministic negative probes for DT-1.tz-arg, stored as data: each patch with its base and
// result hashes and the outcome vector the added checks are expected to give on it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatch, parsePatch, reversePatch, type StructuredPatch } from "diff";
import { decodeUtf8, sha256Hex } from "./hash.ts";

export class ProbeDataError extends Error {
  override name = "ProbeDataError";
}

export type ExpectedCheck =
  | { readonly outcome: "pass" }
  | { readonly outcome: "assertion_fail"; readonly reason: string };

export interface ProbeEntry {
  readonly id: string;
  readonly description: string;
  readonly patch: string;
  readonly base_sha256: string;
  readonly result_sha256: string;
  readonly expected: Readonly<Record<string, ExpectedCheck>>;
}

export interface ProbeData {
  readonly shape_id: string;
  readonly target_path: string;
  readonly host_commit: string;
  readonly clean_sha256: string;
  readonly planted_sha256: string;
  readonly checks: readonly string[];
  readonly fixed_reference: {
    readonly base_sha256: string;
    readonly method: "reverse_mutation_patch";
    readonly note: string;
    readonly result_sha256: string;
  };
  readonly invalid_outcomes: { readonly note: string; readonly outcomes: readonly string[] };
  readonly scope: string;
  readonly probes: readonly ProbeEntry[];
}

export interface ProbeSet {
  readonly data: ProbeData;
  /** Patch text by probe ID. */
  readonly patches: ReadonlyMap<string, string>;
}

export interface ProbeRecord {
  readonly shape_id: string;
  readonly status: "confirmed";
  readonly target_path: string;
  readonly host_commit: string;
  readonly clean_sha256: string;
  readonly planted_sha256: string;
  readonly checks: readonly string[];
  readonly fixed_reference: { readonly base_sha256: string; readonly method: string; readonly result_sha256: string };
  readonly invalid_outcomes: readonly string[];
  readonly probes: readonly {
    readonly id: string;
    readonly base_sha256: string;
    readonly result_sha256: string;
    readonly patch_sha256: string;
    readonly expected: Readonly<Record<string, ExpectedCheck>>;
  }[];
}

export type ProbeOutcome =
  | { readonly status: "confirmed"; readonly record: ProbeRecord }
  | { readonly status: "refused"; readonly reason: string; readonly detail: string };

const SHA256 = /^[0-9a-f]{64}$/;
const MUTATION = "mutation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ProbeDataError(`${where} must be a non-empty string`);
  }
  return value;
}

function hash(value: unknown, where: string): string {
  const checked = text(value, where);
  if (!SHA256.test(checked)) {
    throw new ProbeDataError(`${where} must be a SHA-256 in lowercase hex`);
  }
  return checked;
}

function texts(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProbeDataError(`${where} must be a non-empty list`);
  }
  return value.map((item, index) => text(item, `${where}[${String(index)}]`));
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProbeDataError(`${where} must be an object`);
  }
  return value;
}

function expectedVector(value: unknown, checks: readonly string[], where: string): Record<string, ExpectedCheck> {
  const vector = record(value, where);
  const keys = Object.keys(vector).sort();
  if (keys.join("\n") !== [...checks].sort().join("\n")) {
    throw new ProbeDataError(`${where} must name exactly the listed checks`);
  }
  const result: Record<string, ExpectedCheck> = {};
  for (const key of keys) {
    const entry = record(vector[key], `${where}.${key}`);
    if (entry.outcome === "pass" && Object.keys(entry).length === 1) {
      result[key] = { outcome: "pass" };
    } else if (entry.outcome === "assertion_fail" && Object.keys(entry).length === 2) {
      result[key] = { outcome: "assertion_fail", reason: text(entry.reason, `${where}.${key}.reason`) };
    } else {
      throw new ProbeDataError(`${where}.${key} must be a pass or an assertion_fail with a reason`);
    }
  }
  return result;
}

function parseProbeData(value: unknown): ProbeData {
  const data = record(value, "probe data");
  const checks = texts(data.checks, "checks");
  const fixed = record(data.fixed_reference, "fixed_reference");
  if (fixed.method !== "reverse_mutation_patch") {
    throw new ProbeDataError("fixed_reference.method must be reverse_mutation_patch");
  }
  const invalid = record(data.invalid_outcomes, "invalid_outcomes");
  if (!Array.isArray(data.probes)) {
    throw new ProbeDataError("probes must be a list");
  }
  const probes = data.probes.map((item, index): ProbeEntry => {
    const where = `probes[${String(index)}]`;
    const probe = record(item, where);
    const patch = text(probe.patch, `${where}.patch`);
    if (patch.includes("/") || patch.includes("\\") || patch.startsWith(".")) {
      throw new ProbeDataError(`${where}.patch must be a file name in the probe directory`);
    }
    return {
      id: text(probe.id, `${where}.id`),
      description: text(probe.description, `${where}.description`),
      patch,
      base_sha256: hash(probe.base_sha256, `${where}.base_sha256`),
      result_sha256: hash(probe.result_sha256, `${where}.result_sha256`),
      expected: expectedVector(probe.expected, checks, `${where}.expected`),
    };
  });
  const ids = probes.map((probe) => probe.id);
  if (new Set(ids).size !== ids.length || !ids.includes(MUTATION)) {
    throw new ProbeDataError(`probe IDs must be unique and include ${MUTATION}`);
  }
  return {
    shape_id: text(data.shape_id, "shape_id"),
    target_path: text(data.target_path, "target_path"),
    host_commit: text(data.host_commit, "host_commit"),
    clean_sha256: hash(data.clean_sha256, "clean_sha256"),
    planted_sha256: hash(data.planted_sha256, "planted_sha256"),
    checks,
    fixed_reference: {
      base_sha256: hash(fixed.base_sha256, "fixed_reference.base_sha256"),
      method: "reverse_mutation_patch",
      note: text(fixed.note, "fixed_reference.note"),
      result_sha256: hash(fixed.result_sha256, "fixed_reference.result_sha256"),
    },
    invalid_outcomes: {
      note: text(invalid.note, "invalid_outcomes.note"),
      outcomes: texts(invalid.outcomes, "invalid_outcomes.outcomes"),
    },
    scope: text(data.scope, "scope"),
    probes,
  };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new ProbeDataError(`cannot read ${path}`, { cause: error });
  }
}

// ADM-06: probe data loader for the partial and stub negative probes and the mutation they follow.
export function loadProbeSet(dir: string): ProbeSet {
  let parsed: unknown;
  const raw = readText(join(dir, "probes.json"));
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProbeDataError("probes.json is not valid JSON", { cause: error });
  }
  const data = parseProbeData(parsed);
  const patches = new Map(data.probes.map((probe) => [probe.id, readText(join(dir, probe.patch))]));
  return { data, patches };
}

class Refused extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

/** Parses a probe patch and requires it to change only the target file, in exactly one hunk. */
function targetPatch(data: ProbeData, id: string, patchText: string | undefined): StructuredPatch {
  const patches = parsePatch(patchText ?? "");
  const [patch] = patches;
  if (
    patches.length !== 1 ||
    patch?.oldFileName !== `a/${data.target_path}` ||
    patch.newFileName !== `b/${data.target_path}` ||
    patch.hunks.length !== 1
  ) {
    throw new Refused("patch_scope", `probe ${id} must change only ${data.target_path}, in one hunk`);
  }
  return patch;
}

function apply(id: string, base: string, patch: StructuredPatch): string {
  const result = applyPatch(base, patch);
  if (result === false) {
    throw new Refused("patch_does_not_apply", `probe ${id} does not apply to its base`);
  }
  return result;
}

function check(set: ProbeSet, planted: Uint8Array): ProbeRecord {
  const { data } = set;
  const plantedSha = sha256Hex(planted);
  if (plantedSha !== data.planted_sha256) {
    throw new Refused("base_hash_mismatch", `the planted file hashes to ${plantedSha}, expected ${data.planted_sha256}`);
  }
  const plantedText = decodeUtf8(planted);
  if (plantedText === undefined) {
    throw new Refused("base_hash_mismatch", "the planted file is not valid UTF-8");
  }
  const mutation = targetPatch(data, MUTATION, set.patches.get(MUTATION));
  const clean = apply("fixed reference", plantedText, reversePatch(mutation));
  const cleanSha = sha256Hex(clean);
  const reference = data.fixed_reference;
  if (reference.base_sha256 !== plantedSha || cleanSha !== reference.result_sha256 || cleanSha !== data.clean_sha256) {
    throw new Refused("fixed_reference_mismatch", `restoring the argument gives ${cleanSha}, expected ${data.clean_sha256}`);
  }
  const bases = new Map([
    [plantedSha, plantedText],
    [cleanSha, clean],
  ]);
  const probes = data.probes.map((probe) => {
    const base = bases.get(probe.base_sha256);
    if (base === undefined) {
      throw new Refused("base_hash_mismatch", `probe ${probe.id} names a base that is neither the planted nor the clean file`);
    }
    const patchText = set.patches.get(probe.id);
    const result = apply(probe.id, base, targetPatch(data, probe.id, patchText));
    const resultSha = sha256Hex(result);
    if (resultSha !== probe.result_sha256) {
      throw new Refused("result_hash_mismatch", `probe ${probe.id} gives ${resultSha}, expected ${probe.result_sha256}`);
    }
    return {
      id: probe.id,
      base_sha256: probe.base_sha256,
      result_sha256: resultSha,
      patch_sha256: sha256Hex(patchText ?? ""),
      expected: probe.expected,
    };
  });
  return {
    shape_id: data.shape_id,
    status: "confirmed",
    target_path: data.target_path,
    host_commit: data.host_commit,
    clean_sha256: cleanSha,
    planted_sha256: plantedSha,
    checks: data.checks,
    fixed_reference: { base_sha256: reference.base_sha256, method: reference.method, result_sha256: cleanSha },
    invalid_outcomes: data.invalid_outcomes.outcomes,
    probes,
  };
}

/**
 * Applies every probe to its recorded base and checks its recorded result hash. The planted file
 * must hash to the recorded planted hash: a patch that would also apply textually to another file
 * is refused there by hash, not by whether it applies.
 */
export function checkProbes(set: ProbeSet, planted: Uint8Array): ProbeOutcome {
  try {
    return { status: "confirmed", record: check(set, planted) };
  } catch (error) {
    if (error instanceof Refused) {
      return { status: "refused", reason: error.reason, detail: error.message };
    }
    throw error;
  }
}
