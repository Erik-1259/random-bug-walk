import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as factoryWeb from "../../src/factory-web.ts";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** Static imports and re-exports of a source file (dynamic imports load on first use only). */
function staticImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)";/gms)].map((match) => match[1] ?? "");
}

/** Every module factory-web.ts loads, following its relative imports. */
function graph(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier.startsWith(".")) visit(join(dirname(file), specifier));
      else packages.add(specifier);
    }
  };
  visit(join(SRC, "factory-web.ts"));
  return { files, packages };
}

describe("@rbw/controller/factory-web", () => {
  it("loads no runner, harness, Umami driver, worker loop or PGlite, like judge-web: only the database driver and the factory core besides", () => {
    const { files, packages } = graph();
    const names = [...files].map((file) => file.slice(SRC.length)).sort();
    expect(names).toEqual(["database-ledger.ts", "factory-launch.ts", "factory-ledger.ts", "factory-lost.ts", "factory-ports.ts", "factory-profile.ts", "factory-run-once.ts", "factory-spend.ts", "factory-web.ts"]);
    for (const forbidden of ["@electric-sql/pglite", "@rbw/local-runner", "@rbw/umami-driver", "@rbw/admission", "@rbw/publisher", "tar-stream", "@vercel/sandbox"]) expect(packages.has(forbidden)).toBe(false);
    expect([...packages].sort()).toEqual(["@rbw/envelope", "@rbw/factory", "@rbw/factory-contract", "@rbw/local-runner/shared", "@rbw/schema", "@rbw/spend", "pg"]);
  });

  it("exports what the web service calls", () => {
    for (const name of ["startFactoryWorker", "startFactoryValidation", "finalizeLostWorker", "completeReconciliation", "workerOperation", "validationOperation", "copyOperation", "createWorkerSandboxSdk", "profileForService", "factoryEnvelope", "factoryProfileInput", "parseRateSheet", "busyReason", "openFactoryDatabase", "factoryDatabaseOver"] as const) {
      expect(typeof factoryWeb[name]).toBe("function");
    }
    for (const name of ["lostWorker", "finished", "attention"] as const) expect(typeof factoryWeb.FACTORY_EVENTS[name]).toBe("function");
    expect(factoryWeb.FACTORY_IDENTITY.project_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(factoryWeb.FACTORY_PROFILE.limits.max_budget_microusd).toBe(3_000_000);
    expect(factoryWeb.WORKER_IMAGE_VARIABLE).toBe("RBW_FACTORY_WORKER_IMAGE");
  });
});
