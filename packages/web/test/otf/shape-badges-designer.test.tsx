import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AssistClient, BugSpec } from "../../src/assist/client.ts";
import { designerReducer, INITIAL_DESIGNER, specKey, type DesignerAction, type DesignerState } from "../../src/assist/designer-state.ts";
import { BugDesignerView, freezeOnPick, handoffDesignerSpec, type BugDesignerViewProps, type CustomBuildDesign } from "../../src/components/bug-designer.tsx";
import { OtfDraftController } from "../../src/components/otf/draft.ts";
import { shapeBadgeGroups, ShapeBadgesController, type ShapeBadgesSnapshot, type ShapeSearchContext } from "../../src/components/otf/shape-badge-state.ts";
import { OtfWorkspaceView, type OtfWorkspaceViewProps } from "../../src/components/otf/workspace.tsx";
import { OtfController, type OtfClient, type ShapeBadgesClient } from "../../src/otf/client.ts";
import { ruleSha256 } from "../../src/otf/canonical.ts";
import { OTF_OPEN_CRITERION_ID, type OtfAvailability, type OtfClassification, type OtfJobStatus } from "../../src/otf/contract.ts";
import { SHAPE_BADGE_COPY, type OtfShapeBadge, type OtfShapeBadges } from "../../src/otf/shape-badges-contract.ts";

const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"] as const;
const time = "2026-10-30T00:00:00Z";
const card: BugSpec = { title: "Synthetic task update", target_app: "task-report", where: "Task update route", change: "A saved title disappears.", why_tests_miss: "Tests read only before updates.", checks_to_add: ["Read after an update."], fix: "Retain saved titles." };
const written: DesignerState = { ...INITIAL_DESIGNER, query: "Synthetic updates", searchQuery: "Synthetic updates", shapeId: ids[0], hostId: "task-report", specFor: specKey(ids[0], "task-report"),
  shapes: { shapes: ids.map((id, index) => ({ id, title: `Synthetic shape ${String(index)}`, summary: `Synthetic task behavior ${String(index)}.`, fit: null, fit_reason: "", sources: [] })),
    search: { provider: "tavily", query: "Synthetic updates bug report", at: time, result_count: 3 }, model: { provider: "nebius-token-factory", model_id: "synthetic-model", at: time } },
  spec: { spec: card, model: { provider: "nebius-token-factory", model_id: "synthetic-model", at: time } } };
const badges: OtfShapeBadge[] = [
  { index: 0, outcome: "refused", family: null, proven_criterion_id: null, translated_failure: null, refusal_kind: "out_of_scope", reason: "Synthetic unsupported behavior." },
  { index: 1, outcome: "open", family: "data_handling", proven_criterion_id: null, translated_failure: "A synthetic saved task returns its previous title.", refusal_kind: null, reason: null },
  { index: 2, outcome: "proven", family: "concurrency", proven_criterion_id: "concurrency.lost-acknowledged-change", translated_failure: null, refusal_kind: null, reason: null },
];
const availability: OtfAvailability = { enabled: true, builder: "running", active_jobs: 0, queued_jobs: 0, max_queued: 4, cold_start_min: null, spend_left_microusd: 1_000_000,
  behaviors: [{ criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: "Synthetic open behavior", measured: false, example_phrases: [] },
    { criterion_id: "concurrency.lost-acknowledged-change", host_id: "task-report", label: "Synthetic overlapping saves", measured: true, example_phrases: [] }],
  hosts: [{ host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [], deadline_min: 45, typical: null },
    { host_id: "umami", label: "Umami", offered: false, unavailable_reason: "calendar", active_jobs: 0, queued_jobs: 0, max_active: 1, lanes: [], deadline_min: 60, typical: null }] };
