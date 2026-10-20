// What the factory web service imports (@rbw/controller/factory-web): the factory profile, the
// operation identities and sandbox names, the request and validation launches, the one lost-worker
// routine and the end of a reconciliation. Like judge-web.ts it imports only small modules: no
// runner, harness, driver or PGlite. The service injects the ledger, the factory records, the
// identity module, the factory core's event builders, the Sandbox SDK and the clock.
import type { WorkerSandboxInstance, WorkerSandboxSdk } from "./factory-ports.ts";

export { parseRateSheet } from "@rbw/envelope";
export { FACTORY_HOSTS, FACTORY_PROFILE, ProfileMismatch, RATE_SHEET_V1_SHA256, factoryEnvelope, priceProfile, profileForService } from "./factory-profile.ts";
export type { CopyLimitsProfile, EnvelopeKind, FactoryEnvelope, FactoryPrices, FactoryProfile, FactoryProfileBody, SandboxSize } from "./factory-profile.ts";
export {
  EVENT_KEYS,
  FACTORY_KIND,
  ROUTE_ACTOR,
  SANDBOX_PROVIDER,
  WORKER_ACTOR,
  busyReason,
  copyOperation,
  copySandboxName,
  copySettlementFor,
  fullSettlement,
  outcomeOf,
  validationOperation,
  validationSandboxName,
  validationSettlement,
  workerOperation,
  workerSandboxName,
} from "./factory-ledger.ts";
export type { CopyIdentity, CopyOperationContext, FactoryOperation, OperationContext, SandboxUsage } from "./factory-ledger.ts";
export { LaunchConfigError, VALIDATION_POLL_MS, WORKER_REPOSITORY, WORKER_RUN_ONCE_DIR, startFactoryValidation, startFactoryWorker, workerCommandArgs } from "./factory-launch.ts";
export type { FactoryLaunchDeps, ValidationStart, ValidationStartArgs, WorkerLaunchConfig, WorkerStart } from "./factory-launch.ts";
export { completeReconciliation, finalizeLostWorker } from "./factory-lost.ts";
export type { LostDeps, LostOutcome, LostTarget, ReconciliationOutcome } from "./factory-lost.ts";
export type * from "./factory-ports.ts";

/** The configuration value that names the pinned worker image: `<vcr repository>@sha256:<digest>`. */
export const WORKER_IMAGE_VARIABLE = "RBW_FACTORY_WORKER_IMAGE";

function status(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("response" in error)) return null;
  const response = error.response;
  return typeof response === "object" && response !== null && "status" in response && typeof response.status === "number" ? response.status : null;
}

/** The real Sandbox SDK for worker sandboxes, with the credentials bound as SDK options; loaded on first use. */
export function createWorkerSandboxSdk(credentials: { token: string; teamId: string; projectId: string }): WorkerSandboxSdk {
  const wrap = (sandbox: { name: string; status: WorkerSandboxInstance["status"]; runCommand: WorkerSandboxInstance["runCommand"]; stop: () => Promise<unknown> }): WorkerSandboxInstance => ({
    name: sandbox.name,
    status: sandbox.status,
    runCommand: (params) => sandbox.runCommand(params),
    stop: () => sandbox.stop(),
  });
  return {
    async create(params) {
      const { Sandbox } = await import("@vercel/sandbox");
      return wrap(await Sandbox.create({ ...params, ...credentials }));
    },
    async get(name) {
      const { Sandbox } = await import("@vercel/sandbox");
      try {
        return wrap(await Sandbox.get({ name, ...credentials }));
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },
  };
}
