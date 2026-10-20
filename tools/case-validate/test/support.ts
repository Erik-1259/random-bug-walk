import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packArchive, resultsSha256, unpackArchive, type ArchiveMember } from "@rbw/case-package";
import { syntheticBaseline } from "@rbw/case-package/synthetic";
import type { CollectedCopy, CopyPlan, CopyRoots, CopyRunner } from "@rbw/factory-contract";
import { encodeCanonical } from "@rbw/schema";

export const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Unpacks an archive, lets the test change its members and packs it again. */
export function repack(archive: Uint8Array, change: (members: ArchiveMember[]) => ArchiveMember[]): Uint8Array {
  return packArchive(change(unpackArchive(archive)));
}

/** Changes one member's bytes and, when it is listed, its hash in the manifest, so only the intended check can fail. */
export function replaceMember(archive: Uint8Array, manifestName: string, path: string, bytes: Uint8Array): Uint8Array {
  return editManifest(
    repack(archive, (members) => members.map((member) => (member.path === path ? { path, bytes } : member))),
    manifestName,
    (manifest) => {
      const files = manifest.files as { path: string; sha256: string }[];
      for (const file of files) if (file.path === path) file.sha256 = sha(bytes);
    },
  );
}

/** Edits a manifest member in place and writes it back as canonical JSON. */
export function editManifest(archive: Uint8Array, name: string, edit: (manifest: Record<string, unknown>) => void): Uint8Array {
  return repack(archive, (members) =>
    members.map((member) => {
      if (member.path !== name) return member;
      const manifest = JSON.parse(new TextDecoder().decode(member.bytes)) as Record<string, unknown>;
      edit(manifest);
      return { path: name, bytes: encodeCanonical(manifest) };
    }),
  );
}

/** A runner that records every call and must never be reached in the tests that use it. */
export function forbiddenRunner(): CopyRunner & { calls: number } {
  const runner = {
    calls: 0,
    run(): Promise<never> {
      runner.calls += 1;
      return Promise.reject(new Error("no copy may run in this test"));
    },
  };
  return runner;
}

const ARCHITECTURE = process.arch === "arm64" ? "arm64" : "amd64";
const NO_DIGEST = `sha256:${"0".repeat(64)}`;

function collected(plan: CopyPlan, fields: Partial<CollectedCopy>): CollectedCopy {
  return {
    copy_id: plan.copy_id,
    outcome: "ran",
    exit_code: 0,
    results_dir: null,
    image_digest: plan.image.digest ?? NO_DIGEST,
    architecture: ARCHITECTURE,
    started_at: "2026-10-19T12:00:00.000Z",
    finished_at: "2026-10-19T12:00:01.000Z",
    results_sha256: null,
    ...fields,
  };
}

/** Copies a plan's files from the roots into a directory, checking each hash; false on any mismatch. */
async function place(plan: CopyPlan, roots: CopyRoots, dir: string): Promise<boolean> {
  const sets = [[roots.app_root, plan.files, join(dir, "app")], [roots.evaluator_root, plan.evaluator_files, join(dir, "evaluator")]] as const;
  for (const [root, files, target] of sets) {
    for (const file of files) {
      const bytes = new Uint8Array(await readFile(join(root, file.path)));
      if (sha(bytes) !== file.sha256) return false;
      await mkdir(dirname(join(target, file.path)), { recursive: true });
      await writeFile(join(target, file.path), bytes);
    }
  }
  return true;
}

/**
 * A synthetic test runner that runs the plan's command as a local Node process instead of a container: the
 * plan's destinations are mapped to directories of a fresh copy directory. It proves the harness end to end
 * on the synthetic host only.
 */
export function localProcessRunner(parent: string): CopyRunner & { plans: CopyPlan[] } {
  const runner = {
    plans: [] as CopyPlan[],
    async run(plan: CopyPlan, roots: CopyRoots): Promise<CollectedCopy> {
      runner.plans.push(plan);
      const dir = await mkdtemp(join(parent, "copy-"));
      if (!(await place(plan, roots, dir))) return collected(plan, { outcome: "setup_failed", exit_code: null });
      const mapped = plan.command.map((arg) =>
        arg
          .replace(plan.destinations.app, join(dir, "app"))
          .replace(plan.destinations.evaluator, join(dir, "evaluator"))
          .replace(plan.destinations.results, join(dir, "results")),
      );
      const [command = "", ...args] = mapped;
      const exit = await new Promise<number | null>((resolve) => {
        execFile(command === "node" ? process.execPath : command, args, { cwd: dir, timeout: plan.limits.timeout_s * 1000 }, (error) => {
          resolve(error === null ? 0 : typeof error.code === "number" ? error.code : null);
        });
      });
      const results = join(dir, "results");
      const present = await access(results).then(() => true, () => false);
      return collected(plan, {
        exit_code: exit,
        results_dir: present ? results : null,
        results_sha256: present ? await resultsSha256(results) : null,
      });
    },
  };
  return runner;
}

export interface ScriptedCopy {
  outcome: "ran" | "setup_failed" | "timed_out" | "reject";
  /** For ran: whether the original suite fails and whether the check detects the failure, in every round. */
  suiteFails?: boolean;
  detected?: boolean;
  failureCode?: string;
  rounds?: number;
  error?: Error;
}

/** A synthetic test runner whose copies end as the script says; ran copies write the synthetic driver's record. */
export function scriptedRunner(parent: string, script: (plan: CopyPlan) => ScriptedCopy): CopyRunner & { plans: CopyPlan[] } {
  const runner = {
    plans: [] as CopyPlan[],
    async run(plan: CopyPlan): Promise<CollectedCopy> {
      runner.plans.push(plan);
      const step = script(plan);
      if (step.outcome === "reject") throw step.error ?? new Error("synthetic uncertain provider outcome");
      if (step.outcome !== "ran") return collected(plan, { outcome: step.outcome, exit_code: null });
      const results = join(await mkdtemp(join(parent, "copy-")), "results");
      await mkdir(results, { recursive: true });
      const round = {
        original_suite: { executed: 3, failing_test_ids: step.suiteFails === true ? ["synthetic-one"] : [] },
        verification: { ok: step.detected !== true, failure_code: step.detected === true ? (step.failureCode ?? "acknowledged_completion_not_counted") : null },
      };
      const record = { format: "synthetic-copy/1", suite_sha256: syntheticBaseline(plan.host_id).original_suite.sha256, rounds: Array.from({ length: step.rounds ?? 2 }, () => round) };
      await writeFile(join(results, "copy.json"), `${JSON.stringify(record)}\n`);
      return collected(plan, { results_dir: results, results_sha256: await resultsSha256(results) });
    },
  };
  return runner;
}
