import { canonicalDigest, sha256Hex } from "@rbw/schema";
import type { CatalogEntry, NormalizedRequestInput, RequestStatus } from "@rbw/factory-contract";
import { criteriaCatalogV1 } from "../src/criteria.ts";
import type { CriteriaCatalog } from "../src/criteria.ts";
import { interpret } from "../src/interpret.ts";
import { runRequest } from "../src/orchestrator.ts";
import type { RunRequestDeps, RunResult } from "../src/orchestrator.ts";
import type { CasePackages, QualifyHarness } from "../src/ports.ts";
import type { FactoryProfileInput } from "../src/profile.ts";
import { projectStatus } from "../src/projection.ts";
import type { CaseEvidence } from "../src/projection.ts";
import { candidateIndex } from "../src/sources.ts";
import type { HostRegistry } from "../src/sources.ts";
import { TEST_PROFILE, fixtureRegistry, syntheticSha } from "../src/testing/catalog.ts";
import { fakeHarness, qualifyingPlan } from "../src/testing/harness.ts";
import type { EntryPlan, FakeHarnessOptions } from "../src/testing/harness.ts";
import { MemoryEventStore, MemoryLedger } from "../src/testing/memory.ts";
import type { MemoryLedgerOptions } from "../src/testing/memory.ts";
import { declaredCodes } from "../src/testing/scenarios.ts";
import { statusFixture } from "./support.ts";

export const REQUEST_ID = "00000000-0000-4000-8000-000000000199";
export const CREATED_AT = "2026-10-20T14:00:00.000Z";

export function fixtureInput(name: string, budget?: number): NormalizedRequestInput {
  const input = structuredClone(statusFixture(name).interpretation.input);
  if (budget !== undefined) input.budget_microusd = budget;
  return input;
}

export interface World {
  deps: RunRequestDeps;
  events: MemoryEventStore;
  ledger: MemoryLedger;
  evidence: Map<string, CaseEvidence>;
  /** Order of effects, for checks such as evidence before package_ready. */
  log: string[];
  qualified: string[];
  stop: { requested: boolean };
  clock: { now: number };
  run(): Promise<RunResult>;
  status(): RequestStatus;
}

export interface WorldOptions {
  input: NormalizedRequestInput;
  registry?: HostRegistry;
  catalog?: CriteriaCatalog;
  profile?: FactoryProfileInput;
  plan?: (entry: CatalogEntry) => EntryPlan;
  ledger?: Partial<MemoryLedgerOptions>;
  hooks?: FakeHarnessOptions["hooks"];
  /** Wraps the fake harness (for example, to fail it). */
  qualify?: (inner: QualifyHarness) => QualifyHarness;
  /** Milliseconds the clock advances on each read. */
  tick?: number;
}

