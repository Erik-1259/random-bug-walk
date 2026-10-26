import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KNOWN_UPSTREAM_LINES, type KnownUpstreamLine } from "../src/known-upstream-lines.ts";
import { exemptKnownLines, GITLEAKS_COMMAND_VARIABLE, PATTERN_FILE_VARIABLE, scanPreparedPart } from "../src/prepare-scan-hook.ts";
import type { ScanResult } from "../src/scan.ts";
import { forms, STUB_LEAK_MARKER, tempDir, writePatterns, writeStubGitleaks } from "./support.ts";

const TERM = "synthetic-known-line-term";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// A header line the attribution check flags, assembled at run time so this file passes its own scan.
const HEADER = `// ${forms.generatedBy} a synthetic contract tool. Do not edit.`;
const OTHER_HEADER = `// ${forms.generatedBy} another synthetic tool.`;

type Members = { path: string; bytes: Uint8Array }[];

function members(files: Record<string, string>): Members {
  return Object.entries(files).map(([path, text]) => ({ path, bytes: encode(text) }));
}

const HEADER_ENTRY: KnownUpstreamLine = {
  part: "bug_case",
  path: /^src\/gen\/(?:[^/]+\/)+contract\.ts$/,
  line: 1,
  sha256: sha256(HEADER),
  reason: "A synthetic header line.",
};
const LIST: readonly KnownUpstreamLine[] = [HEADER_ENTRY];

const FILES = {
  "src/gen/a/contract.ts": `${HEADER}\nexport const a = 1;\n`,
  "src/gen/b/c/contract.ts": `${HEADER}\r\nexport const b = 2;\r\n`,
  "src/other.ts": `export const c = 3;\n${HEADER}\n`,
  "src/gen/d/contract.ts": `${OTHER_HEADER}\nexport const d = 4;\n`,
  "src/gen/contract.ts": `${HEADER}\n`,
  "xsrc/gen/a/contract.ts": `${HEADER}\n`,
  paths: `${HEADER}\n`,
};

const blocked = (...locations: string[]): ScanResult => ({ outcome: "blocked", locations });

describe("exemptKnownLines", () => {
  it("answers clean when every location is a listed line with the listed text, LF or CRLF", () => {
    const result = exemptKnownLines(blocked("src/gen/a/contract.ts:1", "src/gen/b/c/contract.ts:1"), "bug_case", members(FILES), LIST);
    expect(result).toEqual({ outcome: "clean" });
  });

  it("keeps only the locations no entry exempts, in their original order", () => {
    const result = exemptKnownLines(
      blocked("src/gen/a/contract.ts:1", "src/other.ts:2", "src/gen/b/c/contract.ts:1", "src/gen/a/contract.ts:2"),
      "bug_case",
      members(FILES),
      LIST,
    );
    expect(result).toEqual(blocked("src/other.ts:2", "src/gen/a/contract.ts:2"));
  });

  it("still blocks the listed path and line when the line's text differs", () => {
    const result = exemptKnownLines(blocked("src/gen/d/contract.ts:1"), "bug_case", members(FILES), LIST);
    expect(result).toEqual(blocked("src/gen/d/contract.ts:1"));
  });

  it("still blocks the listed text on another line, under a path the expression does not match, or in another part", () => {
    expect(exemptKnownLines(blocked("src/other.ts:2"), "bug_case", members(FILES), LIST)).toEqual(blocked("src/other.ts:2"));
    expect(exemptKnownLines(blocked("src/gen/contract.ts:1"), "bug_case", members(FILES), LIST)).toEqual(blocked("src/gen/contract.ts:1"));
    expect(exemptKnownLines(blocked("xsrc/gen/a/contract.ts:1"), "bug_case", members(FILES), LIST)).toEqual(blocked("xsrc/gen/a/contract.ts:1"));
    expect(exemptKnownLines(blocked("src/gen/a/contract.ts:1"), "validator", members(FILES), LIST)).toEqual(blocked("src/gen/a/contract.ts:1"));
  });

  it("never exempts a paths location, even when a member and an entry would match it", () => {
    const pathsEntry: KnownUpstreamLine = { ...HEADER_ENTRY, path: /^paths$/ };
    expect(exemptKnownLines(blocked("paths:1"), "bug_case", members(FILES), [pathsEntry])).toEqual(blocked("paths:1"));
  });

  it("never exempts a malformed location or one whose member is not in the part", () => {
    const locations = [
      "src/gen/a/contract.ts",
      "src/gen/a/contract.ts:0",
      "src/gen/a/contract.ts:01",
      "src/gen/a/contract.ts:1.0",
      "src/gen/a/contract.ts: 1",
      "src/gen/a/contract.ts:+1",
      "src/gen/a/contract.ts:1:",
      "src/gen/e/contract.ts:1",
      "src/gen/a/contract.ts:9",
    ];
    expect(exemptKnownLines(blocked(...locations), "bug_case", members(FILES), LIST)).toEqual(blocked(...locations));
  });

  it("passes clean and unavailable through unchanged", () => {
    expect(exemptKnownLines({ outcome: "clean" }, "bug_case", members(FILES), LIST)).toEqual({ outcome: "clean" });
    expect(exemptKnownLines({ outcome: "unavailable" }, "bug_case", members(FILES), LIST)).toEqual({ outcome: "unavailable" });
  });

  it("answers unavailable, never clean, when the step itself fails", () => {
    const broken = [{ path: "src/gen/a/contract.ts", bytes: null as unknown as Uint8Array }];
    expect(exemptKnownLines(blocked("src/gen/a/contract.ts:1"), "bug_case", broken, LIST)).toEqual({ outcome: "unavailable" });
  });
});

