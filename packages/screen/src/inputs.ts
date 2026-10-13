// The screen input file and the source it names. The input names the planted file and the nearby
// files the model is shown, all relative to the planted tree; the clean copy of the planted file
// comes separately and is never shown to the model.
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { plantedSite, sha256Hex } from "./site.ts";
import type { PlantedSite } from "./site.ts";

/** Files shown to the model per run. */
export const MAX_FILES = 12;
/** Symptom text, in characters. */
export const MAX_SYMPTOM_CHARACTERS = 4_000;

const RelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => !isAbsolute(path) && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."), {
    message: "a path must be relative, use forward slashes and have no empty, '.' or '..' segment",
  });

export const ScreenInputSchema = z.strictObject({
  format_version: z.literal(1),
  /** The case name; lowercase letters, digits, `-` and `_`. */
  case: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  case_status: z.string().min(1).max(200),
  shape: z.string().min(1).max(200),
  host: z.string().min(1).max(100),
  host_commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** Where the source was read from, as the screen record states it. */
  source_read_from: z.string().min(1).max(400),
  target_path: RelativePath,
  /** Every file shown to the model, the planted file among them. Shown sorted by path. */
  files: z.array(RelativePath).min(1).max(MAX_FILES),
  /** The issue-style symptom: what a user sees, never where the bug is. */
  symptom: z.string().min(1).max(MAX_SYMPTOM_CHARACTERS),
});
export type ScreenInput = z.infer<typeof ScreenInputSchema>;

export function parseScreenInput(value: unknown): ScreenInput {
  const input = ScreenInputSchema.parse(value);
  if (new Set(input.files).size !== input.files.length) {
    throw new Error("files lists a path twice");
  }
  if (!input.files.includes(input.target_path)) {
    throw new Error("files must include target_path");
  }
  return input;
}

export interface SourceFile {
  path: string;
  text: string;
}

/** What one screen run is about: the files shown, the planted site and both hashes. */
export interface ScreenSubject {
  input: ScreenInput;
  /** Sorted by path. */
  files: SourceFile[];
  planted_text: string;
  clean_text: string;
  planted_sha256: string;
  clean_sha256: string;
  site: PlantedSite;
}

async function readInside(root: string, path: string): Promise<Buffer> {
  const realRoot = await realpath(root);
  const full = await realpath(resolve(realRoot, path));
  const rel = relative(realRoot, full);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`${path} resolves outside the planted tree`);
  }
  return readFile(full);
}

function utf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${what} is not UTF-8 text`);
  }
}

/** Reads the shown files from the planted tree and the clean copy of the planted file. */
export async function loadSubject(input: ScreenInput, tree: string, cleanPath: string): Promise<ScreenSubject> {
  const files: SourceFile[] = [];
  for (const path of [...input.files].sort()) {
    files.push({ path, text: utf8(await readInside(tree, path), path) });
  }
  const plantedBytes = await readInside(tree, input.target_path);
  const cleanBytes = await readFile(cleanPath);
  const planted_text = utf8(plantedBytes, input.target_path);
  const clean_text = utf8(cleanBytes, "the clean file");
  return {
    input,
    files,
    planted_text,
    clean_text,
    planted_sha256: sha256Hex(plantedBytes),
    clean_sha256: sha256Hex(cleanBytes),
    site: plantedSite(clean_text, planted_text),
  };
}
