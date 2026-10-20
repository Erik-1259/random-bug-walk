// The strict manifest readers the harness verifies user-supplied archives with: each refusal on its own,
// starting from the synthetic pair's real manifests, so removing any one check fails its case.
import { createHash } from "node:crypto";
import { encodeCanonical } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import { unpackArchive } from "../src/archive.ts";
import { BUG_CASE_MANIFEST, VALIDATOR_MANIFEST } from "../src/format.ts";
import { ManifestError, parseBugCaseManifest, parseValidatorManifest } from "../src/manifest.ts";
import { buildSyntheticPair } from "../src/synthetic.ts";

type Fields = Record<string, unknown>;
interface Digest { path: string; sha256: string }

const encoder = new TextEncoder();
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const pair = buildSyntheticPair({ evidence: null });

function manifestBytes(archive: Uint8Array, name: string): Uint8Array {
  const member = unpackArchive(archive).find((entry) => entry.path === name);
  if (member === undefined) throw new Error(`no ${name}`);
  return member.bytes;
}

const BUG_CASE_BYTES = manifestBytes(pair.bug_case.bytes, BUG_CASE_MANIFEST);
const VALIDATOR_BYTES = manifestBytes(pair.validator.bytes, VALIDATOR_MANIFEST);
const fields = (bytes: Uint8Array): Fields => JSON.parse(new TextDecoder().decode(bytes)) as Fields;
const sorted = (files: Digest[]): Digest[] => [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

function reason(parse: (bytes: Uint8Array) => unknown, bytes: Uint8Array): string {
  try {
    parse(bytes);
  } catch (error) {
    if (error instanceof ManifestError) return error.message;
    throw error;
  }
  throw new Error("the manifest was accepted");
}

/** The reason a manifest edited as canonical JSON is refused. */
function refusedAfter(parse: (bytes: Uint8Array) => unknown, original: Uint8Array, edit: (manifest: Fields) => void): string {
  const manifest = fields(original);
  edit(manifest);
  return reason(parse, encodeCanonical(manifest));
}

function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)]));
}

describe("manifest readers", () => {
  it("read both manifests as the exporter wrote them", () => {
    expect(parseBugCaseManifest(BUG_CASE_BYTES)).toEqual(fields(BUG_CASE_BYTES));
    expect(parseValidatorManifest(VALIDATOR_BYTES)).toEqual(fields(VALIDATOR_BYTES));
  });

  it("refuse JSON that is not in canonical form: white space, key order or a trailing newline", () => {
    for (const [name, parse, bytes] of [["bug case", parseBugCaseManifest, BUG_CASE_BYTES], ["validator", parseValidatorManifest, VALIDATOR_BYTES]] as const) {
      const value = fields(bytes);
      const variants = [JSON.stringify(value, null, 1), JSON.stringify(reordered(value)), `${new TextDecoder().decode(bytes)}\n`];
      for (const variant of variants) expect(reason(parse, encoder.encode(variant)), name).toBe("manifest: not in canonical form");
    }
  });

  it("refuse another format", () => {
    expect(refusedAfter(parseBugCaseManifest, BUG_CASE_BYTES, (manifest) => { manifest.format = "rbw-bug-case/2"; })).toBe("manifest: format is not rbw-bug-case/1");
    expect(refusedAfter(parseValidatorManifest, VALIDATOR_BYTES, (manifest) => { manifest.format = "rbw-validator/2"; })).toBe("manifest: format is not rbw-validator/1");
  });

  it("refuse a field the format does not document", () => {
    expect(refusedAfter(parseBugCaseManifest, BUG_CASE_BYTES, (manifest) => { manifest.synthetic_extra = 1; })).toBe("manifest: bug-case.json does not have exactly the documented fields");
    expect(refusedAfter(parseValidatorManifest, VALIDATOR_BYTES, (manifest) => { manifest.synthetic_extra = 1; })).toBe("manifest: validator.json does not have exactly the documented fields");
  });

  it("refuse file lists out of path order or with a path twice", () => {
    for (const [parse, bytes] of [[parseBugCaseManifest, BUG_CASE_BYTES], [parseValidatorManifest, VALIDATOR_BYTES]] as const) {
      const reversed = refusedAfter(parse, bytes, (manifest) => { manifest.files = [...(manifest.files as Digest[])].reverse(); });
      expect(reversed).toBe("manifest: files is not unique and in path order");
      const twice = refusedAfter(parse, bytes, (manifest) => {
        const files = manifest.files as Digest[];
        manifest.files = sorted([...files, ...files.slice(0, 1)]);
      });
      expect(twice).toBe("manifest: files is not unique and in path order");
    }
  });

  it("refuse a baseline of another host", () => {
    const otherHost = (manifest: Fields): void => { manifest.baseline = { ...(manifest.baseline as Fields), host_id: "umami" }; };
    expect(refusedAfter(parseBugCaseManifest, BUG_CASE_BYTES, otherHost)).toBe("manifest: baseline belongs to another host");
    expect(refusedAfter(parseValidatorManifest, VALIDATOR_BYTES, otherHost)).toBe("manifest: baseline belongs to another host");
  });

  it("refuse a bug case member outside source/ and incident/", () => {
    for (const path of ["checks/verify.js", "notes/synthetic.txt", "repair/reference.patch"]) {
      const refused = refusedAfter(parseBugCaseManifest, BUG_CASE_BYTES, (manifest) => {
        manifest.files = sorted([...(manifest.files as Digest[]), { path, sha256: sha(path) }]);
      });
      expect(refused, path).toBe("manifest: files lists a path outside source/ and incident/");
    }
  });

  it("refuse a validator member outside checks/ and the two patch members", () => {
    for (const path of ["source/src/counter.js", "notes/synthetic.txt", "repair/other.patch"]) {
      const refused = refusedAfter(parseValidatorManifest, VALIDATOR_BYTES, (manifest) => {
        manifest.files = sorted([...(manifest.files as Digest[]), { path, sha256: sha(path) }]);
      });
      expect(refused, path).toBe("manifest: files lists a path outside checks/ and the patch members");
    }
  });

  it("refuse a patch member at another path, a patch member left out of the files, or one whose hash is not its patch hash", () => {
    const repairPath = refusedAfter(parseValidatorManifest, VALIDATOR_BYTES, (manifest) => {
      manifest.reference_repair = { ...(manifest.reference_repair as Fields), path: "repair/other.patch" };
    });
    expect(repairPath).toBe("manifest: reference_repair.path is not the documented member");
    const reconstructionPath = refusedAfter(parseValidatorManifest, VALIDATOR_BYTES, (manifest) => {
      manifest.clean_reconstruction = { ...(manifest.clean_reconstruction as Fields), path: "reconstruction/other.patch" };
    });
    expect(reconstructionPath).toBe("manifest: clean_reconstruction.path is not the documented member");
    for (const path of ["repair/reference.patch", "reconstruction/clean.patch"]) {
      const missing = refusedAfter(parseValidatorManifest, VALIDATOR_BYTES, (manifest) => {
        manifest.files = (manifest.files as Digest[]).filter((file) => file.path !== path);
      });
      expect(missing, path).toBe("manifest: files does not list both patch members");
      const otherHash = refusedAfter(parseValidatorManifest, VALIDATOR_BYTES, (manifest) => {
        manifest.files = (manifest.files as Digest[]).map((file) => (file.path === path ? { path, sha256: "0".repeat(64) } : file));
      });
      expect(otherHash, path).toBe("manifest: a patch member's hash differs from its patch hash");
    }
  });
});
