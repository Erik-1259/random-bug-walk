import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  closedByCalendar, describeFactoryMessage, describeServiceState, describeStopReason, describeSupport, formatBudgetInput, formatClock, formatDateTime,
  formatDuration, formatExactUsd, formatOffset, formatUsd, shortId, UMAMI_CALENDAR_REASON,
} from "../src/factory/format.ts";
import type { Capabilities } from "../src/factory/client.ts";

// The web package does not depend on the Umami host, so the test reads its source for the reason text.
const AVAILABILITY = readFileSync(new URL("../../host-umami/src/availability.ts", import.meta.url), "utf8");
const CALENDAR_REASON = /export const CALENDAR_REASON =\s*"([^"]+)";/.exec(AVAILABILITY)?.[1] ?? "missing";

describe("display formatting", () => {
  it("shows dollars and cents, rounding in the direction that cannot contradict a budget gate", () => {
    expect(formatUsd(590_000)).toBe("$0.59");
    expect(formatUsd(2_000_000)).toBe("$2.00");
    expect(formatUsd(346_482, "up")).toBe("$0.35");
    expect(formatUsd(349_999, "down")).toBe("$0.34");
    expect(formatUsd(1_234_567_890)).toBe("$1,234.57");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(471)).toBe("<$0.01");
    expect(formatUsd(-50_000)).toBe("-$0.05");
    expect(formatUsd(-1, "down")).toBe("-$0.01");
  });

  it("keeps the exact reported amount for the details views and a plain value for the budget field", () => {
    expect(formatExactUsd(346_482)).toBe("$0.346482");
    expect(formatExactUsd(590_000)).toBe("$0.59");
    expect(formatBudgetInput(2_000_000)).toBe("2.00");
    expect(formatBudgetInput(1_500_000)).toBe("1.50");
    expect(formatBudgetInput(1_000_001)).toBe("1.000001");
  });

  it("writes durations, offsets and clock times without the raw ISO text", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(260_000)).toBe("4 min 20 s");
    expect(formatDuration(300_000)).toBe("5 min");
    expect(formatDuration(3_900_000)).toBe("1 h 5 min");
    expect(formatDuration(-5_000)).toBe("0 s");
    expect(formatOffset("2026-10-20T14:00:00.000Z", "2026-10-20T14:02:41.812Z")).toBe("+2 min 42 s");
    expect(formatClock("2026-10-20T14:02:41.812Z", "UTC")).toBe("2:02:41 PM");
    expect(formatDateTime("2026-10-12T17:52:24Z")).toBe("Oct 12, 2026, 5:52 PM UTC");
    expect(shortId("6e5f4274-0000-4000-8000-000000000000")).toBe("6e5f4274…");
    expect(shortId("short")).toBe("short");
  });
});

describe("plain service states", () => {
  it("titles the client's code-prefixed messages and keeps the service's own text", () => {
    const busy = describeFactoryMessage("busy: Another factory request or validation run is active. Try again after it finishes.");
    expect(busy.title).toBe("Another request is running");
    expect(busy.body).toContain("one live request or validation at a time");
    expect(busy.raw).toBe("busy: Another factory request or validation run is active. Try again after it finishes.");
    const reconcile = describeFactoryMessage("busy: Earlier factory work has spend that is waiting for an operator to reconcile it. No new factory work can start until then.");
    expect(reconcile.title).toBe("Paused for an operator check");
    expect(reconcile.body).not.toMatch(/minute/);
    expect(describeFactoryMessage("budget_unavailable: The factory pool's available amount cannot cover this request's budget right now.").title).toBe("Not enough shared budget left");
    expect(describeFactoryMessage("passcode_incorrect: The passcode is not correct. Check it and try again.").title).toBe("That passcode didn't work");
    expect(describeFactoryMessage("synthetic text without a code")).toEqual({ title: "The request service refused this", body: null, raw: "synthetic text without a code" });
  });

  it("words the service state by its code", () => {
    expect(describeServiceState({ state: "unavailable", code: "halted", message: "Spending is halted for an operator check, so no paid work can start." })).toBe("Paused for an operator check. No new requests can start right now.");
    expect(describeServiceState({ state: "unavailable", code: "not_configured", message: null })).toBe("Live requests are not set up on this deployment.");
    expect(describeServiceState(null)).toContain("did not answer");
    expect(describeServiceState({ state: "available", code: null, message: null })).toContain("Reviewing your requirements is free");
  });

  it("explains each stop code in plain words", () => {
    const limits = { max_wall_clock_s: 2700, deadline_at: "2026-10-20T15:00:00.000Z", max_candidates: 10, candidates_started: 2 };
    expect(describeStopReason({ stop_reason: { code: "time_limit", message: "synthetic" }, limits })).toBe("Stopped at the 45-minute time limit. Cases delivered before that stay available below.");
    expect(describeStopReason({ stop_reason: { code: "cancelled_by_user", message: "synthetic" }, limits })).toContain("Stopped at your request.");
    expect(describeStopReason({ stop_reason: { code: "candidate_limit", message: "synthetic" }, limits })).toContain("trying 10 candidate bugs");
    expect(describeStopReason({ stop_reason: null, limits })).toBeNull();
  });

  it("recognizes the Umami calendar refusal by the service's exact reason", () => {
    expect(UMAMI_CALENDAR_REASON).toBe(CALENDAR_REASON);
    expect(describeSupport("unsupported", CALENDAR_REASON)).toBe("not available today");
    expect(describeSupport("unsupported", "No concurrency catalog with implemented verification checks is declared for Umami yet.")).toBe("not offered yet");
    expect(describeSupport("supported", null)).toBe("available");
    const capabilities = { combinations: [{ host_id: "umami", bug_type_id: "date_time", status: "unsupported", reason: CALENDAR_REASON, source: null }] } as unknown as Capabilities;
    expect(closedByCalendar(capabilities, "umami")).toBe(true);
    expect(closedByCalendar(capabilities, "task-report")).toBe(false);
  });
});
