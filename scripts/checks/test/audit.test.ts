import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lines, makeTempDir, repositoryRoot, runScript, writeFiles, type RunResult } from "./helpers.ts";

// Fake executables replay canned output so these tests never reach a registry.
const fakeTool = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DIR/$(basename "$0")-$1.args"
if [ "$1" = "tool" ]; then
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--requirement" ]; then cp "$arg" "$FAKE_DIR/requirements.seen"; fi
    previous="$arg"
  done
fi
output="$FAKE_DIR/$(basename "$0")-$1.out"
if [ -f "$output" ]; then cat "$output"; fi
exit "$(cat "$FAKE_DIR/$(basename "$0")-$1.exit" 2>/dev/null || echo 0)"
`;

interface FakeCall {
  out: string;
  exit: number;
}

interface AuditRun extends RunResult {
  fakeDir: string;
}

function runAudit(kind: string, fakes: Readonly<Record<string, FakeCall>>): AuditRun {
  const fakeDir = makeTempDir("audit-fake");
  const files: Record<string, string> = {};
  for (const [name, call] of Object.entries(fakes)) {
    files[`${name}.out`] = call.out;
    files[`${name}.exit`] = String(call.exit);
  }
  writeFiles(fakeDir, files);
  const bin = join(fakeDir, "bin");
  for (const tool of new Set(Object.keys(fakes).map((name) => name.split("-")[0] ?? ""))) {
    writeFiles(bin, { [tool]: fakeTool });
    chmodSync(join(bin, tool), 0o755);
  }
  writeFiles(bin, {});
  const result = runScript("audit.ts", [kind], {
    cwd: fakeDir,
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: fakeDir },
  });
  return { ...result, fakeDir };
}

function pnpmAudit(advisories: Record<string, { module_name: string; severity: string; id: string }>, total: number): string {
  return JSON.stringify({
    actions: [],
    advisories: Object.fromEntries(
      Object.entries(advisories).map(([key, advisory]) => [
        key,
        {
          module_name: advisory.module_name,
          severity: advisory.severity,
          github_advisory_id: advisory.id,
          vulnerable_versions: "<1.0.0",
          title: "synthetic advisory",
          findings: [{ version: "0.9.0", paths: [`.>${advisory.module_name}`] }],
        },
      ]),
    ),
    muted: [],
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      dependencies: total,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: total,
    },
  });
}

describe("npm advisory audit", () => {
  it("passes and prints the number of packages checked", () => {
    const result = runAudit("npm", { "pnpm-audit": { out: pnpmAudit({}, 155), exit: 0 } });

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toContain("npm audit: checked 155 packages, 0 high or critical advisories");
    const args = readFileSync(join(result.fakeDir, "pnpm-audit.args"), "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining(["audit", "--json", "--audit-level", "high"]));
  });

  it("fails on a high-severity advisory and names the package", () => {
    const result = runAudit("npm", {
      "pnpm-audit": {
        out: pnpmAudit(
          {
            "1": { module_name: "synthetic-high", severity: "high", id: "GHSA-aaaa-bbbb-cccc" },
            "2": { module_name: "synthetic-moderate", severity: "moderate", id: "GHSA-dddd-eeee-ffff" },
          },
          12,
        ),
        exit: 1,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("npm audit: high synthetic-high GHSA-aaaa-bbbb-cccc");
    expect(result.stdout).not.toContain("synthetic-moderate");
  });

  it("fails on a critical advisory even if pnpm exits 0", () => {
    const result = runAudit("npm", {
      "pnpm-audit": {
        out: pnpmAudit({ "1": { module_name: "synthetic-critical", severity: "critical", id: "GHSA-gggg-hhhh-iiii" } }, 3),
        exit: 0,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("npm audit: critical synthetic-critical GHSA-gggg-hhhh-iiii");
  });

  it("passes with only moderate advisories", () => {
    const result = runAudit("npm", {
      "pnpm-audit": {
        out: pnpmAudit({ "1": { module_name: "synthetic-moderate", severity: "moderate", id: "GHSA-dddd-eeee-ffff" } }, 3),
        exit: 0,
      },
    });

    expect(result.status).toBe(0);
  });

  it.each([
    ["an endpoint error", { out: JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "410" } }), exit: 1 }],
    ["non-JSON output", { out: "request failed", exit: 1 }],
    ["zero packages checked", { out: pnpmAudit({}, 0), exit: 0 }],
    ["a failing exit without a high advisory", { out: pnpmAudit({}, 5), exit: 1 }],
    ["a report without metadata", { out: JSON.stringify({ advisories: {} }), exit: 0 }],
  ])("fails when the audit cannot run: %s", (_label, call) => {
    const result = runAudit("npm", { "pnpm-audit": call });

    expect(result.status).toBe(2);
  });

  it("fails when pnpm is not installed", () => {
    const result = runAudit("npm", {});

    expect(result.status).toBe(2);
  });
});

const exported = [
  "certifi==2026.7.22",
  "colorama==0.4.6 ; sys_platform == 'win32'",
  "pytest==9.1.1",
  "",
].join("\n");

function pipAuditReport(dependencies: readonly { name: string; version: string; vulns: readonly string[] }[]): string {
  return JSON.stringify({
    dependencies: dependencies.map((dependency) => ({
      name: dependency.name,
      version: dependency.version,
      vulns: dependency.vulns.map((id) => ({ id, fix_versions: ["9.9.9"], aliases: [`CVE-${id}`], description: "synthetic" })),
    })),
    fixes: [],
  });
}

describe("Python advisory audit", () => {
  it("audits every exported third-party package without markers and prints the count", () => {
    const result = runAudit("python", {
      "uv-export": { out: exported, exit: 0 },
      "uv-tool": {
        out: pipAuditReport([
          { name: "certifi", version: "2026.7.22", vulns: [] },
          { name: "colorama", version: "0.4.6", vulns: [] },
          { name: "pytest", version: "9.1.1", vulns: [] },
        ]),
        exit: 0,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pip-audit: checked 3 packages, 0 known vulnerabilities");
    const exportArgs = readFileSync(join(result.fakeDir, "uv-export.args"), "utf8").split("\n");
    expect(exportArgs).toEqual(
      expect.arrayContaining([
        "--frozen",
        "--all-packages",
        "--all-groups",
        "--all-extras",
        "--no-emit-workspace",
        "--no-hashes",
      ]),
    );
    const runArgs = readFileSync(join(result.fakeDir, "uv-tool.args"), "utf8").split("\n");
    // pip-audit runs in an isolated tool environment, so its dependencies never enter uv.lock.
    expect(runArgs.slice(0, 6)).toEqual(["tool", "run", "--isolated", "--python", "3.12", "--from=pip-audit==2.10.1"]);
    expect(runArgs).toEqual(expect.arrayContaining(["pip-audit", "--strict", "--no-deps", "--disable-pip"]));
    expect(runArgs).not.toContain("--frozen");
    expect(readFileSync(join(result.fakeDir, "requirements.seen"), "utf8")).toBe(
      "certifi==2026.7.22\ncolorama==0.4.6\npytest==9.1.1\n",
    );
  });

  it("fails on a known vulnerability and names the package and advisory", () => {
    const result = runAudit("python", {
      "uv-export": { out: exported, exit: 0 },
      "uv-tool": {
        out: pipAuditReport([
          { name: "certifi", version: "2026.7.22", vulns: [] },
          { name: "colorama", version: "0.4.6", vulns: [] },
          { name: "pytest", version: "9.1.1", vulns: ["PYSEC-0000-0"] },
        ]),
        exit: 1,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("pip-audit: pytest==9.1.1 PYSEC-0000-0");
  });

  it("reports each advisory once with its aliases when pip-audit repeats it", () => {
    const result = runAudit("python", {
      "uv-export": { out: "pytest==9.1.1\n", exit: 0 },
      "uv-tool": {
        out: pipAuditReport([{ name: "pytest", version: "9.1.1", vulns: ["PYSEC-0000-1", "PYSEC-0000-1"] }]),
        exit: 1,
      },
    });

    expect(result.status).toBe(1);
    expect(lines(result.stdout)).toEqual([
      "pip-audit: pytest==9.1.1 PYSEC-0000-1 (CVE-PYSEC-0000-1)",
      "pip-audit: checked 1 packages, 1 known vulnerabilities",
    ]);
  });

  it("treats repeated advisories with reordered aliases as one", () => {
    const vuln = (aliases: string[]): unknown => ({ id: "PYSEC-0000-2", fix_versions: [], aliases, description: "synthetic" });
    const report = JSON.stringify({
      dependencies: [{ name: "pytest", version: "9.1.1", vulns: [vuln(["CVE-0000-2", "GHSA-0000-2"]), vuln(["GHSA-0000-2", "CVE-0000-2"])] }],
      fixes: [],
    });
    const result = runAudit("python", {
      "uv-export": { out: "pytest==9.1.1\n", exit: 0 },
      "uv-tool": { out: report, exit: 1 },
    });

    expect(lines(result.stdout)).toEqual([
      "pip-audit: pytest==9.1.1 PYSEC-0000-2 (CVE-0000-2, GHSA-0000-2)",
      "pip-audit: checked 1 packages, 1 known vulnerabilities",
    ]);
  });

  it.each([
    ["a pip-audit run without JSON output", { "uv-export": { out: exported, exit: 0 }, "uv-tool": { out: "connection error", exit: 1 } }],
    ["a failing export", { "uv-export": { out: "", exit: 2 } }],
    ["an empty export", { "uv-export": { out: "", exit: 0 } }],
    [
      "an export line that is not an exact pin",
      { "uv-export": { out: "synthetic @ git+https://example.invalid/synthetic\n", exit: 0 } },
    ],
    [
      "a report with fewer packages than exported",
      {
        "uv-export": { out: exported, exit: 0 },
        "uv-tool": { out: pipAuditReport([{ name: "pytest", version: "9.1.1", vulns: [] }]), exit: 0 },
      },
    ],
    [
      "a failing exit without vulnerabilities",
      {
        "uv-export": { out: "pytest==9.1.1\n", exit: 0 },
        "uv-tool": { out: pipAuditReport([{ name: "pytest", version: "9.1.1", vulns: [] }]), exit: 1 },
      },
    ],
  ])("fails when the audit cannot run: %s", (_label, fakes) => {
    const result = runAudit("python", fakes);

    expect(result.status).toBe(2);
  });

  it("does not run pip-audit when the export is empty", () => {
    const result = runAudit("python", { "uv-export": { out: "", exit: 0 }, "uv-tool": { out: "", exit: 0 } });

    expect(result.status).toBe(2);
    expect(existsSync(join(result.fakeDir, "uv-tool.args"))).toBe(false);
  });
});

describe("audit usage", () => {
  it("exits 2 for an unknown audit kind", () => {
    expect(runScript("audit.ts", ["synthetic"]).status).toBe(2);
  });
});

describe("pip-audit isolation", () => {
  it("keeps pip-audit and its dependencies out of the project's dev group and lockfile", () => {
    expect(readFileSync(join(repositoryRoot, "pyproject.toml"), "utf8")).not.toContain("pip-audit");
    expect(readFileSync(join(repositoryRoot, "uv.lock"), "utf8")).not.toMatch(/name = "pip-audit"/);
  });
});
