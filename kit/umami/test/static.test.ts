import { describe, expect, it } from "vitest";
import { parseBuildOutputs, parseEnvFile, parseHashList } from "../src/manifest.ts";
import { argDefaults, memo, parseDockerfile, readKitFile, type Instruction } from "./kit-files.ts";

const dockerfile = memo(() => readKitFile("Dockerfile"));
const instructions = memo(() => parseDockerfile(dockerfile()));
const froms = memo(() => instructions().filter((instruction) => instruction.keyword === "FROM"));
const runs = memo(() => instructions().filter((instruction) => instruction.keyword === "RUN"));
const finalStage = memo(() => froms().at(-1)?.stage ?? "");
const launcher = memo(() => readKitFile("bin/rbw-launch"));

function stageInstructions(stage: string): Instruction[] {
  return instructions().filter((instruction) => instruction.stage === stage);
}

function envOf(stage: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const instruction of stageInstructions(stage)) {
    if (instruction.keyword === "ENV") {
      for (const pair of instruction.args.split(/\s+/)) {
        const [name, value] = pair.split("=", 2);
        if (name !== undefined && value !== undefined) {
          env.set(name, value);
        }
      }
    }
  }
  return env;
}

describe("base images", () => {
  const defaults = memo(() => argDefaults(instructions()));
  const firstFrom = memo(() => instructions().findIndex((instruction) => instruction.keyword === "FROM"));
  const globalArgs = memo(() => instructions().slice(0, firstFrom()).filter((instruction) => instruction.keyword === "ARG"));

  it("takes the registry from a build argument that defaults to Docker Hub, declared before the first FROM", () => {
    expect(globalArgs().map((instruction) => instruction.args)).toContain("REGISTRY=docker.io");
  });

  it("pins every registry FROM by a sha256 digest build argument with the tag in a comment", () => {
    const stages = new Set<string>();
    const pinned: string[] = [];
    for (const from of froms()) {
      const ref = from.args.split(/\s+/)[0] ?? "";
      if (stages.has(ref)) {
        stages.add(from.stage);
        continue;
      }
      if (ref === "scratch") {
        expect(from.stage).toBe("rbw-kit");
        stages.add(from.stage);
        continue;
      }
      const match = /^\$\{REGISTRY\}\/library\/[a-z0-9-]+@\$\{([A-Z0-9_]+)\}$/.exec(ref);
      expect(match, `FROM ${from.args}`).not.toBeNull();
      const argName = match?.[1] ?? "";
      expect(defaults().get(argName), argName).toMatch(/^sha256:[0-9a-f]{64}$/);
      const declaration = globalArgs().find((instruction) => instruction.args.startsWith(`${argName}=`));
      expect(declaration?.comments.join(" "), argName).toMatch(/\b(node|postgres):[0-9]+-alpine\b/);
      pinned.push(argName);
      stages.add(from.stage);
    }
    expect(pinned.length).toBeGreaterThanOrEqual(3);
  });

  it("uses node:22-alpine for the app, node:24-alpine for the verifier and postgres:15-alpine for the database", () => {
    const tagOf = (argName: string) =>
      globalArgs().find((instruction) => instruction.args.startsWith(`${argName}=`))?.comments.join(" ") ?? "";
    expect(tagOf("NODE22_DIGEST")).toContain("node:22-alpine");
    expect(tagOf("NODE24_DIGEST")).toContain("node:24-alpine");
    expect(tagOf("POSTGRES15_DIGEST")).toContain("postgres:15-alpine");
    expect(froms().find((from) => from.stage === finalStage())?.args.split(/\s+/)[0]).toBe("app-base");
    expect(froms().find((from) => from.stage === "app-base")?.args).toMatch(/@\$\{NODE22_DIGEST\}/);
  });

  it("pins pnpm 12.3.4 for the app, as Umami does", () => {
    expect(argDefaults(instructions()).get("PNPM_VERSION")).toBe("12.3.4");
  });

  it("copies the verifier's Node 24 runtime into the verifier area", () => {
    expect(dockerfile()).toMatch(/COPY --from=verifier-node[^\n]*\/usr\/local\/bin\/node \/opt\/rbw\/verifier\/node\/bin\/node/);
  });
});

