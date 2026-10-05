// Checks against the pinned upstream blobs. Run through `pnpm run test:upstream`, never `pnpm test`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePatch } from "diff";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/hash.ts";
import { canonicalJson } from "../../src/json.ts";
import { checkProbes, loadProbeSet } from "../../src/probes.ts";
import { applyFix, loadRules } from "../../src/rules.ts";
import { DT1_SOURCE, DT1_TARGET, FIXED_RULE_ID, PROBE_DIR, RULE_FILE, SOURCE_RULE_FILE } from "../../src/shape.ts";
import { confirmSource } from "../../src/source.ts";
import { confirmTarget, confirmTargetWith } from "../../src/target.ts";
import { broadRule } from "../unit/support.ts";
import {
  FIX_COMMIT,
  FIX_PARENT,
  FIX_PARENT_FIRST_PARENT,
  HOST_COMMIT,
  ROUTE_PATH,
  fileMode,
  readBlob,
  umamiGitDir,
} from "./pinned.ts";

const GIT_DIR = umamiGitDir();
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const AST_GREP = join(dirname(createRequire(import.meta.url).resolve("@ast-grep/cli/package.json")), "ast-grep");
const PLANTED_SHA = "7cb3219367fc73838d6ddc849e5d0b334fc6de4ad7a56bd3c593f35778d84b6c";

const clean = readBlob(GIT_DIR, HOST_COMMIT, DT1_TARGET.path);
const route = readBlob(GIT_DIR, HOST_COMMIT, ROUTE_PATH);
const mode = fileMode(GIT_DIR, HOST_COMMIT, DT1_TARGET.path);
const rule = readFileSync(RULE_FILE);
const lines = clean.toString("utf8").split("\n");

const scratch = mkdtempSync(join(tmpdir(), "shapes-upstream-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
const cleanFile = join(scratch, "clean.ts");
const routeFile = join(scratch, "route.ts");
writeFileSync(cleanFile, clean);
writeFileSync(routeFile, route);

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function planted(): string {
  const outcome = confirmTarget({ path: DT1_TARGET.path, mode, bytes: clean, routeBytes: route, ruleBytes: rule });
  if (outcome.status !== "confirmed") {
    throw new Error(`target not confirmed: ${outcome.reason}`);
  }
  return outcome.result;
}

describe("target on the pinned tree", () => {
  it("confirms the target and changes only line 28 to the recorded result hash", () => {
    expect(mode).toBe("100644");
    const outcome = confirmTarget({ path: DT1_TARGET.path, mode, bytes: clean, routeBytes: route, ruleBytes: rule });
    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") {
      return;
    }
    const { target } = outcome.record;
    expect(target.line).toBe(28);
    expect(target.original_sha256).toBe(DT1_TARGET.sha256);
    expect(target.result_sha256).toBe(PLANTED_SHA);
    expect(target.function).toBe("src/queries/sql/pageviews/getPageviewStats.ts#relationalQuery");
    expect(outcome.record.route.sha256).toBe(DT1_TARGET.routeSha256);
    const hunks = parsePatch(target.diff)[0]?.hunks ?? [];
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.filter((line) => /^[-+]/.test(line))).toEqual([
      "-      ${getDateSQL('website_event.created_at', unit, timezone)} x,",
      "+      ${getDateSQL('website_event.created_at', unit)} x,",
    ]);
    const result = outcome.result.split("\n");
    for (const line of [66, 86]) {
      expect(result[line - 1]).toBe(lines[line - 1]);
      expect(result[line - 1]).toContain("getDateSQL('website_event.created_at', unit, timezone)");
    }
  });

  it("writes the record and the declared mutation file through the CLI", () => {
    const record = join(scratch, "target-record.json");
    const mutation = join(scratch, "declared-mutation.json");
    const result = cli([
      "confirm-target",
      "--file",
      cleanFile,
      "--path",
      DT1_TARGET.path,
      "--route",
      routeFile,
      "--mode",
      mode,
      "--record",
      record,
      "--declared-mutation",
      mutation,
    ]);
    expect(result.status).toBe(0);
    const diff = (JSON.parse(readFileSync(record, "utf8")) as { target: { diff: string } }).target.diff;
    expect(readFileSync(mutation, "utf8")).toBe(
      `{"diff":${JSON.stringify(diff)},"files":[{"mode":"100644",` +
        `"original_sha256":"1f679f7a666f2ca7888b9094fb85a69a31b546566f194e27ac6eef2e9aef9b1b",` +
        `"path":"src/queries/sql/pageviews/getPageviewStats.ts",` +
        `"result_sha256":"7cb3219367fc73838d6ddc849e5d0b334fc6de4ad7a56bd3c593f35778d84b6c"}],` +
        `"host_commit":"ec0ff50388c264ed8ce46f00967e92f7e71476ae"}`,
    );
    const again = join(scratch, "target-record-again.json");
    expect(cli(["confirm-target", "--file", cleanFile, "--path", DT1_TARGET.path, "--route", routeFile, "--record", again]).status).toBe(0);
    expect(readFileSync(again, "utf8")).toBe(readFileSync(record, "utf8"));
  });

  it("is not applicable on the planted file", () => {
    const bytes = Buffer.from(planted());
    const outcome = confirmTarget({ path: DT1_TARGET.path, mode, bytes, routeBytes: route, ruleBytes: rule });
    expect(outcome).toMatchObject({ status: "not_applicable", reason: "file_hash_mismatch" });
    const declared = confirmTargetWith({ ...DT1_TARGET, sha256: PLANTED_SHA }, { path: DT1_TARGET.path, mode, bytes, routeBytes: route, ruleBytes: rule });
    expect(declared).toMatchObject({ status: "not_applicable", reason: "match_count" });
  });

  it("fails with a broad rule that selects lines 28, 66 and 86", () => {
    const outcome = confirmTarget({ path: DT1_TARGET.path, mode, bytes: clean, routeBytes: route, ruleBytes: broadRule() });
    expect(outcome).toEqual({
      status: "not_applicable",
      reason: "match_count",
      detail: "expected exactly one rule match, found 3 (lines 28, 66, 86)",
    });
  });

  it("gives the same bytes from `ast-grep scan --update-all` as the napi rewrite", () => {
    const copy = join(scratch, "scan-copy.ts");
    writeFileSync(copy, clean);
    const scan = spawnSync(process.execPath, [AST_GREP, "scan", "--update-all", "--rule", RULE_FILE, copy], { encoding: "utf8" });
    expect(scan.status).toBe(0);
    const napi = applyFix(loadRules(rule).get(FIXED_RULE_ID) ?? expect.fail("rule missing"), clean.toString("utf8"));
    expect(readFileSync(copy, "utf8")).toBe(napi);
    expect(napi).toBe(planted());
  });
});

