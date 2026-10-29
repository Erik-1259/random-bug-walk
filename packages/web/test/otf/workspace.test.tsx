import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OtfWorkspaceView, type OtfWorkspaceViewProps } from "../../src/components/otf/workspace.tsx";
import { BugDesignerView, CATALOG_HONESTY } from "../../src/components/bug-designer.tsx";
import { INITIAL_DESIGNER } from "../../src/assist/designer-state.ts";
import { specSha256 } from "../../src/otf/canonical.ts";
import type { OtfAvailability, OtfCreateJob, OtfHostAvailability, OtfJobStatus } from "../../src/otf/contract.ts";

const noop = () => undefined;
const taskReport: OtfHostAvailability = { host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], deadline_min: 45, typical: null };
const umami: OtfHostAvailability = { host_id: "umami", label: "Umami", offered: false, unavailable_reason: "calendar", active_jobs: 0, queued_jobs: 0, max_active: 1, lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], deadline_min: 60, typical: null };
const availability: OtfAvailability = { enabled: true, builder: "stopped", active_jobs: 0, queued_jobs: 0, max_queued: 4,
  behaviors: [{ criterion_id: "concurrency.lost-acknowledged-change", host_id: "task-report", label: "Synthetic overlapping writes", example_phrases: ["A synthetic edit is lost."] }],
  hosts: [taskReport, umami], cold_start_min: null, spend_left_microusd: 1000000 };
const NOV_3 = Date.UTC(2026, 10, 3, 12);
const spec = { title: "Synthetic grouping card", where: "Synthetic report", change: "A synthetic day shifts.", why_tests_miss: "Synthetic tests use UTC.", checks_to_add: ["Group a synthetic late event."], fix: "Group by the chosen zone." };
async function umamiRequest(): Promise<OtfCreateJob> {
  return { client_key: "00000000-0000-4000-8000-000000000002", host_id: "umami", criterion_id: "date_time.time-zone-grouping", sentence: "Synthetic late events land on the wrong day.", spec, spec_sha256: await specSha256(spec) };
}
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
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} availability={null} pending message="signed_out: Sign in again." />);
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
  it("renders nothing when availability is unavailable or failed and nothing is saved", () => {
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} availability={null} message="unavailable: Synthetic unconfigured." />);
    expect(html).toBe("");
  });
  it("still shows a saved job while availability is unknown", () => {
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} availability={null} pending />);
    expect(html).toContain("Your accepted custom build is saved");
  });
  it("keeps the card and sentence after a host refusal, with the host's reason and the catalog fallback, never an error", async () => {
    const request = await umamiRequest();
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} pending pendingRequest={request} refusal="host_unavailable" canRetryCreate canNewDraft nowMs={NOV_3} />);
    expect(html).toContain("This custom build was not started. Umami is unavailable on UTC days 2–5. They open again on November 6 (UTC). Task-report builds and the catalog are still available.");
    expect(html).toContain("Card: Synthetic grouping card."); expect(html).toContain("Sentence: Synthetic late events land on the wrong day.");
    expect(html).toContain("Edit custom design"); expect(html).toContain("Retry the same custom build");
    expect(html).toContain("<h2>Start the closest catalog bug</h2>"); expect(html).not.toContain("While this builds");
    expect(html).not.toMatch(/error/i); expect(html).not.toContain('role="alert"');
  });
  it("says While this builds only while a custom build is pending or running", async () => {
    expect(renderToStaticMarkup(<OtfWorkspaceView {...props} />)).not.toContain("While this builds");
    expect(renderToStaticMarkup(<OtfWorkspaceView {...props} pending canRetryCreate />)).toContain("While this builds");
    const running: OtfJobStatus = { job_id: "00000000-0000-4000-8000-000000000001", created_at: "2026-10-29T00:00:00Z", state: "building", host_id: "task-report", queue_position: null, builder: "running", outcome: null, reason: null, criterion_id: "concurrency.lost-acknowledged-change", spec, spec_sha256: await specSha256(spec), deadline_at: null, elapsed_ms: 0, lanes: [], events: [], next_after: 0, poll_after_ms: 2000, spend: { model_microusd: 0, cap_microusd: 8000000, source: "builder proxy meter (upper bound)" }, winner: null, artifacts: [], certificate: null, validation: null, catalog_request_id: null };
    expect(renderToStaticMarkup(<OtfWorkspaceView {...props} pending status={running} />)).toContain("While this builds");
    const failed = renderToStaticMarkup(<OtfWorkspaceView {...props} pending status={{ ...running, state: "finished", outcome: "time_limit" }} />);
    expect(failed).not.toContain("While this builds"); expect(failed).toContain("<h2>Start the closest catalog bug</h2>");
  });
  it("shows a host_unavailable validation refusal as the host's reason line, never an error", async () => {
    const delivered: OtfJobStatus = { job_id: "00000000-0000-4000-8000-000000000001", created_at: "2026-10-29T00:00:00Z", state: "finished", host_id: "umami", queue_position: null, builder: "running", outcome: "delivered", reason: null, criterion_id: "date_time.time-zone-grouping", spec, spec_sha256: await specSha256(spec), deadline_at: null, elapsed_ms: 0, lanes: [], events: [], next_after: 0, poll_after_ms: 30000, spend: { model_microusd: 0, cap_microusd: 8000000, source: "builder proxy meter (upper bound)" }, winner: null, artifacts: [], certificate: null, validation: null, catalog_request_id: null };
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} pending status={delivered} validationRefused nowMs={NOV_3} />);
    expect(html).toContain("Validation was not started. Umami is unavailable on UTC days 2–5. They open again on November 6 (UTC). Task-report builds and the catalog are still available.");
    expect(html).toContain("Validate stored bundles"); expect(html).not.toContain('role="alert"');
    expect(renderToStaticMarkup(<OtfWorkspaceView {...props} pending status={delivered} nowMs={NOV_3} />)).not.toContain("Validation was not started");
  });
  it("hides the spec card when the picked behavior's host is not offered", () => {
    const html = renderToStaticMarkup(<OtfWorkspaceView {...props} criterionId="date_time.time-zone-grouping" spec={spec} />);
    expect(html).not.toContain("Accept and build this custom bug");
    expect(renderToStaticMarkup(<OtfWorkspaceView {...props} spec={spec} />)).toContain("Accept and build this custom bug");
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
