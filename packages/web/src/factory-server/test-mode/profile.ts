// The test-mode factory profile: the worst cases contract section 15.1 fixes for test mode and request
// limits that admit every fixture input. The production profile is a separate frozen object priced
// from the rate sheet; nothing here prices real work.
import type { HostId, Limits } from "@rbw/factory-contract";
import { canonicalDigest } from "@rbw/schema";

export interface TestProfile {
  limits: Limits;
  /** The test factory pool (contract section 15.1). */
  pool_microusd: number;
  worker_microusd: number;
  /** A candidate's worst case; its three copies share it. */
  candidate_microusd: Record<HostId, number>;
  validation_microusd: Record<HostId, number>;
}

export const TEST_PROFILE: TestProfile = {
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
  pool_microusd: 40_000_000,
  worker_microusd: 200_000,
  candidate_microusd: { umami: 600_000, "task-report": 300_000 },
  validation_microusd: { umami: 300_000, "task-report": 200_000 },
};

export function profileSha256(profile: TestProfile): string {
  return canonicalDigest({ kind: "rbw-factory-test-profile", version: 1, profile }).sha256;
}