describe("source fix pairing", () => {
  it("pairs useDateRange in RevenuePage before and after the fix", () => {
    const outcome = confirmSource({
      commit: FIX_COMMIT,
      parent: FIX_PARENT,
      parents: [FIX_PARENT],
      changes: [{ status: "M", path: DT1_SOURCE.path }],
      before: readBlob(GIT_DIR, FIX_PARENT, DT1_SOURCE.path),
      after: readBlob(GIT_DIR, FIX_COMMIT, DT1_SOURCE.path),
      ruleBytes: readFileSync(SOURCE_RULE_FILE),
    });
    expect(outcome.status).toBe("confirmed");
    if (outcome.status !== "confirmed") {
      return;
    }
    expect(outcome.record.source.before).toMatchObject({ call: "useDateRange()", line: 10 });
    expect(outcome.record.source.after).toMatchObject({
      call: "useDateRange({ timezone })",
      line: 11,
      binding: { line: 8, text: "const { timezone } = useTimezone();" },
    });
  });

  it("confirms the pairing through the CLI from the git directory", () => {
    const record = join(scratch, "source-record.json");
    const result = cli(["confirm-source", "--git-dir", GIT_DIR, "--commit", FIX_COMMIT, "--parent", FIX_PARENT, "--record", record]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(readFileSync(record, "utf8")) as { source: { before: { git_blob: string }; after: { git_blob: string } } };
    expect(parsed.source.before.git_blob).toBe("3e429c18784ff43a761291d100d797f963bce6be");
    expect(parsed.source.after.git_blob).toBe("4dc19e012a0aa9f2a8f410aea79e5e4bad42f043");
  });

  it("is unsupported for the parent commit paired with its own first parent", () => {
    const result = cli(["confirm-source", "--git-dir", GIT_DIR, "--commit", FIX_PARENT, "--parent", FIX_PARENT_FIRST_PARENT]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^unsupported_source_match: unsupported_commit: /);
    const changes = spawnSync("git", ["--git-dir", GIT_DIR, "diff-tree", "-r", "--name-only", FIX_PARENT_FIRST_PARENT, FIX_PARENT], {
      encoding: "utf8",
    });
    expect(changes.stdout.trim()).toBe("pnpm-lock.yaml");
  });
});

describe("probe patches on the pinned tree", () => {
  it("ADM-06 probes reproduce their recorded hashes from the planted file", () => {
    const outcome = checkProbes(loadProbeSet(PROBE_DIR), Buffer.from(planted()));
    expect(outcome.status).toBe("confirmed");
    if (outcome.status === "confirmed") {
      expect(outcome.record.fixed_reference.result_sha256).toBe(DT1_TARGET.sha256);
      expect(canonicalJson(outcome.record.probes.map((probe) => [probe.id, probe.result_sha256]))).toBe(
        canonicalJson([
          ["mutation", PLANTED_SHA],
          ["partial", "3dfbe7db1608a5968bdc0f7856d18bbbab47d958b7036a5d4400a265b903898d"],
          ["stub", "977bcbccf4cb22bf815309b0cf7e62b5a48a60d94e64069dade02515b2ff6109"],
        ]),
      );
    }
    const plantedFile = join(scratch, "planted.ts");
    writeFileSync(plantedFile, planted());
    expect(cli(["check-probes", "--planted", plantedFile]).status).toBe(0);
    const refused = cli(["check-probes", "--planted", cleanFile]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^refused: base_hash_mismatch: /);
  });

  it("ADM-06 probe patches apply cleanly with git apply in a scratch copy of the pinned tree", () => {
    const data = loadProbeSet(PROBE_DIR).data;
    for (const probe of data.probes) {
      const tree = join(scratch, `tree-${probe.id}`);
      const target = join(tree, DT1_TARGET.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, probe.base_sha256 === PLANTED_SHA ? planted() : clean);
      const patch = join(PROBE_DIR, probe.patch);
      const check = spawnSync("git", ["apply", "--check", patch], { cwd: tree, encoding: "utf8" });
      expect(check.status, `${probe.id}: ${check.stderr}`).toBe(0);
      expect(spawnSync("git", ["apply", patch], { cwd: tree }).status).toBe(0);
      expect(sha256Hex(readFileSync(target)), probe.id).toBe(probe.result_sha256);
    }
  });
});
