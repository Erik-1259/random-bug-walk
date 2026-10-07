// The controller's test harness: a PGlite spend ledger with every migration and both slot keys,
// the local runner's simulated kit image (whose copies run the real driver's runTrial) behind a
// fake Docker that also lists a VCR repository digest, its fake Sandbox SDK, and synthetic inputs.
// A recording wrapper notes each ledger call with how many SDK calls had happened by then.
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { loadRateSheet } from "@rbw/envelope";
import type { Rates } from "@rbw/envelope";
import type { Clock, Docker } from "@rbw/local-runner";
import { createSpend, migrate } from "@rbw/spend";
import type { Spend } from "@rbw/spend";
import { FakeClock, FakeDocker, ok } from "../../../local-runner/test/support/fakes.ts";
import { FakeSandboxSdk } from "../../../local-runner/test/support/fake-sandbox.ts";
import type { FakeSandboxOptions } from "../../../local-runner/test/support/fake-sandbox.ts";
import { KitImage } from "../../../local-runner/test/support/kit-image.ts";
import type { KitImageOptions } from "../../../local-runner/test/support/kit-image.ts";
import { tempDir, writeAlternativeDir, writeManifest, writeProbeDir, writeTerms } from "../../../local-runner/test/support/synthetic.ts";
import { RATE_SHEET_PATH } from "../../src/envelope.ts";
import { DEVELOPMENT } from "../../src/limits.ts";
import type { ControllerDeps, JobInputs } from "../../src/controller.ts";

export const VCR_DIGEST = `sha256:${"cd".repeat(32)}`;
export const VCR_IMAGE = `synthetic-team/synthetic-project/rbw-umami-kit@${VCR_DIGEST}`;

export function uuids(prefix = "8000"): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-${prefix}-${counter.toString(16).padStart(12, "0")}`;
  };
}

export interface TestLedger {
  spend: Spend;
  close: () => Promise<void>;
}

/** Creates the two slot keys the controller uses; the migrations seed the pools but no slot key. */
export async function createSlotKeys(spend: Spend): Promise<void> {
  for (const key of ["development", "judge"]) {
    const created = await spend.createSlotKey({ slot_key: key, actor_role: "owner", reason: "synthetic controller test" });
    if (!created.ok) throw new Error(`synthetic: slot key ${key} was refused`);
  }
}

/** A fresh PGlite ledger with every spend migration, the seeded pools and both slot keys. */
export async function pgliteLedger(clock: Clock): Promise<TestLedger> {
  const db = await PGlite.create();
  await migrate(db, { schema: "public" });
  const spend = createSpend({ client: db, schema: "public", clock: () => new Date(clock.now()) });
  await createSlotKeys(spend);
  return { spend, close: () => db.close() };
}

export interface LedgerCall {
  method: string;
  request: unknown;
  /** How many SDK calls the fake had recorded when this ledger call was made. */
  sdkCalls: number;
  ok: boolean;
}

/** The spend API, noting each call, its request, its result and the SDK calls made before it. */
export function recordingSpend(spend: Spend, calls: LedgerCall[], sdkCalls: () => number): Spend {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(spend) as [string, (request: unknown) => Promise<{ ok: boolean }>][]) {
    wrapped[name] = async (request: unknown) => {
      const before = sdkCalls();
      const result = await fn(request);
      calls.push({ method: name, request, sdkCalls: before, ok: result.ok });
      return result;
    };
  }
  return wrapped as unknown as Spend;
}

/** The simulated kit image's Docker, whose local image also lists the VCR digest the sandbox copies run. */
export function pushedDocker(kit: KitImage, repoDigests: string[] = [`vcr.example.invalid/synthetic-team/synthetic-project/rbw-umami-kit@${VCR_DIGEST}`]): FakeDocker {
  return new FakeDocker((args, runOptions) => (args.includes("{{json .RepoDigests}}") ? ok(JSON.stringify(repoDigests)) : kit.docker.run(args, runOptions)));
}

export function rates(): Promise<Rates> {
  return loadRateSheet(RATE_SHEET_PATH);
}

export interface World {
  kit: KitImage;
  clock: FakeClock;
  sdk: FakeSandboxSdk;
  docker: Docker;
  spend: Spend;
  close: () => Promise<void>;
  ledgerCalls: LedgerCall[];
  deps: ControllerDeps;
  logs: string[];
  dir: string;
}

export interface WorldOptions {
  kit?: KitImageOptions;
  sandbox?: FakeSandboxOptions;
  /** Wraps the Docker layer, for example to move the clock during an export. */
  docker?: (inner: Docker, clock: FakeClock) => Docker;
  clock?: FakeClock;
  /** The spend ledger; PGlite by default. */
  ledger?: (clock: Clock) => Promise<TestLedger>;
}

export async function world(options: WorldOptions = {}): Promise<World> {
  const clock = options.clock ?? new FakeClock();
  const kit = new KitImage(options.kit);
  const sdk = new FakeSandboxSdk({ collected: { runExit: 0 }, ...options.sandbox });
  const base = pushedDocker(kit);
  const docker = options.docker === undefined ? base : options.docker(base, clock);
  const { spend, close } = await (options.ledger ?? pgliteLedger)(clock);
  const ledgerCalls: LedgerCall[] = [];
  const logs: string[] = [];
  const deps: ControllerDeps = {
    docker,
    clock,
    uuid: uuids(),
    spend: recordingSpend(spend, ledgerCalls, () => sdk.calls.length),
    ledgerKind: "in_memory",
    rates: await rates(),
    sandbox: sdk,
    log: (line) => {
      logs.push(line);
    },
  };
  return { kit, clock, sdk, docker, spend, close, ledgerCalls, deps, logs, dir: tempDir("rbw-controller-test-") };
}

/** Inputs for one job on the sandbox backend, with synthetic manifest, terms, probes and alternative fix. */
export function jobInputs(w: World, overrides: Partial<JobInputs> = {}): JobInputs {
  return {
    kind: "observe",
    work: join(w.dir, "run"),
    name: "observe",
    image: "rbw-umami-kit:synthetic",
    manifest: writeManifest(w.dir),
    terms: writeTerms(w.dir),
    policy: null,
    kitStage: w.kit.kitStage,
    originalSuite: null,
    probesDir: writeProbeDir(),
    alternativeDir: writeAlternativeDir(),
    backend: "sandbox",
    sandboxImage: VCR_IMAGE,
    trials: null,
    ledger: DEVELOPMENT,
    ...overrides,
  };
}
