import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InputError } from "../src/input.ts";
import { matchSpans, parseTerms, textHasTerm } from "../src/terms.ts";
import {
  BASE_TREE,
  EXCLUSIONS,
  Fixture,
  GENERIC,
  MUTATED_PATH,
  NEUTRAL,
  RESULT_QUERY,
  STRICT,
  STRICT_PHRASE,
  TERMS,
  expectNoTerm,
  locations,
  reasons,
  tempRoot,
} from "./support.ts";

function termsOf(text: string): ReturnType<typeof parseTerms> {
  return parseTerms(Buffer.from(text));
}

describe("term list parsing", () => {
  it("ADM-07 reads strict and generic terms, trimming them and skipping comments and blank lines", () => {
    const terms = termsOf("# heading\n\nstrict:  one \n  generic:two words\t\n  # indented comment\r\nstrict:three\r\n");
    expect(terms.strict.map((term) => term.text)).toEqual(["one", "three"]);
    expect(terms.generic.map((term) => term.text)).toEqual(["two words"]);
  });

  it("ADM-07 rejects an unknown prefix, a missing prefix, an empty term and bytes that are not UTF-8", () => {
    for (const text of ["strict:a\nother:b\n", "strict:a\nplain\n", "strict:a\nstrict:\n", "strict:a\ngeneric:   \n", "Strict:a\n"]) {
      expect(() => termsOf(text)).toThrow(InputError);
    }
    expect(() => parseTerms(Buffer.from([0x73, 0x74, 0x72, 0x69, 0x63, 0x74, 0x3a, 0xff]))).toThrow(InputError);
  });
});

describe("term matching", () => {
  const terms = termsOf(`strict:${STRICT}\nstrict:${STRICT_PHRASE}\nstrict:a.b(c)\n`);

  it("ADM-07 matches case-insensitively and literally", () => {
    expect(matchSpans(Buffer.from(`x\ny ${STRICT.toUpperCase()}\n`), terms.strict)).toEqual([{ start: 2, end: 2 }]);
    expect(matchSpans(Buffer.from("a.b(c)\naxb(c)\n"), terms.strict)).toEqual([{ start: 1, end: 1 }]);
  });

  it("ADM-07 matches a phrase wrapped across lines and indentation", () => {
    expect(matchSpans(Buffer.from("one\nthe Synthetic   strict\n\t  PHRASE ends\n"), terms.strict)).toEqual([{ start: 2, end: 3 }]);
  });

  it("ADM-07 scans bytes that are not UTF-8 with ASCII case folding only", () => {
    const content = Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from(`id ${STRICT.toUpperCase()} end\n`)]);
    expect(matchSpans(content, terms.strict)).toEqual([{ start: 2, end: 2 }]);
    const latin = termsOf("strict:café\n");
    const upper = Buffer.from([0xff, 0x0a, 0x43, 0x41, 0x46, 0xc3, 0x89]);
    const lower = Buffer.from([0xff, 0x0a, 0x63, 0x61, 0x66, 0xc3, 0xa9]);
    expect(matchSpans(upper, latin.strict)).toEqual([]);
    expect(matchSpans(lower, latin.strict)).toEqual([{ start: 2, end: 2 }]);
  });

  it("ADM-07 matches names", () => {
    expect(textHasTerm(`prefix-${STRICT.toUpperCase()}.ts`, terms.strict)).toBe(true);
    expect(textHasTerm("innocent.ts", terms.strict)).toBe(false);
  });
});

