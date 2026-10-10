import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FILE_HASH_ALLOWLIST, GITLEAKS_CONFIG } from "../src/gitleaks.ts";

// Built at run time so this file itself holds no line that gitleaks' generic-api-key rule reports.
const digest = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const fileKey = (...parts: string[]): string => parts.join(".");
const allowed = (match: string): boolean => new RegExp(FILE_HASH_ALLOWLIST).test(match);

describe("PUB-02 gitleaks configuration", () => {
  it("extends the built-in rules and allowlists only generic-api-key matches", () => {
    expect(GITLEAKS_CONFIG.startsWith("[extend]\nuseDefault = true\n")).toBe(true);
    expect(GITLEAKS_CONFIG).toContain('targetRules = ["generic-api-key"]');
    expect(GITLEAKS_CONFIG).toContain('regexTarget = "match"');
    expect(GITLEAKS_CONFIG).toContain(`regexes = ['''${FILE_HASH_ALLOWLIST}''']`);
  });

  it("allows a SHA-256 digest keyed by a file path, as suite manifests write them", () => {
    expect(allowed(`${fileKey("playwright", "api", "config", "ts")}":"${digest("a")}"`)).toBe(true);
    expect(allowed(`tests/api/${fileKey("alpha", "spec", "ts")}": "${digest("b")}"`)).toBe(true);
    expect(allowed(`${fileKey("rbw-api", "config", "ts")}":"${digest("c")}`)).toBe(true);
  });

  it("still reports a digest under any other key, and any other value under a file path", () => {
    expect(allowed(`api_token":"${digest("d")}"`)).toBe(false);
    expect(allowed(`apiKey = "${digest("e")}"`)).toBe(false);
    expect(allowed(`auth_secret":"${digest("f")}"`)).toBe(false);
    expect(allowed(`${fileKey("deploy", "api", "config", "ts")}":"${digest("g").slice(0, 40)}"`)).toBe(false);
    expect(allowed(`${fileKey("deploy", "api", "config", "ts")}":"${digest("h").toUpperCase()}"`)).toBe(false);
    expect(allowed(`${fileKey("deploy", "api", "config", "ts")}":"${digest("i")}x"`)).toBe(false);
  });
});