describe("browsers", () => {
  it("has no browser install step", () => {
    expect(dockerfile()).not.toMatch(/playwright\s+install/);
    expect(dockerfile()).not.toMatch(/install-deps/);
    expect(dockerfile()).not.toMatch(/chromium|firefox|webkit/i);
  });

  it("sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 in every stage that installs packages", () => {
    const installing = new Set(
      runs().filter((run) => /\b(pnpm|npm) install\b/.test(run.args)).map((run) => run.stage),
    );
    expect(installing.size).toBeGreaterThanOrEqual(2);
    for (const stage of installing) {
      expect(envOf(stage).get("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"), stage).toBe("1");
    }
  });
});

describe("users", () => {
  it("creates rbw-app as UID 2001 and rbw-db as UID 2002, each in its own group", () => {
    expect(dockerfile()).toMatch(/addgroup -g 2001 rbw-app/);
    expect(dockerfile()).toMatch(/adduser -D -H [^\n]*-G rbw-app -u 2001 rbw-app/);
    expect(dockerfile()).toMatch(/addgroup -g 2002 rbw-db/);
    expect(dockerfile()).toMatch(/adduser -D -H [^\n]*-G rbw-db -u 2002 rbw-db/);
  });

  it("maps the launcher's app and db identities to those IDs", () => {
    expect(launcher()).toMatch(/app\)\s*uid=2001;?\s*gid=2001/);
    expect(launcher()).toMatch(/db\)\s*uid=2002;?\s*gid=2002/);
  });

  it("removes setuid and setgid bits from every file in the image", () => {
    expect(dockerfile()).toMatch(/find \/ -xdev -type f \\\( -perm -4000 -o -perm -2000 \\\) -exec chmod ug-s/);
  });
});

