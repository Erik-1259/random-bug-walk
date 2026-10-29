import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OtfWorkspaceView, type OtfWorkspaceViewProps } from "../../src/components/otf/workspace.tsx";
import { BugDesignerView, CATALOG_HONESTY } from "../../src/components/bug-designer.tsx";
import { INITIAL_DESIGNER } from "../../src/assist/designer-state.ts";
import type { OtfAvailability } from "../../src/otf/contract.ts";

const noop = () => undefined;
const availability: OtfAvailability = { enabled: true, builder: "stopped", active_jobs: 0, queued_jobs: 0, max_active: 2, max_queued: 4,
  behaviors: [{ criterion_id: "concurrency.lost-acknowledged-change", label: "Synthetic overlapping writes", example_phrases: ["A synthetic edit is lost."] }],
  lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], typical: { median_min: 10, p90_min: 35, cold_start_min: null, basis: "measured on 13 sample specs, Oct 29" }, spend_left_microusd: 1000000 };
const props: OtfWorkspaceViewProps = { availability, status: null, pending: false, busy: false, designing: false, signedIn: true,
  criterionId: "concurrency.lost-acknowledged-change", sentence: "Synthetic overlapping writes", spec: null, message: null, canRetryCreate: false, canNewDraft: false,
  onBehavior: noop, onSentence: noop, onSpec: noop, onDesign: noop, onAccept: noop, onRetry: noop, onRefresh: noop, onStop: noop, onValidate: noop, onNew: noop,
  catalog: { onStart: noop, disabled: false, requestId: null, ready: false, message: null } };

describe("custom workspace boundary", () => {
  it("renders the guided picker only after availability enables it", () => {
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} />);
    expect(html).toContain("Synthetic overlapping writes");
    expect(html).toContain("Write my spec card");
    expect(html).not.toContain("Built for your request");
  });
  it("shows honest offline copy and the catalog fallback without a queueing illusion", () => {
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} availability={{ ...availability, enabled: false }} />);
    expect(html).toContain("Custom builds are offline right now. The catalog is available.");
    expect(html).toContain("Start the closest catalog bug");
    expect(html).not.toContain("Write my spec card");
    expect(html).not.toContain("Starting the Nebius machine");
  });
  it("keeps unavailable and signed-out failures visible with an explicit refresh", () => {
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} availability={null} message="signed_out: Sign in again." />);
    expect(html).toContain("signed_out: Sign in again.");
    expect(html).toContain("Refresh custom build");
    expect(html).toContain("Start the closest catalog bug");
  });
  it("offers only the same saved create after an ambiguous network result", () => {
    const retry = vi.fn();
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} pending canRetryCreate onRetry={retry} message="The response was lost." />);
    expect(html).toContain("Retry the same custom build");
    expect(html).toContain("saved");
    expect(html).not.toContain("Write my spec card");
    expect(retry).not.toHaveBeenCalled();
  });
  it("announces designer progress and never claims the design is already built", () => {
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} designing />);
    expect(html).toContain("Writing your spec card");
    expect(html).not.toContain("Built for your request");
  });
  it("offers an explicit edit only when the controller proves no job was created", () => {
    const refused = renderToStaticMarkup(<OtfWorkspaceView {...props} pending canRetryCreate canNewDraft message="invalid_spec: Edit the card." />);
    expect(refused).toContain("Edit custom design");
    const uncertain = renderToStaticMarkup(<OtfWorkspaceView {...props} pending canRetryCreate message="The response was lost." />);
    expect(uncertain).not.toContain("Edit custom design");
  });
  it("scopes the existing designer's next-step copy to enabled custom builds", () => {
    const common = { signedIn: true, capabilities: null, applyBlocked: null, onUsePlan: noop, state: INITIAL_DESIGNER, dispatch: noop, onSearch: noop, onWrite: noop };
    const offline = renderToStaticMarkup(<BugDesignerView {...common} otfEnabled={false} />);
    expect(offline).toContain(CATALOG_HONESTY);
    expect(offline).not.toContain("Building this exact design is the next step");
    const online = renderToStaticMarkup(<BugDesignerView {...common} otfEnabled />);
    expect(online).toContain("Building this exact design is the next step");
    expect(online).toContain("task-report");
  });
});