describe("strict and generic scan", () => {
  it("ADM-07 refuses a strict term in unchanged pinned contents at path:line, without printing it", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, "src/leak.ts": `const a = 1;\n// ${STRICT}\n` } });
    await fixture.ready();
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expect(reasons(result)).toEqual(["strict_term"]);
    expect(locations(result, "strict_term")).toEqual(["src/leak.ts:2"]);
    expect(result.stdout).toBe("verdict=refused\nstrict_term src/leak.ts:2\n");
    expectNoTerm(result);
  });

  it("ADM-07 refuses a strict term in a different case", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, "src/leak.ts": `${STRICT.toUpperCase()}\n` } });
    await fixture.ready();
    const result = await fixture.audit();
    expect(locations(result, "strict_term")).toEqual(["src/leak.ts:1"]);
    expectNoTerm(result);
  });

  it("ADM-07 refuses a strict phrase wrapped across a line break in shipped prose and lists the prose file", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, "README.md": "# App\n\nSee the Synthetic strict\n   phrase for details.\n" } });
    await fixture.ready();
    const result = await fixture.audit();
    expect(locations(result, "strict_term")).toEqual(["README.md:3"]);
    expect(result.report.prose_files).toContain("README.md");
    expectNoTerm(result);
  });

  it("ADM-07 refuses a strict term in a file name without revealing the name", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, [`src/${STRICT}.ts`]: "export {};\n" } });
    await fixture.ready();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["strict_term"]);
    expect(locations(result, "strict_term")).toEqual(["src/[redacted-1]"]);
    expectNoTerm(result);
  });

  it("ADM-07 refuses a strict term in a directory name and redacts the segment in every location", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, [`synthetic-STRICT-Canary/x.ts`]: "export {};\n" } });
    await fixture.prepare();
    writeFileSync(join(fixture.copy, "synthetic-STRICT-Canary", "extra.ts"), "export {};\n");
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(result.report.findings).toEqual([
      { line: null, path: "[redacted-1]", reason: "strict_term" },
      { line: null, path: "[redacted-1]/extra.ts", reason: "unlisted_file" },
    ]);
    expectNoTerm(result);
  });

  it("ADM-07 refuses and redacts a strict term that spans path segments", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    fixture.writeTerms(`strict:${STRICT}\nstrict:src/extra\nstrict:src/app.test\nstrict:docs/guide\n`);
    writeFileSync(join(fixture.copy, "src", "extra.ts"), "export {};\n");
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(result.report.findings).toEqual([
      { line: null, path: "[redacted-1]", reason: "strict_term" },
      { line: null, path: "[redacted-3]", reason: "strict_term" },
      { line: null, path: "[redacted-3]", reason: "unlisted_file" },
    ]);
    expect(result.report.exclusions.map((entry) => entry.path)).toContain("[redacted-2]");
    expectNoTerm(result, ["src/extra", "src/app.test", "docs/guide"]);
  });

  it("ADM-07 redacts excluded paths that contain a strict term", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, [`answers/${STRICT}.txt`]: "notes\n" } });
    await fixture.ready();
    const result = await fixture.audit();
    expect(result.code).toBe(0);
    expect(result.report.exclusions.map((entry) => entry.path)).toContain("answers/[redacted-1]");
    expectNoTerm(result);
  });

  it("ADM-07 refuses a strict term in bytes that are not UTF-8", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, "assets/blob.bin": Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(`${STRICT.toUpperCase()}\n`)]) } });
    await fixture.ready();
    const result = await fixture.audit();
    expect(locations(result, "strict_term")).toEqual(["assets/blob.bin:2"]);
  });

  it("ADM-07 refuses a strict term in the commit message and the commit identity", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    const identity = { ...NEUTRAL, name: `${STRICT} bot`, message: `Initial\n\nmentions ${STRICT_PHRASE}` };
    fixture.writePolicy({ dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: identity });
    expect((await fixture.commitNeutral()).code).toBe(0);
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["strict_term"]);
    expect(locations(result, "strict_term")).toEqual([".git:2", ".git:3", ".git:7"]);
    expect(result.report.git).toMatchObject({ author: { name: "[withheld]" }, committer: { name: "[withheld]" }, message_matches_policy: true });
    expectNoTerm(result);
  });

  it("ADM-07 refuses a strict term in the declared mutation's added line", async () => {
    const result = RESULT_QUERY.replace("select(unit);", `select(unit); // ${STRICT}`);
    const fixture = new Fixture({ result });
    await fixture.ready();
    const audit = await fixture.audit();
    expect(reasons(audit)).toEqual(["strict_term"]);
    expect(locations(audit, "strict_term")).toEqual([`${MUTATED_PATH}:3`]);
    expectNoTerm(audit);
  });

  it("ADM-07 passes a generic term in unchanged pinned bytes with no finding and no review entry", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, "src/other.ts": `// ${GENERIC.toUpperCase()}\n` } });
    await fixture.ready();
    const result = await fixture.audit();
    expect(result.code).toBe(0);
    expect(result.report.findings).toEqual([]);
    expect(result.report.review).toEqual([]);
  });

  it("ADM-07 lists a generic term in the mutation's added line for review without failing", async () => {
    const result = RESULT_QUERY.replace("select(unit);", `select(unit); // ${GENERIC}`);
    const fixture = new Fixture({ result });
    await fixture.ready();
    const audit = await fixture.audit();
    expect(audit.code).toBe(0);
    expect(audit.report.verdict).toBe("pass");
    expect(audit.report.review).toEqual([`${MUTATED_PATH}:3`]);
    expect(audit.stdout).toBe(`verdict=pass\nreview ${MUTATED_PATH}:3\n`);
    expectNoTerm(audit, [GENERIC]);
  });

  it("ADM-07 does not list a generic term on an unchanged line of the mutated file", async () => {
    const tree = { ...BASE_TREE, [MUTATED_PATH]: `// ${GENERIC}\nline two\nconst rows = select(unit, timezone);\nline four\nline five\n` };
    const fixture = new Fixture({ tree, result: `// ${GENERIC}\nline two\nconst rows = select(unit);\nline four\nline five\n` });
    await fixture.ready();
    const audit = await fixture.audit();
    expect(audit.code).toBe(0);
    expect(audit.report.review).toEqual([]);
  });

  it("ADM-07 never prints a term or a term-list line, whatever is found", async () => {
    const fixture = new Fixture({ tree: { ...BASE_TREE, [`${STRICT}/x.ts`]: `${STRICT_PHRASE}\n`, "README.md": `${STRICT}\n` } });
    await fixture.prepare();
    writeFileSync(join(fixture.copy, `${STRICT}.txt`), `${STRICT}\n`);
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expectNoTerm(result);
    for (const line of TERMS.split("\n").filter((entry) => entry.trim() !== "")) {
      expect(result.stdout + result.stderr + result.reportText).not.toContain(line.trim());
    }
  });
});

