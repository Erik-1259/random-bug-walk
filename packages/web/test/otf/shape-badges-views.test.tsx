import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BugShape } from "../../src/assist/client.ts";
import { ShapeAlternativesView, ShapeBadgeView } from "../../src/components/otf/shape-badges.tsx";
import { typicalSentence } from "../../src/components/otf/host-copy.tsx";
import { type OtfAvailability, type OtfHostAvailability, type OtfHostId } from "../../src/otf/contract.ts";
import { SHAPE_BADGE_COPY, type OtfShapeBadge } from "../../src/otf/shape-badges-contract.ts";

const task: OtfHostAvailability = { host_id: "task-report", label: "Synthetic task service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [], deadline_min: 45, typical: { source: "development_attempts", median_min: 12, p90_min: 24, samples: 10, measured_on: "2026-10-30" } };
const umami: OtfHostAvailability = { ...task, host_id: "umami", label: "Umami", max_active: 1, typical: { source: "development_attempts", median_min: 18, p90_min: 36, samples: 20, measured_on: "2026-10-30" } };
const availability: OtfAvailability = { enabled: true, builder: "running", active_jobs: 0, queued_jobs: 0, max_queued: 4, cold_start_min: null, spend_left_microusd: 1000000, hosts: [task, umami],
  behaviors: [
    { criterion_id: "concurrency.lost-acknowledged-change", host_id: "task-report", label: "Synthetic saved changes", measured: true, example_phrases: [] },
    { criterion_id: "date_time.time-zone-grouping", host_id: "umami", label: "Synthetic local days", measured: true, example_phrases: [] },
  ],
};
const translated = "The daily task report omits a saved completion.";
function open(index = 0, translated_failure: string | null = translated): OtfShapeBadge {
  return { index, outcome: "open", family: "data_handling", proven_criterion_id: null, translated_failure, refusal_kind: null, reason: null };
}
function proven(hostId: OtfHostId = "task-report", index = 0): OtfShapeBadge {
  return { index, outcome: "proven", family: hostId === "umami" ? "date_time" : "concurrency", proven_criterion_id: hostId === "umami" ? "date_time.time-zone-grouping" : "concurrency.lost-acknowledged-change", translated_failure: null, refusal_kind: null, reason: null };
}
function refused(index = 0, refusal_kind: "security" | "out_of_scope" = "out_of_scope"): OtfShapeBadge {
  return { index, outcome: "refused", family: null, proven_criterion_id: null, translated_failure: null, refusal_kind, reason: "Synthetic behavior is outside this service." };
}
function shape(id: string): BugShape {
  return { id, title: `Synthetic ${id}`, summary: `Synthetic description for ${id}.`, sources: [], fit: null, fit_reason: "" };
}
const shapes = [shape("chosen"), shape("open-first"), shape("proven"), shape("refused"), shape("open-second")];
const badges = [open(4), refused(3), open(1), open(0), proven("task-report", 2)];

function buttons(node: ReactNode): { onClick?: () => void; disabled?: boolean }[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>(child)) return [];
    return child.type === "button" ? [child.props] : buttons(child.props.children);
  });
}

