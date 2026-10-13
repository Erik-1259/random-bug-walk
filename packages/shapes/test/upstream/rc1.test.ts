// RC-1.atomic-backup-code against the pinned upstream blobs. Run through `pnpm run test:upstream`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { structuredPatch } from "diff";
import { afterAll, describe, expect, it } from "vitest";
import { gitBlobSha1, sha256Hex } from "../../src/hash.ts";
import { checkProbes, loadProbeSet } from "../../src/probes.ts";
import {
  RC1_FIXED_RULE_ID,
  RC1_PLANTED_RULE_ID,
  RC1_PROBE_DIR,
  RC1_RULE_FILE,
  RC1_SOURCE,
  RC1_SOURCE_RULE_FILE,
  RC1_SOURCE_RULE_ID,
  RC1_TARGET,
} from "../../src/rc1.ts";
import { applyFix, findMatches, loadRules, type LoadedRule } from "../../src/rules.ts";
import { HOST_COMMIT, RC1_FIX_COMMIT, RC1_FIX_PARENT, fileMode, readBlob, umamiGitDir } from "./pinned.ts";

const GIT_DIR = umamiGitDir();
const AST_GREP = join(dirname(createRequire(import.meta.url).resolve("@ast-grep/cli/package.json")), "ast-grep");
const rules = loadRules(readFileSync(RC1_RULE_FILE));
const sourceRules = loadRules(readFileSync(RC1_SOURCE_RULE_FILE));
const clean = readBlob(GIT_DIR, HOST_COMMIT, RC1_TARGET.path);
const cleanText = clean.toString("utf8");

const scratch = mkdtempSync(join(tmpdir(), "shapes-rc1-upstream-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function rule(map: Map<string, LoadedRule>, id: string): LoadedRule {
  return map.get(id) ?? expect.fail(`rule ${id} not loaded`);
}

function planted(): string {
  return applyFix(rule(rules, RC1_FIXED_RULE_ID), cleanText);
}

describe("RC-1 target on the pinned tree", () => {
  it("pins the target file by mode, git blob and SHA-256", () => {
    expect(RC1_TARGET.hostCommit).toBe(HOST_COMMIT);
    expect(fileMode(GIT_DIR, HOST_COMMIT, RC1_TARGET.path)).toBe(RC1_TARGET.mode);
    expect(gitBlobSha1(clean)).toBe(RC1_TARGET.gitBlob);
    expect(sha256Hex(clean)).toBe(RC1_TARGET.sha256);
  });

  it("matches one where object, on line 97 inside POST, and the fix changes only that line", () => {
    const matches = findMatches(rule(rules, RC1_FIXED_RULE_ID), cleanText);
    expect(matches.map((match) => match.range().start.line + 1)).toEqual([RC1_TARGET.line]);
    const result = planted();
    expect(sha256Hex(result)).toBe(RC1_TARGET.resultSha256);
    const hunks = structuredPatch("a", "b", cleanText, result, undefined, undefined, { context: 3 }).hunks;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.filter((line) => /^[-+]/.test(line))).toEqual([
      `-${RC1_TARGET.cleanLine}`,
      `+${RC1_TARGET.plantedLine}`,
    ]);
    expect(findMatches(rule(rules, RC1_FIXED_RULE_ID), result)).toHaveLength(0);
    expect(findMatches(rule(rules, RC1_PLANTED_RULE_ID), result)).toHaveLength(1);
    expect(findMatches(rule(rules, RC1_PLANTED_RULE_ID), cleanText)).toHaveLength(0);
  });

  it("leaves the count check in place, unreachable on the planted code", () => {
    const result = planted();
    expect(result).toContain("    if (consumed.count === 0) {");
    expect(result).toContain("prisma.client.twoFactorBackupCode.updateMany({");
  });

  it("gives the same bytes from `ast-grep scan --update-all` as the napi rewrite", () => {
    const copy = join(scratch, "scan-route.ts");
    writeFileSync(copy, clean);
    const scan = spawnSync(process.execPath, [AST_GREP, "scan", "--update-all", "--rule", RC1_RULE_FILE, copy], { encoding: "utf8" });
    expect(scan.status).toBe(0);
    expect(readFileSync(copy, "utf8")).toBe(planted());
  });
});

describe("RC-1 source fix pairing", () => {
  const before = readBlob(GIT_DIR, RC1_FIX_PARENT, RC1_SOURCE.path);
  const after = readBlob(GIT_DIR, RC1_FIX_COMMIT, RC1_SOURCE.path);

  it("pins the fix commit, its only parent and both blobs", () => {
    expect([RC1_SOURCE.commit, RC1_SOURCE.parent]).toEqual([RC1_FIX_COMMIT, RC1_FIX_PARENT]);
    const parents = spawnSync("git", ["--git-dir", GIT_DIR, "rev-parse", `${RC1_FIX_COMMIT}^@`], { encoding: "utf8" });
    expect(parents.stdout.trim().split("\n")).toEqual([RC1_FIX_PARENT]);
    const changes = spawnSync("git", ["--git-dir", GIT_DIR, "diff-tree", "-r", "--name-only", RC1_FIX_PARENT, RC1_FIX_COMMIT], {
      encoding: "utf8",
    });
    expect(changes.stdout.trim()).toBe(RC1_SOURCE.path);
    expect({ gitBlob: gitBlobSha1(before), sha256: sha256Hex(before) }).toEqual(RC1_SOURCE.before);
    expect({ gitBlob: gitBlobSha1(after), sha256: sha256Hex(after) }).toEqual(RC1_SOURCE.after);
  });

  it("anchors the plain update before the fix and the guarded updateMany after it", () => {
    const anchor = rule(sourceRules, RC1_SOURCE_RULE_ID);
    const methods = (bytes: Buffer): string[] =>
      findMatches(anchor, bytes.toString("utf8")).map((match) => match.getMatch("METHOD")?.text() ?? "");
    expect(methods(before)).toEqual([RC1_SOURCE.beforeMethod]);
    expect(methods(after)).toEqual([RC1_SOURCE.afterMethod]);
    expect(findMatches(rule(rules, RC1_FIXED_RULE_ID), after.toString("utf8"))).toHaveLength(1);
  });
});

describe("RC-1 probe patches on the pinned tree", () => {
  it("confirms the mutation from the planted file and refuses the clean file", () => {
    const set = loadProbeSet(RC1_PROBE_DIR);
    const outcome = checkProbes(set, Buffer.from(planted()));
    expect(outcome.status).toBe("confirmed");
    if (outcome.status === "confirmed") {
      expect(outcome.record.fixed_reference.result_sha256).toBe(RC1_TARGET.sha256);
      expect(outcome.record.adm_06?.status).toBe("not_applicable");
    }
    expect(checkProbes(set, clean)).toMatchObject({ status: "refused", reason: "base_hash_mismatch" });
  });

  it("applies the mutation patch with git apply in a scratch copy of the pinned tree", () => {
    const tree = join(scratch, "tree");
    const target = join(tree, RC1_TARGET.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, clean);
    const patch = join(RC1_PROBE_DIR, "mutation.patch");
    const check = spawnSync("git", ["apply", "--check", patch], { cwd: tree, encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
    expect(spawnSync("git", ["apply", patch], { cwd: tree }).status).toBe(0);
    expect(sha256Hex(readFileSync(target))).toBe(RC1_TARGET.resultSha256);
  });
});
