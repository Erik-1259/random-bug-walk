import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXCLUSIONS, Fixture, MUTATED_PATH, NEUTRAL, ORIGINAL_QUERY, RESULT_QUERY, locations, reasons, sha256, spawnCli, tempRoot } from "./support.ts";

describe("audit pass case", () => {
  it("ADM-01 passes the pinned tree with exclusions, a declared one-line mutation and neutral history", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const result = await fixture.audit();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("verdict=pass\n");
    expect(result.report.verdict).toBe("pass");
    expect(result.report.exit_code).toBe(0);
    expect(result.report.findings).toEqual([]);
    expect(result.report.review).toEqual([]);
    expect(result.report.counts).toEqual({ included: 7, excluded: 3, mutated: 1 });
    expect(result.report.exclusions).toEqual([
      { category: "answer_metadata", path: "answers/deep/more.txt" },
      { category: "answer_metadata", path: "answers/notes.txt" },
      { category: "original_test", path: "src/app.test.ts" },
    ]);
  });

  it("ADM-01 records the manifest, policy and term-list hashes and the commit identity", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const result = await fixture.audit();
    const manifestSha = /manifest_sha256=([0-9a-f]{64})/.exec((await fixture.writeManifest()).stdout)?.[1];
    expect(result.report.manifest_sha256).toBe(manifestSha);
    expect(result.report.terms_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.report.policy_sha256).toMatch(/^[0-9a-f]{64}$/);
    const head = fixture.copyGit(["rev-parse", "HEAD"]);
    expect(result.report.git).toEqual({
      author: { date: NEUTRAL.date, email: NEUTRAL.email, name: NEUTRAL.name, timezone: "+0000" },
      commit: head,
      committer: { date: NEUTRAL.date, email: NEUTRAL.email, name: NEUTRAL.name, timezone: "+0000" },
      message_matches_policy: true,
    });
  });

  it("ADM-01 hashes the policy over canonical bytes, so key order and whitespace do not change it", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const first = (await fixture.audit()).report.policy_sha256;
    writeFileSync(
      fixture.policyPath,
      `{\n  "neutral_commit": ${JSON.stringify(NEUTRAL)},\n  "exclusions": ${JSON.stringify(EXCLUSIONS)},\n  "dependency_links": []\n}\n`,
    );
    expect((await fixture.audit()).report.policy_sha256).toBe(first);
  });

  it("ADM-01 lists the shipped prose files it scanned", async () => {
    const fixture = new Fixture({
      tree: {
        "README.md": "readme\n",
        "CHANGELOG.md": "changes\n",
        "notes.md": "root markdown\n",
        "docs/deep/page.txt": "doc\n",
        "packages/lib/README.md": "nested readme\n",
        "packages/lib/notes.md": "nested markdown, not prose\n",
        [MUTATED_PATH]: ORIGINAL_QUERY,
        "src/app.test.ts": "test\n",
        "answers/notes.txt": "n\n",
      },
    });
    await fixture.ready();
    const result = await fixture.audit();
    expect(result.code).toBe(0);
    expect(result.report.prose_files).toEqual(["CHANGELOG.md", "README.md", "docs/deep/page.txt", "notes.md", "packages/lib/README.md"]);
  });

  it("runs from the command line with the same verdict", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const result = spawnCli(fixture.auditArgs());
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("verdict=pass\n");
  });
});