describe("term list availability", () => {
  const cases: [string, string | null][] = [
    ["missing", null],
    ["empty", ""],
    ["comment-only", "# nothing here\n\n"],
    ["malformed", `strict:${STRICT}\nnot a term line\n`],
    ["strict-free", `generic:${GENERIC}\n`],
  ];
  for (const [name, text] of cases) {
    it(`ADM-07 makes the audit unavailable for a ${name} term list`, async () => {
      const fixture = new Fixture();
      await fixture.ready();
      if (text === null) fixture.termsPath = join(fixture.inputs, "absent.txt");
      else fixture.writeTerms(text);
      const result = await fixture.audit();
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("verdict=unavailable error=terms_unavailable\n");
      expect(result.report).toEqual({ error: "terms_unavailable", exit_code: 2, verdict: "unavailable" });
      expectNoTerm(result);
    });
  }

  it("ADM-07 refuses a term list inside the copy, directly or through a symlink", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    mkdirSync(join(fixture.copy, "config"));
    writeFileSync(join(fixture.copy, "config", "terms.txt"), TERMS);
    fixture.termsPath = join(fixture.copy, "config", "terms.txt");
    const direct = await fixture.audit();
    expect(direct.code).toBe(2);
    expect(direct.report.error).toBe("terms_inside_copy");
    const link = join(tempRoot(), "terms-link.txt");
    symlinkSync(join(fixture.copy, "config", "terms.txt"), link);
    fixture.termsPath = link;
    const viaLink = await fixture.audit();
    expect(viaLink.code).toBe(2);
    expect(viaLink.report.error).toBe("terms_inside_copy");
  });
});
