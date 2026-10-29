import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BugSpec } from "../../src/assist/client.ts";
import { INITIAL_DESIGNER, specKey, type DesignerState } from "../../src/assist/designer-state.ts";
import { BugDesignerView, CUSTOM_BUILD_DESIGNER_NOTE, handoffDesignerSpec, OTF_DESIGNER_NOTE, type BugDesignerViewProps } from "../../src/components/bug-designer.tsx";

const shapeId = "00000000-0000-4000-8000-000000000001";
const spec: BugSpec = { title: "Synthetic reporting behavior", target_app: "task-report", where: "Synthetic reporting route", change: "A task appears twice in a synthetic report.", why_tests_miss: "Existing synthetic checks use distinct tasks.", checks_to_add: ["Check a report after two synthetic updates."], fix: "Keep one entry for each task." };
const written: DesignerState = {
  ...INITIAL_DESIGNER, query: "  synthetic duplicate reports  ", shapeId, hostId: "task-report", specFor: specKey(shapeId, "task-report"),
  shapes: { shapes: [{ id: shapeId, title: "Synthetic report behavior", summary: "A synthetic task appears twice.", fit: null, fit_reason: "", sources: [] }],
    search: { provider: "tavily", query: "synthetic reports", at: "2026-10-29T00:00:00Z", result_count: 1 }, model: { provider: "nebius-token-factory", model_id: "synthetic-model", at: "2026-10-29T00:00:00Z" } },
  spec: { spec, model: { provider: "nebius-token-factory", model_id: "synthetic-model", at: "2026-10-29T00:00:00Z" } },
};
const noop = () => undefined;
function render(extra: Partial<BugDesignerViewProps> = {}) {
  return renderToStaticMarkup(<BugDesignerView signedIn capabilities={null} applyBlocked={null} onUsePlan={noop} state={written}
    dispatch={noop} onSearch={noop} onWrite={noop} otfEnabled customBuildOffered onBuildCustom={noop} {...extra} />);
}

describe("designer custom-build handoff", () => {
  it("shows the explicit handoff beside the ready card without handing it off during render", () => {
    const onBuildCustom = vi.fn();
    const html = render({ onBuildCustom });
    expect(html).toMatch(/<button type="button" class="factory-button">Build this as a custom bug<\/button>/);
    expect(html).toContain(spec.title);
    expect(html).toContain(CUSTOM_BUILD_DESIGNER_NOTE);
    expect(html).not.toContain(OTF_DESIGNER_NOTE);
    expect(onBuildCustom).not.toHaveBeenCalled();
  });
  it.each([false, true])("hides the handoff when signed in is %s but OTF is disabled", signedIn => {
    expect(render({ signedIn, otfEnabled: false })).not.toContain("Build this as a custom bug");
  });
  it("hides the handoff when the judge is signed out", () => {
    expect(render({ signedIn: false })).not.toContain("Build this as a custom bug");
  });
  it("hides the handoff for a stale card after choosing another host", () => {
    expect(render({ state: { ...written, hostId: "umami" } })).not.toContain("Build this as a custom bug");
  });
  it("shows no handoff and the unchanged note while the open behavior is absent from availability", () => {
    const html = render({ customBuildOffered: false });
    expect(html).not.toContain("Build this as a custom bug");
    expect(html).toContain(OTF_DESIGNER_NOTE); expect(html).not.toContain(CUSTOM_BUILD_DESIGNER_NOTE);
    expect(html).toBe(render({ customBuildOffered: false, onBuildCustom: undefined, customBuildBlocked: "Synthetic hold." }));
  });
  it("keeps the existing next-step note when a handoff is not usable", () => {
    for (const extra of [{ customBuildOffered: false }, { onBuildCustom: undefined }, { state: INITIAL_DESIGNER }, { state: { ...written, busy: "spec" as const } }]) {
      const html = render(extra);
      expect(html).toContain(OTF_DESIGNER_NOTE);
      expect(html).not.toContain(CUSTOM_BUILD_DESIGNER_NOTE);
    }
  });
  it("disables the handoff with a visible reason while the custom panel is busy, and keeps the custom-build note", () => {
    const html = render({ customBuildBlocked: "The custom-build panel is classifying a card. Wait for it to finish." });
    expect(html).toMatch(/disabled="" aria-describedby="designer-custom-blocked">Build this as a custom bug<\/button>/);
    expect(html).toContain('<p id="designer-custom-blocked" class="factory-note">The custom-build panel is classifying a card. Wait for it to finish.</p>');
    expect(html).toContain(CUSTOM_BUILD_DESIGNER_NOTE); expect(html).not.toContain(OTF_DESIGNER_NOTE);
  });
  it("disables the handoff while the designer is still writing", () => {
    expect(render({ state: { ...written, busy: "spec" as const } })).toMatch(/disabled="">Build this as a custom bug<\/button>/);
  });
  it("shows no handoff without a handoff target", () => {
    expect(render({ onBuildCustom: undefined })).not.toContain("Build this as a custom bug");
  });
  it("does not tie custom readiness to a catalog request or catalog fit", () => {
    const html = render({ applyBlocked: "A synthetic catalog request is running." });
    expect(html).toContain("No proven bug on Task and report service can fill the request form yet.");
    expect(html).toMatch(/<button type="button" class="factory-button">Build this as a custom bug<\/button>/);
  });
  it("hands off the current card, query and host only on an explicit action", () => {
    const onBuild = vi.fn();
    handoffDesignerSpec(written, onBuild);
    expect(onBuild).toHaveBeenCalledExactlyOnceWith({ spec, query: written.query, hostId: "task-report" });
    const sent = onBuild.mock.calls[0]?.[0] as { spec: BugSpec };
    expect(sent.spec).not.toBe(spec);
    expect(sent.spec.checks_to_add).not.toBe(spec.checks_to_add);
  });
  it("never hands off a stale or still-writing spec", () => {
    const onBuild = vi.fn();
    handoffDesignerSpec({ ...written, hostId: "umami" }, onBuild);
    handoffDesignerSpec({ ...written, busy: "spec" }, onBuild);
    handoffDesignerSpec(INITIAL_DESIGNER, onBuild);
    expect(onBuild).not.toHaveBeenCalled();
  });
});
