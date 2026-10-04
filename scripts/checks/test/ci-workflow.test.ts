import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checksDir, repositoryRoot } from "./helpers.ts";

type Mapping = Record<string, unknown>;

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  shell?: string;
  with?: Mapping;
  env?: Mapping;
  "working-directory"?: string;
  "continue-on-error"?: unknown;
}

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  strategy?: unknown;
  permissions?: unknown;
  "continue-on-error"?: unknown;
  "runs-on"?: unknown;
  outputs?: Mapping;
  steps?: Step[];
  uses?: string;
  with?: Mapping;
  secrets?: unknown;
}

interface Workflow {
  name?: string;
  on: Mapping;
  permissions?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  defaults?: { run?: { shell?: string; "working-directory"?: string } };
  env?: Mapping;
  jobs: Record<string, Job>;
}

const workflowPath = join(repositoryRoot, ".github", "workflows", "ci.yml");
const workflowText = readFileSync(workflowPath, "utf8");
const workflow = parse(workflowText) as Workflow;
const callerText = readFileSync(join(checksDir, "test", "fixtures", "execution-caller.yml"), "utf8");
const caller = parse(callerText) as Workflow;

const requiredJobs = ["typecheck", "lint", "unit-tests", "build", "public-safety", "names-attribution", "prose"];
const expensiveJobs = ["typecheck", "lint", "unit-tests", "build"];
const scanJobs = ["public-safety", "names-attribution"];
const expensiveIf =
  "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.docs-only != 'true') }}";
// The scan jobs hold the pattern secret, so their tools come from a trusted commit: the pinned
// tools-ref when called, the pull request's base commit, or the pushed main commit.
const scanToolsRef = "${{ inputs.tools-ref || github.event.pull_request.base.sha || github.sha }}";
const fullSha = "0123456789abcdef0123456789abcdef01234567";
const concurrencyGroup =
  "rbw-ci-${{ github.workflow_ref }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('push-{0}', github.sha) }}";

function jobs(): [string, Job][] {
  return Object.entries(workflow.jobs);
}

function steps(job: Job): Step[] {
  return job.steps ?? [];
}

function allSteps(): Step[] {
  return jobs().flatMap(([, job]) => steps(job));
}

describe("ci.yml jobs", () => {
  it("has exactly the seven required jobs plus the change classifier", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([...requiredJobs, "changes"].sort());
  });

  it("reports each job under its id: no name, no matrix", () => {
    for (const [id, job] of jobs()) {
      expect(job.name, id).toBeUndefined();
      expect(job.strategy, id).toBeUndefined();
    }
  });

  it("runs every job on a pinned hosted runner with a timeout", () => {
    for (const [id, job] of jobs()) {
      expect(job["runs-on"], id).toBe("ubuntu-24.04");
      expect((job as Mapping)["timeout-minutes"], id).toEqual(expect.any(Number));
    }
  });
});

describe("ci.yml triggers", () => {
  it("runs on pull requests to main, including edits, on pushes to main and when called", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_call"]);
    expect(workflow.on.pull_request).toEqual({
      branches: ["main"],
      types: ["opened", "synchronize", "reopened", "edited"],
    });
    expect(workflow.on.push).toEqual({ branches: ["main"] });
  });

  it("uses no pull_request_target and no path filters", () => {
    expect(workflowText).not.toMatch(/pull_request_target/);
    expect(workflowText).not.toMatch(/^\s*paths(-ignore)?:/m);
  });

  it("declares the tools inputs and the pattern secret for callers", () => {
    const call = workflow.on.workflow_call as { inputs: Record<string, Mapping>; secrets: Record<string, Mapping> };
    expect(Object.keys(call.inputs).sort()).toEqual(["tools-ref", "tools-repository"]);
    expect(call.inputs["tools-repository"]).toMatchObject({ type: "string", required: true });
    expect(call.inputs["tools-ref"]).toMatchObject({ type: "string", required: true });
    expect(Object.keys(call.secrets)).toEqual(["PUBLIC_SAFETY_PATTERNS"]);
    expect(call.secrets.PUBLIC_SAFETY_PATTERNS).toMatchObject({ required: false });
  });

  it("defaults the tools to the current repository and commit when not called", () => {
    expect(workflow.env).toEqual({
      TOOLS_REPOSITORY: "${{ inputs.tools-repository || github.repository }}",
      TOOLS_REF: "${{ inputs.tools-ref || github.sha }}",
      TOOLS_REPOSITORY_INPUT: "${{ toJSON(inputs.tools-repository) }}",
      TOOLS_REF_INPUT: "${{ toJSON(inputs.tools-ref) }}",
    });
  });
});

