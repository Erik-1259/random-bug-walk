import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalDigest, parseCanonical, sha256Hex } from "@rbw/schema";
import { decide, importRecordSet, runCli } from "../src/index.ts";
import { LA, cleanupRecordSets, observe, rebuildRequest, recordSet, tempDir } from "./support/record-set.ts";

afterAll(cleanupRecordSets);

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const read = (dir: string, name: string): Buffer => readFileSync(join(dir, name));
const outputs = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("evidence before verdict", () => {
  it("decide returns the same output for the same evidence, including a parsed copy", () => {
    const evidence = importRecordSet(recordSet());
    const first = decide(evidence);
    expect(decide(evidence)).toEqual(first);
    expect(decide(structuredClone(evidence))).toEqual(first);
  });

  it("writes evidence.json and its SHA-256 before decision.json, which carries that hash", () => {
    const out = join(tempDir(), "out");
    const order: string[] = [];
    const result = runCli(["import", "--records", recordSet(), "--out", out], {
      writeFile: (path, bytes) => {
        order.push(path.slice(out.length + 1));
        writeFileSync(path, bytes);
      },
    });
    expect(result.code).toBe(0);
    expect(order).toEqual(["evidence.json", "evidence.sha256", "decision.json"]);
    const evidenceBytes = read(out, "evidence.json");
    const decision = parseCanonical(read(out, "decision.json")) as { evidence_sha256: string; outcome_verdict: string };
    expect(decision.evidence_sha256).toBe(sha256Hex(evidenceBytes));
    expect(read(out, "evidence.sha256").toString()).toBe(`${sha256Hex(evidenceBytes)}\n`);
    expect(decision.outcome_verdict).toBe("pass");
  });

  it("writes evidence.json and decision.json as canonical JSON", () => {
    const out = join(tempDir(), "out");
    runCli(["import", "--records", recordSet(), "--out", out]);
    for (const name of ["evidence.json", "decision.json"]) {
      const bytes = read(out, name);
      expect(Buffer.from(canonicalDigest(parseCanonical(bytes)).bytes).equals(bytes)).toBe(true);
    }
    const evidence = importRecordSet(recordSet());
    expect(parseCanonical(read(out, "evidence.json"))).toEqual(evidence);
  });

  it("writes no decision when writing the evidence fails", () => {
    const out = join(tempDir(), "out");
    const result = runCli(["import", "--records", recordSet(), "--out", out], {
      writeFile: (path, bytes) => {
        if (path.endsWith("evidence.json")) throw new Error("synthetic write failure");
        writeFileSync(path, bytes);
      },
    });
    expect(result.code).toBe(3);
    expect(existsSync(join(out, "decision.json"))).toBe(false);
  });

  it("removes a stale decision from an earlier run before importing", () => {
    const out = tempDir();
    writeFileSync(join(out, "decision.json"), "stale");
    const result = runCli(["import", "--records", recordSet(), "--out", out], {
      writeFile: (path, bytes) => {
        if (path.endsWith("evidence.json")) throw new Error("synthetic write failure");
        writeFileSync(path, bytes);
      },
    });
    expect(result.code).toBe(3);
    expect(outputs(out)).toEqual([]);
  });

  it("writes identical bytes across two runs", () => {
    const records = recordSet();
    const [first, second] = [join(tempDir(), "out"), join(tempDir(), "out")];
    runCli(["import", "--records", records, "--out", first]);
    runCli(["import", "--records", records, "--out", second]);
    for (const name of ["evidence.json", "evidence.sha256", "decision.json"]) expect(read(first, name).equals(read(second, name))).toBe(true);
  });
});

describe("exit codes", () => {
  it("exits 0 with a written decision whatever the verdict", () => {
    const out = join(tempDir(), "out");
    const result = runCli(["import", "--records", recordSet((draft) => {
      observe(draft, "planted-02", LA, 1, "pass", null);
    }), "--out", out]);
    expect(result.code).toBe(0);
    expect((parseCanonical(read(out, "decision.json")) as { outcome_verdict: string }).outcome_verdict).toBe("reject");
  });

  it("exits 1 with no output files when the request-level checks refuse the import", () => {
    const out = join(tempDir(), "out");
    const result = runCli(["import", "--records", recordSet((draft) => {
      rebuildRequest(draft, { expected_trials_sha256: "9".repeat(64) });
    }), "--out", out]);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("import:expected_trials_hash");
    expect(outputs(out)).toEqual([]);
  });

  it.each([[[]], [["import"]], [["import", "--records", "x"]], [["verify", "--records", "x", "--out", "y"]], [["import", "--records", "x", "--out", "y", "--extra"]]])("exits 2 for the usage error %j", (argv) => {
    expect(runCli(argv).code).toBe(2);
  });

  it("runs under Node directly and prints the decision summary", () => {
    const out = join(tempDir(), "out");
    const child = spawnSync(process.execPath, [cliPath, "import", "--records", recordSet(), "--out", out], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("outcome_verdict pass");
    expect(child.stdout).toContain("comparison blind_spot_demonstrated");
    expect(outputs(out)).toEqual(["decision.json", "evidence.json", "evidence.sha256"]);
  });
});
