// A UC1 case file: the admitted bug a run is for, its screen record, the bug report every attempt
// gets, the pinned kit image, and the inputs the session and the controller's grades need. Paths
// are resolved against the current directory, as the other tools resolve theirs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "@rbw/schema";
import { PILOT_CASE_ID } from "./plan.ts";
import type { RunMode } from "./plan.ts";

export interface CaseConfig {
  /** The admitted case's ID, such as umami-tz-arg-001. */
  case_id: string;
  /** The case's screen record, docs/uc1-screen/<case-id>.json. */
  screen_record: string;
  /** The bug report, as released: the same text in every attempt of both arms. */
  issue: string;
  /** The local kit image (tag or digest) the sessions and grade 1 run. */
  image: string;
  /** The content digest the case admits; a session on any other digest is refused. */
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

const FIELDS = ["case_id", "screen_record", "issue", "image", "image_digest", "sandbox_image", "manifest", "terms", "audit_policy", "probes_dir", "reference_fix", "kit_stage", "original_suite"] as const;
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
  if (!DIGEST.test(config.image_digest)) throw new CaseError("image_digest must be sha256:<64 hex>");
  if (!/@sha256:[0-9a-f]{64}$/.test(config.sandbox_image)) throw new CaseError("sandbox_image must be pinned by digest (<repository>@sha256:<64 hex>)");
  return config;
}

export function loadCase(path: string): { config: CaseConfig; sha256: string } {
  const bytes = readFileSync(path);
  return { config: parseCase(bytes), sha256: sha256Hex(bytes) };
}

/** What a screen record says about using its case in a UC1 run. */
export interface ScreenStatus {
  case_id: string | null;
  /** Both verdicts of the race-class format are `pass`. */
  eligible: boolean;
  detail: string;
}

/**
 * Reads a screen record. A case is eligible only in the pre-registered format with both
 * `static_headroom.verdict` and `leak_screen.verdict` equal to `pass`; anything else (the
 * time-zone case's record, whose verdict is `fail`, included) is not.
 */
export function screenStatus(bytes: Uint8Array): ScreenStatus {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { case_id: null, eligible: false, detail: "the screen record is not JSON" };
  }
  if (!isRecord(data)) return { case_id: null, eligible: false, detail: "the screen record is not an object" };
  const caseId = typeof data.case_id === "string" ? data.case_id : typeof data.case === "string" ? data.case : null;
  const headroom = isRecord(data.static_headroom) ? data.static_headroom.verdict : undefined;
  const leak = isRecord(data.leak_screen) ? data.leak_screen.verdict : undefined;
  if (data.schema_version === 1 && headroom === "pass" && leak === "pass") return { case_id: caseId, eligible: true, detail: "static headroom pass, leak screen pass" };
  if (typeof data.verdict === "string") return { case_id: caseId, eligible: false, detail: `the screen record's verdict is ${data.verdict}` };
  const label = (value: unknown) => (typeof value === "string" ? value : "missing");
  return { case_id: caseId, eligible: false, detail: `static headroom ${label(headroom)}, leak screen ${label(leak)}` };
}

/**
 * Whether a mode may run this case. The pilot runs only the time-zone case, whose record fails it;
 * a counted run needs an eligible screen record for the same case. The fallback branch (decision 6)
 * is an amendment to the pre-registration and is not built in.
 */
export function checkCaseForMode(mode: RunMode, config: CaseConfig, screen: ScreenStatus): void {
  if (screen.case_id !== config.case_id) throw new CaseError(`the screen record is for ${String(screen.case_id)}, not ${config.case_id}`);
  if (mode === "pilot") {
    if (config.case_id !== PILOT_CASE_ID) throw new CaseError(`the harness pilot runs only ${PILOT_CASE_ID}`);
    return;
  }
  if (!screen.eligible) throw new CaseError(`${config.case_id} is not eligible for a counted UC1 run: ${screen.detail}`);
}

/** The controller options of the case that both grades share. */
export function controllerBase(config: CaseConfig): string[] {
  return [
    "--image",
    config.image,
    "--manifest",
    config.manifest,
    "--terms",
    config.terms,
    "--kit-stage",
    config.kit_stage,
    ...(config.original_suite === null ? [] : ["--original-suite", config.original_suite]),
    ...(config.audit_policy === null ? [] : ["--policy", config.audit_policy]),
  ];
}
