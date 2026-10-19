// Synthetic host adapters and catalog entries for tests and test mode. Every value is synthetic:
// hashes are SHA-256 of labeled text, IDs start with "synthetic-" and images use ".invalid" hosts.
import { createHash } from "node:crypto";
import { CHECK_SET_VALUES, COPY_STATE_VALUES } from "@rbw/factory-contract";
import type {
  BaselineIdentity,
  BugCaseInputs,
  BugTypeId,
  CatalogEntry,
  CellObservation,
  CopyPlan,
  CopyRecord,
  CopyState,
  HostAdapter,
  HostAvailability,
  HostId,
  Protocol,
  UnpackedPair,
  InterpretedCells,
  ValidatorInputs,
} from "@rbw/factory-contract";
import { environmentSha256 } from "../identity.ts";
import type { FactoryProfileInput } from "../profile.ts";

/** SHA-256 hex of a labeled synthetic text. */
export function syntheticSha(label: string): string {
  return createHash("sha256").update(`synthetic:${label}`, "utf8").digest("hex");
}

export const SYNTHETIC_BASELINES: Readonly<Record<HostId, BaselineIdentity>> = {
  umami: {
    host_id: "umami",
    baseline_id: "umami@ec0ff503",
    app_commit: "c1".repeat(20),
    original_suite: { suite_id: "synthetic-umami-original-suite", sha256: "5b".repeat(32), test_count: 64, test_ids_sha256: "5d".repeat(32) },
  },
  "task-report": {
    host_id: "task-report",
    baseline_id: "task-report@ca4a71f",
    app_commit: "c0".repeat(20),
    original_suite: { suite_id: "synthetic-task-report-original-suite", sha256: "5a".repeat(32), test_count: 48, test_ids_sha256: "5c".repeat(32) },
  },
};

/** One copy per state; the original suite runs 3 rounds and the checks the host's verification rounds. */
export function syntheticProtocol(verificationRuns: number): Protocol {
  const state = { copies: 1, rounds_per_copy: verificationRuns, min_valid_runs: verificationRuns };
  return {
    protocol_id: "synthetic-repetition-protocol",
    version: "1",
    sha256: syntheticSha(`protocol:${String(verificationRuns)}`),
    per_state: { clean: { ...state }, buggy: { ...state }, fixed: { ...state } },
    valid_trial_rules: ["synthetic-rule-exit-code"],
  };
}

const TYPE_SLUG: Readonly<Record<BugTypeId, string>> = { concurrency: "concurrency", date_time: "date-time" };

const PRESENTATION: Readonly<Record<HostId, CatalogEntry["presentation"]>> = {
  "task-report": {
    title: "Overlapping task updates lose an acknowledged change",
    observed_failure: "When two updates to the same task overlap, both receive a success response, but the stored task keeps only one of the two changes.",
    how_checked:
      "Separate verification checks ran on fresh clean, buggy and reference-fixed copies and detected the lost change only on the buggy copy. The unchanged original suite passed on all three.",
    repetition_summary: "Each copy ran the original suite 3 times and the verification checks 5 times. All runs were valid and agreed.",
  },
  umami: {
    title: "Daily totals are grouped in the wrong time zone",
    observed_failure: "Totals grouped by day are bucketed in a different time zone from the one the report asks for, so events near midnight are counted on the wrong day.",
    how_checked:
      "Separate verification checks ran on fresh clean, buggy and reference-fixed copies and detected the wrong-day grouping only on the buggy copy. The unchanged original suite passed on all three.",
    repetition_summary: "Each copy ran the original suite 3 times and the verification checks 3 times. All runs were valid and agreed.",
  },
};

export interface SyntheticEntryOptions {
  host_id: HostId;
  bug_type_id: BugTypeId;
  /** The entry's number in its source, from 1. */
  n: number;
  criteria: string[];
  /** Plant the same change as entry `defect_of` of the same source, so both entries are one defect. */
  defect_of?: number;
}