export function world(options: WorldOptions): World {
  const catalog = options.catalog ?? criteriaCatalogV1();
  const registry = options.registry ?? fixtureRegistry();
  const profile = options.profile ?? TEST_PROFILE;
  const clock = { now: Date.parse(CREATED_AT) };
  const tick = options.tick ?? 10;
  const now = (): Date => {
    const value = new Date(clock.now);
    clock.now += tick;
    return value;
  };
  const interpretation = interpret({ input: options.input, registry, catalog, profile, now: new Date(CREATED_AT) });
  if (!interpretation.startable) throw new Error(`the test input is not startable: ${JSON.stringify(interpretation.problems.concat(interpretation.items.flatMap((i) => i.problems)))}`);
  const events = new MemoryEventStore();
  const ledger = new MemoryLedger({ budget_microusd: options.input.budget_microusd, worker_worst_case_microusd: profile.worker_worst_case_microusd, ...options.ledger });
  const evidence = new Map<string, CaseEvidence>();
  const log: string[] = [];
  const qualified: string[] = [];
  const stop = { requested: false };
  const plan = options.plan ?? ((entry: CatalogEntry): EntryPlan => ({ states: qualifyingPlan(declaredCodes(catalog, entry)) }));
  // The entry's exported archives: what the fake harness reports it ran on, and what the fake packaging stores.
  const exported = (entry: CatalogEntry) => ({ bug_case: syntheticSha(`bug-case:${entry.entry_id}`), validator: syntheticSha(`validator-core:${entry.entry_id}`) });
  const inner = fakeHarness({ plan, packages: exported, now, ...(options.hooks === undefined ? {} : { hooks: options.hooks }) });
  const tracked: QualifyHarness = async (input) => {
    qualified.push(input.entry.entry_id);
    return inner(input);
  };
  const qualify = options.qualify?.(tracked) ?? tracked;
  const appendSink = {
    append: async (event: Parameters<MemoryEventStore["append"]>[0]): Promise<void> => {
      log.push(`event:${event.type}`);
      await events.append(event);
    },
  };
  // A faithful packaging: the final validator is the entry's core plus the record as its evidence member,
  // and it reports what the stored validator holds, as the real one reads it back from the stored bytes.
  const packageCase = (input: { case_id: string; entry: CatalogEntry; record_json: Uint8Array }): Promise<CasePackages> => {
    log.push("package");
    const parts = exported(input.entry);
    const evidence = sha256Hex(input.record_json);
    const validator = canonicalDigest({ core: parts.validator, evidence }).sha256;
    return Promise.resolve({
      package_version: 1,
      pair_sha256: canonicalDigest({ bug_case_sha256: parts.bug_case, case_id: input.case_id, validator_sha256: validator }).sha256,
      bug_case: { sha256: parts.bug_case, size_bytes: 1000, filename: `rbw-bug-case-${input.case_id.slice(0, 12)}-v1.tar.gz` },
      validator: { sha256: validator, size_bytes: 100, filename: `rbw-validator-${input.case_id.slice(0, 12)}-v1.tar.gz`, core_sha256: parts.validator, evidence_sha256: evidence },
    });
  };
  // What the start route and the worker launch append before the loop runs.
  const start = async (): Promise<void> => {
    await events.append({ event_key: "start:accepted", at: CREATED_AT, type: "request_accepted", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "Request accepted.", data: {} });
    const s = ledger.snapshot();
    await events.append({
      event_key: "start:worker-reserved",
      at: CREATED_AT,
      type: "budget_updated",
      host_id: null,
      candidate_id: null,
      item_key: null,
      case_id: null,
      message: "Reserved the worker's worst case.",
      data: { reserved_microusd: s.reserved_microusd, spent_microusd: s.spent_microusd, remaining_microusd: s.budget_microusd - s.reserved_microusd - s.spent_microusd },
    });
    await events.append({ event_key: "worker:started", at: CREATED_AT, type: "worker_started", host_id: null, candidate_id: null, item_key: null, case_id: null, message: "The worker started.", data: {} });
  };
  const deps: RunRequestDeps = {
    request: { request_id: REQUEST_ID, created_at: CREATED_AT, interpretation },
    registry,
    catalog,
    profile,
    now,
    events: appendSink,
    ledger,
    stopRequested: () => Promise.resolve(stop.requested),
    qualify,
    packageCase,
    writeEvidence: (input) => {
      log.push("evidence");
      evidence.set(input.case_id, input.evidence);
      return Promise.resolve();
    },
  };
  return {
    deps,
    events,
    ledger,
    evidence,
    log,
    qualified,
    stop,
    clock,
    run: async () => {
      await start();
      return runRequest(deps);
    },
    status: () =>
      projectStatus({
        request: deps.request,
        events: events.events,
        candidates: candidateIndex(registry),
        evidence: [...evidence.values()],
        validations: {},
        budget: ledger.snapshot(),
        last_heartbeat_at: null,
        stop_recorded: stop.requested,
        now: new Date(clock.now),
        after: 0,
      }),
  };
}
