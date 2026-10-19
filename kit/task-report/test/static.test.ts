import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_DIR, ETC_DIR, EVALUATOR_DIR, EVALUATOR_SUITE_DIR, LAUNCH, PG_SOCKET_DIR, RESULTS_DIR } from "../../../packages/host-task-report/src/copy/layout.ts";
import { loadData } from "../../../packages/host-task-report/src/f3/data.ts";
import { buildArgs } from "../../../packages/host-task-report/src/local/cli.ts";

const kit = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(`${kit}/${path}`, "utf8");
const dockerfile = read("Dockerfile");

function argDefault(text: string, name: string): string | undefined {
  return new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(text)?.[1];
}

describe("base images", () => {
  it("pins the same multi-architecture Node 24 and PostgreSQL 15 digests as the Umami kit", () => {
    const umami = read("../umami/Dockerfile");
    for (const name of ["NODE24_DIGEST", "POSTGRES15_DIGEST"]) {
      expect(argDefault(dockerfile, name), name).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(argDefault(dockerfile, name), name).toBe(argDefault(umami, name));
    }
    expect(dockerfile).toContain("node:24-alpine (Node 24.21.0");
    expect(dockerfile).toContain("postgres:15-alpine (PostgreSQL 15.19");
    for (const from of dockerfile.split("\n").filter((line) => line.startsWith("FROM "))) {
      expect(from).toMatch(/^FROM (\$\{REGISTRY\}\/library\/(node|postgres)@\$\{(NODE24|POSTGRES15)_DIGEST\}|node24) AS [a-z0-9-]+$/);
    }
  });
});

describe("app dependencies and the evaluator area", () => {
  it("installs the baseline's dependencies from its lockfile without lifecycle scripts", () => {
    expect(dockerfile).toContain("COPY --from=app --chown=node:node package.json package-lock.json ./");
    expect(dockerfile).toContain("RUN npm ci --ignore-scripts --no-audit --no-fund");
    expect(dockerfile).toContain(`/home/node/deps/node_modules ${APP_DIR}/node_modules`);
    expect(dockerfile).toContain(`/home/node/deps/node_modules ${EVALUATOR_DIR}/node_modules`);
  });

  it("keeps the evaluator tree and the results root-only", () => {
    expect(dockerfile).toContain(`chown -R root:root ${EVALUATOR_DIR}`);
    expect(dockerfile).toContain(`find ${EVALUATOR_DIR} -type d -exec chmod 0700 {} +`);
    expect(dockerfile).toContain(`find ${EVALUATOR_DIR} -type f ! -perm /111 -exec chmod 0600 {} +`);
    expect(dockerfile).toContain(`install -d -o root -g root -m 0700 ${RESULTS_DIR}`);
    expect(dockerfile).toContain(`install -d -o root -g rbw-db -m 0770 ${PG_SOCKET_DIR}`);
    expect(dockerfile).toContain(`COPY --from=app --chown=0:0 test ${EVALUATOR_SUITE_DIR}/test`);
  });

  it("takes rbw-launch from the Umami kit instead of keeping a copy", () => {
    expect(existsSync(`${kit}/bin/rbw-launch`)).toBe(false);
    expect(dockerfile).toContain(`COPY --from=launcher --chown=0:0 --chmod=0755 rbw-launch ${LAUNCH}`);
    expect(buildArgs("rbw-task-report:t", "/r")).toEqual(expect.arrayContaining(["launcher=/r/kit/umami/bin", "app=/r/hosts/task-report/app", "evaluator=/r/packages/host-task-report", "/r/kit/task-report"]));
    expect(read("../umami/bin/rbw-launch")).toMatch(/app\) uid=2001; gid=2001; user=rbw-app/);
    expect(dockerfile).toMatch(/-u 2001 rbw-app/);
    expect(dockerfile).toMatch(/-u 2002 rbw-db/);
  });

  it("runs the copy driver from the evaluator area as the default command", () => {
    expect(read("bin/rbw-copy")).toContain(`exec /usr/local/bin/node ${EVALUATOR_DIR}/pkg/src/copy/main.ts "$@"`);
    expect(dockerfile).toContain('ENTRYPOINT ["/sbin/tini", "--"]');
  });
});

describe("database access", () => {
  const data = loadData();

  it("accepts only the app role over loopback TCP, with its password", () => {
    const rules = read("etc/pg_hba.conf")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+/));
    expect(rules).toEqual([
      ["local", "all", "all", "trust"],
      ["host", "taskapp", data.environment.app_role, "127.0.0.1/32", "scram-sha-256"],
    ]);
    expect(read("etc/postgresql.task-report.conf")).toContain(`unix_socket_directories = '${PG_SOCKET_DIR}'`);
  });

  it("provisions the data file's roles, gives only the app role a password, and the app uses it", () => {
    const roles = read("etc/provision/00-roles.sql");
    expect(roles).toContain(`CREATE ROLE ${data.environment.gate_role} LOGIN NOSUPERUSER`);
    const password = /CREATE ROLE taskapp_app LOGIN PASSWORD '([^']+)'/.exec(roles)?.[1];
    expect(password).toBeDefined();
    expect((roles.match(/PASSWORD/g) ?? []).length).toBe(1);
    const env = read("etc/app.environment");
    expect(env).toContain(`DATABASE_URL=postgresql://${data.environment.app_role}:${String(password)}@127.0.0.1:5432/taskapp`);
    expect(read("etc/provision/10-after-migrate.sql")).toContain(`GRANT SELECT, UPDATE ON tasks TO ${data.environment.gate_role};`);
  });

  it("leaves the pool at the app's default size, which the check's gates assume", () => {
    const settings = read("etc/app.environment")
      .split("\n")
      .filter((line) => !line.startsWith("#"));
    expect(settings.some((line) => line.startsWith("DB_POOL_MAX="))).toBe(false);
    expect(data.environment.db_pool_max).toBe(10);
    expect(existsSync(`${kit}/etc/provision`)).toBe(true);
    expect(ETC_DIR).toBe("/opt/rbw/etc");
  });
});