export function syntheticEntry(options: SyntheticEntryOptions): CatalogEntry {
  const sourceId = `synthetic-${options.host_id}-${TYPE_SLUG[options.bug_type_id]}`;
  const entryId = `${sourceId}-${String(options.n).padStart(2, "0")}`;
  const plantLabel = `${sourceId}:plant:${String(options.defect_of ?? options.n)}`;
  const kitDigest = `sha256:${syntheticSha(`kit:${options.host_id}`)}`;
  return {
    entry_id: entryId,
    source_id: sourceId,
    catalog_version: "1",
    host_id: options.host_id,
    bug_type_id: options.bug_type_id,
    criteria: options.criteria.map((criterion_id) => ({ criterion_id, version: "1" })),
    plant: {
      patch: "synthetic planted patch text\n",
      patch_sha256: syntheticSha(`${plantLabel}:patch`),
      targets: [{ path: "src/synthetic/target.ts", before_sha256: syntheticSha(`${plantLabel}:before`), after_sha256: syntheticSha(`${plantLabel}:after`) }],
    },
    reference_repair: {
      patch: "synthetic repair patch text\n",
      patch_sha256: syntheticSha(`${plantLabel}:repair`),
      result_sha256: [{ path: "src/synthetic/target.ts", sha256: syntheticSha(`${plantLabel}:before`) }],
      kind: "revert",
    },
    incident: { path: "incident/synthetic-incident.md", sha256: syntheticSha(`${entryId}:incident`) },
    presentation: { ...PRESENTATION[options.host_id] },
    verification: {
      check_set_id: `${sourceId}-checks`,
      version: "1",
      check_set_sha256: syntheticSha(`${sourceId}:checks`),
      expected_vectors_sha256: syntheticSha(`${sourceId}:expected`),
      protocol_id: "synthetic-repetition-protocol",
      protocol_sha256: syntheticSha(`protocol:${options.host_id}`),
    },
    environment: {
      kit_image: `registry.invalid/synthetic/${options.host_id}-kit:1`,
      kit_image_digest: kitDigest,
      environment_sha256: environmentSha256(options.host_id, kitDigest),
    },
    difficulty: { status: "not_assessed" },
  };
}

/** A copy plan for a synthetic copy; the fakes never run it. */
export function syntheticCopyPlan(entry: CatalogEntry, state: CopyState, n: number): CopyPlan {
  return {
    copy_id: `${entry.entry_id}-${state}-${String(n)}`,
    host_id: entry.host_id,
    state,
    image: { reference: entry.environment.kit_image, digest: entry.environment.kit_image_digest },
    files: [],
    evaluator_files: [],
    command: ["synthetic-copy"],
    limits: { timeout_s: 900, vcpus: 2, memory_mb: 4096, network: "none" },
  };
}

function aggregate(observations: CellObservation[]): CellObservation {
  if (observations.length === 0) return { observed: "incomplete", runs_valid: 0, runs_total: 0, failure_codes: [], detail: "" };
  const first = observations[0]?.observed ?? "incomplete";
  const codes: string[] = [];
  for (const observation of observations) for (const code of observation.failure_codes) if (!codes.includes(code)) codes.push(code);
  const observed = observations.some((o) => o.observed === "error")
    ? "error"
    : observations.every((o) => o.observed === first)
      ? first
      : "incomplete";
  return {
    observed,
    runs_valid: observations.reduce((sum, o) => sum + o.runs_valid, 0),
    runs_total: observations.reduce((sum, o) => sum + o.runs_total, 0),
    failure_codes: codes,
    detail: "synthetic aggregate",
  };
}

export interface FakeAdapterOptions {
  host_id: HostId;
  entries: CatalogEntry[];
  /** Verification rounds per copy: 5 for the task-report fakes and 3 for the Umami fakes by default. */
  verification_runs?: number;
  availability?: (entry: CatalogEntry, from: string, until: string) => HostAvailability;
}

