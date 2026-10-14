// A UC1 case file: the admitted bug a run is for, its screen record, the bug report every attempt
// gets, the pinned kit image, and the inputs the session and the controller's grades need. Paths
// are resolved against the current directory, as the other tools resolve theirs.
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_FAMILY, FAMILY_IDS } from "@rbw/local-runner";
import type { FamilyId } from "@rbw/local-runner";
import { sha256Hex } from "@rbw/schema";
import { PILOT_CASE_ID } from "./plan.ts";
import type { RunMode } from "./plan.ts";

export interface CaseConfig {
  /** The admitted case's ID, such as umami-tz-arg-001. */
  case_id: string;
  /** The bug family (time-zone or race): the session's code states and both grades use its fixture, stage and probe checks. */
  family: FamilyId;
  /** The case's screen record, docs/uc1-screen/<case-id>.json. */
  screen_record: string;
  /** The bug report, as released: the same text in every attempt of both arms. */
  issue: string;
  /** The local kit image (tag or digest) the sessions run; it must resolve to image_digest. */
  image: string;
  /** The content digest the case admits (the local image ID); grade 1 runs it, and a session on any other digest is refused. */
  image_digest: string;
  /** Grade 2's kit image in the registry, pinned by digest (the controller's --sandbox-image). */
  sandbox_image: string;
  manifest: string;
  terms: string;
  /** The projection audit policy; null for none. */
  audit_policy: string | null;
  /** The shapes package's probe directory; null for the local runner's default. */
  probes_dir: string | null;
  /** The case's committed alternative fix directory (the clean-equal route needs it). */
  reference_fix: string;
  kit_stage: string;
  /** The frozen original suite; null lets the controller's freeze copy make it. */
  original_suite: string | null;
}

export class CaseError extends Error {
  override name = "CaseError";
}

const FIELDS = ["case_id", "family", "screen_record", "issue", "image", "image_digest", "sandbox_image", "manifest", "terms", "audit_policy", "probes_dir", "reference_fix", "kit_stage", "original_suite"] as const;
const NULLABLE = new Set<string>(["audit_policy", "probes_dir", "original_suite"]);
const PATHS = new Set<string>(["screen_record", "issue", "manifest", "terms", "audit_policy", "probes_dir", "reference_fix", "kit_stage", "original_suite"]);
const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a case file's bytes; every field is required, unknown fields are refused, paths are resolved. */
export function parseCase(bytes: Uint8Array): CaseConfig {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new CaseError("the case file is not JSON");
  }
  if (!isRecord(data)) throw new CaseError("the case file must be a JSON object");
  const extra = Object.keys(data).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) throw new CaseError(`the case file has unknown fields: ${extra.join(", ")}`);
  const out: Record<string, string | null> = {};
  for (const field of FIELDS) {
    const value = data[field];
    if (value === null && NULLABLE.has(field)) {
      out[field] = null;
      continue;
    }
    if (typeof value !== "string" || value === "") throw new CaseError(`the case file's ${field} must be a non-empty string${NULLABLE.has(field) ? " or null" : ""}`);
    out[field] = PATHS.has(field) ? resolve(value) : value;
  }
  const config = out as unknown as CaseConfig;
  if (!CASE_ID.test(config.case_id)) throw new CaseError("case_id must be lower-case letters, digits and single hyphens");
  if (!(FAMILY_IDS as readonly string[]).includes(config.family)) throw new CaseError(`family must be one of ${FAMILY_IDS.join(", ")}`);
  if (!DIGEST.test(config.image_digest)) throw new CaseError("image_digest must be sha256:<64 hex>");
  if (!/@sha256:[0-9a-f]{64}$/.test(config.sandbox_image)) throw new CaseError("sandbox_image must be pinned by digest (<repository>@sha256:<64 hex>)");
  return config;
}

export function loadCase(path: string): { config: CaseConfig; sha256: string } {
  const bytes = readFileSync(path);
  return { config: parseCase(bytes), sha256: sha256Hex(bytes) };
}

