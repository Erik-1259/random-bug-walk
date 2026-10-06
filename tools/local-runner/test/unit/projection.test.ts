import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadProbeSet } from "@rbw/shapes";
import { deriveCodeStates, loadAlternativeFix } from "../../src/code-states.ts";
import { auditCopy, exportImage, kitNonSource } from "../../src/projection.ts";
import { FakeDocker, ok } from "../support/fakes.ts";
import { CLEAN, STRICT_TERM, TARGET, appTree, tarOf, tempDir, writeAlternativeDir, writeManifest, writeProbeDir, writeTerms } from "../support/synthetic.ts";
import type { TarEntry } from "../support/synthetic.ts";

const IMAGE = `sha256:${"ab".repeat(32)}`;
const IMAGE_MANIFEST = '{"synthetic":"image manifest"}';

function exportDocker(extra: readonly TarEntry[] = []): FakeDocker {
  return new FakeDocker(async (args, options) => {
    if (args[0] === "cp" && args[2] === "-") {
      const stream = options.stdout as Writable;
      const bytes = String(args[1]).endsWith(":/workspace/app") ? await appTree(extra) : await tarOf([{ name: "image-manifest.json", content: IMAGE_MANIFEST, mode: 0o600 }]);
      stream.end(bytes);
    }
    return ok();
  });
}

function states() {
  return deriveCodeStates(Buffer.from(CLEAN), loadProbeSet(writeProbeDir()), loadAlternativeFix(writeAlternativeDir()));
}

async function exported(extra: readonly TarEntry[] = []) {
  const dir = tempDir();
  const docker = exportDocker(extra);
  const result = await exportImage(docker, { image: IMAGE, container: "rbw-synthetic-export", dest: join(dir, "source") });
  return { dir, docker, result };
}

describe("the source projection exported from the kit image", () => {
  it("lists the kit's own non-source paths from its committed build outputs", () => {
    const paths = kitNonSource("dir .next\nfile next-env.d.ts\ntracked src/tracker/index.d.ts\nsticky packages/mcp\n# comment\n");
    expect(paths).toEqual(["node_modules", "packages/api-client/node_modules", "packages/mcp/node_modules", "src/proxy.ts", ".next", "next-env.d.ts"]);
  });

  it("keeps the app's source and leaves out dependencies, the kit's build input and empty build outputs", async () => {
    const { result, docker } = await exported();
    const files = ["README.md", "package.json", "src/index.ts", TARGET];
    for (const file of files) expect(existsSync(join(result.source_dir, file))).toBe(true);
    for (const skipped of ["src/proxy.ts", "next-env.d.ts", ".next", "node_modules"]) expect(existsSync(join(result.source_dir, skipped))).toBe(false);
    expect(readFileSync(join(result.source_dir, TARGET), "utf8")).toBe(CLEAN);
    expect(result.image_manifest.toString()).toBe(IMAGE_MANIFEST);
    expect(docker.calls).toEqual([
      ["create", "--name", "rbw-synthetic-export", "--network", "none", IMAGE],
      ["cp", "rbw-synthetic-export:/workspace/app", "-"],
      ["cp", "rbw-synthetic-export:/opt/rbw/verifier/image-manifest.json", "-"],
      ["rm", "--force", "rbw-synthetic-export"],
    ]);
  });

  it("keeps the executable bit of an executable source file", async () => {
    const { result } = await exported([{ name: "app/scripts/run.sh", content: "#!/bin/sh\n", mode: 0o755 }]);
    expect(statSync(join(result.source_dir, "scripts/run.sh")).mode & 0o111).not.toBe(0);
  });
});

describe("the projection audit of each copy, before its build", () => {
  async function audit(extra: readonly TarEntry[], key: "planted" | "clean" | "fixed" | "partial", terms?: string) {
    const { dir, result } = await exported(extra);
    const state = states().get(key);
    if (state === undefined) throw new Error("missing state");
    return auditCopy({
      sourceDir: result.source_dir,
      workDir: join(dir, "copy"),
      state,
      manifestPath: writeManifest(dir),
      termsPath: terms ?? writeTerms(dir),
      policyPath: null,
    });
  }

  it("passes the planted copy: the pinned source plus the one declared change, with a neutral history", async () => {
    const result = await audit([], "planted");
    expect(result).toMatchObject({ verdict: "pass", reason: null, findings: 0 });
    expect(result.report_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("audits the same bytes the copy receives", async () => {
    const { dir, result } = await exported();
    const state = states().get("partial");
    if (state === undefined) throw new Error("missing state");
    auditCopy({ sourceDir: result.source_dir, workDir: join(dir, "copy"), state, manifestPath: writeManifest(dir), termsPath: writeTerms(dir), policyPath: null });
    expect(readFileSync(join(dir, "copy", "projection", TARGET)).equals(state.bytes)).toBe(true);
    expect(readFileSync(join(result.source_dir, TARGET), "utf8")).toBe(CLEAN);
  });

  it("refuses a copy with a strict term in a file, without naming the term", async () => {
    const result = await audit([{ name: "app/README.md", content: `# Synthetic app ${STRICT_TERM}\n` }], "planted");
    expect(result.verdict).toBe("refused");
    expect(result.reason?.split(",")).toEqual(["changed_bytes", "strict_term"]);
    expect(JSON.stringify(result)).not.toContain(STRICT_TERM);
  });

  it("refuses a copy with a file the manifest does not list", async () => {
    const result = await audit([{ name: "app/src/answer.ts", content: "export const answer = 1;\n" }], "planted");
    expect(result).toMatchObject({ verdict: "refused", reason: "unlisted_file" });
  });

  it("is unavailable, never a pass, when the term list cannot be read", async () => {
    const result = await audit([], "planted", "/nonexistent/terms.txt");
    expect(result).toMatchObject({ verdict: "unavailable", reason: "terms_unavailable" });
  });

  it("does not apply to a copy with no declared change, whose bytes are the pinned source", async () => {
    expect(await audit([], "clean")).toMatchObject({ verdict: "not_applicable", reason: "no_declared_change", report_sha256: null });
    expect(await audit([], "fixed")).toMatchObject({ verdict: "not_applicable", reason: "no_declared_change" });
  });
});
