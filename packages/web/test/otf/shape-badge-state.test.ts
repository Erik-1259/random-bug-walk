import { describe, expect, it, vi } from "vitest";
import type { BugShape, ShapesResult } from "../../src/assist/client.ts";
import { designerReducer, INITIAL_DESIGNER, type DesignerAction } from "../../src/assist/designer-state.ts";
import { shapeBadgeGroups, shapeBadgesFor, shapeBadgeStatus, ShapeBadgesController, visibleShapeBadges, type ShapeBadgeGroup, type ShapeBadgesInput } from "../../src/components/otf/shape-badge-state.ts";
import { OtfClientError, type ShapeBadgesClient } from "../../src/otf/client.ts";
import { OTF_OPEN_CRITERION_ID, type OtfAvailability, type OtfHostId } from "../../src/otf/contract.ts";
import { SHAPE_BADGE_COPY, type OtfShapeBadge, type OtfShapeBadges } from "../../src/otf/shape-badges-contract.ts";
import { validateShapeBadgesRequest } from "../../src/otf/shape-badges-schemas.ts";

const submitted = "Synthetic saved tasks";
const availability: OtfAvailability = { enabled: true, builder: "stopped", active_jobs: 0, queued_jobs: 0, max_queued: 4, cold_start_min: null, spend_left_microusd: 1_000_000,
  behaviors: [{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID, label: "Synthetic open behavior", measured: false, example_phrases: [] },
    { host_id: "task-report", criterion_id: "concurrency.lost-acknowledged-change", label: "Synthetic overlapping saves", measured: true, example_phrases: [] }],
  hosts: [{ host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [], deadline_min: 45, typical: null }],
};
function shape(index: number, host: OtfHostId | null): BugShape {
  return { id: `synthetic-shape-${String(index)}`, title: `Synthetic shape ${String(index)}`, summary: `Synthetic task behavior ${String(index)}.`, sources: [], fit_reason: "",
    fit: host === null ? null : { host_id: host, bug_type_id: "synthetic_type", phrase: "synthetic phrase" } };
}
/** The search provider's string adds " bug report" to the judge's query, as the designer route does. */
function result(query = submitted, hosts: (OtfHostId | null)[] = ["umami", null, "task-report", "umami"]): ShapesResult {
  return { shapes: hosts.map((host, index) => shape(index, host)), search: { provider: "tavily", query: `${query} bug report`, at: "2026-10-30T00:00:00Z", result_count: hosts.length },
    model: { provider: "nebius-token-factory", model_id: "synthetic-designer", at: "2026-10-30T00:00:00Z" } };
}
/** A designer that has just shown its shapes: no shape picked and no host chosen yet. */
function searched(query = submitted, shapes = result(query.trim())) {
  return ([{ type: "query", query }, { type: "search" }, { type: "shapes", result: shapes }] as DesignerAction[]).reduce(designerReducer, INITIAL_DESIGNER);
}
function groupsOf(shapes: ShapesResult, query = submitted): ShapeBadgeGroup[] {
  const groups = shapeBadgeGroups(shapes, query, true, availability);
  if (groups === null) throw new Error("Synthetic groups are missing.");
  return groups;
}
const open = (index: number): OtfShapeBadge => ({ index, outcome: "open", proven_criterion_id: null, family: "data_handling", translated_failure: "A saved task returns its old title after an update.", refusal_kind: null, reason: null });
const refused = (index: number): OtfShapeBadge => ({ index, outcome: "refused", proven_criterion_id: null, family: null, translated_failure: null, refusal_kind: "out_of_scope", reason: "The synthetic report needs another application." });
const proven = (index: number): OtfShapeBadge => ({ index, outcome: "proven", proven_criterion_id: "concurrency.lost-acknowledged-change", family: "concurrency", translated_failure: null, refusal_kind: null, reason: null });
const answer = (badges: OtfShapeBadge[]): OtfShapeBadges => ({ model: "synthetic-classifier", badges });

