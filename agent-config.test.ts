/// <reference types="node" />
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Codex stops reading project instructions at project_doc_max_bytes (32 KiB by default).
const AGENTS_MD_MAX_BYTES = 24 * 1024;

const RUNNERS = ["", "npx ", "pnpm exec ", "pnpm dlx ", "pnpm "] as const;

function viaRunners(commands: readonly string[]): string[] {
  return RUNNERS.flatMap((runner) => commands.map((command) => `Bash(${runner}${command})`));
}

const RM_FLAGS = [
  "-rf",
  "-fr",
  "-Rf",
  "-fR",
  "-r -f",
  "-f -r",
  "-R -f",
  "-f -R",
  "--recursive --force",
  "--force --recursive",
] as const;

const RM_TARGETS = ["/", "/*", "~", "~/*", "$HOME", "$HOME/*", ".", "./", "./*", "..", ".git", ".git/"] as const;

const GIT_GLOBAL_OPTION_PREFIXES = ["-C *", "-c *", "--git-dir*", "--work-tree*", "--no-pager", "-P"] as const;

// One entry per deny category of the agent settings; each rule must appear exactly as written.
const DENY_RULES: Record<string, readonly string[]> = {
  "pushes, including git global options before the subcommand": [
    "Bash(git push *)",
    "Bash(git -* push)",
    "Bash(git -* push *)",
    ...GIT_GLOBAL_OPTION_PREFIXES.flatMap((prefix) => [`Bash(git ${prefix} push)`, `Bash(git ${prefix} push *)`]),
  ],
  "hard resets and forced cleans": [
    "Bash(git reset --hard *)",
    "Bash(git reset * --hard)",
    "Bash(git reset * --hard *)",
    "Bash(git -C * reset --hard *)",
    "Bash(git -c * reset --hard *)",
    "Bash(git -C * reset --hard)",
    "Bash(git -c * reset --hard)",
    "Bash(git -* reset --hard)",
    "Bash(git -* reset --hard *)",
    "Bash(git -* reset * --hard)",
    "Bash(git -* reset * --hard *)",
    "Bash(git -* clean)",
    "Bash(git -* clean *)",
    "Bash(git clean *)",
    "Bash(git -C * clean *)",
    "Bash(git -c * clean *)",
  ],
  "hook bypass on commit": [
    "Bash(git commit --no-verify *)",
    "Bash(git commit * --no-verify)",
    "Bash(git commit * --no-verify *)",
    "Bash(git commit -n *)",
    "Bash(git commit * -n)",
    "Bash(git commit * -n *)",
  ],
  "direct posting with gh": [
    ...["pr create", "pr comment", "pr edit", "pr review", "pr close", "pr reopen"].map((c) => `Bash(gh ${c} *)`),
    ...["issue create", "issue comment", "issue edit", "issue close", "issue reopen"].map((c) => `Bash(gh ${c} *)`),
    ...["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"].flatMap((option) => [
      `Bash(gh api ${option}*)`,
      `Bash(gh api * ${option}*)`,
    ]),
  ],
  "vercel deploys, promotions, rollbacks and removals": viaRunners([
    "vercel",
    "vercel --prod *",
    "vercel * --prod",
    "vercel * --prod *",
    "vercel deploy *",
    "vercel redeploy *",
    "vercel promote *",
    "vercel rollback *",
    "vercel remove *",
    "vercel rm *",
  ]),
  "database resets and deletions": [
    ...["neonctl", "neon"].flatMap((cli) =>
      ["delete", "reset", "restore"].flatMap((verb) => [`Bash(${cli} * ${verb})`, `Bash(${cli} * ${verb} *)`]),
    ),
    ...viaRunners([
      "prisma migrate reset *",
      "prisma db push --force-reset *",
      "prisma db push * --force-reset",
      "prisma db push * --force-reset *",
    ]),
    "Bash(dropdb *)",
  ],
  "recursive forced removal of root, home, working copy, parent and git directory": RM_FLAGS.flatMap((flags) =>
    RM_TARGETS.map((target) => `Bash(rm ${flags} ${target})`),
  ),
  "permissions, ownership and images": [
    "Bash(chmod -R 777 *)",
    "Bash(chmod --recursive 777 *)",
    "Bash(chown *)",
    "Bash(docker push *)",
    "Bash(docker image push *)",
    "Bash(docker system prune *)",
  ],
  "secret files and environment output": [
    "Read(.env*)",
    "Read(*.env)",
    "Bash(printenv *)",
    "Bash(env)",
    "Bash(env *)",
  ],
};

interface AgentSettings {
  topLevelKeys: string[];
  permissionKeys: string[];
  allow: string[];
  deny: string[];
  attribution: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new TypeError(`${label} must be a list of strings`);
  }
  return value;
}

function loadSettings(): AgentSettings {
  const parsed: unknown = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  if (!isRecord(parsed)) throw new TypeError("settings must be a JSON object");
  const { permissions, attribution } = parsed;
  if (!isRecord(permissions)) throw new TypeError("permissions must be an object");
  if (!isRecord(attribution)) throw new TypeError("attribution must be an object");
  return {
    topLevelKeys: Object.keys(parsed),
    permissionKeys: Object.keys(permissions),
    allow: stringList(permissions.allow ?? [], "permissions.allow"),
    deny: stringList(permissions.deny, "permissions.deny"),
    attribution,
  };
}

