import { renderToStaticMarkup as render } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BehaviorPickerView, SpecAcceptView, ruleProblem } from "../../src/components/otf/guided.tsx";
import { CertificateView } from "../../src/components/otf/certificate.tsx";
import { LaneBoard } from "../../src/components/otf/lane-board.tsx";
import { EXPECTED_CELLS, OTF_OPEN_CRITERION_ID, OTF_OPEN_LABEL, OTF_OPEN_TIME_COPY, OTF_RESERVED_FAILURE_CODES, PROVEN_FAILURE_CODES, type OtfAvailability, type OtfBehaviorOption, type OtfClassification, type OtfHostAvailability, type OtfJobStatus, type OtfOpenRule, type OtfSpecCard } from "../../src/otf/contract.ts";

const noop = () => undefined;
const hash = "0".repeat(64);
const rule: OtfOpenRule = { family: "data_handling", observable_failure: "A saved synthetic task loses its description after the next read.", failure_code: "synthetic_description_lost" };
const spec: OtfSpecCard = { title: "Synthetic task description", where: "Task routes", change: "Lose the description on save.", why_tests_miss: "Existing checks read only titles.", checks_to_add: ["Read the saved description."], fix: "Retain the description." };
const open: OtfBehaviorOption = { criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: OTF_OPEN_LABEL, example_phrases: [], measured: false };
const proven: OtfBehaviorOption = { criterion_id: "concurrency.lost-acknowledged-change", host_id: "task-report", label: "Synthetic proven behavior", example_phrases: [], measured: true };
const host: OtfHostAvailability = { host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 1, queued_jobs: 1, max_active: 2, lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], deadline_min: 45, typical: { source: "development_attempts", median_min: 15.5, p90_min: 30.9, samples: 89, measured_on: "2026-10-29" } };
const availability: OtfAvailability = { enabled: true, builder: "running", active_jobs: 1, queued_jobs: 1, max_queued: 4, behaviors: [proven, open], hosts: [host], cold_start_min: 4, spend_left_microusd: 1000000 };
const classification: OtfClassification = { family: rule.family, proven_criterion_id: null, buildable: [{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }], rule, refusal: null, model: "synthetic-classifier" };
const acceptProps = { spec, host, busy: false, signedIn: true, onChange: noop, onAccept: noop, behavior: open, rule, onRule: noop, classification };
const blocked = /disabled=""[^>]*>Accept and build this custom bug/;
function status(): OtfJobStatus {
  return { job_id: "00000000-0000-4000-8000-000000000001", created_at: "2026-10-29T00:00:00Z", state: "queued", host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID, rule, spec, spec_sha256: hash, queue_position: 2, builder: "running", outcome: null, reason: null, deadline_at: null, elapsed_ms: 0, lanes: [], events: [], next_after: 0, poll_after_ms: 2000, spend: { model_microusd: 0, cap_microusd: 8000000, source: "builder proxy meter (upper bound)" }, winner: null, artifacts: [], certificate: null, validation: null, catalog_request_id: null };
}

