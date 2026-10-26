// The contract fixtures that test mode replays (contract section 15.1): each scenario runs the events
// of its end-state fixture, and interpretations are looked up by the requirements of their normalized
// input, whatever item keys the client chose. Every file is checked against its contract definition
// when it loads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Capabilities, Case, DefName, DefTypes, Interpretation, NormalizedRequestInput, RequestStatus, TestScenario, ValidationRun } from "@rbw/factory-contract";
import { assertContract } from "@rbw/factory-contract/validate";
import { canonicalDigest } from "@rbw/schema";

/** The fixture whose input a scenario sends and whose end state it reaches (contract section 15.1). */
export const SCENARIO_FIXTURE: Record<TestScenario, string> = {
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
  // No end-state fixture: the run ends as status-zero-result.json does, with its candidate invalid.
  "setup-failed": "status-zero-result.json",
};

const STATUS_FILES = [...new Set([...Object.values(SCENARIO_FIXTURE), "status-queued.json", "status-running.json", "status-validated.json"])];
const INTERPRETATION_FILES = ["interpretation-supported.json", "interpretation-unsupported.json", "interpretation-budget-below-minimum.json", "interpretation-budget-below-item.json"];

export interface TestFixtures {
  capabilities: Capabilities;
  example: Case;
  statuses: ReadonlyMap<string, RequestStatus>;
  /** By the requirements of the normalized input (requirementsKey). */
  interpretations: ReadonlyMap<string, Interpretation>;
  runs: { running: ValidationRun; passed: ValidationRun; failed: ValidationRun; error: ValidationRun };
}

/**
 * What test mode matches an input on: the canonical SHA-256 of the normalized input with every item's
 * key left out. Items stay positional and keep their order, so only the keys do not count.
 */
export function requirementsKey(input: NormalizedRequestInput): string {
  return canonicalDigest({ ...input, items: input.items.map((item) => ({ ...item, item_key: null })) }).sha256;
}

export function loadTestFixtures(dir: string): TestFixtures {
  const read = <K extends DefName>(name: K, file: string): DefTypes[K] => assertContract(name, JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown);
  const statuses = new Map(STATUS_FILES.map((file) => [file, read("RequestStatus", file)] as const));
  const interpretations = new Map<string, Interpretation>();
  const all = [...INTERPRETATION_FILES.map((file) => read("Interpretation", file)), ...[...statuses.values()].map((status) => status.interpretation)];
  for (const interpretation of all) {
    const key = requirementsKey(interpretation.input);
    const known = interpretations.get(key);
    if (known !== undefined && known.interpretation_sha256 !== interpretation.interpretation_sha256) {
      throw new Error("test mode: two fixtures interpret one input differently");
    }
    interpretations.set(key, interpretation);
  }
  return {
    capabilities: read("Capabilities", "capabilities.json"),
    example: read("ExampleResponse", "example.json").case,
    statuses,
    interpretations,
    runs: {
      running: read("ValidationRun", "validation-running.json"),
      passed: read("ValidationRun", "validation-passed.json"),
      failed: read("ValidationRun", "validation-failed.json"),
      error: read("ValidationRun", "validation-error.json"),
    },
  };
}