describe("shape badge copy", () => {
  it.each(["task-report", "umami"] as const)("renders the %s proven label and that host's existing time line", hostId => {
    const html = render(<ShapeBadgeView badge={proven(hostId)} hostId={hostId} availability={availability} />);
    expect(html).toContain(hostId === "umami" ? "Builds in Umami as a proven behavior: Synthetic local days" : "Builds as a proven behavior: Synthetic saved changes");
    expect(html).toContain(typicalSentence(hostId === "umami" ? umami : task));
    expect(html).not.toContain(typicalSentence(hostId === "umami" ? task : umami));
  });
  it.each(["task-report", "umami"] as const)("shows the %s open translation without measured timing", hostId => {
    const html = render(<ShapeBadgeView badge={open()} hostId={hostId} availability={availability} />);
    expect(html).toContain(hostId === "umami" ? "Builds in the task-report service, not Umami" : "Builds in the task-report service</p>");
    expect(html).toContain(`Builds in the task-report service as: “${translated}”. Not measured yet.`);
    expect(html).not.toContain("In development runs"); expect(html).not.toContain("Usually about");
  });
  it("uses the exact Umami fallback detail when the translation is absent", () => {
    const html = render(<ShapeBadgeView badge={open(0, null)} hostId="umami" availability={availability} />);
    expect(html).toContain("Builds in the task-report service, not Umami");
    expect(html).toContain("The same kind of failure is recreated in our task-report service, because Umami builds cover time-zone grouping only. Not measured yet.");
    expect(html).not.toContain("as: “");
  });
  it("shows only the task-report headline when the translation is absent", () => {
    const html = render(<ShapeBadgeView badge={open(0, null)} hostId="task-report" availability={availability} />);
    expect(html).toContain("Builds in the task-report service");
    expect(html).not.toContain("as: “"); expect(html).not.toContain("Umami"); expect(html.match(/<p/g)).toHaveLength(1);
  });
  it.each(["task-report", "umami"] as const)("shows a refusal reason on %s without a build or time claim", hostId => {
    const html = render(<ShapeBadgeView badge={refused()} hostId={hostId} availability={availability} />);
    expect(html).toContain("Can&#x27;t be built here: Synthetic behavior is outside this service.");
    expect(html).not.toContain("In development runs"); expect(html).not.toContain("Not measured yet");
  });
  it("keeps the same visible refusal copy for a security refusal", () => {
    expect(render(<ShapeBadgeView badge={refused(0, "security")} hostId="task-report" availability={availability} />))
      .toBe(render(<ShapeBadgeView badge={refused()} hostId="task-report" availability={availability} />));
  });
  it.each([null, { ...availability, behaviors: [] }])("hides a proven badge without its availability label", current => {
    expect(render(<ShapeBadgeView badge={proven()} hostId="task-report" availability={current} />)).toBe("");
  });
  it("escapes displayed translation text instead of rendering markup", () => {
    const html = render(<ShapeBadgeView badge={open(0, "The task title includes <em>synthetic</em> text.")} hostId="task-report" availability={availability} />);
    expect(html).toContain("&lt;em&gt;synthetic&lt;/em&gt;"); expect(html).not.toContain("<em>");
  });
});

describe("other buildable shapes after a card refusal", () => {
  it("uses the exact heading and stable proven-before-open order, excluding the chosen and refused shapes", () => {
    const html = render(<ShapeAlternativesView shapes={shapes} badges={badges} selectedShapeId="chosen" availability={availability} onPick={vi.fn()} />);
    expect(html).toContain(SHAPE_BADGE_COPY.disagreement);
    expect(html).not.toContain("Synthetic chosen"); expect(html).not.toContain("Synthetic refused");
    expect(html.indexOf("Synthetic proven")).toBeLessThan(html.indexOf("Synthetic open-first"));
    expect(html.indexOf("Synthetic open-first")).toBeLessThan(html.indexOf("Synthetic open-second"));
    expect(html.match(/<button/g)).toHaveLength(3); expect(html).not.toContain("disabled");
    expect(html).toContain("Builds as a proven behavior: Synthetic saved changes"); expect(html).toContain(translated);
  });
  it("hands only the explicitly selected original shape to the caller", () => {
    const onPick = vi.fn();
    const view = ShapeAlternativesView({ shapes, badges, selectedShapeId: "chosen", availability, onPick });
    expect(onPick).not.toHaveBeenCalled();
    const choices = buttons(view);
    choices[1]?.onClick?.();
    expect(onPick).toHaveBeenCalledExactlyOnceWith(shapes[1]);
  });
  it("disables alternative buttons only when the surrounding operation is busy", () => {
    const html = render(<ShapeAlternativesView shapes={shapes} badges={badges} selectedShapeId="chosen" availability={availability} disabled onPick={vi.fn()} />);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
  it.each([{ currentBadges: [] }, { currentBadges: [open(0), refused(1)] }])("shows nothing when no other shape is buildable", ({ currentBadges }) => {
    expect(render(<ShapeAlternativesView shapes={shapes.slice(0, 2)} badges={currentBadges} selectedShapeId="chosen" availability={availability} onPick={vi.fn()} />)).toBe("");
  });
  it("neither offers nor sorts first a proven shape whose label availability does not list", () => {
    const labelless = { ...availability, behaviors: availability.behaviors.slice(1) };
    const html = render(<ShapeAlternativesView shapes={shapes} badges={badges} selectedShapeId="chosen" availability={labelless} onPick={vi.fn()} />);
    expect(html).not.toContain("Synthetic proven"); expect(html).not.toContain("Builds as a proven behavior");
    expect(html.match(/<button/g)).toHaveLength(2);
  });
  it("shows each alternative's badge in its own badge host's copy", () => {
    const mixed = shapes.map(item => item.id === "open-first" ? { ...item, fit: { host_id: "umami" as const, bug_type_id: "synthetic_type", phrase: "synthetic phrase" } } : item);
    const html = render(<ShapeAlternativesView shapes={mixed} badges={badges} selectedShapeId="chosen" availability={availability} onPick={vi.fn()} />);
    expect(html.match(/Builds in the task-report service, not Umami/g)).toHaveLength(1);
    expect(html.match(/Builds in the task-report service<\/p>/g)).toHaveLength(1);
  });
});
