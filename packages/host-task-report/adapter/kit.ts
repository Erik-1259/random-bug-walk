// The kit image the version 2 copies run (catalog/kit-image.v2.json): its reference, digest and
// architecture, and the layout and limits every version 2 copy plan declares. The image is built
// from kit/task-report/v2/Dockerfile; it holds the runtime only, never the checks.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "../src/hash.ts";
import type { CopyDestinations } from "./contract.ts";

export const KIT_IMAGE_FILE = fileURLToPath(new URL("../catalog/kit-image.v2.json", import.meta.url));
export const KIT_IMAGE_FORMAT = "rbw.task-report.kit-image.v2";

/** Where a version 2 copy keeps the app tree, the validator's evaluator files and its record set. */
export const COPY_DESTINATIONS: CopyDestinations = {
  app: "/workspace/app",
  evaluator: "/opt/rbw/evaluator/pkg",
  results: "/var/lib/rbw/results/copy",
};

/** The command a version 2 copy starts with, before its arguments. */
export const COPY_COMMAND = "/opt/rbw/bin/rbw-copy-v2";

/** How the local runner, and qualify.ts pin, read a local image: its image ID and architecture. */
export const IMAGE_INSPECT_FORMAT = "{{.Id}} {{.Architecture}}";

/** One copy: at most 4 vCPUs, 8 GB and 720 s, with no network. */
export const COPY_LIMITS = { timeout_s: 720, vcpus: 4, memory_mb: 8192, network: "none" } as const;

export interface KitImagePin {
  reference: string;
  digest: string;
  architecture: "amd64" | "arm64";
}

export class KitImageError extends Error {
  override name = "KitImageError";
}

export function parseKitImage(value: unknown): KitImagePin {
  if (!isRecord(value) || value.format !== KIT_IMAGE_FORMAT) throw new KitImageError(`the kit image pin is not ${KIT_IMAGE_FORMAT}`);
  const { reference, digest, architecture } = value;
  if (typeof reference !== "string" || !/^[a-z0-9][a-z0-9._/:-]{0,255}$/.test(reference)) throw new KitImageError("reference must be an image reference");
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new KitImageError("digest must be an OCI image digest");
  if (architecture !== "amd64" && architecture !== "arm64") throw new KitImageError("architecture must be amd64 or arm64");
  return { reference, digest, architecture };
}

export function loadKitImage(path: string = KIT_IMAGE_FILE): KitImagePin {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new KitImageError("the kit image pin is not JSON");
  }
  return parseKitImage(value);
}