describe("ci.yml docs-only skip", () => {
  it("guards exactly the four expensive jobs with the classifier", () => {
    for (const [id, job] of jobs()) {
      if (expensiveJobs.includes(id)) {
        expect(job.needs, id).toBe("changes");
        expect(job.if, id).toBe(expensiveIf);
      } else {
        expect(job.needs, id).toBeUndefined();
        expect(job.if, id).toBeUndefined();
      }
    }
  });

  it("classifies from the diff of the event's commits, not from the event type", () => {
    const changes = workflow.jobs.changes;
    expect(changes?.outputs).toEqual({ "docs-only": "${{ steps.classify.outputs.docs-only }}" });
    const classify = steps(changes ?? {}).find((step) => step.id === "classify");
    expect(classify?.run).toContain('git diff --name-only --no-renames "$base...$head"');
    expect(classify?.run).toContain("node ../check-tools/scripts/checks/docs-only.ts");
    expect(classify?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      PR_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      PUSH_BEFORE: "${{ github.event.before }}",
      PUSH_AFTER: "${{ github.event.after }}",
    });
    expect(classify?.run).not.toMatch(/edited|action/);
  });
});

describe("ci.yml concurrency", () => {
  it("cancels superseded runs per pull request number and keys pushes on the commit", () => {
    expect(workflow.concurrency).toEqual({
      group: concurrencyGroup,
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
  });

  it("never keys on branch names and includes the workflow identity", () => {
    const group = workflow.concurrency?.group ?? "";
    expect(group).not.toMatch(/head_ref|github\.ref\b|ref_name/);
    expect(group).toContain("github.workflow_ref");
    expect(group).toContain("github.event.pull_request.number");
    expect(group).toContain("github.sha");
  });

  it("cannot share a group with the execution repository caller", () => {
    expect(caller.concurrency).toBeUndefined();
    expect(Object.values(caller.jobs).every((job) => (job as Mapping).concurrency === undefined)).toBe(true);
  });
});

describe("ci.yml permissions and secrets", () => {
  it("grants nothing at the top level and at most contents: read per job", () => {
    expect(workflow.permissions).toEqual({});
    for (const [id, job] of jobs()) {
      expect(job.permissions, id).toEqual({ contents: "read" });
    }
  });

  it("checks out without persisted credentials", () => {
    const checkouts = allSteps().filter((step) => step.uses?.startsWith("actions/checkout@") === true);
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.with?.["persist-credentials"], step.name).toBe(false);
    }
  });

  it("references the pattern secret only in the two scan jobs, through env", () => {
    for (const [id, job] of jobs()) {
      const text = JSON.stringify(job);
      if (scanJobs.includes(id)) {
        const writers = steps(job).filter((step) => JSON.stringify(step).includes("secrets."));
        expect(writers.map((step) => step.name), id).toEqual(["Write pattern list"]);
        expect(writers[0]?.env).toEqual({ PUBLIC_SAFETY_PATTERNS: "${{ secrets.PUBLIC_SAFETY_PATTERNS }}" });
      } else {
        expect(text, id).not.toContain("secrets.");
      }
    }
  });

  it("writes the pattern list owner-only, fails when it is empty and always removes it", () => {
    for (const id of scanJobs) {
      const jobSteps = steps(workflow.jobs[id] ?? {});
      const writeIndex = jobSteps.findIndex((step) => step.name === "Write pattern list");
      const write = jobSteps[writeIndex];
      expect(write?.run).toContain("umask 077");
      expect(write?.run).toContain('if [[ -z "$PUBLIC_SAFETY_PATTERNS" ]]');
      expect(write?.run).toContain("pattern list unavailable");
      expect(write?.run).not.toMatch(/set -x|xtrace/);
      const last = jobSteps.at(-1);
      expect(last?.name).toBe("Remove pattern list");
      expect(last?.if).toBe("${{ always() }}");
      expect(last?.run).toContain('rm -f "$RUNNER_TEMP/pattern-list.txt"');
      for (const step of jobSteps.slice(writeIndex)) {
        expect(step.uses, step.name).toBeUndefined();
        expect(step.run ?? "", step.name).not.toMatch(/\b(pnpm|npm|npx|uv|pip)\b/);
      }
    }
  });

  it("runs the scan wrapper with the real scanner path in the right mode", () => {
    for (const id of scanJobs) {
      const scan = steps(workflow.jobs[id] ?? {}).find((step) => step.name === "Scan");
      expect(scan?.run).toContain(`node ../check-tools/scripts/checks/scan.ts --mode ${id}`);
      expect(scan?.run).toContain("--scanner ../check-tools/tools/publication/src/cli.ts");
      expect(scan?.run).toContain('--repository "$GITHUB_REPOSITORY"');
      expect(scan?.run).toContain('--gitleaks "$RUNNER_TEMP/gitleaks/gitleaks"');
    }
  });

  it("verifies gitleaks against a committed checksum before use", () => {
    for (const id of scanJobs) {
      const download = steps(workflow.jobs[id] ?? {}).find((step) => step.name === "Download gitleaks");
      expect(download?.run).toContain("cli.ts gitleaks-version");
      expect(download?.run).toContain("scripts/checks/gitleaks.sha256");
      expect(download?.run).toContain("sha256sum --check --strict");
    }
  });
});