describe("Claude Code project settings", () => {
  it("parse as strict JSON with only permissions and attribution, and permissions holds only allow and deny", () => {
    const settings = loadSettings();
    expect(settings.topLevelKeys.sort()).toEqual(["attribution", "permissions"]);
    expect(settings.permissionKeys.every((key) => key === "allow" || key === "deny")).toBe(true);
    expect(settings.permissionKeys).toContain("deny");
  });

  it.each(Object.entries(DENY_RULES))("deny %s", (_category, rules) => {
    const { deny } = loadSettings();
    const missing = rules.filter((rule) => !deny.includes(rule));
    expect(missing).toEqual([]);
  });

  it("deny nothing beyond the listed categories and hold no duplicate rules", () => {
    const { deny } = loadSettings();
    const expected = new Set(Object.values(DENY_RULES).flat());
    expect(deny.filter((rule) => !expected.has(rule))).toEqual([]);
    expect(new Set(deny).size).toBe(deny.length);
  });

  it("keep publishing, removal, secret and broad shell forms out of the allow list", () => {
    const { allow, deny } = loadSettings();
    const forbidden: [string, (rule: string) => boolean][] = [
      ["whole Bash tool", (rule) => rule === "Bash" || rule === "Bash(*)"],
      ["environment output", (rule) => /^Bash\((env|printenv)\b/.test(rule)],
      ["broad rm", (rule) => rule.startsWith("Bash(rm ") || rule.startsWith("Bash(rm:")],
      ["broad gh", (rule) => /^Bash\(gh( \*|:\*|\))/.test(rule)],
      ["gh api", (rule) => rule.startsWith("Bash(gh api")],
      ["leading variable assignment", (rule) => /^Bash\([A-Za-z_][A-Za-z0-9_]*=/.test(rule)],
      ["vercel", (rule) => rule.includes("vercel")],
      ["broad git", (rule) => /^Bash\(git( \*|:\*|\))/.test(rule)],
      ["push", (rule) => rule.includes(" push")],
      ["bare pnpm or uv runner", (rule) => /^Bash\((pnpm|uv)( \*|:\*|\))/.test(rule) || /^Bash\((pnpm|uv) (exec|dlx|-)/.test(rule)],
      ["listed in deny", (rule) => deny.includes(rule)],
    ];
    const hits = allow.flatMap((rule) => forbidden.filter(([, test]) => test(rule)).map(([name]) => `${name}: ${rule}`));
    expect(hits).toEqual([]);
  });

  it("switch commit, PR and session-link attribution off with the values older versions also accept", () => {
    const { attribution } = loadSettings();
    expect(attribution).toStrictEqual({ commit: "", pr: "", sessionUrl: false });
  });
});

describe("agent instruction files", () => {
  it("CLAUDE.md imports AGENTS.md on its first line", () => {
    const firstLine = readFileSync("CLAUDE.md", "utf8").split("\n")[0];
    expect(firstLine).toBe("@AGENTS.md");
  });

  it("AGENTS.md has one section per topic, in order", () => {
    const headings = readFileSync("AGENTS.md", "utf8")
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## Working environment",
      "## Public safety",
      "## Publishing: pushes, pull requests and comments",
      "## Claims and public text",
      "## Commits, pull requests and attribution",
      "## Specification fidelity",
      "## Code and tests",
      "## Required checks",
      "## Git, review and merge",
      "## Review guidelines",
      "## Integration proof",
      "## Reuse, dependencies and licences",
      "## Security, credentials and agent permissions",
      "## Inbox",
    ]);
  });

  it("AGENTS.md names the publication wrapper, its inbox directories, the public rule IDs and every required check", () => {
    const text = readFileSync("AGENTS.md", "utf8");
    const required = [
      "tools/publication/bin/rbw-publish",
      "/inbox/publication/requests/",
      "/inbox/publication/responses/",
      "PUB-01",
      "PUB-02",
      ...["typecheck", "lint", "unit-tests", "build", "integration", "public-safety", "names-attribution", "prose"].map(
        (job) => `\`${job}\``,
      ),
    ];
    expect(required.filter((needle) => !text.includes(needle))).toEqual([]);
  });

  it("CLAUDE.md states the headless launch mode and does not claim deny rules load in every session", () => {
    const text = readFileSync("CLAUDE.md", "utf8");
    expect(text).toContain("--permission-mode dontAsk");
    expect(text).toContain("--allowedTools");
    expect(text).not.toContain("every session");
  });

  it("AGENTS.md describes the credentials file and the read-only publication mount, and no sign-in volume", () => {
    const text = readFileSync("AGENTS.md", "utf8");
    expect(text).toContain("owner-only credentials file");
    expect(text).toContain("read-only");
    expect(text).not.toContain("Docker volume");
  });

  it("AGENTS.md names the integration-heavy workflow, lists runner options as uncovered and drops the trailer-parse advice", () => {
    const text = readFileSync("AGENTS.md", "utf8");
    expect(text).toContain("`integration-heavy` workflow");
    expect(text).toContain("runner options");
    expect(text).not.toContain("other git global options");
    expect(text).not.toContain("git interpret-trailers");
  });

  it("AGENTS.md stays under the size Codex reads in full", () => {
    expect(statSync("AGENTS.md").size).toBeLessThan(AGENTS_MD_MAX_BYTES);
  });
});

describe("Codex project configuration", () => {
  it("adds no .codex directory, because Codex has no documented local attribution key", () => {
    expect(existsSync(".codex")).toBe(false);
  });
});
