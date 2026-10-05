import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXCLUSIONS, Fixture, MUTATED_PATH, NEUTRAL, cli, sha256, spawnCli, tempRoot } from "./support.ts";

type Json = Record<string, unknown>;

function editJson(path: string, edit: (value: Json) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Json;
  edit(value);
  writeFileSync(path, JSON.stringify(value));
}

function manifestFiles(value: Json): Json[] {
  return value.files as Json[];
}

function first(list: unknown): Json {
  const [item] = list as Json[];
  if (item === undefined) throw new Error("empty list");
  return item;
}

async function expectUnavailable(fixture: Fixture, error: string): Promise<void> {
  const result = await fixture.audit();
  expect(result.code).toBe(2);
  expect(result.report).toEqual({ error, exit_code: 2, verdict: "unavailable" });
  expect(result.stdout).toBe(`verdict=unavailable error=${error}\n`);
}

describe("malformed inputs", () => {
  for (const [name, path] of [
    ["an absolute path", "/etc/passwd"],
    ["a .. segment", "src/../README.md"],
    ["a . segment", "./README.md"],
    ["an empty segment", "src//app.ts"],
    ["a backslash", "src\\app.ts"],
    ["a NUL", "src/app\u0000.ts"],
    ["a trailing slash", "src/"],
  ] as const) {
    it(`ADM-01 refuses a manifest path with ${name}`, async () => {
      const fixture = new Fixture();
      await fixture.ready();
      editJson(fixture.manifestPath, (value) => {
        const files = manifestFiles(value);
        files.push({ mode: "100644", path, sha256: "0".repeat(64), size_bytes: 0 });
      });
      await expectUnavailable(fixture, "malformed_manifest");
    });
  }

  it("ADM-01 refuses unknown keys in the manifest, its entries, the policy, the neutral commit and the mutation", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const manifest = readFileSync(fixture.manifestPath, "utf8");
    editJson(fixture.manifestPath, (value) => (value.extra = 1));
    await expectUnavailable(fixture, "malformed_manifest");
    writeFileSync(fixture.manifestPath, manifest);
    editJson(fixture.manifestPath, (value) => {
      const first = manifestFiles(value)[0];
      if (first !== undefined) first.extra = 1;
    });
    await expectUnavailable(fixture, "malformed_manifest");
    writeFileSync(fixture.manifestPath, manifest);

    fixture.writePolicy({ dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: NEUTRAL, redactions: [] });
    await expectUnavailable(fixture, "malformed_policy");
    fixture.writePolicy({ dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: { ...NEUTRAL, signature: "x" } });
    await expectUnavailable(fixture, "malformed_policy");
    fixture.writePolicy();

    fixture.writeMutation((mutation) => (mutation.note = "x"));
    await expectUnavailable(fixture, "malformed_mutation");
  });

  it("ADM-01 refuses a manifest that is unsorted, duplicated or has a bad mode or hash", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const manifest = readFileSync(fixture.manifestPath, "utf8");
    const edits: ((value: Json) => void)[] = [
      (value) => manifestFiles(value).reverse(),
      (value) => manifestFiles(value).push({ ...manifestFiles(value).at(-1) }),
      (value) => (first(value.files).mode = "120000"),
      (value) => (first(value.files).sha256 = "A".repeat(64)),
      (value) => (value.host_commit = "abc"),
    ];
    for (const edit of edits) {
      writeFileSync(fixture.manifestPath, manifest);
      editJson(fixture.manifestPath, edit);
      await expectUnavailable(fixture, "malformed_manifest");
    }
  });

  it("ADM-01 refuses an exclusion that matches no manifest file", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    fixture.writePolicy({ dependency_links: [], exclusions: [...EXCLUSIONS, { path: "absent/", category: "answer_metadata" }], neutral_commit: NEUTRAL });
    await expectUnavailable(fixture, "malformed_policy");
    fixture.writePolicy({ dependency_links: [], exclusions: [{ path: "src/app", category: "original_test" }], neutral_commit: NEUTRAL });
    await expectUnavailable(fixture, "malformed_policy");
  });

  it("ADM-01 refuses a malformed policy: bad category, relative link root, bad date, link inside the copy", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const policies: Json[] = [
      { dependency_links: [], exclusions: [{ path: "src/app.test.ts", category: "rewrite" }], neutral_commit: NEUTRAL },
      { dependency_links: [{ path: "node_modules", root: "relative/root" }], exclusions: EXCLUSIONS, neutral_commit: NEUTRAL },
      { dependency_links: [{ path: "/node_modules", root: tempRoot() }], exclusions: EXCLUSIONS, neutral_commit: NEUTRAL },
      { dependency_links: [{ path: "node_modules", root: fixture.copy }], exclusions: EXCLUSIONS, neutral_commit: NEUTRAL },
      { dependency_links: [{ path: "src", root: tempRoot() }], exclusions: EXCLUSIONS, neutral_commit: NEUTRAL },
      { dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: { ...NEUTRAL, date: "2000-01-01T00:00:00+01:00" } },
      { dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: { ...NEUTRAL, date: "2000-02-30T00:00:00Z" } },
      { dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: { ...NEUTRAL, email: "a<b>@example.invalid" } },
      { dependency_links: [], exclusions: EXCLUSIONS, neutral_commit: { ...NEUTRAL, message: "" } },
    ];
    for (const policy of policies) {
      fixture.writePolicy(policy);
      await expectUnavailable(fixture, "malformed_policy");
    }
  });

  it("ADM-01 refuses a mutation of an excluded file or a path outside the manifest", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    for (const path of ["src/app.test.ts", "src/unlisted.ts", "answers/notes.txt"]) {
      fixture.writeMutation((mutation) => {
        const files = mutation.files as Json[];
        if (files[0] !== undefined) files[0].path = path;
        mutation.diff = String(mutation.diff).split(MUTATED_PATH).join(path);
      });
      await expectUnavailable(fixture, "malformed_mutation");
    }
  });

  it("ADM-01 refuses a mutation with another host commit, mode or original hash", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const edits: ((mutation: Json) => void)[] = [
      (mutation) => (mutation.host_commit = "f".repeat(40)),
      (mutation) => (first(mutation.files).mode = "100755"),
      (mutation) => (first(mutation.files).original_sha256 = sha256("other")),
      (mutation) => (mutation.files = []),
    ];
    for (const edit of edits) {
      fixture.writeMutation(edit);
      await expectUnavailable(fixture, "malformed_mutation");
    }
  });

  it("ADM-01 refuses a diff that touches an unlisted file, adds a file or changes a mode", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const extraSection = "diff --git a/README.md b/README.md\nindex 1111111..2222222 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Synthetic app\n+# Changed\n";
    const newFile = "diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n";
    const modeChange = `diff --git a/${MUTATED_PATH} b/${MUTATED_PATH}\nold mode 100644\nnew mode 100755\n`;
    for (const diff of [
      (base: string) => base + extraSection,
      (base: string) => base + newFile,
      (base: string) => modeChange + base.slice(base.indexOf("\n") + 1),
      () => "not a diff\n",
      () => "",
    ]) {
      fixture.writeMutation((mutation) => (mutation.diff = diff(String(mutation.diff))));
      await expectUnavailable(fixture, "malformed_mutation");
    }
  });

  it("refuses a report path inside the copy and writes nothing there", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    fixture.reportPath = join(fixture.copy, "report.json");
    const result = await cli(fixture.auditArgs());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("verdict=unavailable error=report_inside_copy\n");
    expect(existsSync(fixture.reportPath)).toBe(false);
  });

  it("refuses unknown commands, missing options and unknown options with usage and exit 2", async () => {
    for (const args of [[], ["unknown"], ["manifest", "--repo", "x"], ["audit", "--copy", "x"], ["commit-neutral", "--dir", "x", "--policy", "y", "--extra"]]) {
      const result = await cli(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage:");
    }
    expect(spawnCli(["--help"]).code).toBe(2);
  });

  it("makes the audit unavailable when the copy does not exist", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    const result = await cli([...fixture.auditArgs().slice(0, -4), "--copy", join(fixture.root, "absent"), "--report", fixture.reportPath]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("verdict=unavailable error=copy_unreadable\n");
  });
});

describe("determinism and report file", () => {
  it("ADM-01 gives identical report bytes for the same inputs", async () => {
    const fixture = new Fixture();
    await fixture.prepare();
    writeFileSync(join(fixture.copy, "b.txt"), "x\n");
    writeFileSync(join(fixture.copy, "a.txt"), "x\n");
    await fixture.commitNeutral();
    const first = await fixture.audit();
    const second = await fixture.audit();
    expect(first.code).toBe(1);
    expect(second.reportText).toBe(first.reportText);
    expect(second.stdout).toBe(first.stdout);
    expect(first.reportText).toBe(JSON.stringify(JSON.parse(first.reportText)));
    expect(first.reportText.indexOf('"counts"')).toBeLessThan(first.reportText.indexOf('"exclusions"'));
  });

  it("writes the report with mode 0600, also over an existing wider file", async () => {
    const fixture = new Fixture();
    await fixture.ready();
    writeFileSync(fixture.reportPath, "old");
    chmodSync(fixture.reportPath, 0o644);
    await fixture.audit();
    expect(statSync(fixture.reportPath).mode & 0o777).toBe(0o600);
  });
});
