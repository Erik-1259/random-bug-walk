import { describe, expect, it } from "vitest";
import { COPY_OUTER_LIMIT_MS } from "@rbw/local-runner";
import { COPY_ENVELOPE_SECONDS, copyEnvelope, copySettlement } from "../../src/envelope.ts";
import { COPY_DEADLINE_MS, DEVELOPMENT, JOB_LIMITS, JUDGE, childDeadlineMs, launchDecision } from "../../src/limits.ts";
import { rates } from "../support/harness.ts";

describe("spec §9.4 limits", () => {
  it("gives each job kind its controller deadline, ceiling and most copies", () => {
    expect(JOB_LIMITS).toEqual({
      admission: { controller_ms: 9_000_000, ceiling_microusd: 8_000_000, max_copies: 13 },
      kit_check: { controller_ms: 9_000_000, ceiling_microusd: 8_000_000, max_copies: 5 },
      observe: { controller_ms: 900_000, ceiling_microusd: 1_000_000, max_copies: 1 },
      judge_verify: { controller_ms: 2_100_000, ceiling_microusd: 2_000_000, max_copies: 3 },
    });
    expect(DEVELOPMENT).toEqual({ pool_key: "development", allocation_key: null, slot_key: "development" });
    expect(JUDGE).toEqual({ pool_key: "judge-demo", allocation_key: "judge", slot_key: "judge" });
  });

  it("gives a child the minimum of 600 s and the parent's remaining time minus 120 s, and no time when that is not positive", () => {
    expect(COPY_DEADLINE_MS).toBe(600_000);
    expect(childDeadlineMs(900_000)).toBe(600_000);
    expect(childDeadlineMs(720_000)).toBe(600_000);
    expect(childDeadlineMs(700_000)).toBe(580_000);
    expect(childDeadlineMs(120_001)).toBe(1);
    expect(childDeadlineMs(120_000)).toBeNull();
    expect(childDeadlineMs(-5_000)).toBeNull();
  });

  it("launches a copy only when its child deadline is the copy's whole 600 s, and names why otherwise", () => {
    expect(launchDecision(720_000)).toEqual({ launch: true, child_ms: 600_000 });
    expect(launchDecision(719_999)).toEqual({ launch: false, reason: "child_deadline_short", child_ms: 599_999 });
    expect(launchDecision(120_000)).toEqual({ launch: false, reason: "parent_deadline", child_ms: null });
  });
});

describe("the per-copy priced envelope", () => {
  it("prices one app copy for the sandbox's own timeout plus the shutdown allowance, from the pinned rate sheet", async () => {
    const envelope = copyEnvelope(await rates());
    if (!envelope.ok) throw new Error("synthetic: envelope refused");
    expect(COPY_ENVELOPE_SECONDS).toBe(COPY_OUTER_LIMIT_MS / 1000 + 60);
    expect(envelope.lines).toEqual([
      { service: "vercel-sandbox", unit: "vcpu_second", limit: 3120, enforced_by: "provider_timeout", price: { microusd: 128000, per_units: 3600 } },
      { service: "vercel-sandbox", unit: "memory_gb_second", limit: 6240, enforced_by: "provider_timeout", price: { microusd: 21200, per_units: 3600 } },
      { service: "vercel-sandbox", unit: "creation", limit: 1, enforced_by: "client_counter", price: { microusd: 600000, per_units: 1000000 } },
    ]);
    expect(envelope.reserved_microusd).toBe(147_682n);
    expect(envelope.bound_microusd).toBe(147_681n);
  });

  it("fits every job kind's most copies under its ceiling", async () => {
    const envelope = copyEnvelope(await rates());
    if (!envelope.ok) throw new Error("synthetic: envelope refused");
    for (const limits of Object.values(JOB_LIMITS)) {
      expect(envelope.reserved_microusd * BigInt(limits.max_copies)).toBeLessThanOrEqual(BigInt(limits.ceiling_microusd));
    }
  });

  it("settles a launched copy from its measured lifetime rounded up to whole seconds, and an unlaunched one at zero", async () => {
    const envelope = copyEnvelope(await rates());
    if (!envelope.ok) throw new Error("synthetic: envelope refused");
    const operation = "a".repeat(64);
    const evidence = { key: "jobs/kit-check/evidence/clean-01-stop.json", sha256: "b".repeat(64) };
    const launched = copySettlement(envelope, operation, { launched: true, lifetime_ms: 300_001 }, evidence);
    expect(launched).toEqual({
      schema_version: 1,
      operation_id: operation,
      runtime_profile_sha256: envelope.runtime_profile_sha256,
      rate_sheet_sha256: envelope.rate_sheet_sha256,
      reserved_microusd: 147_682,
      service_lines: [
        { service: "vercel-sandbox", unit: "vcpu_second", actual_quantity: 1204, actual_microusd: 42_809, retained_microusd: 0 },
        { service: "vercel-sandbox", unit: "memory_gb_second", actual_quantity: 2408, actual_microusd: 14_181, retained_microusd: 0 },
        { service: "vercel-sandbox", unit: "creation", actual_quantity: 1, actual_microusd: 1, retained_microusd: 0 },
      ],
      usage_state: "known",
      terminal_evidence_key: evidence.key,
      terminal_evidence_sha256: evidence.sha256,
    });
    const unlaunched = copySettlement(envelope, operation, { launched: false, lifetime_ms: 0 }, null);
    expect(unlaunched.service_lines.map((line) => [line.actual_quantity, line.actual_microusd])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(unlaunched.terminal_evidence_key).toBeNull();
  });
});