describe("audit reason codes", () => {
  it("ADM-01 refuses an extra file with unlisted_file", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(join(fixture.copy, "src", "extra.ts"), "export {};\n");
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expect(result.report.verdict).toBe("refused");
    expect(reasons(result)).toEqual(["unlisted_file"]);
    expect(locations(result, "unlisted_file")).toEqual(["src/extra.ts"]);
    expect(result.stdout).toBe("verdict=refused\nunlisted_file src/extra.ts\n");
  });

  it("ADM-01 refuses one changed byte in an unmutated file with changed_bytes", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(join(fixture.copy, "docs", "guide.md"), "Guide text!\n");
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expect(reasons(result)).toEqual(["changed_bytes"]);
    expect(locations(result, "changed_bytes")).toEqual(["docs/guide.md"]);
  });

  it("ADM-01 refuses a deleted included file with missing_file", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    unlinkSync(join(fixture.copy, "docs", "guide.md"));
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["missing_file"]);
    expect(locations(result, "missing_file")).toEqual(["docs/guide.md"]);
  });

  it("ADM-01 refuses a chmod with mode_changed, in both directions", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    chmodSync(join(fixture.copy, "docs", "guide.md"), 0o755);
    chmodSync(join(fixture.copy, "bin", "run.sh"), 0o644);
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["mode_changed"]);
    expect(locations(result, "mode_changed")).toEqual(["bin/run.sh", "docs/guide.md"]);
  });

  it("ADM-01 refuses an excluded file left in place with excluded_present", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(join(fixture.copy, "src", "app.test.ts"), "synthetic original test\n");
    mkdirSync(join(fixture.copy, "answers", "deep"), { recursive: true });
    writeFileSync(join(fixture.copy, "answers", "deep", "more.txt"), "synthetic more notes\n");
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["excluded_present"]);
    expect(locations(result, "excluded_present")).toEqual(["answers/deep/more.txt", "src/app.test.ts"]);
  });

  it("ADM-01 refuses mutation bytes that are off by one with mutation_mismatch", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(join(fixture.copy, MUTATED_PATH), RESULT_QUERY.replace("unit", "unot"));
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["mutation_mismatch"]);
    expect(locations(result, "mutation_mismatch")).toEqual([MUTATED_PATH]);
  });

  it("ADM-01 refuses a diff that does not reproduce the declared result with mutation_mismatch", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    fixture.writeMutation((mutation) => {
      mutation.diff = String(mutation.diff).replace("+const rows = select(unit);", "+const rows = select(unit, zone);");
    });
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expect(reasons(result)).toEqual(["mutation_mismatch"]);
  });

  it("ADM-01 refuses a declared result hash that the diff does not produce, even when the copy matches it", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    const other = RESULT_QUERY.replace("line five", "line 5");
    writeFileSync(join(fixture.copy, MUTATED_PATH), other);
    fixture.writeMutation((mutation) => {
      const files = mutation.files as Record<string, unknown>[];
      if (files[0] !== undefined) files[0].result_sha256 = sha256(other);
    });
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["mutation_mismatch"]);
  });

  it("ADM-01 refuses an undeclared symlink with symlink", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    symlinkSync("guide.md", join(fixture.copy, "docs", "alias.md"));
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["symlink"]);
    expect(locations(result, "symlink")).toEqual(["docs/alias.md"]);
  });

  it("ADM-01 refuses a symlinked directory that escapes the copy with symlink and path_traversal", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    const outside = tempRoot();
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(outside, join(fixture.copy, "lib"));
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["path_traversal", "symlink"]);
    expect(locations(result, "path_traversal")).toEqual(["lib"]);
    expect(locations(result, "symlink")).toEqual(["lib"]);
  });

  it("ADM-01 accepts a declared dependency link inside its root and refuses one pointing outside it", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    const deps = tempRoot();
    mkdirSync(join(deps, "root", "node_modules"), { recursive: true });
    mkdirSync(join(deps, "elsewhere"));
    const policy = { dependency_links: [{ path: "node_modules", root: join(deps, "root") }], exclusions: EXCLUSIONS, neutral_commit: NEUTRAL };
    fixture.writePolicy(policy);
    symlinkSync(join(deps, "root", "node_modules"), join(fixture.copy, "node_modules"));
    await fixture.commitNeutral();
    const inside = await fixture.audit();
    expect(inside.code).toBe(0);
    unlinkSync(join(fixture.copy, "node_modules"));
    symlinkSync(join(deps, "elsewhere"), join(fixture.copy, "node_modules"));
    const outside = await fixture.audit();
    expect(reasons(outside)).toEqual(["symlink"]);
    expect(locations(outside, "symlink")).toEqual(["node_modules"]);
    unlinkSync(join(fixture.copy, "node_modules"));
    symlinkSync(join(deps, "root", "absent"), join(fixture.copy, "node_modules"));
    expect(reasons(await fixture.audit())).toEqual(["symlink"]);
  });

  it("ADM-01 refuses a file name with a backslash or a control character with path_traversal", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(join(fixture.copy, "src", "back\\slash.ts"), "x\n");
    writeFileSync(join(fixture.copy, "src", "bell\u0007.ts"), "x\n");
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["path_traversal"]);
    expect(result.report.findings.map((finding) => finding.path)).toEqual(["src/back\\slash.ts", "src/bell\u0007.ts"]);
    expect(result.stdout).toContain('path_traversal "src/back\\\\slash.ts"');
  });

  it("ADM-01 refuses a FIFO with special_file", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    execFileSync("mkfifo", [join(fixture.copy, "src", "pipe")]);
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["special_file"]);
    expect(locations(result, "special_file")).toEqual(["src/pipe"]);
  });

  it("ADM-01 refuses inherited .next output, a source map, a tsbuildinfo and caches with inherited_build_artifact", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    mkdirSync(join(fixture.copy, ".next", "server"), { recursive: true });
    writeFileSync(join(fixture.copy, ".next", "server", "page.js"), "built\n");
    mkdirSync(join(fixture.copy, "packages", "lib", ".turbo"), { recursive: true });
    writeFileSync(join(fixture.copy, "src", "app.js.map"), "{}\n");
    writeFileSync(join(fixture.copy, "tsconfig.tsbuildinfo"), "{}\n");
    writeFileSync(join(fixture.copy, ".eslintcache"), "[]\n");
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(result.code).toBe(1);
    expect(reasons(result)).toEqual(["inherited_build_artifact"]);
    expect(locations(result, "inherited_build_artifact")).toEqual([
      ".eslintcache",
      ".next",
      "packages/lib/.turbo",
      "src/app.js.map",
      "tsconfig.tsbuildinfo",
    ]);
  });

  it("ADM-01 allows tracked files under coverage/ and tracked source maps", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    expect(statSync(join(fixture.copy, "tests", "api", "coverage", "bundle.js.map")).isFile()).toBe(true);
    const result = await fixture.audit();
    expect(result.code).toBe(0);
  });

  it("ADM-01 classes an untracked file under a tracked directory named like a cache as an artifact", async () => {
    const fixture = new Fixture({
      tree: { ".cache/kept.txt": "tracked\n", [MUTATED_PATH]: ORIGINAL_QUERY, "src/app.test.ts": "t\n", "answers/notes.txt": "n\n" },
    });
    await fixture.prepare();
    writeFileSync(join(fixture.copy, ".cache", "new.bin"), "cached\n");
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(reasons(result)).toEqual(["inherited_build_artifact"]);
    expect(locations(result, "inherited_build_artifact")).toEqual([".cache/new.bin"]);
  });

  it("reports every finding, not only the first", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(join(fixture.copy, "extra.txt"), "x\n");
    writeFileSync(join(fixture.copy, "docs", "guide.md"), "changed\n");
    rmSync(join(fixture.copy, "README.md"));
    await fixture.commitNeutral();
    const result = await fixture.audit();
    expect(result.report.findings).toEqual([
      { line: null, path: "README.md", reason: "missing_file" },
      { line: null, path: "docs/guide.md", reason: "changed_bytes" },
      { line: null, path: "extra.txt", reason: "unlisted_file" },
    ]);
  });
});