function settings(): Record<string, string> {
  const root = tempDir("rbw-known-lines-test-");
  const patterns = writePatterns(root, `# synthetic pattern list\n${TERM}\n`);
  const stub = writeStubGitleaks(root);
  return { [PATTERN_FILE_VARIABLE]: patterns, [GITLEAKS_COMMAND_VARIABLE]: stub.command };
}

describe("scanPreparedPart with known upstream lines", () => {
  const LEAK_LINE = `key ${STUB_LEAK_MARKER}`;
  const list: readonly KnownUpstreamLine[] = [
    HEADER_ENTRY,
    { part: "bug_case", path: /^config\/test\.yml$/, line: 2, sha256: sha256(LEAK_LINE), reason: "A synthetic stand-in secret." },
  ];
  const files = {
    "manifest.json": '{ "format": "synthetic" }\n',
    "src/gen/a/contract.ts": `${HEADER}\nexport const a = 1;\n`,
    "config/test.yml": `services:\n${LEAK_LINE}\n`,
  };
  const part = (extra: Record<string, string> = {}): { part: string; members: Members } => ({ part: "bug_case", members: members({ ...files, ...extra }) });

  it("passes a part whose only findings are listed lines, from the attribution check and from gitleaks", async () => {
    const env = settings();
    expect(await scanPreparedPart(part(), env, [])).toEqual(blocked("config/test.yml:2", "src/gen/a/contract.ts:1"));
    expect(await scanPreparedPart(part(), env, list)).toEqual({ outcome: "clean" });
  });

  it("still blocks a planted pattern term on another line of the same part", async () => {
    const env = settings();
    const verdict = await scanPreparedPart(part({ "src/app.ts": `export const e = 5;\n// ${TERM}\n` }), env, list);
    expect(verdict).toEqual(blocked("src/app.ts:2"));
  });

  it("uses the committed list by default, which names none of these synthetic lines", async () => {
    const env = settings();
    expect(await scanPreparedPart(part(), env)).toEqual(blocked("config/test.yml:2", "src/gen/a/contract.ts:1"));
  });
});

describe("the committed list of known upstream lines", () => {
  it("holds exactly two well-formed entries, both for the bug_case part", () => {
    expect(KNOWN_UPSTREAM_LINES).toHaveLength(2);
    for (const entry of KNOWN_UPSTREAM_LINES) {
      expect(entry.part).toBe("bug_case");
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(entry.line) && entry.line >= 1).toBe(true);
      expect(entry.path.source.startsWith("^")).toBe(true);
      expect(entry.path.source.endsWith("$")).toBe(true);
      expect(entry.path.flags).toBe("");
      expect(entry.reason).toMatch(/^\S[^\n]*$/);
    }
  });

  it("names the generated contract headers under the API routes and line 36 of the test compose file", () => {
    const [header, compose] = KNOWN_UPSTREAM_LINES;
    expect(header?.line).toBe(1);
    expect(header?.sha256).toBe("177bdbd43301fb7810ee495d5c80630f5c843cf4ac9c19b359cf29185f5cbaba");
    expect(header?.path.test("source/src/app/api/websites/contract.generated.ts")).toBe(true);
    expect(header?.path.test("source/src/app/api/websites/[websiteId]/stats/contract.generated.ts")).toBe(true);
    expect(header?.path.test("source/src/app/api/contract.generated.ts")).toBe(false);
    expect(header?.path.test("source/src/app/api/websites/contract.generated.ts.bak")).toBe(false);
    expect(header?.path.test("vendor/source/src/app/api/websites/contract.generated.ts")).toBe(false);
    expect(compose?.line).toBe(36);
    expect(compose?.sha256).toBe("45cc5ae1f0d0cbe9c7f68edf29b7942cd5c9ec54cc3ca4c927544cb52d780e3b");
    expect(compose?.path.test("source/docker-compose.test.yml")).toBe(true);
    expect(compose?.path.test("source/docker-compose.yml")).toBe(false);
    expect(compose?.path.test("source/docker-compose.test.yml.orig")).toBe(false);
  });
});
