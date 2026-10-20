// The named test-mode scenarios of contract section 15.1, as plans for the fake harness. Catalog
// order puts task-report first. Each scenario names the fixture whose `interpretation.input` the
// client sends and the fixture showing its end state.
import { TEST_SCENARIO_VALUES } from "@rbw/factory-contract";
import type { CatalogEntry, TestScenario, ValidationResult } from "@rbw/factory-contract";
import { criterionOf } from "../criteria.ts";
import type { CriteriaCatalog } from "../criteria.ts";
import { fixtureRegistry } from "./catalog.ts";
import type { FakeHostAdapter } from "./catalog.ts";
import { qualifyingPlan } from "./harness.ts";
import type { EntryPlan, StatePlan } from "./harness.ts";

export interface ScenarioSetup {
  scenario: TestScenario;
  /** The fixture whose `interpretation.input` the client sends. */
  input_fixture: string;
  /** The fixture showing the end state, or null. */
  end_fixture: string | null;
  registry: FakeHostAdapter[];
  plan: (entry: CatalogEntry) => EntryPlan;
  /** What validation runs of the delivered cases observe. */
  validation: ValidationResult;
}

const INPUT_FIXTURE: Readonly<Record<TestScenario, string>> = {
  "two-host-fulfilled": "status-fulfilled.json",
  "partial-budget": "status-partial-budget.json",
  "sources-exhausted": "status-exhausted.json",
  "duplicate-defect": "status-duplicate-defect.json",
  "zero-result": "status-zero-result.json",
  "wrong-failure": "status-wrong-failure.json",
  "cancel-midway": "status-cancelled.json",
  "worker-lost": "status-operational-error.json",
  "uncertain-provider": "status-operational-error.json",
  "validation-failed": "status-fulfilled.json",
  "validation-error": "status-fulfilled.json",
  "setup-failed": "status-zero-result.json",
};

const END_FIXTURE: Readonly<Record<TestScenario, string | null>> = {
  "two-host-fulfilled": "status-fulfilled.json",
  "partial-budget": "status-partial-budget.json",
  "sources-exhausted": "status-exhausted.json",
  "duplicate-defect": "status-duplicate-defect.json",
  "zero-result": "status-zero-result.json",
  "wrong-failure": "status-wrong-failure.json",
  "cancel-midway": "status-cancelled.json",
  "worker-lost": "status-operational-error.json",
  "uncertain-provider": null,
  "validation-failed": "status-fulfilled.json",
  "validation-error": "status-fulfilled.json",
  "setup-failed": null,
};

export const SCENARIOS: readonly TestScenario[] = TEST_SCENARIO_VALUES;

/** The failure codes of the entry's declared criteria, from the criteria catalog. */
export function declaredCodes(catalog: CriteriaCatalog, entry: CatalogEntry): string[] {
  return entry.criteria.map((ref) => {
    const found = criterionOf(catalog, ref.criterion_id);
    if (found === null) throw new Error(`criterion ${ref.criterion_id} is not in the catalog`);
    return found.criterion.failure_code;
  });
}

/** A failure code of the entry's bug type that belongs to none of its declared criteria. */
function otherCode(catalog: CriteriaCatalog, entry: CatalogEntry): string {
  const type = catalog.bug_types.find((candidate) => candidate.bug_type_id === entry.bug_type_id);
  const other = type?.criteria.find((criterion) => !entry.criteria.some((ref) => ref.criterion_id === criterion.criterion_id));
  return other?.failure_code ?? "synthetic_unrelated_failure";
}

/** What a validation run of a case observes under each validation result (contract section 11). */
export function validationPlan(result: ValidationResult, codes: string[]): StatePlan {
  const plan = qualifyingPlan(codes);
  if (result === "failed") plan.buggy = { original_suite: "pass", verification: "pass" };
  if (result === "error") plan.clean = { original_suite: "error", verification: "error" };
  return plan;
}

export function scenarioSetup(scenario: TestScenario, catalog: CriteriaCatalog): ScenarioSetup {
  const registry = fixtureRegistry({ duplicate_defect: scenario === "duplicate-defect" });
  const firstTaskReport = "synthetic-task-report-concurrency-01";
  const umami = "synthetic-umami-date-time-01";
  const plan = (entry: CatalogEntry): EntryPlan => {
    const codes = declaredCodes(catalog, entry);
    const base: EntryPlan = { states: qualifyingPlan(codes) };
    switch (scenario) {
      case "zero-result":
        if (entry.entry_id === umami) base.states.buggy = { original_suite: "fail", verification: "fail", failure_codes: codes };
        return base;
      case "wrong-failure":
        base.states.buggy = { original_suite: "pass", verification: "fail", failure_codes: [otherCode(catalog, entry)] };
        return base;
      case "cancel-midway":
        // The second candidate (Umami) pauses with its second copy in flight until the stop arrives.
        if (entry.entry_id === umami) base.pause_at_copy = 2;
        return base;
      case "worker-lost":
        if (entry.entry_id === firstTaskReport) base.lost_after_copies = 2;
        return base;
      case "uncertain-provider":
        if (entry.entry_id === firstTaskReport) base.uncertain_at_copy = 1;
        return base;
      case "setup-failed":
        // The first candidate (the only one, on Umami) cannot prepare its clean copy: both of that
        // copy's cells observe error, so the candidate is invalid (setup_failed), never rejected.
        if (entry.entry_id === umami) base.states.clean = { original_suite: "error", verification: "error" };
        return base;
      default:
        return base;
    }
  };
  const validation: ValidationResult = scenario === "validation-failed" ? "failed" : scenario === "validation-error" ? "error" : "passed";
  return { scenario, input_fixture: INPUT_FIXTURE[scenario], end_fixture: END_FIXTURE[scenario], registry, plan, validation };
}
