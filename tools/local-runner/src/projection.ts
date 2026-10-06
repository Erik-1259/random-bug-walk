// The source projection of a copy and its audit. The pinned source is read once from the kit
// image's /workspace/app (as a tar stream from `docker cp`), leaving out only what the kit itself
// adds that is not source: the installed dependencies, the declared build input src/proxy.ts and
// the empty build outputs listed in kit/umami/build-outputs.txt. Each copy's projection is that
// source with the copy's verified target file in place, given a neutral history and audited by
// @rbw/projection against the pinned manifest, the copy's declared mutation and the term list.
import { copyFileSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audit, canonicalJson, commitNeutral, InputError, parsePolicy } from "@rbw/projection";
import { sha256Hex } from "@rbw/schema";
import { extract } from "tar-stream";
import type { Header } from "tar-stream";
import type { StateFile } from "./code-states.ts";
import { APP_DIR, COMMAND_TIMEOUT_MS } from "./copy.ts";
import type { AuditResult } from "./copy.ts";
import type { Docker } from "./docker.ts";

export const KIT_BUILD_OUTPUTS = fileURLToPath(new URL("../../../kit/umami/build-outputs.txt", import.meta.url));
export const IMAGE_MANIFEST_PATH = "/opt/rbw/verifier/image-manifest.json";

/** The default projection policy: no exclusions, no dependency links, the default neutral commit. */
export const DEFAULT_POLICY = "{}";

/** Streaming the app tree, dependencies included, can take a while on a slow disk. */
const EXPORT_TIMEOUT_MS = 1_800_000;

export class ExportError extends Error {
  override name = "ExportError";
}

/** What the kit adds to /workspace/app that is not source, from its build-outputs list. */
export function kitNonSource(buildOutputs: string): string[] {
  const paths = ["node_modules", "packages/api-client/node_modules", "packages/mcp/node_modules", "src/proxy.ts"];
  for (const line of buildOutputs.split("\n")) {
    const [kind, path] = line.trim().split(/\s+/);
    if ((kind === "dir" || kind === "file") && path !== undefined) paths.push(path);
  }
  return paths;
}

function excluded(path: string, paths: readonly string[]): boolean {
  return paths.some((item) => path === item || path.startsWith(`${item}/`));
}

/** The entry's path below the archive's top directory `app/`, or null for the top directory itself. */
function relativeEntry(name: string): string | null {
  const trimmed = name.replace(/\/+$/, "");
  if (trimmed === "app") return null;
  if (!trimmed.startsWith("app/")) throw new ExportError("the app archive has an entry outside app/");
  const path = trimmed.slice("app/".length);
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new ExportError("the app archive has an unsafe path");
  return path;
}

type EntryHandler = (header: Header, content: Buffer) => void;

/** Runs a `docker cp <container>:<path> -` and hands each archive entry with its content to `onEntry`. */
async function readArchive(docker: Docker, args: readonly string[], wanted: (header: Header) => boolean, onEntry: EntryHandler): Promise<void> {
  const archive = extract();
  const state: { failure: Error | null } = { failure: null };
  archive.on("entry", (header, stream, next) => {
    const keep = state.failure === null && wanted(header);
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      if (keep) chunks.push(Buffer.from(chunk as Uint8Array));
    });
    stream.on("end", () => {
      if (keep) {
        try {
          onEntry(header, Buffer.concat(chunks));
        } catch (error) {
          state.failure = error instanceof Error ? error : new ExportError("an archive entry could not be written");
        }
      }
      next();
    });
    stream.resume();
  });
  const finished = new Promise<void>((resolve, reject) => {
    archive.on("finish", resolve);
    archive.on("error", reject);
  });
  const result = await docker.run(args, { stdout: archive, timeoutMs: EXPORT_TIMEOUT_MS });
  if (result.code !== 0) throw new ExportError(`docker ${args.join(" ")} exited ${String(result.code)}`);
  await finished;
  if (state.failure !== null) throw state.failure;
}

export interface ExportedImage {
  source_dir: string;
  files: number;
  /** /opt/rbw/verifier/image-manifest.json, which records the image's inputs. */
  image_manifest: Buffer;
}