if (written.shapes === null) throw new Error("Synthetic search is missing.");
const shapeSearch: ShapeSearchContext = { query: "Synthetic updates", shapes: written.shapes.shapes, badges, selectedShapeId: ids[0] };
const search = written.shapes;
function snapshot(extra: Partial<ShapeBadgesSnapshot> = {}): ShapeBadgesSnapshot {
  return { search, pending: [false, false, false], badges: [], order: null, ...extra };
}
/** The designer right after a search: shapes shown, no shape picked and no host chosen yet. */
const listed: DesignerState = { ...written, shapeId: null, hostId: null, spec: null, specFor: null,
  shapes: { ...search, shapes: search.shapes.map((item, index) => index === 1 ? { ...item, fit: { host_id: "umami" as const, bug_type_id: "synthetic_type", phrase: "synthetic phrase" } } : item) } };
const refusal: OtfClassification = { family: null, proven_criterion_id: null, buildable: [], rule: null, refusal: { kind: "out_of_scope", reason: "Synthetic card is outside this application." }, model: "synthetic-classifier" };
const open: OtfClassification = { family: "data_handling", proven_criterion_id: null, buildable: [{ criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report" }],
  rule: { family: "data_handling", observable_failure: "GET /api/tasks/{id} returns the previous title after an update.", failure_code: "synthetic_title_missing" }, refusal: null, model: "synthetic-classifier" };
const noop = () => undefined;
function render(extra: Partial<BugDesignerViewProps> = {}) {
  return renderToStaticMarkup(<BugDesignerView state={written} signedIn capabilities={null} applyBlocked={null} onUsePlan={noop} dispatch={noop} onSearch={noop} onWrite={noop}
    otfEnabled customBuildOffered onBuildCustom={noop} {...extra} />);
}
/** Presses a button by its text in the designer's element tree, the way a click calls its handler; the designer's components use no hooks. */
function press(node: ReactNode, label: string): boolean {
  if (Array.isArray(node)) return node.some((child: ReactNode) => press(child, label));
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return false;
  if (typeof node.type === "function") return press((node.type as (props: unknown) => ReactNode)(node.props), label);
  if (node.type === "button" && node.props.children === label) { node.props.onClick?.(); return true; }
  return press(node.props.children, label);
}
const workspace: OtfWorkspaceViewProps = { availability, status: null, pending: false, busy: false, designing: false, signedIn: true, criterionId: OTF_OPEN_CRITERION_ID,
  sentence: "Synthetic updates", spec: card, message: null, canRetryCreate: false, canNewDraft: false, onBehavior: noop, onSentence: noop, onSpec: noop, onDesign: noop, onAccept: noop,
  onRetry: noop, onRefresh: noop, onStop: noop, onValidate: noop, onNew: noop, catalog: { onStart: noop, requestId: null, ready: false, disabled: false, message: null } };

describe("shape badges in the designer", () => {
  it.each(["flag off", "open absent"] as const)("preserves the entire designer markup with %s", gate => {
    const props = { shapeBadgesEnabled: gate !== "flag off", otfAvailability: gate === "open absent" ? { ...availability, behaviors: availability.behaviors.slice(1) } : availability };
    expect(render({ ...props, shapeBadges: snapshot({ pending: [true, true, true], badges, order: [2, 1, 0] }) })).toBe(render());
  });
  it("shows loading on every still-selectable shape and one polite status, without starting a card or a job", () => {
    const write = vi.fn(); const handoff = vi.fn();
    const html = render({ shapeBadgesEnabled: true, otfAvailability: availability, shapeBadges: snapshot({ pending: [true, true, true] }), onWrite: write, onBuildCustom: handoff });
    expect(html.split(SHAPE_BADGE_COPY.loading)).toHaveLength(5);
    expect(html).toMatch(new RegExp(`<div role="status" aria-live="polite" class="designer-live"><p>Found 3 bug shapes from 3 public results.</p><p>${SHAPE_BADGE_COPY.loading}</p></div>`));
    expect(html.match(/role="status"/g)).toHaveLength(render().match(/role="status"/g)?.length ?? 0);
    expect(html.match(/name="designer-shape"/g)).toHaveLength(3);
    expect(html).not.toContain('class="designer-shapes" disabled');
    expect(write).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled();
  });
  it("shows badges right after the search, before any pick or host, each in its own host's copy", () => {
    const umamiOpen = { ...badges[1], index: 1 } as OtfShapeBadge;
    const html = render({ state: listed, shapeBadgesEnabled: true, otfAvailability: availability, shapeBadges: snapshot({ search: listed.shapes, badges: [badges[0], umamiOpen, badges[2]] as OtfShapeBadge[], order: [2, 1, 0] }) });
    expect(html).not.toContain("Step 3");
    expect(html).toContain("Builds in the task-report service, not Umami");
    expect(html).toContain("Builds as a proven behavior: Synthetic overlapping saves");
    expect(html).toContain("Checked 3 shapes: 2 can be built.");
    expect(html.indexOf("Synthetic shape 2")).toBeLessThan(html.indexOf("Synthetic shape 1"));
  });
  it("shows loading only on the shapes whose group is still running", () => {
    const html = render({ state: listed, shapeBadgesEnabled: true, otfAvailability: availability, shapeBadges: snapshot({ search: listed.shapes, pending: [true, false, true], badges: [{ ...badges[1], index: 1 } as OtfShapeBadge] }) });
    expect(html.split(SHAPE_BADGE_COPY.loading)).toHaveLength(4);
    expect(html).toContain("Builds in the task-report service, not Umami");
  });
  it("orders shapes as the controller decided while keeping all radio controls selectable", () => {
    const html = render({ shapeBadgesEnabled: true, otfAvailability: availability, shapeBadges: snapshot({ badges, order: [2, 1, 0] }) });
    expect(html.indexOf("Synthetic shape 2")).toBeLessThan(html.indexOf("Synthetic shape 1"));
    expect(html.indexOf("Synthetic shape 1")).toBeLessThan(html.indexOf("Synthetic shape 0"));
    expect(html).toContain("Builds as a proven behavior: Synthetic overlapping saves");
    expect(html).toContain("Can&#x27;t be built here: Synthetic unsupported behavior.");
    expect(html.match(/name="designer-shape"/g)).toHaveLength(3);
    expect(html).not.toContain('class="designer-shapes" disabled');
  });
  it("keeps the designer's order when the order froze before the badges arrived", () => {
    const html = render({ shapeBadgesEnabled: true, otfAvailability: availability, shapeBadges: snapshot({ badges }) });
    expect(html.indexOf("Synthetic shape 0")).toBeLessThan(html.indexOf("Synthetic shape 1"));
    expect(html.indexOf("Synthetic shape 1")).toBeLessThan(html.indexOf("Synthetic shape 2"));
    expect(html).toContain("Builds as a proven behavior: Synthetic overlapping saves");
  });
  it("shows no badge for a proven badge whose label availability does not list", () => {
    const html = render({ shapeBadgesEnabled: true, otfAvailability: { ...availability, behaviors: availability.behaviors.slice(0, 1) }, shapeBadges: snapshot({ badges }) });
    expect(html).not.toContain("Builds as a proven behavior");
    expect(html).toContain("Checked 2 shapes: 1 can be built.");
  });
  it.each(["a failure", "another search"])("renders exactly the original designer after %s", kind => {
    const shapeBadges = kind === "a failure" ? snapshot() : snapshot({ search: listed.shapes, pending: [true, true, true], badges, order: [2, 1, 0] });
    expect(render({ shapeBadgesEnabled: true, otfAvailability: availability, shapeBadges })).toBe(render());
  });
  it("copies the matching search into an explicit card handoff without sharing mutable badge data", () => {
    const sent = vi.fn<(design: CustomBuildDesign) => void>();
    handoffDesignerSpec(written, sent, shapeSearch);
    expect(sent).toHaveBeenCalledExactlyOnceWith({ spec: card, query: written.query, hostId: "task-report", shapeSearch });
    expect(sent.mock.calls[0]?.[0].shapeSearch).not.toBe(shapeSearch);
    expect(sent.mock.calls[0]?.[0].shapeSearch?.badges).not.toBe(badges);
  });
  it("hands on the judge's submitted query, not the provider's, when \u201cBuild this as a custom bug\u201d is pressed", () => {
    const sent = vi.fn<(design: CustomBuildDesign) => void>();
    const view = BugDesignerView({ state: written, signedIn: true, capabilities: null, applyBlocked: null, onUsePlan: noop, dispatch: noop, onSearch: noop, onWrite: noop,
      otfEnabled: true, customBuildOffered: true, onBuildCustom: sent, shapeBadgesEnabled: true, otfAvailability: availability, shapeBadges: snapshot({ badges }) });
    expect(press(view, "Build this as a custom bug")).toBe(true);
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]?.[0].shapeSearch?.query).toBe("Synthetic updates");
    expect(search.search.query).toBe("Synthetic updates bug report");
  });
  it("keeps the designer's order when the badges arrive after a pick but before the next render", async () => {
    const answers: { request: Parameters<ShapeBadgesClient["classifyShapes"]>[0]; finish: (value: OtfShapeBadges) => void }[] = [];
    const client: ShapeBadgesClient = { classifyShapes: request => new Promise(finish => { answers.push({ request, finish }); }) };
    const controller = new ShapeBadgesController(client);
    let state = listed;
    const sync = () => {
      const groups = shapeBadgeGroups(state.shapes, state.searchQuery, true, availability);
      if (groups === null || state.shapes === null) throw new Error("Synthetic badge groups are missing.");
      controller.sync({ search: state.shapes, groups, signedIn: true, selectedShapeId: state.shapeId, availability });
    };
    sync();
    expect(answers).toHaveLength(2);
    freezeOnPick(state, controller, (action: DesignerAction) => { state = designerReducer(state, action); })({ type: "pick_shape", shapeId: ids[0] });
    // Shape 0 is refused and shape 2 is proven, so an unfrozen list would move shape 2 above the picked shape.
    for (const { request, finish } of answers) {
      const own = badges.filter(badge => (badge.index === 1) === (request.host_id === "umami"));
      finish({ model: "synthetic-classifier", badges: own.map((badge, index) => ({ ...badge, index })) });
    }
    await new Promise(resolve => { setTimeout(resolve, 0); });
    sync();
    expect(controller.snapshot().badges).toHaveLength(3);
    expect(controller.snapshot().order).toBeNull();
    const html = render({ state, shapeBadgesEnabled: true, otfAvailability: availability, shapeBadges: controller.snapshot() });
    expect(html.indexOf("Synthetic shape 0")).toBeLessThan(html.indexOf("Synthetic shape 1"));
    expect(html.indexOf("Synthetic shape 1")).toBeLessThan(html.indexOf("Synthetic shape 2"));
  });
  it("attaches the search after a Step 3 host change, but never another search's badges or the provider's query", () => {
    const sent = vi.fn<(design: CustomBuildDesign) => void>();
    const umami = { ...written, hostId: "umami" as const, specFor: specKey(ids[0], "umami") };
    handoffDesignerSpec(umami, sent, shapeSearch);
    expect(sent.mock.calls[0]?.[0]).toMatchObject({ hostId: "umami", shapeSearch });
    handoffDesignerSpec(written, sent, { ...shapeSearch, shapes: shapeSearch.shapes.slice(1) });
    handoffDesignerSpec(written, sent, { ...shapeSearch, query: "Synthetic updates bug report" });
    handoffDesignerSpec(written, sent, { ...shapeSearch, selectedShapeId: ids[1] });
    expect(sent).toHaveBeenCalledTimes(4);
    for (const [design] of sent.mock.calls.slice(1)) expect(design).not.toHaveProperty("shapeSearch");
  });
});