describe("protected paths", () => {
  it("creates the verifier tree root-owned with directories 0700, files 0600 and executables 0700", () => {
    expect(dockerfile()).toMatch(/find \/opt\/rbw\/verifier -type d -exec chmod 0700 \{\} \+/);
    expect(dockerfile()).toMatch(/find \/opt\/rbw\/verifier -type f -perm \/111 -exec chmod 0700 \{\} \+/);
    expect(dockerfile()).toMatch(/find \/opt\/rbw\/verifier -type f ! -perm \/111 -exec chmod 0600 \{\} \+/);
    expect(dockerfile()).toMatch(/chown -R root:root \/opt\/rbw\/verifier/);
  });

  it("creates the results directory root-owned with mode 0700", () => {
    expect(dockerfile()).toMatch(/install -d -o root -g root -m 0700 \/var\/lib\/rbw\/results/);
  });

  it("creates the database directory owned by rbw-db with mode 0700", () => {
    expect(dockerfile()).toMatch(/install -d -o rbw-db -g rbw-db -m 0700 \/var\/lib\/rbw\/pgdata/);
  });

  it("installs the launcher and the other scripts root-owned and not writable by others", () => {
    expect(dockerfile()).toMatch(/COPY --chown=0:0 --chmod=0755 bin\/ \/opt\/rbw\/bin\//);
  });

  it("writes the image manifest root-owned with mode 0600", () => {
    expect(dockerfile()).toMatch(/--out \/opt\/rbw\/verifier\/image-manifest\.json/);
  });
});

describe("postgres configuration", () => {
  const conf = memo(() => readKitFile("etc/postgresql.rbw.conf"));
  const hba = memo(() => readKitFile("etc/pg_hba.conf"));

  it("listens on 127.0.0.1 only", () => {
    const listen = conf().split("\n").filter((line) => /^\s*listen_addresses\b/.test(line));
    expect(listen).toEqual(["listen_addresses = '127.0.0.1'"]);
  });

  it("puts the Unix socket in the root-and-rbw-db directory", () => {
    expect(conf()).toMatch(/^unix_socket_directories = '\/run\/rbw-pg'$/m);
    expect(dockerfile()).toMatch(/install -d -o root -g rbw-db -m 0770 \/run\/rbw-pg/);
  });

  it("accepts TCP connections only from loopback, and only for the app role", () => {
    const rules = hba().split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    const hostRules = rules.filter((rule) => rule.startsWith("host"));
    expect(hostRules).toEqual(["host    umami   umami_app   127.0.0.1/32   scram-sha-256"]);
  });

  it("gives the app role no superuser, role or database creation rights", () => {
    const bootstrap = readKitFile("etc/bootstrap.sql");
    expect(bootstrap).toMatch(/CREATE ROLE umami_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/);
    expect(bootstrap).toMatch(/CREATE DATABASE umami OWNER umami_owner/);
    expect(bootstrap).not.toMatch(/GRANT[^;]*umami_owner[^;]*TO umami_app/);
  });
});

describe("app environment", () => {
  const appEnv = memo(() => parseEnvFile(readKitFile("etc/app.environment")));
  const buildEnv = memo(() => parseEnvFile(readKitFile("etc/build.environment")));

  it("sets the test settings from Umami's test compose file", () => {
    expect(appEnv().set).toMatchObject({
      TZ: "UTC",
      DISABLE_BOT_CHECK: "1",
      MCP_ENABLED: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_UPDATES: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      APP_SECRET: "umami-api-test-secret",
      TWO_FACTOR_ENCRYPTION_KEY: "0".repeat(64),
    });
    expect(appEnv().set.TWO_FACTOR_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
  });

  it("points DATABASE_URL at the restricted role on loopback", () => {
    expect(appEnv().set.DATABASE_URL).toMatch(/^postgresql:\/\/umami_app:[^@]+@127\.0\.0\.1:5432\/umami$/);
  });

  it("explicitly unsets the ClickHouse, Redis, cloud and replica variables", () => {
    const forced = ["CLICKHOUSE_URL", "REDIS_URL", "CLOUD_MODE", "DATABASE_REPLICA_URL"];
    for (const name of forced) {
      expect(appEnv().unset).toContain(name);
      expect(appEnv().set).not.toHaveProperty(name);
      expect(buildEnv().unset).toContain(name);
      expect(buildEnv().set).not.toHaveProperty(name);
    }
  });

  it("builds with SKIP_BUILD_GEO=1 and telemetry off", () => {
    expect(buildEnv().set).toMatchObject({ SKIP_BUILD_GEO: "1", NEXT_TELEMETRY_DISABLED: "1" });
  });
});

describe("tracked Umami files", () => {
  const scripts = memo(() => ["rbw-launch", "rbw-start", "rbw-stop", "rbw-build-app", "rbw-db-init"].map((name) =>
    readKitFile(`bin/${name}`),
  ));

  it("never edits pnpm-workspace.yaml, and sets strictDepBuilds through pnpm's environment instead", () => {
    for (const run of runs()) {
      expect(run.args).not.toContain("pnpm-workspace.yaml");
    }
    expect(envOf("deps").get("pnpm_config_strict_dep_builds")).toBe("false");
  });

  it("has no in-place edit, patch or redirect into the app tree", () => {
    for (const text of [dockerfile(), ...scripts()]) {
      expect(text).not.toMatch(/sed -i|git apply|\bpatch -p|>>\s*\/workspace\/app/);
    }
  });

  it("adds docker/proxy.ts as src/proxy.ts only where no tracked file exists", () => {
    expect(dockerfile()).toMatch(/test ! -e src\/proxy\.ts && cp docker\/proxy\.ts src\/proxy\.ts/);
  });

  it("checks the source tree against the pinned commit", () => {
    expect(dockerfile()).toMatch(/test "\$\(git rev-parse HEAD\)" = "\$UMAMI_COMMIT"/);
    expect(argDefaults(instructions()).get("UMAMI_COMMIT")).toBe("ec0ff50388c264ed8ce46f00967e92f7e71476ae");
  });
});

describe("build outputs", () => {
  const outputs = memo(() => parseBuildOutputs(readKitFile("build-outputs.txt")));

  it("declares exactly the paths pnpm build:docker writes", () => {
    expect(outputs()).toEqual([
      { kind: "dir", path: ".next" },
      { kind: "dir", path: "generated" },
      { kind: "dir", path: "packages/api-client/dist" },
      { kind: "dir", path: "packages/mcp/dist" },
      { kind: "dir", path: "src/generated" },
      { kind: "file", path: "next-env.d.ts" },
      { kind: "file", path: "public/openapi.json" },
      { kind: "file", path: "public/recorder.js" },
      { kind: "file", path: "public/script.js" },
      { kind: "sticky", path: "packages/api-client" },
      { kind: "sticky", path: "packages/mcp" },
      { kind: "tracked", path: "packages/api-client/src/generated/operations.ts" },
      { kind: "tracked", path: "packages/api-client/src/generated/types.ts" },
      { kind: "tracked", path: "src/tracker/index.d.ts" },
    ]);
  });

  it("is applied by the Dockerfile from the committed list", () => {
    expect(dockerfile()).toMatch(/build-outputs\.txt/);
  });
});

describe("suite closure", () => {
  const entries = memo(() => parseHashList(readKitFile("closure.sha256")));
  const paths = memo(() => entries().map((entry) => entry.path));

  it("lists the config, the analytics-query helper and tests/api only, without .runtime", () => {
    expect(paths()).toContain("playwright.api.config.ts");
    expect(paths()).toContain("src/lib/analytics-query.ts");
    const others = paths().filter((path) => path !== "playwright.api.config.ts" && path !== "src/lib/analytics-query.ts");
    expect(others.length).toBeGreaterThan(0);
    for (const path of others) {
      expect(path.startsWith("tests/api/"), path).toBe(true);
      expect(path.includes("/.runtime"), path).toBe(false);
    }
  });

  it("is sorted and has no duplicates", () => {
    expect([...paths()].sort()).toEqual(paths());
    expect(new Set(paths()).size).toBe(paths().length);
  });

  it("is checked against the fetched files, and against the full tests/api listing, at build time", () => {
    expect(dockerfile()).toMatch(/sha256sum -c \/rbw\/closure\.sha256/);
    expect(dockerfile()).toMatch(/find tests\/api -type f/);
  });
});

describe("verifier lock", () => {
  const lock = memo(() => readKitFile("verifier/pnpm-lock.yaml"));
  const manifest = memo(() => JSON.parse(readKitFile("verifier/package.json")) as { dependencies: Record<string, string> });

  it("pins @playwright/test 1.63.0, otplib 13.5.0 and pg 8.23.1 as the only direct dependencies", () => {
    expect(manifest().dependencies).toEqual({ "@playwright/test": "1.63.0", otplib: "13.5.0", pg: "8.23.1" });
    for (const [name, version] of Object.entries(manifest().dependencies)) {
      const block = new RegExp(`\\n {6}'?${name.replace("/", "\\/")}'?:\\n {8}specifier: ${version}\\n {8}version: ${version}\\n`);
      expect(lock(), name).toMatch(block);
    }
    expect(lock()).toMatch(/^lockfileVersion: '9\.0'$/m);
  });

  it("is installed with the frozen lockfile and no lifecycle scripts", () => {
    expect(dockerfile()).toMatch(/pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts/);
  });
});

describe("launcher", () => {
  it("is a POSIX sh script around setpriv, setsid and env -i", () => {
    expect(launcher().startsWith("#!/bin/sh\n")).toBe(true);
    expect(launcher()).toMatch(/exec setsid \/bin\/setpriv [^\n]*--no-new-privs/);
    expect(launcher()).toMatch(/exec setsid \/bin\/setpriv [^\n]*--clear-groups/);
    expect(launcher()).toMatch(/\bsetsid\b/);
    expect(launcher()).toMatch(/\benv -i\b/);
  });

  it("drops loader and runtime overrides even when the env file sets them", () => {
    for (const name of ["LD_\\*", "NODE_OPTIONS", "NODE_PATH"]) {
      expect(launcher()).toMatch(new RegExp(`denied_name\\(\\)[\\s\\S]*${name}[\\s\\S]*\\n}`));
    }
  });

  it("defaults to 1 MiB per stream", () => {
    expect(launcher()).toMatch(/max_bytes=1048576/);
  });
});

describe("runtime", () => {
  it("runs tini as PID 1", () => {
    expect(instructions().find((instruction) => instruction.keyword === "ENTRYPOINT" && instruction.stage === finalStage())?.args).toBe(
      '["/sbin/tini", "--"]',
    );
  });

  it("installs tini, setpriv, tzdata and tmux from Alpine", () => {
    const apk = stageInstructions(finalStage())
      .filter((instruction) => instruction.keyword === "RUN" && instruction.args.includes("apk add"))
      .map((instruction) => instruction.args)
      .join(" ");
    for (const name of ["tini", "setpriv", "tzdata", "tmux"]) {
      expect(apk).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it("copies the driver and fixture packages from the rbw-kit context, which defaults to an empty stage", () => {
    expect(dockerfile()).toMatch(/^FROM scratch AS rbw-kit$/m);
    expect(dockerfile()).toMatch(/COPY --from=rbw-kit \/ \/opt\/rbw\/verifier\/kit\//);
  });
});

describe("offline fonts", () => {
  const mocks = memo(() => readKitFile("fonts/next-font-google-mocks.cjs"));
  const fonts = memo(() => parseHashList(readKitFile("fonts/fonts.sha256")));

  it("serves exactly the hashed font files from the loopback font server", () => {
    const urls = [...mocks().matchAll(/http:\/\/127\.0\.0\.1:3901\/([A-Za-z0-9_-]+\.woff2)/g)].map((match) => match[1]);
    expect([...new Set(urls)].sort()).toEqual(fonts().map((font) => font.path).sort());
    expect(mocks()).not.toMatch(/https?:\/\/fonts\.gstatic\.com/);
  });

  it("points the build at the mock file", () => {
    expect(parseEnvFile(readKitFile("etc/build.environment")).set.NEXT_FONT_GOOGLE_MOCKED_RESPONSES).toBe(
      "/opt/rbw/build/next-font-google-mocks.cjs",
    );
  });
});

describe("in-image self-test", () => {
  const selftest = memo(() => readKitFile("bin/rbw-kit-selftest"));

  it("names every required check", () => {
    for (const name of [
      "app-cannot-read-verifier",
      "app-cannot-list-verifier",
      "app-cannot-write-results",
      "app-cannot-signal-driver",
      "app-cannot-read-driver-environ",
      "launcher-sets-no-new-privs",
      "launcher-clears-loader-overrides",
      "launcher-truncates-output",
      "launcher-kills-term-ignoring-child",
      "postgres-listens-on-loopback-only",
      "app-role-cannot-create-roles-or-databases",
      "no-browser-binaries",
      "no-build-outputs-or-caches",
      "suite-closure-hashes-match",
    ]) {
      expect(selftest()).toContain(`check ${name} `);
    }
  });

  it("says when NoNewPrivs was already set for the self-test, so the launcher's own setting is untested", () => {
    expect(selftest()).toContain("grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status");
    expect(selftest()).toContain("NoNewPrivs was already 1 for the self-test");
  });
});
