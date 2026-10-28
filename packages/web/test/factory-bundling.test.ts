// What a deployment's factory functions hold (next.config.ts): every factory route traces the prepared
// packages directory and no judge route does, matched as Next.js matches a tracing include's route
// glob; the bundled host registry gets the frozen task-report adapter, which answers the web's calls
// exactly as the real adapter does; and the standalone output stays off unless the local check asks.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_REGISTRY } from "@rbw/case-validate/registry";
import type { HostAdapter } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";
import { describe, expect, it } from "vitest";
import config from "../next.config.ts";
import { freezeTaskReport, frozenTaskReportAdapter } from "../src/factory-server/live/task-report-frozen.ts";

const APP = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
// The matcher Next.js applies to outputFileTracingIncludes keys (build/collect-build-traces.js).
const picomatch = require("next/dist/compiled/picomatch") as (glob: string, options: { dot: boolean; contains: boolean }) => (path: string) => boolean;

/** Every route path under app/api, as Next.js names a route handler's entry. */
function apiRoutes(): string[] {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
  return walk(join(APP, "app", "api"))
    .filter((path) => path.endsWith(`${sep}route.ts`))
    .map((path) => `/${relative(join(APP, "app"), path).split(sep).slice(0, -1).join("/")}`)
    .sort();
}

function tracedFor(route: string): string[] {
  const includes = config.outputFileTracingIncludes ?? {};
  return Object.entries(includes).flatMap(([glob, files]) => (picomatch(glob, { dot: true, contains: true })(route) ? files : []));
}

const same = (a: unknown, b: unknown): boolean => canonicalDigest(a).sha256 === canonicalDigest(b).sha256;

function realTaskReport(): HostAdapter {
  const registration = HOST_REGISTRY.get("task-report");
  if (registration === null) throw new Error("the registry holds no task-report adapter");
  return registration.adapter;
}

describe("the factory routes' traced files", () => {
  const routes = apiRoutes();

  it("hold the prepared packages directory in every factory route", () => {
    const factory = routes.filter((route) => route.startsWith("/api/factory/"));
    // The factory contract's 13 routes and the bug designer's 3 under the factory session's path.
    expect(factory.length).toBe(16);
    for (const route of factory) expect(tracedFor(route), route).toEqual(["./factory-packages/**/*"]);
  });

  it("leave every other route unchanged", () => {
    const others = routes.filter((route) => !route.startsWith("/api/factory/"));
    expect(others).toEqual(expect.arrayContaining(["/api/judge", "/api/judge/session", "/api/judge/status"]));
    for (const route of others) expect(tracedFor(route), route).toEqual([]);
  });

  it("name the directory the deploy copies the packages into, which is never committed", () => {
    // packages/web/.gitignore holds /factory-packages/; the Vercel CLI uploads ignored files all the same.
    expect(existsSync(join(APP, ".gitignore"))).toBe(true);
    expect(readFileSync(join(APP, ".gitignore"), "utf8")).toContain("/factory-packages/\n");
  });

  it("are a standard server build unless the local standalone check asks for one", () => {
    expect(process.env.RBW_WEB_STANDALONE).toBeUndefined();
    expect(config.output).toBeUndefined();
  });
});

describe("the frozen task-report adapter", () => {
  it("is what the bundler gives the host registry for the task-report adapter", () => {
    const target = config.turbopack?.resolveAlias?.["@rbw/host-task-report/adapter"];
    if (typeof target !== "string") throw new Error("the adapter alias is not a path");
    expect(target).toBe("./src/factory-server/live/task-report-frozen.ts");
    expect(existsSync(join(APP, target))).toBe(true);
  });

  it("is frozen by the build from the real adapter", () => {
    expect(config.env?.RBW_FACTORY_TASK_REPORT_FROZEN).toBe(freezeTaskReport(realTaskReport()));
  });

  it("answers the web's calls as the real adapter does", () => {
    const real = realTaskReport();
    const frozen = frozenTaskReportAdapter(() => freezeTaskReport(real));
    expect(frozen.host_id).toBe(real.host_id);
    expect(same(frozen.baseline(), real.baseline())).toBe(true);
    expect(same(frozen.catalog(), real.catalog())).toBe(true);
    expect(real.catalog().length).toBeGreaterThan(0);
    for (const entry of real.catalog()) {
      expect(same(frozen.protocol(entry), real.protocol(entry))).toBe(true);
      expect(frozen.availability?.(entry, "2026-11-03T00:00:00Z", "2026-11-03T01:00:00Z")).toEqual(real.availability?.(entry, "2026-11-03T00:00:00Z", "2026-11-03T01:00:00Z"));
    }
  });

  it("refuses an entry outside its catalog and every call that runs copies", () => {
    const frozen = frozenTaskReportAdapter(() => freezeTaskReport(realTaskReport()));
    const [entry] = frozen.catalog();
    if (entry === undefined) throw new Error("no entry");
    expect(() => frozen.protocol({ ...entry, entry_id: "synthetic-other-entry" })).toThrow("not an entry of the frozen task-report catalog");
    expect(() => frozen.protocol({ ...entry, catalog_version: "synthetic" })).toThrow("not an entry of the frozen task-report catalog");
    expect(() => frozen.bugCaseInputs(entry)).toThrow("only the task-report adapter's baseline, catalog and protocols");
    expect(() => frozen.validatorInputs(entry)).toThrow("only the task-report adapter's baseline, catalog and protocols");
    expect(() => frozenTaskReportAdapter(() => undefined).catalog()).toThrow("the build froze no task-report catalog");
    // Each call hands out a copy.
    const first = frozen.catalog();
    first.length = 0;
    expect(frozen.catalog().length).toBeGreaterThan(0);
  });
});