describe("ci.yml pinning and step safety", () => {
  it("pins every action to a full commit SHA with a release tag comment", () => {
    const usesLines = workflowText.split("\n").filter((line) => /^\s*(-\s+)?uses:/.test(line));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
    }
  });

  it("uses no local actions", () => {
    expect(workflowText).not.toMatch(/uses:\s*\.\//);
  });

  it("puts no expressions inside run scripts", () => {
    for (const step of allSteps()) {
      expect(step.run ?? "", step.name).not.toContain("${{");
    }
  });

  it("never continues on error or swallows a failure", () => {
    expect(workflowText).not.toMatch(/continue-on-error/);
    for (const step of allSteps()) {
      expect(step.run ?? "", step.name).not.toMatch(/\|\|\s*(true|:)|set \+e|set \+o/);
    }
  });

  it("runs every step with bash, errexit and pipefail", () => {
    expect(workflow.defaults?.run?.shell).toBe("bash");
    for (const step of allSteps()) {
      expect(step.shell, step.name).toBeUndefined();
    }
  });

  it("validates the tools reference before checking out the tools in every job", () => {
    for (const [id, job] of jobs()) {
      const jobSteps = steps(job);
      const refVariable = scanJobs.includes(id) ? "SCAN_TOOLS_REF" : "TOOLS_REF";
      expect(jobSteps[0]?.name, id).toBe("Validate tools reference");
      expect(jobSteps[0]?.run, id).toContain(`[[ "$${refVariable}" =~ ^[0-9a-f]{40}$ ]]`);
      const toolsCheckout = jobSteps.find((step) => step.name === "Check out check tools");
      if (toolsCheckout !== undefined) {
        expect(toolsCheckout.with, id).toEqual({
          repository: "${{ env.TOOLS_REPOSITORY }}",
          ref: "${{ env." + refVariable + " }}",
          path: "check-tools",
          "persist-credentials": false,
        });
      }
    }
  });

  function validate(id: string, env: Record<string, string>): number | null {
    const script = steps(workflow.jobs[id] ?? {})[0]?.run ?? "";
    const base = { TOOLS_REPOSITORY: "synthetic-owner/synthetic-repo", TOOLS_REF: fullSha, SCAN_TOOLS_REF: fullSha };
    return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      env: { PATH: process.env.PATH, ...base, ...env },
      stdio: "ignore",
    }).status;
  }

  it.each(jobs().map(([id]) => [id]))("accepts runs that are not called and well-formed inputs in %s", (id) => {
    expect(validate(id, { TOOLS_REF_INPUT: "null", TOOLS_REPOSITORY_INPUT: "null" })).toBe(0);
    expect(
      validate(id, { TOOLS_REF_INPUT: `"${fullSha}"`, TOOLS_REPOSITORY_INPUT: '"synthetic-owner/synthetic-repo"' }),
    ).toBe(0);
  });

  it.each(jobs().map(([id]) => [id]))("fails a caller's empty or malformed inputs in %s", (id) => {
    const repositoryInput = '"synthetic-owner/synthetic-repo"';
    expect(validate(id, { TOOLS_REF_INPUT: '""', TOOLS_REPOSITORY_INPUT: repositoryInput })).toBe(1);
    expect(validate(id, { TOOLS_REF_INPUT: '"main"', TOOLS_REPOSITORY_INPUT: repositoryInput })).toBe(1);
    expect(validate(id, { TOOLS_REF_INPUT: `"${fullSha}"`, TOOLS_REPOSITORY_INPUT: '""' })).toBe(1);
    expect(validate(id, { TOOLS_REF_INPUT: `"${fullSha}"`, TOOLS_REPOSITORY_INPUT: '"no-slash"' })).toBe(1);
  });

  it.each(scanJobs.map((id) => [id]))("fails %s when the trusted tools commit is not a full SHA", (id) => {
    expect(validate(id, { TOOLS_REF_INPUT: "null", TOOLS_REPOSITORY_INPUT: "null", SCAN_TOOLS_REF: "" })).toBe(1);
  });

  it("checks out the content of the triggering repository", () => {
    for (const [id, job] of jobs()) {
      const content = steps(job).find((step) => step.name === "Check out content");
      expect(content?.with?.path, id).toBe("content");
      expect(content?.with?.repository, id).toBeUndefined();
      expect(content?.with?.ref, id).toBeUndefined();
    }
  });

  it("names no owner or repository", () => {
    expect(workflowText).not.toMatch(/github\.com\/(?!gitleaks\/gitleaks\/)/);
    expect(workflowText).not.toMatch(/random-bug-walk/i);
  });
});