function deferred() {
  let resolve!: (value: OtfShapeBadges) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<OtfShapeBadges>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
/** A fake route that keeps each host's requests in order, so a test answers each one separately. */
function route() {
  const queues: Record<OtfHostId, ReturnType<typeof deferred>[]> = { "task-report": [], umami: [] };
  const classifyShapes = vi.fn<ShapeBadgesClient["classifyShapes"]>(request => {
    const next = deferred(); queues[request.host_id].push(next); return next.promise;
  });
  const nth = (host: OtfHostId, index = -1) => {
    const pending = queues[host].at(index); if (pending === undefined) throw new Error(`No synthetic ${host} request.`);
    return pending;
  };
  return { classifyShapes, last: (host: OtfHostId) => nth(host), nth };
}
const flush = () => new Promise(resolve => { setTimeout(resolve, 0); });
function input(shapes: ShapesResult, extra: Partial<ShapeBadgesInput> = {}): ShapeBadgesInput {
  return { search: shapes, groups: groupsOf(shapes), signedIn: true, selectedShapeId: null, availability, ...extra };
}

describe("shape badge requests", () => {
  it("groups the shapes by designer-suggested host before any pick, keeping the designer's order in each group", () => {
    const state = searched(`  ${submitted}  `);
    expect(state.hostId).toBeNull(); expect(state.shapeId).toBeNull(); expect(state.searchQuery).toBe(submitted);
    const groups = shapeBadgeGroups(state.shapes, state.searchQuery, true, availability);
    const shapes = state.shapes?.shapes ?? [];
    const pick = (indices: number[]) => indices.map(index => ({ title: shapes[index]?.title, summary: shapes[index]?.summary }));
    expect(groups).toEqual([
      { hostId: "task-report", indices: [1, 2], request: { query: submitted, host_id: "task-report", shapes: pick([1, 2]) } },
      { hostId: "umami", indices: [0, 3], request: { query: submitted, host_id: "umami", shapes: pick([0, 3]) } },
    ]);
  });
  it("sends one request when every shape shares a host, and checks shapes with no suggestion against the task-report service", () => {
    expect(groupsOf(result(submitted, [null, null, "task-report"])).map(group => [group.hostId, group.indices])).toEqual([["task-report", [0, 1, 2]]]);
    expect(groupsOf(result(submitted, ["umami", "umami"])).map(group => [group.hostId, group.indices])).toEqual([["umami", [0, 1]]]);
  });
  it("sends the judge's own 300-character query without the search provider's suffix", () => {
    const query = "q".repeat(300);
    const state = searched(query);
    expect(state.shapes?.search.query).toBe(`${query} bug report`);
    const groups = shapeBadgeGroups(state.shapes, state.searchQuery, true, availability) ?? [];
    expect(groups).toHaveLength(2);
    for (const { request } of groups) {
      expect(request.query).toBe(query); expect(request.query).not.toContain(" bug report");
      expect(validateShapeBadgesRequest(request)).toEqual([]);
    }
  });
  it.each(["disabled", "unavailable", "closed", "no-open", "no-shapes", "no-query", "invalid-query"])("does not request badges with %s", kind => {
    const state = searched();
    const shapes = kind === "no-shapes" ? null : state.shapes;
    const query = kind === "no-query" ? null : kind === "invalid-query" ? "" : state.searchQuery;
    const offered = kind === "unavailable" ? null : kind === "no-open" ? { ...availability, behaviors: availability.behaviors.slice(1) }
      : kind === "closed" ? { ...availability, hosts: availability.hosts.map(host => ({ ...host, offered: false })) } : availability;
    expect(shapeBadgeGroups(shapes, query, kind !== "disabled", offered)).toBeNull();
  });
});

describe("shape badges before the first pick", () => {
  it("requests every group at once, shows loading per group and maps each badge back to its shape", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result();
    controller.sync(input(shapes));
    expect(fake.classifyShapes).toHaveBeenCalledTimes(2);
    expect(fake.classifyShapes.mock.calls.map(([request]) => request.host_id)).toEqual(["task-report", "umami"]);
    expect(controller.snapshot()).toEqual({ search: shapes, pending: [true, true, true, true], badges: [], order: null });
    fake.last("umami").resolve(answer([refused(0), open(1)]));
    await flush();
    expect(controller.snapshot()).toMatchObject({ pending: [false, true, true, false], badges: [refused(0), open(3)], order: null });
    fake.last("task-report").resolve(answer([proven(1), open(0)]));
    await flush();
    expect(controller.snapshot()).toEqual({ search: shapes, pending: [false, false, false, false], badges: [proven(2), open(1), refused(0), open(3)], order: [2, 1, 3, 0] });
  });
  it("never re-requests or clears badges when the judge picks shapes or changes the Step 3 host", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result();
    controller.sync(input(shapes));
    fake.last("umami").resolve(answer([open(0), open(1)])); fake.last("task-report").resolve(answer([open(0), refused(1)]));
    await flush();
    const before = controller.snapshot();
    expect(before.badges).toHaveLength(4);
    let state = searched(submitted, shapes);
    for (const action of [{ type: "pick_shape", shapeId: "synthetic-shape-0" }, { type: "pick_shape", shapeId: "synthetic-shape-2" }, { type: "pick_host", hostId: "umami" }] as DesignerAction[]) {
      state = designerReducer(state, action);
      controller.sync(input(shapes, { groups: groupsOf(shapes, state.searchQuery ?? ""), selectedShapeId: state.shapeId }));
    }
    expect(fake.classifyShapes).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toBe(before);
  });
  it("hides an old search's answer after a new search and keeps request bytes stable", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const first = result(submitted, [null]); const second = result("Synthetic next search", [null]);
    const sent = input(first);
    controller.sync(sent);
    const group = sent.groups[0]; if (group === undefined) throw new Error("Synthetic group is missing.");
    group.request.query = "Synthetic replacement"; group.request.shapes.reverse();
    expect(fake.classifyShapes.mock.calls[0]?.[0].query).toBe(submitted);
    controller.sync(input(second, { groups: groupsOf(second, "Synthetic next search") }));
    expect(shapeBadgesFor(controller.snapshot(), first)).toBeNull();
    fake.nth("task-report", 0).resolve(answer([open(0)])); await flush();
    expect(controller.snapshot()).toEqual({ search: second, pending: [true], badges: [], order: null });
    expect(shapeBadgesFor(controller.snapshot(), second)).toBe(controller.snapshot());
    expect(shapeBadgesFor(undefined, second)).toBeNull();
    controller.sync(null);
    expect(controller.snapshot()).toEqual({ search: null, pending: [], badges: [], order: null });
  });
});

