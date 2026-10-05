// `fetch-closure` (development): downloads the pristine closure from the pinned Umami commit and
// checks every file against the kit's closure list before writing anything. Inside the kit image
// the closure is already staged in the verifier, and this command is not used.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "@rbw/schema";
import { UMAMI_COMMIT, UMAMI_REPOSITORY } from "./pinned.ts";

export function closureUrl(path: string): string {
  return `https://raw.githubusercontent.com/${UMAMI_REPOSITORY}/${UMAMI_COMMIT}/${path}`;
}

export class ClosureFetchError extends Error {}

/** Writes the closure under `dest` only when every file downloaded and matched its pinned hash. */
export async function fetchClosure(
  dest: string,
  fetchFile: (url: string) => Promise<Response>,
  pinned: Readonly<Record<string, string>>,
): Promise<number> {
  const files = new Map<string, Uint8Array>();
  const failed: string[] = [];
  for (const [path, expected] of Object.entries(pinned)) {
    const response = await fetchFile(closureUrl(path));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || sha256Hex(bytes) !== expected) failed.push(path);
    else files.set(path, bytes);
  }
  if (failed.length > 0) throw new ClosureFetchError(`these files did not match their pinned hashes: ${failed.join(", ")}`);
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(dest, path)), { recursive: true });
    await writeFile(join(dest, path), bytes);
  }
  return files.size;
}
