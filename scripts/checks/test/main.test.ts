import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntryPoint } from "../main.ts";
import { checksDir } from "./helpers.ts";

const script = join(checksDir, "scan.ts");
const scriptUrl = pathToFileURL(script).href;

describe("check script entry guard", () => {
  it("uses import.meta.main when Node provides it", () => {
    expect(isEntryPoint({ url: scriptUrl, main: true }, "/synthetic/elsewhere.ts")).toBe(true);
    expect(isEntryPoint({ url: scriptUrl, main: false }, script)).toBe(false);
  });

  it("falls back to the process entry path on Node versions without import.meta.main", () => {
    expect(isEntryPoint({ url: scriptUrl }, script)).toBe(true);
    expect(isEntryPoint({ url: scriptUrl }, join(checksDir, "prose.ts"))).toBe(false);
    expect(isEntryPoint({ url: scriptUrl }, undefined)).toBe(false);
  });

  it("is the only entry guard the check scripts use", () => {
    const scripts = readdirSync(checksDir).filter((name) => name.endsWith(".ts") && name !== "main.ts");
    expect(scripts.length).toBeGreaterThan(0);
    for (const name of scripts) {
      const source = readFileSync(join(checksDir, name), "utf8");
      expect(source, name).toContain("if (isEntryPoint(import.meta)) {");
      expect(source, name).not.toContain("if (import.meta.main)");
    }
  });
});
