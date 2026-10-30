import { describe, expect, it, vi } from "vitest";
import { INITIAL_DESIGNER, type DesignerState } from "../../src/assist/designer-state.ts";
import { badgesForRequest, shapeBadgeRequest, ShapeBadgesController } from "../../src/components/otf/shape-badge-state.ts";
import type { ShapeBadgesClient } from "../../src/otf/client.ts";
import { OTF_OPEN_CRITERION_ID, type OtfAvailability } from "../../src/otf/contract.ts";
import type { OtfShapeBadges, OtfShapeBadgesRequest } from "../../src/otf/shape-badges-contract.ts";

const request: OtfShapeBadgesRequest = { query: "Synthetic saved tasks", host_id: "task-report", shapes: [
  { title: "Synthetic task update", summary: "An updated task loses its saved title." },
  { title: "Synthetic task report", summary: "A report omits a completed task." },
] };
const answer: OtfShapeBadges = { model: "synthetic-classifier", badges: [
  { index: 0, outcome: "open", proven_criterion_id: null, family: "data_handling", translated_failure: "A saved task returns its old title after an update.", refusal_kind: null, reason: null },
  { index: 1, outcome: "refused", proven_criterion_id: null, family: null, translated_failure: null, refusal_kind: "out_of_scope", reason: "The synthetic report needs another application." },
] };
const availability: OtfAvailability = { enabled: true, builder: "stopped", active_jobs: 0, queued_jobs: 0, max_queued: 4, cold_start_min: null, spend_left_microusd: 1_000_000,
  behaviors: [{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID, label: "Synthetic open behavior", measured: false, example_phrases: [] }],
  hosts: [{ host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [], deadline_min: 45, typical: null }],
};
const state: DesignerState = { ...INITIAL_DESIGNER, query: "Different text typed after this search", hostId: "task-report", shapes: {
  shapes: request.shapes.map((shape, index) => ({ ...shape, id: `synthetic-shape-${String(index)}`, sources: [], fit: null, fit_reason: "" })),
  search: { provider: "tavily", query: request.query, at: "2026-10-30T00:00:00Z", result_count: 2 },
  model: { provider: "nebius-token-factory", model_id: "synthetic-designer", at: "2026-10-30T00:00:00Z" },
} };