/** A host adapter over synthetic entries. Export inputs are not available from it. */
export class FakeHostAdapter implements HostAdapter {
  readonly host_id: HostId;
  readonly entries: CatalogEntry[];
  readonly verificationRuns: number;
  readonly availability?: (entry: CatalogEntry, from: string, until: string) => HostAvailability;

  constructor(options: FakeAdapterOptions) {
    this.host_id = options.host_id;
    this.entries = options.entries;
    this.verificationRuns = options.verification_runs ?? (options.host_id === "task-report" ? 5 : 3);
    if (options.availability !== undefined) this.availability = options.availability;
  }

  baseline(): BaselineIdentity {
    return structuredClone(SYNTHETIC_BASELINES[this.host_id]);
  }

  catalog(): CatalogEntry[] {
    return this.entries.map((entry) => structuredClone(entry));
  }

  protocol(): Protocol {
    return syntheticProtocol(this.verificationRuns);
  }

  bugCaseInputs(): Promise<BugCaseInputs> {
    return Promise.reject(new Error("the synthetic adapter has no export inputs"));
  }

  validatorInputs(): Promise<ValidatorInputs> {
    return Promise.reject(new Error("the synthetic adapter has no export inputs"));
  }

  copyPlans(state: CopyState, unpacked: UnpackedPair, protocol: Protocol): CopyPlan[] {
    const entry = this.entries[0];
    if (entry === undefined) return [];
    return Array.from({ length: protocol.per_state[state].copies }, (_, index) => ({ ...syntheticCopyPlan(entry, state, index + 1), copy_id: `${unpacked.pair_sha256.slice(0, 12)}-${state}-${String(index + 1)}` }));
  }

  interpret(records: CopyRecord[]): InterpretedCells {
    const cells = Object.fromEntries(CHECK_SET_VALUES.map((set) => [set, aggregate(records.map((record) => record[set]))])) as Record<(typeof CHECK_SET_VALUES)[number], CellObservation>;
    if (records.some((record) => record.status === "invalid")) {
      for (const set of CHECK_SET_VALUES) cells[set] = { ...cells[set], observed: "error" };
    }
    return { original_suite: cells.original_suite, verification: cells.verification };
  }
}

/** The task-report and Umami fakes of the contract fixtures, task-report first (catalog order). */
export function fixtureRegistry(options: { duplicate_defect?: boolean } = {}): FakeHostAdapter[] {
  const taskReport = [syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n: 1, criteria: ["concurrency.lost-acknowledged-change"] })];
  if (options.duplicate_defect === true) {
    taskReport.push(syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n: 2, criteria: ["concurrency.lost-acknowledged-change"], defect_of: 1 }));
  }
  return [
    new FakeHostAdapter({ host_id: "task-report", entries: taskReport }),
    new FakeHostAdapter({ host_id: "umami", entries: [syntheticEntry({ host_id: "umami", bug_type_id: "date_time", n: 1, criteria: ["date_time.time-zone-grouping"] })] }),
  ];
}

/**
 * A synthetic factory profile with the contract's test-mode worst cases (section 15.1): the worker
 * $0.20; one copy per state at $0.10 on task-report and $0.20 on Umami, so a candidate is $0.30 and
 * $0.60; a validation run $0.20 and $0.30. The limits are the capabilities fixture's.
 */
export const TEST_PROFILE: FactoryProfileInput = {
  profile_sha256: syntheticSha("test-profile"),
  limits: {
    max_items: 5,
    max_quantity_per_item: 3,
    max_total_quantity: 6,
    max_description_chars: 500,
    budget_presets_microusd: [1_000_000, 2_000_000, 5_000_000],
    default_budget_microusd: 2_000_000,
    min_budget_microusd: 500_000,
    max_budget_microusd: 5_000_000,
    max_wall_clock_s: 3600,
    max_candidates: 10,
  },
  worker_worst_case_microusd: 200_000,
  copy_envelope_microusd: { "task-report": 100_000, umami: 200_000 },
  validation_worst_case_microusd: { "task-report": 200_000, umami: 300_000 },
};

export const COPY_STATES: readonly CopyState[] = COPY_STATE_VALUES;