describe("card classification has the final say", () => {
  it("offers the other buildable shapes for a refused card even when its own shape has no badge", () => {
    // Shape 0's badge group failed (no badge); shapes 1 and 2 have buildable badges.
    const noOwnBadge: ShapeSearchContext = { ...shapeSearch, badges: badges.filter((badge) => badge.index !== 0) };
    const html = renderToStaticMarkup(<OtfWorkspaceView {...workspace} classification={refusal} shapeSearch={noOwnBadge} shapeBadgesEnabled onShapeAlternative={noop} />);
    expect(html).toContain(SHAPE_BADGE_COPY.disagreement); expect(html).toContain("Synthetic shape 1"); expect(html).toContain("Synthetic shape 2");
    // An open card with no badge on its shape still shows no list: only a refusal or a badge mismatch does.
    expect(renderToStaticMarkup(<OtfWorkspaceView {...workspace} classification={open} shapeSearch={noOwnBadge} shapeBadgesEnabled onShapeAlternative={noop} />)).not.toContain(SHAPE_BADGE_COPY.disagreement);
  });
  it("shows other buildable shapes only for a refusal with badge context and an enabled feature", () => {
    const props = { ...workspace, classification: refusal, shapeSearch, shapeBadgesEnabled: true, onShapeAlternative: noop };
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} />);
    expect(html).toContain(SHAPE_BADGE_COPY.disagreement); expect(html).toContain("Synthetic shape 1"); expect(html).toContain("Synthetic shape 2");
    expect(html).not.toContain("Synthetic shape 0");
    expect(renderToStaticMarkup(<OtfWorkspaceView {...props} shapeBadgesEnabled={false} />)).not.toContain(SHAPE_BADGE_COPY.disagreement);
    expect(renderToStaticMarkup(<OtfWorkspaceView {...props} shapeSearch={null} />)).not.toContain(SHAPE_BADGE_COPY.disagreement);
  });
  it.each(["open", "proven"] as const)("shows a buildable %s card normally, without a disagreement list", outcome => {
    const classification = outcome === "open" ? open : { ...open, proven_criterion_id: "concurrency.lost-acknowledged-change" as const,
      buildable: [{ host_id: "task-report" as const, criterion_id: "concurrency.lost-acknowledged-change" as const }], rule: null };
    expect(renderToStaticMarkup(<OtfWorkspaceView {...workspace} classification={classification} shapeSearch={{ ...shapeSearch, selectedShapeId: outcome === "open" ? ids[2] : ids[1] }} shapeBadgesEnabled />)).not.toContain(SHAPE_BADGE_COPY.disagreement);
  });
  it.each(["open", "proven"] as const)("offers alternatives when a refused badge yields a buildable %s card, without blocking acceptance", outcome => {
    const classification = outcome === "open" ? open : { ...open, proven_criterion_id: "concurrency.lost-acknowledged-change" as const,
      buildable: [{ host_id: "task-report" as const, criterion_id: "concurrency.lost-acknowledged-change" as const }], rule: null };
    const html = renderToStaticMarkup(<OtfWorkspaceView {...workspace} spec={{ ...card }} classification={classification} rule={open.rule} shapeSearch={shapeSearch} shapeBadgesEnabled />);
    expect(html).toContain(SHAPE_BADGE_COPY.disagreement);
    expect(html).not.toMatch(/disabled=""[^>]*>Accept and build this custom bug/);
  });
  it.each([false, true])("keeps late badges tied to their handed-off search (replaced: %s)", async replaced => {
    let finish!: (value: OtfShapeBadge[] | null) => void;
    const pending = new Promise<OtfShapeBadge[] | null>(resolve => { finish = resolve; });
    const draft = new OtfDraftController({ bugSpec: vi.fn() }, { classify: vi.fn<OtfClient["classify"]>().mockResolvedValue(refusal) });
    await draft.handoff({ spec: card, query: "Synthetic updates", hostId: "task-report", shapeSearch: { ...shapeSearch, badges: [] }, shapeBadges: pending }, availability, true);
    if (replaced) await draft.handoff({ spec: card, query: "Synthetic other search", hostId: "task-report", shapeSearch: { ...shapeSearch, query: "Synthetic other search", badges: [] } }, availability, true);
    finish(badges); await pending;
    expect(draft.snapshot().shapeSearch?.badges).toEqual(replaced ? [] : badges);
    expect(draft.acceptedInput(availability, true)).toBeNull();
  });
  it.each(["refused", "buildable"] as const)("writes and classifies an alternative to a %s card but creates nothing before explicit Accept", async initial => {
    const alternativeCard = { ...card, title: "Synthetic alternative card" };
    const designer: Pick<AssistClient, "bugSpec"> = { bugSpec: vi.fn(() => Promise.resolve({ ok: true as const, value: { spec: alternativeCard, model: { provider: "nebius-token-factory" as const, model_id: "synthetic-model", at: time } } })) };
    const classify = vi.fn<OtfClient["classify"]>().mockResolvedValueOnce(initial === "refused" ? refusal : open).mockResolvedValueOnce(open);
    const create = vi.fn<OtfClient["create"]>(body => {
      const status: OtfJobStatus = { job_id: ids[0], created_at: time, state: "queued", host_id: body.host_id, criterion_id: body.criterion_id, spec: body.spec, spec_sha256: body.spec_sha256, rule: body.rule,
        queue_position: 1, builder: "running", outcome: null, reason: null, deadline_at: null, elapsed_ms: 0, lanes: [], events: [], next_after: 0, poll_after_ms: 2000,
        spend: { model_microusd: 0, cap_microusd: 8_000_000, source: "builder proxy meter (upper bound)" }, winner: null, artifacts: [], certificate: null, validation: null, catalog_request_id: null };
      return Promise.resolve({ job_id: ids[0], status });
    });
    const api: OtfClient = { availability: () => Promise.resolve(availability), classify, create, status: vi.fn(), stop: vi.fn(), validate: vi.fn() };
    const draft = new OtfDraftController(designer, api);
    await draft.handoff({ spec: card, query: "Synthetic updates", hostId: "task-report", shapeSearch }, availability, true);
    if (initial === "refused") expect(draft.acceptedInput(availability, true)).toBeNull();
    await draft.selectShapeAlternative(ids[1], availability, true);
    expect(designer.bugSpec).toHaveBeenCalledExactlyOnceWith(shapeSearch.shapes[1], "task-report");
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0]).toMatchObject({ sentence: "Synthetic updates", host_id: "task-report", spec: { title: alternativeCard.title } });
    expect(draft.snapshot().shapeSearch?.selectedShapeId).toBe(ids[1]);
    expect(create).not.toHaveBeenCalled();
    const input = draft.acceptedInput(availability, true); if (input === null || open.rule === null) throw new Error("Synthetic alternative was not classified.");
    const saved = new Map<string, string>();
    const jobs = new OtfController(api, { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: key => { saved.delete(key); } }, () => ids[2], operation => operation());
    await jobs.initialize(); await jobs.create(input);
    expect(create).toHaveBeenCalledOnce(); expect(create.mock.calls[0]?.[0]).toMatchObject({ spec: { title: alternativeCard.title }, rule: open.rule, rule_sha256: await ruleSha256(open.rule) });
  });
  it("does not write an alternative without sign-in, an offered open behavior, or a buildable other shape", async () => {
    const bugSpec = vi.fn<AssistClient["bugSpec"]>(); const draft = new OtfDraftController({ bugSpec }, { classify: vi.fn<OtfClient["classify"]>().mockResolvedValue(refusal) });
    await draft.handoff({ spec: card, query: "Synthetic updates", hostId: "task-report", shapeSearch }, availability, true);
    await draft.selectShapeAlternative(ids[1], availability, false);
    await draft.selectShapeAlternative(ids[1], { ...availability, behaviors: [] }, true);
    await draft.selectShapeAlternative(ids[0], availability, true);
    expect(bugSpec).not.toHaveBeenCalled();
    draft.restore(null, availability);
    await draft.selectShapeAlternative(ids[1], availability, true);
    expect(bugSpec).not.toHaveBeenCalled(); expect(draft.snapshot().shapeSearch).toBeNull();
  });
  it("keeps the original card, its classification and the fallback list after a failed alternative write", async () => {
    const bugSpec = vi.fn<AssistClient["bugSpec"]>().mockResolvedValueOnce({ ok: false, failure: { code: "rate_limited", message: null, retryAfterS: 30 } })
      .mockRejectedValueOnce(new Error("Synthetic designer failure."));
    const draft = new OtfDraftController({ bugSpec }, { classify: vi.fn<OtfClient["classify"]>().mockResolvedValue(refusal) });
    await draft.handoff({ spec: card, query: "Synthetic updates", hostId: "task-report", shapeSearch }, availability, true);
    const before = draft.snapshot();
    for (const message of ["The designer is busy. Try again in 30 seconds.", "The spec designer could not respond. No custom build has started."]) {
      await draft.selectShapeAlternative(ids[1], availability, true);
      const after = draft.snapshot();
      expect(after).toEqual({ ...before, message });
      const html = renderToStaticMarkup(<OtfWorkspaceView {...workspace} spec={after.spec} sentence={after.sentence} classification={after.classification} shapeSearch={after.shapeSearch}
        message={after.message} shapeBadgesEnabled onShapeAlternative={noop} />);
      expect(html).toContain(SHAPE_BADGE_COPY.disagreement); expect(html).toContain("Synthetic shape 1"); expect(html).toContain(message);
    }
    expect(bugSpec).toHaveBeenCalledTimes(2);
  });
  it("announces the fallback list when it appears", () => {
    const html = renderToStaticMarkup(<OtfWorkspaceView {...workspace} classification={refusal} shapeSearch={shapeSearch} shapeBadgesEnabled onShapeAlternative={noop} />);
    expect(html).toContain(`<section aria-labelledby="otf-shape-alternatives"><p id="otf-shape-alternatives" role="status">${SHAPE_BADGE_COPY.disagreement}</p>`);
  });
  it("writes an alternative for the host its badge was checked against, with the judge's own query as its sentence", async () => {
    const query = "Synthetic lost updates";
    const shapes = shapeSearch.shapes.map((item, index) => index === 1 ? { ...item, fit: { host_id: "umami" as const, bug_type_id: "synthetic_type", phrase: "synthetic phrase" } } : item);
    const designer = { bugSpec: vi.fn<AssistClient["bugSpec"]>().mockResolvedValue({ ok: true, value: { spec: { ...card, title: "Synthetic alternative" }, model: { provider: "nebius-token-factory", model_id: "synthetic-model", at: time } } }) };
    const classify = vi.fn<OtfClient["classify"]>().mockResolvedValue(refusal);
    const draft = new OtfDraftController(designer, { classify });
    await draft.handoff({ spec: card, query, hostId: "task-report", shapeSearch: { ...shapeSearch, query, shapes } }, availability, true);
    await draft.selectShapeAlternative(ids[1], availability, true);
    expect(designer.bugSpec).toHaveBeenCalledExactlyOnceWith(shapes[1], "umami");
    expect(draft.snapshot().sentence).toBe(query);
    expect(classify.mock.calls[1]?.[0]).toMatchObject({ sentence: query, host_id: "umami" });
    for (const [body] of classify.mock.calls) expect(body.sentence).not.toContain(" bug report");
  });
  it("checks handed-off late badges against availability labels", async () => {
    let finish!: (value: OtfShapeBadge[] | null) => void;
    const pending = new Promise<OtfShapeBadge[] | null>(resolve => { finish = resolve; });
    const labelless = { ...availability, behaviors: availability.behaviors.slice(0, 1) };
    const draft = new OtfDraftController({ bugSpec: vi.fn() }, { classify: vi.fn<OtfClient["classify"]>().mockResolvedValue(refusal) });
    await draft.handoff({ spec: card, query: "Synthetic updates", hostId: "task-report", shapeSearch: { ...shapeSearch, badges: [] }, shapeBadges: pending }, labelless, true);
    finish(badges); await pending;
    expect(draft.snapshot().shapeSearch?.badges).toEqual(badges.slice(0, 2));
  });
});