function deferred() {
  let resolve!: (value: OtfShapeBadges) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<OtfShapeBadges>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("shape badge request scope", () => {
  it("uses the query and original shape order from the displayed search, on the chosen host", () => {
    expect(shapeBadgeRequest(state, true, availability)).toEqual(request);
    expect(shapeBadgeRequest({ ...state, hostId: "umami" }, true, availability)).toEqual({ ...request, host_id: "umami" });
  });
  it.each(["disabled", "unavailable", "closed", "no-open", "no-shapes", "no-host", "invalid-query"])("does not request badges with %s", kind => {
    const input = kind === "no-shapes" ? { ...state, shapes: null } : kind === "no-host" ? { ...state, hostId: null }
      : kind === "invalid-query" && state.shapes !== null ? { ...state, shapes: { ...state.shapes, search: { ...state.shapes.search, query: "" } } } : state;
    const offered = kind === "unavailable" ? null : kind === "no-open" ? { ...availability, behaviors: [] }
      : kind === "closed" ? { ...availability, hosts: availability.hosts.map(host => ({ ...host, offered: false })) } : availability;
    expect(shapeBadgeRequest(input, kind !== "disabled", offered)).toBeNull();
  });
});

describe("shape badges before card classification", () => {
  it("shows pending for one shared call and caches its badges across repeated effects", async () => {
    const pending = deferred();
    const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>(() => pending.promise);
    const controller = new ShapeBadgesController({ classifyShapes });
    const changes = vi.fn(); const unsubscribe = controller.subscribe(changes);
    const first = controller.load(request); const repeated = controller.load(structuredClone(request));
    expect(controller.snapshot()).toEqual({ request, pending: true, badges: null });
    expect(classifyShapes).toHaveBeenCalledExactlyOnceWith(request);
    pending.resolve(structuredClone(answer)); await Promise.all([first, repeated]);
    expect(controller.snapshot()).toEqual({ request, pending: false, badges: answer.badges });
    expect(changes).toHaveBeenCalledTimes(2);
    await controller.load(structuredClone(request));
    expect(classifyShapes).toHaveBeenCalledOnce(); expect(changes).toHaveBeenCalledTimes(2);
    unsubscribe(); await controller.load(null); expect(changes).toHaveBeenCalledTimes(2);
  });
  it("keeps request bytes stable while the caller changes its copy", async () => {
    const pending = deferred(); const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>(() => pending.promise);
    const controller = new ShapeBadgesController({ classifyShapes });
    const input = structuredClone(request); const work = controller.load(input);
    input.query = "Synthetic replacement search"; input.shapes.reverse();
    expect(classifyShapes.mock.calls[0]?.[0]).toEqual(request);
    pending.resolve(answer); await work;
    expect(controller.snapshot().request).toEqual(request);
  });
  it.each(["network", "invalid-answer"])("hides %s failures and does not spend another call on a rerender", async kind => {
    const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>(() => kind === "network" ? Promise.reject(new Error("Synthetic unavailable.")) : Promise.resolve({ ...answer, badges: [] }));
    const controller = new ShapeBadgesController({ classifyShapes });
    await controller.load(request); await controller.load(structuredClone(request));
    expect(controller.snapshot()).toEqual({ request, pending: false, badges: null });
    expect(classifyShapes).toHaveBeenCalledOnce();
  });
  it("revalidates the answer against the new host and suppresses a wrong-host proven badge", async () => {
    const refused = answer.badges[1]; if (refused === undefined) throw new Error("Synthetic refused badge is missing.");
    const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>(() => Promise.resolve({ ...answer, badges: [
      { index: 0, outcome: "proven" as const, proven_criterion_id: "concurrency.stale-success-response" as const, family: "concurrency" as const, translated_failure: null, refusal_kind: null, reason: null },
      refused,
    ] }));
    const controller = new ShapeBadgesController({ classifyShapes });
    await controller.load({ ...request, host_id: "umami" });
    expect(controller.snapshot().badges).toBeNull();
  });
  it.each(["host", "search", "disabled"])("ignores an old answer after the %s changes", async change => {
    const old = deferred(); const fresh = deferred();
    const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const controller = new ShapeBadgesController({ classifyShapes });
    const first = controller.load(request);
    const next = change === "disabled" ? null : change === "host" ? { ...request, host_id: "umami" as const } : { ...request, query: "Synthetic new search" };
    const second = controller.load(next);
    old.resolve(answer); await first;
    expect(controller.snapshot()).toEqual({ request: next, pending: next !== null, badges: null });
    if (next !== null) fresh.resolve(answer);
    await second;
    expect(controller.snapshot().request).toEqual(next);
    expect(controller.snapshot().badges).toEqual(next === null ? null : answer.badges);
  });
  it("hides stale loading and results before a request-change effect runs", async () => {
    const pending = deferred(); const controller = new ShapeBadgesController({ classifyShapes: () => pending.promise });
    const work = controller.load(request);
    const other = { ...request, host_id: "umami" as const };
    expect(badgesForRequest(controller.snapshot(), request)).toEqual({ pending: true, badges: null });
    expect(badgesForRequest(controller.snapshot(), other)).toEqual({ pending: false, badges: null });
    pending.resolve(answer); await work;
    expect(badgesForRequest(controller.snapshot(), request)).toEqual({ pending: false, badges: answer.badges });
    expect(badgesForRequest(controller.snapshot(), other)).toEqual({ pending: false, badges: null });
    expect(badgesForRequest(controller.snapshot(), null)).toEqual({ pending: false, badges: null });
  });
  it("reuses an in-flight result when returning to its request without starting another call", async () => {
    const pending = deferred(); const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>(() => pending.promise);
    const controller = new ShapeBadgesController({ classifyShapes });
    const first = controller.load(request); await controller.load(null);
    const resumed = controller.load(request);
    pending.resolve(answer); await Promise.all([first, resumed]);
    expect(classifyShapes).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toEqual({ request, pending: false, badges: answer.badges });
  });
  it.each(["host", "search"])("returns the handed-off search's late badges after the active %s changes", async change => {
    const old = deferred(); const fresh = deferred();
    const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const controller = new ShapeBadgesController({ classifyShapes });
    const first = controller.load(request);
    const handedOff = controller.result(request);
    expect(classifyShapes).toHaveBeenCalledOnce();
    const next: OtfShapeBadgesRequest = change === "host" ? { ...request, host_id: "umami" } : { ...request, query: "Synthetic next search" };
    const second = controller.load(next);
    old.resolve(answer); await first;
    expect(await handedOff).toEqual(answer.badges);
    expect(controller.snapshot()).toEqual({ request: next, pending: true, badges: null });
    expect(classifyShapes).toHaveBeenCalledTimes(2);
    fresh.resolve(answer); await second;
    expect(controller.snapshot()).toEqual({ request: next, pending: false, badges: answer.badges });
  });
  it("starts an uncached handoff result once and returns copies without changing a later visible search", async () => {
    const pending = deferred(); const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>(() => pending.promise);
    const controller = new ShapeBadgesController({ classifyShapes });
    const first = controller.result(request); const second = controller.result(request);
    expect(classifyShapes).toHaveBeenCalledExactlyOnceWith(request);
    await controller.load(null);
    pending.resolve(answer);
    const badges = await first;
    expect(badges).toEqual(answer.badges);
    const badge = badges?.[0]; if (badge === undefined) throw new Error("Synthetic handoff badge is missing.");
    badge.index = 1;
    expect(await second).toEqual(answer.badges);
    expect(await controller.result(request)).toEqual(answer.badges);
    expect(classifyShapes).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toEqual({ request: null, pending: false, badges: null });
  });
  it("returns no handoff badges for invalid or failed requests without retrying failures", async () => {
    const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>().mockRejectedValue(new Error("Synthetic unavailable."));
    const controller = new ShapeBadgesController({ classifyShapes });
    expect(await controller.result({ ...request, shapes: [] })).toBeNull();
    expect(classifyShapes).not.toHaveBeenCalled();
    expect(await controller.result(request)).toBeNull();
    expect(await controller.result(request)).toBeNull();
    expect(classifyShapes).toHaveBeenCalledOnce();
  });
});