describe("open behavior views", () => {
  it("renders the offered open option under task-report using the availability label", () => {
    const design = vi.fn();
    const html = render(<BehaviorPickerView behaviors={[proven, { ...open, label: "Synthetic offered open behavior" }]} hosts={[host]} nowMs={0} criterionId={OTF_OPEN_CRITERION_ID} sentence="Synthetic description disappears" signedIn busy={false} onBehavior={noop} onSentence={noop} onDesign={design}/>);
    expect(html).toContain("task-report service"); expect(html).toContain("Synthetic offered open behavior");
    expect(html).toContain('checked=""'); expect(design).not.toHaveBeenCalled();
  });
  it("shows the open rule as editable fields and its exact unmeasured note", () => {
    const html = render(<SpecAcceptView {...acceptProps}/>);
    for (const field of ["family", "observable_failure", "failure_code"]) expect(html).toContain(`id="otf-rule-${field}"`);
    expect(html).toContain(rule.observable_failure); expect(html).toContain(rule.failure_code);
    expect(html).toContain("Open behaviors are not measured yet. The builder&#x27;s checks will look for exactly this failure.");
    expect(html).not.toMatch(blocked); expect(html.toLowerCase()).not.toContain("maxlength");
  });
  it("shows a proven match and a separate switch-back choice", () => {
    const match = { ...classification, family: "concurrency" as const, proven_criterion_id: proven.criterion_id as "concurrency.lost-acknowledged-change", buildable: [...classification.buildable, { host_id: "task-report" as const, criterion_id: proven.criterion_id }] };
    const html = render(<SpecAcceptView {...acceptProps} behavior={proven} classification={match} provenLabel={proven.label} openAvailable onOpen={noop}/>);
    expect(html).toContain(`This matches the proven behavior “${proven.label}”.`);
    expect(html).toContain("The picker now uses this proven behavior.");
    expect(html).toContain("Use the open behavior instead"); expect(html).not.toContain('id="otf-rule-family"');
  });
  it("does not still claim the proven pick after switching back to open", () => {
    const match = { ...classification, proven_criterion_id: "concurrency.lost-acknowledged-change" as const };
    const html = render(<SpecAcceptView {...acceptProps} classification={match} provenLabel={proven.label}/>);
    expect(html).not.toContain("The picker now uses this proven behavior."); expect(html).toContain('id="otf-rule-family"');
  });
  it("shows a classification refusal without enabling Accept", () => {
    const refused: OtfClassification = { family: null, proven_criterion_id: null, buildable: [], rule: null, refusal: { kind: "out_of_scope", reason: "Synthetic behavior is outside the supported host." }, model: "synthetic-classifier" };
    const html = render(<SpecAcceptView {...acceptProps} classification={refused}/>);
    expect(html).toContain(refused.refusal?.reason); expect(html).toMatch(blocked);
  });
  it("disables Accept until classification finishes", () => { expect(render(<SpecAcceptView {...acceptProps} classificationPending/>)).toMatch(blocked); });
  it("blocks Accept after classification fails without claiming it is still running", () => {
    const html = render(<SpecAcceptView {...acceptProps} classificationPending={false} acceptBlocked/>);
    expect(html).toMatch(blocked); expect(html).not.toContain("Classifying this spec card.");
  });
  it("permits Accept when the external block clears", () => {
    const html = render(<SpecAcceptView {...acceptProps} classificationPending={false} acceptBlocked={false}/>);
    expect(html).not.toMatch(blocked); expect(html).not.toContain("Classifying this spec card.");
  });
  it("requires an open rule before Accept", () => { expect(render(<SpecAcceptView {...acceptProps} rule={null}/>)).toMatch(blocked); });
  it("shows the exact unmeasured copy instead of the host's development timing", () => {
    const html = render(<SpecAcceptView {...acceptProps}/>);
    expect(html).toContain(OTF_OPEN_TIME_COPY); expect(html).not.toContain("15.5"); expect(html).not.toContain("30.9"); expect(html).not.toContain("In development runs");
  });
  it("retains the measured host copy for a proven selection", () => {
    const html = render(<SpecAcceptView {...acceptProps} behavior={proven} rule={null} classification={null}/>);
    expect(html).toContain("In development runs"); expect(html).toContain("15.5"); expect(html).not.toContain(OTF_OPEN_TIME_COPY);
  });
  it.each(["queued", "starting_builder", "building"] as const)("does not show estimated times for an open %s job", state => {
    const html = render(<LaneBoard status={{ ...status(), state }} availability={availability} onStop={noop} disabled={false}/>);
    expect(html).toContain(OTF_OPEN_TIME_COPY); expect(html).not.toContain("15.5"); expect(html).not.toContain("30.9"); expect(html).not.toContain("usually takes about");
    if (state === "starting_builder") expect(html).toContain("Starting the Nebius machine.");
  });
  it("keeps an open status unmeasured when availability is absent", () => {
    expect(render(<LaneBoard status={status()} availability={null} onStop={noop} disabled={false}/>)).toContain(OTF_OPEN_TIME_COPY);
  });
  it("shows the accepted rule beside the open certificate and keeps the qualification wording", () => {
    const s = status(); s.state = "finished"; s.outcome = "delivered";
    s.certificate = { format: "rbw-otf-certificate/0", job_id: s.job_id, host_id: "task-report", app_base_commit: "0".repeat(40), criterion: { criterion_id: OTF_OPEN_CRITERION_ID, version: "open-1", failure_code: rule.failure_code }, rule, spec_sha256: hash, designer: { model: "synthetic-designer", route: "bug-spec" }, implementer: { lane_id: "lane-1", agent: "goose 1.57.0", provider: "nebius-token-factory", model: "synthetic-model", rounds_used: 1 }, qualification: { cells: EXPECTED_CELLS, confirmation_cells: EXPECTED_CELLS, admission: null, result: "qualified" }, harness: { tier: "B", kit_image_id: "synthetic-image", copy_limits: "4 vCPU / 8192 MB", instances: { clean: 1, buggy: 3, fixed: 3 }, runner: "docker on the RBW builder (Nebius VM)", harness_sha256: hash }, bundles: { agent_sha256: hash, grader_sha256: hash }, spend: { model_microusd: 1000, tokens_in: 10, tokens_out: 10, lanes: 1 }, timings: { started_at: s.created_at, qualified_at: s.created_at, wall_ms: 1000 }, issued_at: s.created_at, builder_revision: "synthetic-revision", received: { at: s.created_at, sha256_verified: true } };
    const html = render(<CertificateView status={s} onValidate={noop} disabled={false}/>);
    for (const value of ["Open behavior (not measured yet)", rule.family, rule.observable_failure, rule.failure_code, "then confirmed in a second round."]) expect(html).toContain(value);
    expect(html).not.toContain("novel");
  });
});

describe("editable open-rule validation", () => {
  it.each([40, 600])("accepts %s Unicode code points rather than UTF-16 code units", count => { expect(ruleProblem({ ...rule, observable_failure: "🙂".repeat(count) })).toBeNull(); });
  it.each([39, 601])("blocks %s Unicode code points", count => {
    const invalid = { ...rule, observable_failure: "🙂".repeat(count) };
    expect(ruleProblem(invalid)).not.toBeNull(); expect(render(<SpecAcceptView {...acceptProps} rule={invalid}/>)).toMatch(blocked);
  });
  it.each(["\n", "\t", "\u0085", "\u2028", "\u2029", "\u202e", "\u200b", "\u200d", "\ufeff"])("rejects prohibited plain-text character %j", character => { expect(ruleProblem({ ...rule, observable_failure: rule.observable_failure + character })).not.toBeNull(); });
  it.each([...PROVEN_FAILURE_CODES, ...OTF_RESERVED_FAILURE_CODES, "ab", "123_code", "Synthetic_code", "has-hyphen", "a".repeat(49)])("rejects forbidden failure code %s", failure_code => { expect(ruleProblem({ ...rule, failure_code })).not.toBeNull(); });
  it("accepts a valid edited code and shows the code-point count", () => {
    const edited = { ...rule, failure_code: "another_synthetic_failure", observable_failure: "🙂".repeat(40) };
    expect(ruleProblem(edited)).toBeNull(); expect(render(<SpecAcceptView {...acceptProps} rule={edited}/>)).toContain("40 / 600 characters");
  });
});