describe("ci.yml scan jobs run only trusted code while the pattern secret exists", () => {
  it.each(scanJobs.map((id) => [id]))("takes %s's tools from the base commit on pull requests", (id) => {
    const job = workflow.jobs[id] as Job & { env?: Mapping };
    expect(job.env).toEqual({ SCAN_TOOLS_REF: scanToolsRef });
    expect(JSON.stringify(job)).not.toContain("env.TOOLS_REF");
    expect(scanToolsRef).not.toMatch(/head|merge|github\.ref/);
  });

  it.each(scanJobs.map((id) => [id]))("pins %s's Node version in the workflow, not in a file the change controls", (id) => {
    const setup = steps(workflow.jobs[id] ?? {}).filter((step) => step.uses?.startsWith("actions/setup-node@") === true);
    expect(setup).toHaveLength(1);
    expect(Object.keys(setup[0]?.with ?? {}).sort()).toEqual(["node-version", "package-manager-cache"]);
    expect(setup[0]?.with?.["node-version"]).toMatch(/^24\.\d+\.\d+$/);
    expect(setup[0]?.with?.["package-manager-cache"]).toBe(false);
  });

  it.each(scanJobs.map((id) => [id]))("runs only scripts from the trusted tools checkout in %s", (id) => {
    for (const step of steps(workflow.jobs[id] ?? {})) {
      const run = step.run ?? "";
      for (const match of run.matchAll(/\bnode\s+(\S+)/g)) {
        expect(match[1], step.name).toMatch(/^\.\.\/check-tools\//);
      }
      expect(run, step.name).not.toMatch(/(^|[\s"'=])(\.\/)?(scripts|tools)\//);
      expect(JSON.stringify(step.with ?? {}), step.name).not.toContain("content/");
    }
  });
});

describe("ci.yml toolchain jobs", () => {
  function runs(id: string): string {
    return steps(workflow.jobs[id] ?? {})
      .map((step) => step.run ?? "")
      .join("\n");
  }

  it("installs with frozen lockfiles in every toolchain job", () => {
    for (const id of expensiveJobs) {
      expect(runs(id), id).toContain("pnpm install --frozen-lockfile");
      expect(runs(id), id).toContain("uv sync --locked --all-packages");
    }
  });

  it("runs the root commands", () => {
    expect(runs("typecheck")).toContain("pnpm typecheck");
    expect(runs("lint")).toContain("pnpm lint");
    expect(runs("unit-tests")).toContain("pnpm test");
    expect(runs("build")).toContain("pnpm build");
    expect(runs("build")).toContain("uv build");
  });

  it("checks lockfile drift and runs both audits in the lint job", () => {
    const lint = runs("lint");
    expect(lint).toContain("git diff --exit-code -- pnpm-lock.yaml");
    expect(lint).toContain("uv lock --check");
    expect(lint).toContain("node ../check-tools/scripts/checks/audit.ts npm");
    expect(lint).toContain("node ../check-tools/scripts/checks/audit.ts python");
  });

  it("counts the real test run against the floors", () => {
    const testStep = steps(workflow.jobs["unit-tests"] ?? {}).find((step) => step.run === "pnpm test");
    expect(testStep?.env).toEqual({
      RBW_VITEST_JSON_REPORT: "${{ runner.temp }}/vitest-report.json",
      PYTEST_ADDOPTS: "--report-log=${{ runner.temp }}/pytest-report.jsonl",
    });
    expect(runs("unit-tests")).toContain(
      'node ../check-tools/scripts/checks/test-floor.ts --floors scripts/checks/test-floors.json --vitest "$RUNNER_TEMP/vitest-report.json" --pytest "$RUNNER_TEMP/pytest-report.jsonl"',
    );
  });

  it("runs the prose check from the tools checkout", () => {
    expect(runs("prose")).toContain("node ../check-tools/scripts/checks/prose.ts");
  });
});

describe("execution repository caller", () => {
  it("calls this workflow at one pinned SHA with the same triggers and an explicit secret", () => {
    expect(caller.on).toEqual({ pull_request: workflow.on.pull_request, push: workflow.on.push });
    expect(caller.permissions).toEqual({ contents: "read" });
    const job = caller.jobs.ci;
    expect(job?.uses).toBe("OWNER/IMPLEMENTATION-REPOSITORY/.github/workflows/ci.yml@FULL_COMMIT_SHA");
    expect(job?.with).toEqual({ "tools-repository": "OWNER/IMPLEMENTATION-REPOSITORY", "tools-ref": "FULL_COMMIT_SHA" });
    expect(job?.secrets).toEqual({ PUBLIC_SAFETY_PATTERNS: "${{ secrets.PUBLIC_SAFETY_PATTERNS }}" });
    expect(callerText).not.toContain("inherit");
  });
});
