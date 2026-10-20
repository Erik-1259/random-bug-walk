import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRateSheet, parseRateSheet } from "@rbw/envelope";
import { canonicalDigest } from "@rbw/schema";
import { CopyCountInvalid, FACTORY_HOSTS, FACTORY_PROFILE, ProfileMismatch, RATE_SHEET_V1_SHA256, factoryEnvelope, priceProfile, profileForService, validationWorstCase } from "../../src/factory-profile.ts";
import { RATE_SHEET_PATH } from "../../src/rate-sheet.ts";

describe("the factory profile", () => {
  it("pins the v1 rate sheet and recomputes every frozen envelope from it", async () => {
    const rates = await loadRateSheet(RATE_SHEET_PATH);
    expect(rates.rate_sheet_sha256).toBe(RATE_SHEET_V1_SHA256);
    expect(FACTORY_PROFILE.rate_sheet_sha256).toBe(rates.rate_sheet_sha256);
    expect(priceProfile(rates)).toEqual(FACTORY_PROFILE.prices);
    // The worked amounts: 2 vCPU and 4 GB for 3,600 s plus the 60 s allowance and one creation.
    expect(FACTORY_PROFILE.prices.worker_worst_case_microusd).toBe(260_267 + 86_214 + 1);
    // A copy: 4 vCPU and 8 GB for 720 s plus 60 s, one creation (the judge copies' envelope).
    expect(FACTORY_PROFILE.prices.copy_worst_case_microusd["task-report"]).toBe(110_934 + 36_747 + 1);
  });

  it("prices a validation run for the copies its package's protocol declares, from the same sheet", async () => {
    const rates = await loadRateSheet(RATE_SHEET_PATH);
    for (const host of FACTORY_HOSTS) {
      // Its worker for 1,860 s and n copies inside 1,800 s plus n allowances, n + 1 creations.
      expect(validationWorstCase(rates, host, 3)).toBe(413_867 + 137_094 + 3);
      expect(validationWorstCase(rates, host, 6)).toBe(439_467 + 145_574 + 5);
      expect(validationWorstCase(rates, host, 7)).toBe(448_000 + 148_400 + 5);
      const envelope = factoryEnvelope(rates, { kind: "validation", host, copies: 6 });
      expect(envelope.runtime_profile_sha256).toBe(FACTORY_PROFILE.profile_sha256);
      expect(envelope.lines.map((line) => [line.unit, line.limit])).toEqual([
        ["vcpu_second", 3720 + 4 * (1800 + 6 * 60)],
        ["memory_gb_second", 7440 + 8 * (1800 + 6 * 60)],
        ["creation", 7],
      ]);
    }
    for (const copies of [0, -1, 2.5, Number.NaN]) expect(() => factoryEnvelope(rates, { kind: "validation", host: "umami", copies })).toThrow(CopyCountInvalid);
    expect(() => factoryEnvelope({ ...rates, rate_sheet_sha256: "f".repeat(64) }, { kind: "validation", host: "umami", copies: 3 })).toThrow(/not the factory profile's/);
  });

  it("prices each envelope with the reserved total the profile states, and refuses another sheet or a changed price", async () => {
    const rates = await loadRateSheet(RATE_SHEET_PATH);
    for (const host of FACTORY_HOSTS) expect(factoryEnvelope(rates, { kind: "copy", host }).reserved_microusd).toBe(BigInt(FACTORY_PROFILE.prices.copy_worst_case_microusd[host]));
    const worker = factoryEnvelope(rates, { kind: "worker" });
    expect(worker.reserved_microusd).toBe(BigInt(FACTORY_PROFILE.prices.worker_worst_case_microusd));
    expect(worker.runtime_profile_sha256).toBe(FACTORY_PROFILE.profile_sha256);
    expect(worker.lines.map((line) => [line.unit, line.limit])).toEqual([
      ["vcpu_second", 7320],
      ["memory_gb_second", 14640],
      ["creation", 1],
    ]);

    const sheet = JSON.parse(readFileSync(RATE_SHEET_PATH, "utf8")) as { entries: { unit: string; price: { microusd: number } }[] };
    const changed = { ...sheet, entries: sheet.entries.map((entry) => (entry.unit === "vcpu_second" ? { ...entry, price: { ...entry.price, microusd: entry.price.microusd + 1 } } : entry)) };
    const other = parseRateSheet(JSON.stringify(changed));
    expect(() => factoryEnvelope(other, { kind: "worker" })).toThrow(ProfileMismatch);
    // A sheet that prices every line the same but is not the profile's sheet is refused by its hash alone.
    expect(() => factoryEnvelope({ ...rates, rate_sheet_sha256: "f".repeat(64) }, { kind: "worker" })).toThrow(/not the factory profile's/);
    // The same sheet bytes with a profile whose frozen amount differs are refused too.
    const wrong = { ...FACTORY_PROFILE, prices: { ...FACTORY_PROFILE.prices, worker_worst_case_microusd: 1 } };
    expect(() => factoryEnvelope(rates, { kind: "worker" }, wrong)).toThrow(ProfileMismatch);
  });

  it("is frozen, hashed over its body and prices, and holds the approved budget range", () => {
    expect(Object.isFrozen(FACTORY_PROFILE)).toBe(true);
    expect(Object.isFrozen(FACTORY_PROFILE.limits)).toBe(true);
    expect(Object.isFrozen(FACTORY_PROFILE.copy.umami)).toBe(true);
    const { profile_sha256: hash, ...body } = FACTORY_PROFILE;
    expect(hash).toBe(canonicalDigest(body).sha256);
    const limits = FACTORY_PROFILE.limits;
    expect(limits.max_budget_microusd).toBe(3_000_000);
    expect(limits.default_budget_microusd).toBe(1_500_000);
    expect(limits.budget_presets_microusd).toContain(limits.default_budget_microusd);
    for (const preset of limits.budget_presets_microusd) {
      expect(preset).toBeGreaterThanOrEqual(limits.min_budget_microusd);
      expect(preset).toBeLessThanOrEqual(limits.max_budget_microusd);
    }
    expect(profileForService()).toEqual({ limits, profile_sha256: hash });
  });

  it("keeps the contract's timing: heartbeats at least every 30 s, lost after 180 s, validation within 1,800 s, a lifetime past the wall clock", () => {
    const p = FACTORY_PROFILE;
    expect(p.heartbeat.interval_s).toBeLessThanOrEqual(30);
    expect(p.heartbeat.unresponsive_after_s).toBe(60);
    expect(p.heartbeat.lost_after_s).toBe(180);
    expect(p.validation.max_run_s).toBe(1800);
    expect(p.validation.worker.timeout_s).toBeLessThanOrEqual(p.validation.max_run_s);
    expect(p.worker.timeout_s).toBeGreaterThan(p.limits.max_wall_clock_s);
    for (const host of FACTORY_HOSTS) {
      // A copy that starts just before the wall clock ends still ends, with its margin, before the worker's sandbox.
      expect(p.worker.timeout_s).toBeGreaterThanOrEqual(p.limits.max_wall_clock_s + p.copy[host].timeout_s + p.shutdown_seconds + p.copy_launch_margin_s);
      expect(p.copy[host].vcpus * 2048).toBe(p.copy[host].memory_mb);
    }
  });

  it("lets the minimum budget cover the worker and the smallest candidate a protocol can declare (one copy per state)", () => {
    const p = FACTORY_PROFILE;
    const smallest = Math.min(...FACTORY_HOSTS.map((host) => 3 * p.prices.copy_worst_case_microusd[host]));
    expect(p.limits.min_budget_microusd).toBeGreaterThanOrEqual(p.prices.worker_worst_case_microusd + smallest);
  });
});
