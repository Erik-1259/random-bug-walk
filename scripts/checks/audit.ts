// Dependency advisory audits for the lint job.
//   node scripts/checks/audit.ts npm     pnpm-lock.yaml against the npm registry advisories, failing at high or above
//   node scripts/checks/audit.ts python  every third-party package in uv.lock through pip-audit
// pip-audit runs from an isolated uv tool environment at a pinned version, so neither it nor its
// dependencies enter the project's lockfile.
// Each audit prints how many packages it checked. Exit codes: 0 no findings, 1 findings,
// 2 the audit could not run (tool missing, endpoint or network error, malformed output, nothing checked).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEntryPoint, runMain } from "./main.ts";

class AuditUnavailable extends Error {}

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const PIP_AUDIT = "pip-audit==2.10.1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(command: string, args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) {
    throw new AuditUnavailable(`${command} could not be started`);
  }
  return { status: result.status, stdout: result.stdout };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AuditUnavailable(`${what} did not produce a JSON report`);
  }
}

function auditNpm(): number {
  const result = run("pnpm", ["audit", "--json", "--audit-level", "high"]);
  const report = parseJson(result.stdout, "pnpm audit");
  if (!isRecord(report) || "error" in report) {
    throw new AuditUnavailable("pnpm audit reported an error instead of advisories");
  }
  const { advisories, metadata } = report;
  if (!isRecord(advisories) || !isRecord(metadata) || typeof metadata.totalDependencies !== "number") {
    throw new AuditUnavailable("pnpm audit report is malformed");
  }
  const blocking: string[] = [];
  for (const advisory of Object.values(advisories)) {
    if (!isRecord(advisory) || typeof advisory.severity !== "string" || typeof advisory.module_name !== "string") {
      throw new AuditUnavailable("pnpm audit report has a malformed advisory");
    }
    if (BLOCKING_SEVERITIES.has(advisory.severity)) {
      const id = typeof advisory.github_advisory_id === "string" ? advisory.github_advisory_id : "unknown-id";
      blocking.push(`npm audit: ${advisory.severity} ${advisory.module_name} ${id}`);
    }
  }
  for (const line of blocking) {
    process.stdout.write(`${line}\n`);
  }
  const total = metadata.totalDependencies;
  process.stdout.write(`npm audit: checked ${String(total)} packages, ${String(blocking.length)} high or critical advisories\n`);
  if (total === 0) {
    throw new AuditUnavailable("pnpm audit checked no packages");
  }
  if (blocking.length > 0) {
    return 1;
  }
  if (result.status !== 0) {
    throw new AuditUnavailable("pnpm audit failed without a high or critical advisory");
  }
  return 0;
}

/** Turns `uv export` output into exact pins without markers, so every locked package is audited on any platform. */
export function exactPins(exported: string): string[] {
  const pins = new Set<string>();
  for (const raw of exported.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)\s*(;.*)?$/.exec(line);
    if (match === null) {
      throw new AuditUnavailable("uv export produced a requirement that is not an exact PyPI pin");
    }
    pins.add(`${match[1] ?? ""}==${match[2] ?? ""}`);
  }
  return [...pins];
}

function auditPython(): number {
  const exported = run("uv", [
    "export",
    "--frozen",
    "--all-packages",
    "--all-groups",
    "--all-extras",
    "--no-emit-workspace",
    "--no-hashes",
    "--no-header",
    "--no-annotate",
    "--format",
    "requirements.txt",
  ]);
  if (exported.status !== 0) {
    throw new AuditUnavailable("uv export failed");
  }
  const pins = exactPins(exported.stdout);
  if (pins.length === 0) {
    throw new AuditUnavailable("uv.lock lists no third-party packages to audit");
  }
  const dir = mkdtempSync(join(tmpdir(), "rbw-pip-audit-"));
  try {
    const requirements = join(dir, "requirements.txt");
    writeFileSync(requirements, `${pins.join("\n")}\n`);
    const result = run("uv", [
      "tool",
      "run",
      "--isolated",
      "--python",
      "3.12",
      `--from=${PIP_AUDIT}`,
      "pip-audit",
      "--strict",
      "--no-deps",
      "--disable-pip",
      "--progress-spinner",
      "off",
      "--format",
      "json",
      "--requirement",
      requirements,
    ]);
    const report = parseJson(result.stdout, "pip-audit");
    if (!isRecord(report) || !Array.isArray(report.dependencies)) {
      throw new AuditUnavailable("pip-audit report is malformed");
    }
    // pip-audit can list the same advisory more than once for one package.
    const findings = new Set<string>();
    for (const dependency of report.dependencies as unknown[]) {
      if (!isRecord(dependency) || typeof dependency.name !== "string" || !Array.isArray(dependency.vulns)) {
        throw new AuditUnavailable("pip-audit report has a malformed or skipped dependency");
      }
      for (const vuln of dependency.vulns as unknown[]) {
        const id = isRecord(vuln) && typeof vuln.id === "string" ? vuln.id : "unknown-id";
        const aliases =
          isRecord(vuln) && Array.isArray(vuln.aliases)
            ? (vuln.aliases as unknown[]).filter((alias): alias is string => typeof alias === "string").sort()
            : [];
        const suffix = aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
        findings.add(`pip-audit: ${dependency.name}==${String(dependency.version)} ${id}${suffix}`);
      }
    }
    for (const line of findings) {
      process.stdout.write(`${line}\n`);
    }
    const checked = report.dependencies.length;
    process.stdout.write(`pip-audit: checked ${String(checked)} packages, ${String(findings.size)} known vulnerabilities\n`);
    if (checked !== pins.length) {
      throw new AuditUnavailable(`pip-audit checked ${String(checked)} of ${String(pins.length)} locked packages`);
    }
    if (findings.size > 0) {
      return 1;
    }
    if (result.status !== 0) {
      throw new AuditUnavailable("pip-audit failed without reporting a vulnerability");
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): number {
  const kind = process.argv[2];
  if (kind === "npm") {
    return auditNpm();
  }
  if (kind === "python") {
    return auditPython();
  }
  throw new AuditUnavailable("usage: audit.ts <npm|python>");
}

if (isEntryPoint(import.meta)) {
  runMain("audit", main);
}
