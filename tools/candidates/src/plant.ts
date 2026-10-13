// Checks a site from the finder and plants it: in memory for a dry run, or in a scratch copy of
// the host tree for a screen.
import { createHash } from "node:crypto";
import { cpSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { applyPatch, parsePatch } from "diff";
import type { Site } from "./types.ts";

/** Directories left out of a scratch copy: the static screen reads source, not history or installs. */
export const COPY_IGNORE: readonly string[] = [".git", "node_modules"];

export type PlantFailure =
  | "bad_path"
  | "bad_line"
  | "bad_confidence"
  | "file_missing"
  | "not_one_file"
  | "path_mismatch"
  | "does_not_apply"
  | "no_change";

export class PlantError extends Error {
  readonly reason: PlantFailure;

  constructor(reason: PlantFailure, message: string) {
    super(message);
    this.name = "PlantError";
    this.reason = reason;
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A stable ID for a site: the SHA-256 of its file, line and diff. */
export function candidateId(site: Pick<Site, "file" | "line" | "diff">): string {
  return sha256Hex(`${site.file}\0${String(site.line)}\0${site.diff}`);
}

function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function stripPrefix(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  const trimmed = name.split("\t")[0] ?? name;
  return trimmed.startsWith("a/") || trimmed.startsWith("b/") ? trimmed.slice(2) : trimmed;
}

/** Checks the site's own fields, before any file is read. */
export function checkSiteFields(site: Site): void {
  if (typeof site.file !== "string" || !isSafeRelativePath(site.file)) {
    throw new PlantError("bad_path", "site file must be a relative path inside the host without . or .. segments");
  }
  if (!Number.isInteger(site.line) || site.line < 1) {
    throw new PlantError("bad_line", "site line must be a positive integer");
  }
  if (typeof site.confidence !== "number" || !(site.confidence >= 0 && site.confidence <= 1)) {
    throw new PlantError("bad_confidence", "site confidence must be a number from 0 to 1");
  }
}

/** Returns the planted bytes of the site's file, or throws a PlantError. Writes nothing. */
export function plantedText(hostDir: string, site: Site): string {
  checkSiteFields(site);
  let clean: string;
  try {
    // The site's path must name a regular file with no symbolic link anywhere along it, so that a
    // scratch copy (which keeps links as links) can never be written through to another file.
    const root = realpathSync(hostDir);
    const path = join(root, ...site.file.split("/"));
    if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
      throw new Error("not a regular file");
    }
    clean = readFileSync(path, "utf8");
  } catch {
    throw new PlantError("file_missing", "site file is not a regular file in the host tree");
  }
  let patches;
  try {
    patches = parsePatch(site.diff);
  } catch {
    throw new PlantError("not_one_file", "site diff is not a unified diff");
  }
  const [patch] = patches;
  if (patches.length !== 1 || patch === undefined || patch.hunks.length === 0) {
    throw new PlantError("not_one_file", "site diff must change exactly one file");
  }
  if (stripPrefix(patch.oldFileName) !== site.file || stripPrefix(patch.newFileName) !== site.file) {
    throw new PlantError("path_mismatch", "site diff names a different file than the site");
  }
  const planted = applyPatch(clean, patch);
  if (planted === false) {
    throw new PlantError("does_not_apply", "site diff does not apply to the clean file");
  }
  if (planted === clean) {
    throw new PlantError("no_change", "site diff leaves the file unchanged");
  }
  return planted;
}

function ignored(hostDir: string, source: string): boolean {
  const rel = relative(hostDir, source);
  return rel !== "" && rel.split(sep).some((segment) => COPY_IGNORE.includes(segment));
}

/**
 * Copies the host tree to `dest` (which must not exist) without the COPY_IGNORE directories,
 * then writes the planted file. A host path that is itself a symbolic link is resolved first;
 * links inside the tree are copied as links.
 */
export function plantCopy(host: string, site: Site, dest: string): void {
  const hostDir = realpathSync(host);
  const planted = plantedText(hostDir, site);
  cpSync(hostDir, dest, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
    filter: (source) => !ignored(hostDir, source),
  });
  writeFileSync(join(dest, ...site.file.split("/")), planted);
}

/** The scratch directory name for the candidate at `index`. */
export function copyName(index: number, id: string): string {
  return `${String(index + 1).padStart(3, "0")}-${id.slice(0, 12)}`;
}
