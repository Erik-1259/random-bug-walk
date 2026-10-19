// HELD: the hosted `sandbox` copy runner. It implements the shared CopyRunner interface of the
// factory contract package, `run(plan, roots)` resolving a CollectedCopy,
// and that version of the interface (CopyPlan.destinations, CopyRoots, CollectedCopy,
// HostAdapter.collect) is not in @rbw/factory-contract on this branch yet. Until it is, this
// module only names the runner; nothing calls it.
//
// Planned behavior, once the types are there: one Vercel Sandbox per copy from the plan's kit
// image pinned by digest, named copySandboxName(execution), no network, the plan's vCPUs, and the
// plan's timeout plus the shutdown allowance as the provider timeout; every plan.files entry from
// roots.app_root written to destinations.app and every evaluator file from roots.evaluator_root to
// destinations.evaluator, each sha256 checked first (a mismatch is setup_failed); plan.command run
// once; destinations.results read back into a fresh local directory; the stop confirmed by status.
// Each copy goes through CopyMeter (factory-meter.ts), which refuses limits above the host's copy
// limits and copies that would not end before the deadline, reserves and settles the copy (or, in a
// validation run, records it as a child of the run's operation), and turns a rejected run into an
// uncertain outcome that is never retried.

export class SandboxRunnerHeld extends Error {
  override name = "SandboxRunnerHeld";

  constructor() {
    super("the sandbox copy runner is held until @rbw/factory-contract has CopyRunner.run(plan, roots) and CollectedCopy");
  }
}

/** Throws SandboxRunnerHeld: the runner waits for the shared runner types. */
export function createSandboxCopyRunner(): never {
  throw new SandboxRunnerHeld();
}
