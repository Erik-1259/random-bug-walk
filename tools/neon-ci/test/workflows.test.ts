import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS_DIR = join(import.meta.dirname, "..", "..", "..", ".github", "workflows");
const OWN_FILES = ["integration.yml", "integration-heavy.yml", "neon-ci-cleanup.yml"];
const C1_NAMES = ["typecheck", "lint", "unit-tests", "build", "integration", "public-safety", "names-attribution", "prose"];

type Obj = Record<string, unknown>;

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number | boolean>;
}

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  uses?: string;
  strategy?: unknown;
  "timeout-minutes"?: number;
  "runs-on"?: string;
  permissions?: unknown;
  steps?: Step[];
}

interface Workflow {
  text: string;
  on: Obj;
  permissions?: unknown;
  concurrency?: unknown;
  jobs: Record<string, Job>;
}

function load(file: string): Workflow {
  const text = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
  const doc = parse(text) as Obj;
  return { text, on: (doc.on ?? {}) as Obj, permissions: doc.permissions, concurrency: doc.concurrency, jobs: (doc.jobs ?? {}) as Record<string, Job> };
}

const own = new Map(OWN_FILES.map((file) => [file, load(file)]));

function workflowOf(file: string): Workflow {
  const workflow = own.get(file);
  if (workflow === undefined) throw new Error(`unknown workflow ${file}`);
  return workflow;
}

function jobOf(workflow: Workflow, id: string): Job {
  const job = workflow.jobs[id];
  if (job === undefined) throw new Error(`missing job ${id}`);
  return job;
}
const integration = workflowOf("integration.yml");
const heavy = workflowOf("integration-heavy.yml");
const sweep = workflowOf("neon-ci-cleanup.yml");

function reportedName(id: string, job: Job): string {
  return job.name ?? id;
}

function steps(job: Job | undefined): Step[] {
  return job?.steps ?? [];
}

const DB_URL = /outputs\.db_url(?![A-Za-z0-9_])/;

describe("across all workflow files", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  it("has exactly one job reporting `integration`, in integration.yml, without a matrix", () => {
    const reporters = files.flatMap((file) =>
      Object.entries(load(file).jobs)
        .filter(([id, job]) => reportedName(id, job) === "integration")
        .map(([id, job]) => ({ file, id, job })),
    );
    expect(reporters).toHaveLength(1);
    expect(reporters[0]?.file).toBe("integration.yml");
    expect(reporters[0]?.job.strategy).toBeUndefined();
    expect(reporters[0]?.job.uses).toBeUndefined();
  });
});