describe("the badge order", () => {
  it("is not applied when a shape is selected before the badges arrive", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result(submitted, [null, null, null]);
    controller.sync(input(shapes));
    controller.freeze(shapes);
    fake.last("task-report").resolve(answer([refused(0), open(1), proven(2)]));
    await flush();
    expect(controller.snapshot()).toMatchObject({ order: null, badges: [refused(0), open(1), proven(2)] });
  });
  it("freezes when a selection reaches sync between two groups' answers", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result();
    controller.sync(input(shapes));
    fake.last("umami").resolve(answer([refused(0), open(1)])); await flush();
    controller.sync(input(shapes, { selectedShapeId: "synthetic-shape-0" }));
    fake.last("task-report").resolve(answer([proven(0), open(1)])); await flush();
    expect(controller.snapshot().order).toBeNull();
    expect(controller.snapshot().badges).toHaveLength(4);
  });
  it("stays put under a selection after it was applied", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result(submitted, [null, null, null]);
    controller.sync(input(shapes));
    fake.last("task-report").resolve(answer([refused(0), open(1), proven(2)])); await flush();
    expect(controller.snapshot().order).toEqual([2, 1, 0]);
    controller.sync(input(shapes, { selectedShapeId: "synthetic-shape-2" }));
    expect(controller.snapshot().order).toEqual([2, 1, 0]);
  });
  it("counts a proven badge without its availability label as no badge", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result(submitted, [null, null, null]);
    const labelless = { ...availability, behaviors: availability.behaviors.slice(0, 1) };
    controller.sync(input(shapes, { availability: labelless }));
    fake.last("task-report").resolve(answer([refused(0), proven(1), open(2)])); await flush();
    expect(controller.snapshot().order).toEqual([2, 1, 0]);
    expect(visibleShapeBadges(shapes.shapes, controller.snapshot().badges, labelless)).toEqual([refused(0), open(2)]);
    expect(visibleShapeBadges(shapes.shapes, controller.snapshot().badges, availability)).toEqual([refused(0), proven(1), open(2)]);
  });
});

