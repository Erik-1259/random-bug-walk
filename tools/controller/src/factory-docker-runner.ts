// The local `docker` copy runner as the factory worker runs it (--backend docker, for free proofs):
// the harness's docker runner (one local container per copy, no network, the plan's CPU and memory
// limits, files placed by a tar stream) with the copy meter's spend around each copy, as the hosted
// sandbox runner has it. The meter refuses limits above the host's copy limits and a copy that would
// not end before the deadline, launches the operation its candidate reserved at selection (or, in a
// validation run, records the copy under the run's operation), and settles the measured lifetime.
// A local container has no provider state that can be lost: it is recorded as created under the
// copy's sandbox name just before the docker runner runs it, its stop is confirmed when the runner
// returns (the runner removes the container), and every outcome the runner returns is definite.
// A copy the meter does not start is a setup failure or a time-out, as on the sandbox runner; an
// uncertain one (a ledger call that failed, or any copy after one) rejects, which the request loop
// turns into needs_reconciliation.
import type { CollectedCopy, CopyPlan, CopyRoots, CopyRunner } from "@rbw/factory-contract";
import type { CopyMeter, RefusalReason } from "./factory-meter.ts";
import type { FactoryLog } from "./factory-ports.ts";
import { NO_IMAGE_DIGEST, sandboxVcpus } from "./factory-sandbox-runner.ts";

export interface DockerCopyRunnerDeps {
  /** The harness's docker runner (dockerRunner of @rbw/case-validate), or a stand-in in tests. */
  runner: CopyRunner;
  meter: CopyMeter;
  /** The candidate_id, or the case_id of a validation run, whose copies this runner runs. */
  subject: string;
  now: () => number;
  log: FactoryLog;
}

/** A copy's spend outcome is uncertain (a ledger call failed, or an earlier copy's outcome is uncertain). Never retried. */
export class DockerCopyUncertain extends Error {
  override name = "DockerCopyUncertain";
}

/** What a copy the meter did not start reports, as the sandbox runner reports it. */
const REFUSED_OUTCOME: Readonly<Record<Exclude<RefusalReason, "uncertain">, "setup_failed" | "timed_out">> = {
  limits_exceed_profile: "setup_failed",
  no_time: "timed_out",
  stopped: "timed_out",
  halted: "timed_out",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function hostArchitecture(): CollectedCopy["architecture"] {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

/** The runner for one subject's copies: each copy through the meter, then the docker runner. */
export function createDockerCopyRunner(deps: DockerCopyRunnerDeps): CopyRunner {
  return {
    async run(plan: CopyPlan, roots: CopyRoots): Promise<CollectedCopy> {
      const started = deps.now();
      const notRun = (outcome: "setup_failed" | "timed_out"): CollectedCopy => ({
        copy_id: plan.copy_id,
        outcome,
        exit_code: null,
        results_dir: null,
        image_digest: plan.image.digest ?? NO_IMAGE_DIGEST,
        architecture: hostArchitecture(),
        started_at: iso(started),
        finished_at: iso(deps.now()),
        results_sha256: null,
      });
      const outcome = await deps.meter.run({ subject: deps.subject, host: plan.host_id, state: plan.state, limits: plan.limits }, async (name, hooks) => {
        await hooks.created(name);
        const createdAt = deps.now();
        const result = await deps.runner.run(plan, roots);
        return { result, created: true, lifetime_ms: deps.now() - createdAt, stop_confirmed: true, status: result.outcome === "ran" ? ("completed" as const) : ("failed" as const), vcpus: sandboxVcpus(plan) };
      });
      switch (outcome.kind) {
        case "ran":
          return outcome.result;
        case "refused":
          deps.log(`factory: copy ${plan.copy_id} did not start (${outcome.reason}: ${outcome.detail})`);
          if (outcome.reason === "uncertain") throw new DockerCopyUncertain(`copy ${plan.copy_id}: ${outcome.detail}`);
          return notRun(REFUSED_OUTCOME[outcome.reason]);
        case "uncertain":
          throw new DockerCopyUncertain(`copy ${plan.copy_id}: ${outcome.detail}`);
      }
    },
  };
}