/** Reads the pinned source and the image manifest out of a created, never started, container of the image. */
export async function exportImage(docker: Docker, options: { image: string; container: string; dest: string; buildOutputs?: string }): Promise<ExportedImage> {
  const skip = kitNonSource(options.buildOutputs ?? readFileSync(KIT_BUILD_OUTPUTS, "utf8"));
  const created = await docker.run(["create", "--name", options.container, "--network", "none", options.image], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (created.code !== 0) throw new ExportError("docker create failed for the export container");
  let files = 0;
  const found: { manifest: Buffer | null } = { manifest: null };
  try {
    mkdirSync(options.dest, { recursive: true });
    await readArchive(
      docker,
      ["cp", `${options.container}:${APP_DIR}`, "-"],
      (header) => {
        const path = relativeEntry(header.name);
        return path !== null && !excluded(path, skip);
      },
      (header, content) => {
        const path = join(options.dest, relativeEntry(header.name) ?? "");
        mkdirSync(header.type === "directory" ? path : dirname(path), { recursive: true });
        if (header.type === "file") {
          writeFileSync(path, content, { mode: (header.mode & 0o111) !== 0 ? 0o755 : 0o644 });
          files += 1;
        } else if (header.type === "symlink") {
          symlinkSync(header.linkname, path);
        } else if (header.type === "link") {
          copyFileSync(join(options.dest, relativeEntry(header.linkname) ?? ""), path);
          files += 1;
        } else if (header.type !== "directory") {
          throw new ExportError(`the app archive holds a ${header.type} entry the projection cannot hold`);
        }
      },
    );
    await readArchive(
      docker,
      ["cp", `${options.container}:${IMAGE_MANIFEST_PATH}`, "-"],
      (header) => header.type === "file",
      (_header, content) => {
        found.manifest = content;
      },
    );
  } finally {
    await docker.run(["rm", "--force", options.container], { timeoutMs: COMMAND_TIMEOUT_MS });
  }
  if (found.manifest === null) throw new ExportError("the image has no image manifest");
  return { source_dir: options.dest, files, image_manifest: found.manifest };
}

export interface AuditInputs {
  sourceDir: string;
  /** Must not exist yet. */
  workDir: string;
  state: StateFile;
  manifestPath: string;
  termsPath: string;
  /** Null for DEFAULT_POLICY. */
  policyPath: string | null;
}

function unavailable(reason: string): AuditResult {
  return { verdict: "unavailable", reason, report_sha256: null, findings: 0 };
}

/**
 * Audits the copy's projection: the exported source with exactly the bytes the copy receives.
 * A copy with no declared change (clean or fixed, whose bytes are the clean file's) has no
 * mutation to declare, which this version of the audit cannot take; it reports not_applicable.
 */
export function auditCopy(inputs: AuditInputs): AuditResult {
  if (inputs.state.declared_mutation === null) return { verdict: "not_applicable", reason: "no_declared_change", report_sha256: null, findings: 0 };
  const projection = join(inputs.workDir, "projection");
  mkdirSync(inputs.workDir, { recursive: true });
  cpSync(inputs.sourceDir, projection, { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(projection, inputs.state.path), inputs.state.bytes);
  const policyPath = inputs.policyPath ?? join(inputs.workDir, "policy.json");
  if (inputs.policyPath === null) writeFileSync(policyPath, DEFAULT_POLICY);
  try {
    commitNeutral(projection, parsePolicy(readFileSync(policyPath, "utf8")));
  } catch (error) {
    if (error instanceof InputError) return unavailable(error.code);
    throw error;
  }
  const mutationPath = join(inputs.workDir, "mutation.json");
  writeFileSync(mutationPath, inputs.state.declared_mutation);
  const reportPath = join(inputs.workDir, "audit-report.json");
  const outcome = audit({ manifest: inputs.manifestPath, policy: policyPath, mutation: mutationPath, terms: inputs.termsPath, copy: projection, report: reportPath });
  if (outcome.report === null) return unavailable("report_inside_copy");
  const reportBytes = Buffer.from(canonicalJson(outcome.report));
  writeFileSync(reportPath, reportBytes, { mode: 0o600 });
  const report = outcome.report as { error?: string; findings?: { reason: string }[] };
  const findings = report.findings ?? [];
  return {
    verdict: outcome.verdict,
    reason: outcome.verdict === "unavailable" ? (report.error ?? "unavailable") : findings.length === 0 ? null : [...new Set(findings.map((finding) => finding.reason))].sort().join(","),
    report_sha256: sha256Hex(reportBytes),
    findings: findings.length,
  };
}
