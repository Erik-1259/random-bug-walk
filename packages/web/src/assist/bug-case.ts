// A delivered case's public material for its delivery brief: the bug-case archive only, read through
// the same port and the same size and SHA-256 checks as its download, and from it only the manifest's
// runtime and the incident report. The validator part is never read here.
import { createHash } from "node:crypto";
import { unpackArchive } from "@rbw/case-package/archive";
import { BUG_CASE_MANIFEST, INCIDENT_DIRECTORY } from "@rbw/case-package/format";
import type { Case } from "@rbw/factory-contract";
import type { FactoryServer } from "../factory-server/ports.ts";
import { AssistUnavailable } from "./http.ts";
import { BUG_CASE_MAX_UNPACKED_BYTES, INCIDENT_MAX_CHARS } from "./limits.ts";

export interface BugCaseMaterial {
  incident: string;
  kit_image: string | null;
  setup: string[];
}

async function readAll(body: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) return null;
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

function runtimeOf(bytes: Uint8Array | undefined): { kit_image: string | null; setup: string[] } {
  if (bytes === undefined) return { kit_image: null, setup: [] };
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { runtime?: { kit_image?: unknown; setup?: unknown } };
    const runtime = manifest.runtime;
    const setup = Array.isArray(runtime?.setup) ? runtime.setup.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
    return { kit_image: typeof runtime?.kit_image === "string" ? runtime.kit_image : null, setup };
  } catch {
    return { kit_image: null, setup: [] };
  }
}

/** The bug case's incident text and runtime; unavailable when the stored part does not match the case. */
export async function readBugCase(server: FactoryServer, requestId: string, delivered: Case): Promise<BugCaseMaterial> {
  const part = delivered.packages.bug_case;
  const read = await server.ports.readPackage(requestId, delivered.case_id, "bug-case");
  if (read === null) throw new AssistUnavailable("the bug case part is not stored");
  if (read.sha256 !== part.sha256 || read.size !== part.size_bytes) throw new AssistUnavailable("the stored bug case differs from the case's recorded part");
  const bytes = await readAll(read.body, part.size_bytes);
  if (bytes?.length !== part.size_bytes || createHash("sha256").update(bytes).digest("hex") !== part.sha256) throw new AssistUnavailable("the bug case bytes do not match the recorded SHA-256");
  const members = unpackArchive(bytes, { maxBytes: BUG_CASE_MAX_UNPACKED_BYTES, maxMembers: 200_000 });
  const decoder = new TextDecoder();
  const incident = members
    .filter((member) => member.path.startsWith(INCIDENT_DIRECTORY))
    .map((member) => decoder.decode(member.bytes).trim())
    .filter((item) => item !== "")
    .join("\n\n")
    .slice(0, INCIDENT_MAX_CHARS);
  return { incident, ...runtimeOf(members.find((member) => member.path === BUG_CASE_MANIFEST)?.bytes) };
}