/** The SHA-256 of a file's bytes, or of a directory tree: each entry's kind, relative path and content hash, in name order. */
function contentSha256(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return sha256Hex(Buffer.from(`link ${readlinkSync(path)}`));
  if (!stat.isDirectory()) return sha256Hex(readFileSync(path));
  const lines: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const entry = lstatSync(full);
      if (entry.isDirectory()) {
        lines.push(`dir ${relative}`);
        walk(full, relative);
      } else {
        lines.push(`${entry.isSymbolicLink() ? "link" : "file"} ${relative} ${contentSha256(full)}`);
      }
    }
  };
  walk(path, "");
  return sha256Hex(Buffer.from(lines.join("\n")));
}

/**
 * The content hash of every file and directory the case names (null for a null field). The case
 * file holds only paths, so a run records these and refuses to continue when any of them changed:
 * one root never mixes two projections, issues or grading inputs.
 */
export function caseInputDigests(config: CaseConfig): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of FIELDS) {
    if (!PATHS.has(field)) continue;
    const path = config[field];
    out[field] = path === null ? null : contentSha256(path);
  }
  return out;
}

/** The fields whose content differs from what the run recorded (a field the record lacks counts as changed). */
export function changedCaseInputs(recorded: Readonly<Record<string, string | null>> | undefined, config: CaseConfig): string[] {
  return FIELDS.filter((field) => PATHS.has(field)).filter((field) => {
    const path = config[field];
    let now: string | null;
    try {
      now = path === null ? null : contentSha256(path);
    } catch {
      // A file that cannot be read any more has changed.
      return true;
    }
    return recorded?.[field] !== now;
  });
}

/** What a screen record says about using its case in a UC1 run. */
export interface ScreenStatus {
  case_id: string | null;
  /** The record has every pre-registered field, well formed, and both verdicts are `pass`. */
  eligible: boolean;
  detail: string;
  /** The screened target file (`target.path`) and its clean SHA-256 (`target.sha256`); null unless the record is well formed. */
  target: { path: string; sha256: string } | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function text(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The fields of the pre-registered screen format (docs/uc1-preregistration.md, "Bug selection")
 * that are absent or malformed, by dotted name. The verdicts are checked separately.
 */
function screenShapeProblems(data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, field: string) => {
    if (!ok) problems.push(field);
  };
  need(data.schema_version === 1, "schema_version");
  need(typeof data.case_id === "string" && CASE_ID.test(data.case_id), "case_id");
  need(typeof data.recorded === "string" && DATE.test(data.recorded), "recorded");
  need(text(data.recorded_by), "recorded_by");
  if (isRecord(data.target)) {
    for (const field of ["upstream", "host_commit", "path", "mutation"]) need(text(data.target[field]), `target.${field}`);
    need(typeof data.target.sha256 === "string" && SHA256.test(data.target.sha256), "target.sha256");
  } else problems.push("target");
  if (isRecord(data.static_headroom)) {
    const { verdict, judgment, reasons } = data.static_headroom;
    need(verdict === "pass" || verdict === "fail", "static_headroom.verdict");
    need(text(judgment), "static_headroom.judgment");
    need(Array.isArray(reasons) && reasons.length > 0 && reasons.every(text), "static_headroom.reasons");
  } else problems.push("static_headroom");
  if (isRecord(data.leak_screen)) {
    const leak = data.leak_screen;
    need(leak.verdict === "pass" || leak.verdict === "fail" || leak.verdict === "not_assessed", "leak_screen.verdict");
    for (const field of ["issue_text", "observe_and_writer_evidence", "http_responses", "server_logs"]) need(text(leak[field]), `leak_screen.${field}`);
  } else problems.push("leak_screen");
  need(text(data.uc1_use), "uc1_use");
  return problems;
}

/**
 * Reads a screen record. A case is eligible only when the record has every field of the
 * pre-registered format, each well formed, with both `static_headroom.verdict` and
 * `leak_screen.verdict` equal to `pass`; anything else (the time-zone case's record, whose
 * verdict is `fail`, included) is not.
 */
export function screenStatus(bytes: Uint8Array): ScreenStatus {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { case_id: null, eligible: false, detail: "the screen record is not JSON", target: null };
  }
  if (!isRecord(data)) return { case_id: null, eligible: false, detail: "the screen record is not an object", target: null };
  const caseId = typeof data.case_id === "string" ? data.case_id : typeof data.case === "string" ? data.case : null;
  if (typeof data.verdict === "string") return { case_id: caseId, eligible: false, detail: `the screen record's verdict is ${data.verdict}`, target: null };
  const problems = screenShapeProblems(data);
  if (problems.length > 0) return { case_id: caseId, eligible: false, detail: `the screen record is not in the pre-registered format: missing or malformed ${problems.join(", ")}`, target: null };
  const headroom = (data.static_headroom as Record<string, unknown>).verdict as string;
  const leak = (data.leak_screen as Record<string, unknown>).verdict as string;
  const recorded = data.target as Record<string, unknown>;
  const target = { path: recorded.path as string, sha256: recorded.sha256 as string };
  if (headroom === "pass" && leak === "pass") return { case_id: caseId, eligible: true, detail: "static headroom pass, leak screen pass", target };
  return { case_id: caseId, eligible: false, detail: `static headroom ${headroom}, leak screen ${leak}`, target };
}