describe("this item's workflow files", () => {
  it.each(OWN_FILES)("%s: pinned actions, permissions, timeouts and safe expressions", (file) => {
    const workflow = workflowOf(file);
    expect(workflow.permissions).toBeDefined();
    expect(workflow.text).not.toMatch(/pull_request_target/);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job["timeout-minutes"], `${id} timeout`).toBeTypeOf("number");
      expect(job["runs-on"], `${id} runner`).toBe("ubuntu-24.04");
      for (const step of steps(job)) {
        if (step.uses !== undefined) {
          expect(step.uses, `${id} uses`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
        if (step.uses?.startsWith("actions/checkout@") === true) {
          expect(step.with?.["persist-credentials"]).toBe(false);
        }
        if (step.run !== undefined) {
          expect(step.run, `${id} run`).not.toMatch(/\$\{\{\s*(github\.event\.|inputs\.)/);
          expect(step.run, `${id} run`).not.toContain("${{");
        }
      }
    }
    for (const line of workflow.text.split("\n").filter((l) => /\buses:/.test(l))) {
      expect(line).toMatch(/@[0-9a-f]{40} # \S+$/);
    }
  });

  it("the heavy and sweep workflows report no C1 name", () => {
    for (const workflow of [heavy, sweep]) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        expect(C1_NAMES).not.toContain(reportedName(id, job));
      }
    }
    expect(Object.keys(heavy.jobs)).toEqual(["heavy-integration"]);
  });

  it("only integration-scope, integration and integration-cleanup use non-C1 names besides integration", () => {
    expect(Object.keys(integration.jobs)).toEqual(["integration-scope", "integration", "integration-cleanup"]);
    expect(reportedName("integration-scope", jobOf(integration, "integration-scope"))).toBe("integration-scope");
  });
});

describe("integration.yml", () => {
  it("triggers only on pull_request, with no path filters", () => {
    expect(Object.keys(integration.on)).toEqual(["pull_request"]);
    const trigger = integration.on.pull_request as Obj;
    expect(trigger.paths).toBeUndefined();
    expect(trigger["paths-ignore"]).toBeUndefined();
    expect(trigger.types).toBeUndefined();
  });

  it("has an empty workflow-level permissions block and a per-PR cancelling concurrency group", () => {
    expect(integration.permissions).toEqual({});
    const concurrency = integration.concurrency as Obj;
    expect(concurrency["cancel-in-progress"]).toBe(true);
    expect(concurrency.group).toContain("github.event.pull_request.number");
  });

  it("classifies with the shared docs-only script and the three-dot diff", () => {
    const scope = jobOf(integration, "integration-scope");
    const run = steps(scope).map((s) => s.run ?? "").join("\n");
    expect(run).toContain("scripts/checks/docs-only.ts");
    expect(run).toContain("git diff --name-only --no-renames");
    expect(run).toMatch(/\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}/);
    expect(steps(scope).some((s) => s.with?.["fetch-depth"] === 0)).toBe(true);
  });

  it("runs `integration` unless cancelled and unless docs-only classification succeeded", () => {
    const job = jobOf(integration, "integration");
    expect(job.name).toBe("integration");
    expect(job.if).toContain("!cancelled()");
    expect(job.if).toContain("needs.integration-scope.result != 'success'");
    expect(job.if).toContain("needs.integration-scope.outputs.docs_only != 'true'");
    expect(job["timeout-minutes"]).toBe(30);
  });

  it("gives the cleanup job always(), no reference to the integration result, and a same-repo guard", () => {
    const job = jobOf(integration, "integration-cleanup");
    expect(job.if).toContain("always()");
    expect(job.if).not.toContain("needs.integration.result");
    expect(job.if).toContain("needs.integration.outputs.cleanup_confirmed != 'true'");
    expect(job.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(job.needs).toEqual(["integration-scope", "integration"]);
    expect(job["timeout-minutes"]).toBe(10);
  });

  it("deletes with always() and exposes the two outputs", () => {
    const job = integration.jobs.integration as Job & { outputs?: Record<string, string> };
    const del = steps(job).find((s) => s.id === "delete");
    expect(del?.if).toBe("always()");
    expect(del?.run).toContain("cli.ts");
    expect(Object.keys(job.outputs ?? {})).toEqual(["cleanup_confirmed"]);
  });

  it("creates the branch through the neon-ci CLI after install and the configuration check", () => {
    const list = steps(integration.jobs.integration);
    const createIndex = list.findIndex((s) => s.id === "create");
    const installIndex = list.findIndex((s) => s.run?.includes("pnpm install --frozen-lockfile") === true);
    const configIndex = list.findIndex((s) => s.name === "Check Neon configuration");
    expect(installIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(Math.max(installIndex, configIndex));
    expect(list[createIndex]?.uses).toBeUndefined();
    expect(list[createIndex]?.run).toContain("cli.ts create --name");
    expect(integration.text).not.toContain("create-branch-action");
  });

  describe("masking", () => {
    const list = steps(integration.jobs.integration);
    const createIndex = list.findIndex((s) => s.id === "create");

    it("gives the create step exactly the key, project and per-run name", () => {
      expect(list[createIndex]?.env).toEqual({
        NEON_API_KEY: "${{ secrets.NEON_API_KEY }}",
        NEON_PROJECT_ID: "${{ secrets.NEON_PROJECT_ID }}",
        BRANCH_NAME: "${{ steps.name.outputs.branch_name }}",
      });
    });

    it("has no separate mask step and never passes a branch ID through env or outputs", () => {
      expect(list.some((s) => s.run?.includes("cli.ts mask") === true)).toBe(false);
      expect(integration.text).not.toMatch(/branch_id|BRANCH_ID|outputs\.id\b/);
    });

    it("references db_url only in the smoke-check and test steps, both after the create step", () => {
      const referencing = list.map((s, index) => ({ s, index })).filter(({ s }) => DB_URL.test(JSON.stringify(s)));
      expect(referencing.map(({ s }) => s.name)).toEqual(["Smoke check", "Integration tests"]);
      for (const { s, index } of referencing) {
        expect(index).toBeGreaterThan(createIndex);
        expect(s.env?.DATABASE_URL).toBe("${{ steps.create.outputs.db_url }}");
      }
    });

    it("never references the pooled URL, hosts or a password output", () => {
      expect(integration.text).not.toMatch(/db_url_pooled|db_host|outputs\.password/);
    });

    it("keeps the API key out of install, smoke-check and test steps", () => {
      for (const s of list.filter((x) => ["Install dependencies", "Smoke check", "Integration tests"].includes(x.name ?? ""))) {
        expect(JSON.stringify(s)).not.toContain("NEON_API_KEY");
      }
    });

    it("never prints connection details", () => {
      for (const s of list) expect(s.run ?? "").not.toMatch(/echo[^\n]*(DATABASE_URL|db_url)/);
    });
  });
});

describe("integration-heavy.yml", () => {
  it("triggers on workflow_dispatch and pull_request labeled only", () => {
    expect(Object.keys(heavy.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect((heavy.on.pull_request as Obj).types).toEqual(["labeled"]);
    expect((heavy.on.pull_request as Obj).paths).toBeUndefined();
  });

  it("is a placeholder: no checkout, no secrets, no Neon", () => {
    expect(heavy.text).not.toMatch(/secrets\.|actions\/checkout|neondatabase/);
    expect(heavy.permissions).toEqual({});
    expect(jobOf(heavy, "heavy-integration")["timeout-minutes"]).toBe(5);
  });

  it("starts only for the heavy-integration label from the same repository, or manually", () => {
    const condition = jobOf(heavy, "heavy-integration").if ?? "";
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition).toContain("github.event.label.name == 'heavy-integration'");
    expect(condition).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("puts events that do not start the job in a group of their own", () => {
    const concurrency = heavy.concurrency as Obj;
    expect(concurrency["cancel-in-progress"]).toBe(true);
    expect(concurrency.group).toContain("github.run_id");
  });
});

describe("neon-ci-cleanup.yml", () => {
  it("has schedule and workflow_dispatch triggers with the specified inputs", () => {
    const schedule = sweep.on.schedule as { cron: string }[];
    expect(schedule[0]?.cron).toMatch(/^[1-9][0-9]? \*\/6 \* \* \*$/);
    const inputs = ((sweep.on.workflow_dispatch as Obj).inputs ?? {}) as Record<string, Obj>;
    expect(inputs.dry_run).toMatchObject({ type: "boolean", default: true });
    expect(inputs.min_age_minutes).toMatchObject({ default: 120 });
  });

  it("serialises sweeps without cancelling one in progress", () => {
    expect(sweep.concurrency).toEqual({ group: "neon-ci-cleanup", "cancel-in-progress": false });
    expect(sweep.permissions).toEqual({ contents: "read" });
    expect(jobOf(sweep, "sweep")["timeout-minutes"]).toBe(15);
  });
});

describe("header comments", () => {
  it.each(OWN_FILES)("%s names the secrets", (file) => {
    const header = (workflowOf(file)).text.split("\nname:")[0] ?? "";
    expect(header).toContain("NEON_API_KEY");
    expect(header).toContain("NEON_PROJECT_ID");
  });

  it.each(["integration.yml", "neon-ci-cleanup.yml"])("%s states the timing invariant", (file) => {
    expect((workflowOf(file)).text).toMatch(/Timing invariant: a live run holds its branch for at most 40 minutes/);
  });
});
