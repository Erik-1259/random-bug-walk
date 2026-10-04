import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repositoryRoot } from "./helpers.ts";

interface Update {
  "package-ecosystem": string;
  directory: string;
  schedule: { interval: string };
  "open-pull-requests-limit": number;
  cooldown?: { "default-days": number };
  groups?: Record<string, { "dependency-type"?: string; "update-types"?: string[]; patterns?: string[] }>;
  ignore?: { "dependency-name": string; versions?: string[] }[];
  "commit-message"?: { prefix?: string; "prefix-development"?: string; include?: string };
}

const configText = readFileSync(join(repositoryRoot, ".github", "dependabot.yml"), "utf8");
const config = parse(configText) as { version: number; updates: Update[] };

function update(ecosystem: string): Update {
  const found = config.updates.find((entry) => entry["package-ecosystem"] === ecosystem);
  if (found === undefined) {
    throw new Error(`no ${ecosystem} entry`);
  }
  return found;
}

function typescriptPeerUpperBound(): string {
  const require = createRequire(join(repositoryRoot, "package.json"));
  const manifest = require("typescript-eslint/package.json") as { peerDependencies: Record<string, string> };
  const range = manifest.peerDependencies.typescript ?? "";
  const upper = /<\s*(\d+\.\d+\.\d+)\s*$/.exec(range);
  if (upper?.[1] === undefined) {
    throw new Error(`unexpected typescript peer range ${range}`);
  }
  return upper[1];
}

describe("dependabot.yml", () => {
  it("is version 2 with npm, uv and github-actions at the root, weekly", () => {
    expect(config.version).toBe(2);
    expect(config.updates.map((entry) => entry["package-ecosystem"]).sort()).toEqual(["github-actions", "npm", "uv"]);
    for (const entry of config.updates) {
      expect(entry.directory).toBe("/");
      expect(entry.schedule.interval).toBe("weekly");
    }
  });

  it("waits seven days before proposing a new release", () => {
    for (const entry of config.updates) {
      expect(entry.cooldown).toEqual({ "default-days": 7 });
    }
  });

  it("limits open pull requests to 5, 5 and 3", () => {
    expect(update("npm")["open-pull-requests-limit"]).toBe(5);
    expect(update("uv")["open-pull-requests-limit"]).toBe(5);
    expect(update("github-actions")["open-pull-requests-limit"]).toBe(3);
  });

  it("groups npm minor and patch updates by dependency type and leaves majors ungrouped", () => {
    expect(update("npm").groups).toEqual({
      "npm-production": { "dependency-type": "production", "update-types": ["minor", "patch"] },
      "npm-development": { "dependency-type": "development", "update-types": ["minor", "patch"] },
    });
  });

  it("groups uv minor and patch updates", () => {
    expect(update("uv").groups).toEqual({ uv: { patterns: ["*"], "update-types": ["minor", "patch"] } });
  });

  it("ignores TypeScript from the first version outside the typescript-eslint peer range", () => {
    expect(update("npm").ignore).toEqual([
      { "dependency-name": "typescript", versions: [`>=${typescriptPeerUpperBound()}`] },
    ]);
    expect(configText).toMatch(/# .*outside that peer range[\s\S]*installs with a peer dependency warning[\s\S]*pnpm lint fails/);
    expect(configText).not.toMatch(/installs without error/);
  });

  it("uses conventional commit prefixes", () => {
    expect(update("npm")["commit-message"]).toEqual({ prefix: "chore(deps)", "prefix-development": "chore(deps-dev)" });
    expect(update("uv")["commit-message"]).toEqual({ prefix: "chore(deps)", "prefix-development": "chore(deps-dev)" });
    expect(update("github-actions")["commit-message"]).toEqual({ prefix: "ci(deps)" });
  });
});