/**
 * A counted run's screen must be of the target the case derives: the screened file's path and the
 * SHA-256 of its clean bytes (upstream at the host commit, before the mutation) must equal the case's
 * derived target path and clean state, so a run never admits a projection that was not screened.
 */
export function checkScreenTarget(screen: ScreenStatus, targetPath: string, cleanSha256: string): void {
  if (screen.target === null) throw new CaseError("the screen record names no target");
  if (screen.target.path !== targetPath) throw new CaseError(`the screen record's target path is ${screen.target.path}, but the case's target is ${targetPath}`);
  if (screen.target.sha256 !== cleanSha256) throw new CaseError(`the screen record's target SHA-256 is ${screen.target.sha256}, but the case's clean target hashes to ${cleanSha256}`);
}

/**
 * Whether a mode may run this case. The pilot runs only the time-zone case, whose record fails it;
 * a counted run needs a race-class case and an eligible screen record for the same case. The
 * time-zone fallback branch is an amendment to the pre-registration and is not built in.
 */
export function checkCaseForMode(mode: RunMode, config: CaseConfig, screen: ScreenStatus): void {
  if (screen.case_id !== config.case_id) throw new CaseError(`the screen record is for ${String(screen.case_id)}, not ${config.case_id}`);
  if (mode === "pilot") {
    if (config.case_id !== PILOT_CASE_ID) throw new CaseError(`the harness pilot runs only ${PILOT_CASE_ID}`);
    return;
  }
  if (!screen.eligible) throw new CaseError(`${config.case_id} is not eligible for a counted UC1 run: ${screen.detail}`);
  if (config.family !== "race") throw new CaseError(`a counted UC1 run takes only a race-class case; ${config.case_id} is family ${config.family}`);
}

/**
 * The controller options of the case that both grades share. The kit image goes by the case's
 * content digest, not its tag, so a grade runs the image the case admits even if the tag moved.
 */
export function controllerBase(config: CaseConfig): string[] {
  return [
    ...(config.family === DEFAULT_FAMILY ? [] : ["--family", config.family]),
    "--image",
    config.image_digest,
    "--manifest",
    config.manifest,
    "--terms",
    config.terms,
    "--kit-stage",
    config.kit_stage,
    ...(config.original_suite === null ? [] : ["--original-suite", config.original_suite]),
    ...(config.audit_policy === null ? [] : ["--policy", config.audit_policy]),
    ...(config.probes_dir === null ? [] : ["--probes-dir", config.probes_dir]),
  ];
}