describe("badge failures", () => {
  it.each([["network", new Error("Synthetic network failure.")], ["unavailable", new OtfClientError("unavailable", "Synthetic 503.", 503, true)]] as const)(
    "retries a %s failure once on the next render cycle for the same search, never twice", async (_kind, error) => {
      const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
      const shapes = result(submitted, [null, null]);
      controller.sync(input(shapes));
      fake.last("task-report").reject(error); await flush();
      expect(controller.snapshot()).toMatchObject({ pending: [false, false], badges: [] });
      controller.sync(input(shapes));
      expect(fake.classifyShapes).toHaveBeenCalledTimes(2);
      expect(controller.snapshot().pending).toEqual([true, true]);
      fake.last("task-report").reject(error); await flush();
      controller.sync(input(shapes)); controller.sync(input(shapes, { selectedShapeId: "synthetic-shape-0" }));
      expect(fake.classifyShapes).toHaveBeenCalledTimes(2);
      expect(controller.snapshot()).toMatchObject({ pending: [false, false], badges: [], order: null });
    });
  it("succeeds on the one retry after a transient failure", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result(submitted, [null, null]);
    controller.sync(input(shapes));
    fake.last("task-report").reject(new Error("Synthetic timeout.")); await flush();
    controller.sync(input(shapes));
    fake.last("task-report").resolve(answer([refused(0), open(1)])); await flush();
    expect(controller.snapshot()).toMatchObject({ badges: [refused(0), open(1)], order: [1, 0] });
  });
  it("retries a signed_out answer once after the judge signs in again", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result(submitted, [null]);
    controller.sync(input(shapes));
    const onSignedOut = vi.fn(); controller.onSignedOut = onSignedOut;
    fake.last("task-report").reject(new OtfClientError("signed_out", "Synthetic sign-in needed.", 401, false)); await flush();
    // The page re-checks the shared session, which brings back its sign-in form.
    expect(onSignedOut).toHaveBeenCalledOnce();
    controller.sync(input(shapes));
    expect(fake.classifyShapes).toHaveBeenCalledOnce();
    controller.sync(input(shapes, { signedIn: false }));
    expect(fake.classifyShapes).toHaveBeenCalledOnce();
    controller.sync(input(shapes));
    expect(fake.classifyShapes).toHaveBeenCalledTimes(2);
    fake.last("task-report").resolve(answer([open(0)])); await flush();
    expect(controller.snapshot().badges).toEqual([open(0)]);
  });
  it.each(["invalid_request", "invalid-answer"])("does not retry a %s result", async kind => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result(submitted, [null, null]);
    controller.sync(input(shapes));
    if (kind === "invalid_request") fake.last("task-report").reject(new OtfClientError("invalid_request", "Synthetic invalid.", 400, false));
    else fake.last("task-report").resolve(answer([open(0)]));
    await flush();
    controller.sync(input(shapes));
    expect(fake.classifyShapes).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({ pending: [false, false], badges: [] });
  });
  it("does not request while signed out", () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    controller.sync(input(result(), { signedIn: false }));
    expect(fake.classifyShapes).not.toHaveBeenCalled();
  });
});

describe("handed-off badges", () => {
  it("returns every group's badges once both settle, as copies", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result();
    controller.sync(input(shapes));
    const handed = controller.settled(shapes);
    fake.last("umami").resolve(answer([open(0), refused(1)])); await flush();
    fake.last("task-report").resolve(answer([open(0), open(1)]));
    const badges = await handed;
    expect(badges).toEqual([open(1), open(2), open(0), refused(3)]);
    const first = badges?.[0]; if (first === undefined) throw new Error("Synthetic badge is missing.");
    first.index = 9;
    expect(await controller.settled(shapes)).toEqual([open(1), open(2), open(0), refused(3)]);
  });
  it("waits for a due retry, and gives up on it when the designer moves to another search", async () => {
    const fake = route(); const controller = new ShapeBadgesController({ classifyShapes: fake.classifyShapes });
    const shapes = result();
    controller.sync(input(shapes));
    fake.last("umami").resolve(answer([open(0), open(1)])); fake.last("task-report").reject(new Error("Synthetic timeout.")); await flush();
    let done = false;
    const handed = controller.settled(shapes).then(badges => { done = true; return badges; });
    await flush(); expect(done).toBe(false);
    const next = result("Synthetic next search", [null]);
    controller.sync(input(next, { groups: groupsOf(next, "Synthetic next search") }));
    expect(await handed).toEqual([open(0), open(3)]);
    expect(await controller.settled(result())).toBeNull();
  });
});

describe("the badge status line", () => {
  it("says loading, then sums up the result, and stays silent without badges", () => {
    expect(shapeBadgeStatus(true, [])).toBe(SHAPE_BADGE_COPY.loading);
    expect(shapeBadgeStatus(false, [])).toBeNull();
    expect(shapeBadgeStatus(false, [open(0), refused(1), proven(2)])).toBe("Checked 3 shapes: 2 can be built.");
    expect(shapeBadgeStatus(false, [refused(0)])).toBe("Checked 1 shape: 0 can be built.");
  });
});
