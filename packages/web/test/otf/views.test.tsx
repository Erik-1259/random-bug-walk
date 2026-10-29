import { renderToStaticMarkup as render } from "react-dom/server";
import { expect, it } from "vitest";
import { ADMISSION_EVIDENCE, EXPECTED_CELLS, type LaneView, type OtfAdmissionResult, type OtfJobStatus, type OtfCertificate, type OtfAvailability, type OtfHostAvailability } from "../../src/otf/contract.ts";
import { SixCellGrid } from "../../src/components/otf/six-cell-grid.tsx";
import { LaneCard } from "../../src/components/otf/lane-card.tsx";
import { LaneBoard } from "../../src/components/otf/lane-board.tsx";
import { CertificateView } from "../../src/components/otf/certificate.tsx";
import { FailureView } from "../../src/components/otf/failure.tsx";
import { CatalogOffer } from "../../src/components/otf/catalog-offer.tsx";
const noop = () => undefined;
const hash = "ab".repeat(32);
const lane: LaneView = { lane_id: "lane-4", model: "synthetic-model", model_label: "Synthetic model", stage: "confirming", iteration: 2, files: { change: true, checks: 3, fix: false }, meter: { tokens_in: 123, tokens_out: 45, requests: 2, cost_microusd: 1250000 }, rounds: [{ iteration: 2, kind: "qualification", result: "qualified", cells: EXPECTED_CELLS, admission: null, feedback: ["synthetic feedback"], goose_ms: 1000, qualify_ms: 2000 }, { iteration: 2, kind: "confirmation", result: "error", cells: null, admission: null, feedback: ["synthetic infrastructure error"], goose_ms: null, qualify_ms: null }], outcome: null };
function status(): OtfJobStatus { return { job_id: "00000000-0000-4000-8000-000000000001", created_at: "2026-10-29T00:00:00Z", state: "building", host_id: "task-report", queue_position: null, builder: "running", outcome: null, reason: null, criterion_id: "concurrency.lost-acknowledged-change", spec: { title: "Synthetic title", where: "Synthetic location", change: "Synthetic change", why_tests_miss: "Synthetic reason", checks_to_add: ["Synthetic check"], fix: "Synthetic fix" }, spec_sha256: hash, deadline_at: null, elapsed_ms: 120000, lanes: [lane], events: [], next_after: 0, poll_after_ms: 2000, spend: { model_microusd: 1250000, cap_microusd: 8000000, source: "builder proxy meter (upper bound)" }, winner: null, artifacts: [], certificate: null, validation: null, catalog_request_id: null }; }
function delivered(): OtfJobStatus {
 const s=status(); s.state="finished"; s.outcome="delivered";
 const certificate: OtfCertificate = { format:"rbw-otf-certificate/0",job_id:s.job_id,host_id:"task-report",app_base_commit:"ab".repeat(20),criterion:{criterion_id:s.criterion_id,version:"1",failure_code:"synthetic_failure"},spec_sha256:hash,designer:{model:"synthetic-designer",route:"bug-spec"},implementer:{lane_id:"lane-4",agent:"goose 1.57.0",provider:"nebius-token-factory",model:"synthetic-model",rounds_used:2},qualification:{cells:EXPECTED_CELLS,confirmation_cells:EXPECTED_CELLS,admission:null,result:"qualified"},harness:{tier:"B",kit_image_id:"synthetic-image",copy_limits:"4 vCPU / 8192 MB",instances:{clean:1,buggy:3,fixed:3},runner:"docker on the RBW builder (Nebius VM)",harness_sha256:hash},bundles:{agent_sha256:hash,grader_sha256:hash},spend:{model_microusd:1250000,tokens_in:123,tokens_out:45,lanes:4},timings:{started_at:s.created_at,qualified_at:s.created_at,wall_ms:120000},issued_at:s.created_at,builder_revision:"synthetic-revision",received:{at:s.created_at,sha256_verified:true}};
 s.certificate=certificate;s.artifacts=["agent","grader","certificate"].map(part=>({part:part as "agent"|"grader"|"certificate",filename:`synthetic-${part}.tar.gz`,media_type:"application/gzip",size:42,sha256:hash,download_path:`/api/factory/otf/jobs/${s.job_id}/artifacts/${part}`}));return s;
}
it("shows all six observations against expected values, including the expected buggy failure",()=>{const html=render(<SixCellGrid cells={EXPECTED_CELLS} label="Synthetic cells"/>);expect(html).toContain("Synthetic cells");expect(html.match(/expected fail/g)).toHaveLength(1);expect(html.match(/expected pass/g)).toHaveLength(5);});
it("does not invent results for a missing grid",()=>{const html=render(<SixCellGrid cells={null} label="Pending cells"/>);expect(html).toContain("Not run");expect(html).not.toContain("Observed: pass");});
it("shows each lane meter, written files and qualification versus confirmation feedback",()=>{const html=render(<LaneCard lane={lane}/>);for(const text of ["lane-4","Synthetic model","123","45","$1.25","3","qualification","confirmation","synthetic infrastructure error","synthetic feedback"]) expect(html).toContain(text);});
it.each(["queued","starting_builder"] as const)("does not claim generation for %s",state=>{const s=status();s.state=state;const html=render(<LaneBoard status={s} availability={null} onStop={noop} disabled={false}/>);expect(html).not.toContain("Built for your request");});
it("shows only measured cold-start estimates",()=>{const s=status();s.state="starting_builder";const a={cold_start_min:4,hosts:[]} as unknown as OtfAvailability;expect(render(<LaneBoard status={s} availability={a} onStop={noop} disabled={false}/>)).toContain("about 4 minutes");a.cold_start_min=null;expect(render(<LaneBoard status={s} availability={a} onStop={noop} disabled={false}/>)).not.toContain("usually takes");});
it("renders dynamic lanes and a disabled stop",()=>{const html=render(<LaneBoard status={status()} availability={null} onStop={noop} disabled/>);expect(html).toContain("lane-4");expect(html).toContain("disabled");expect(html).toContain("metered by the builder; an upper bound");});
it.each(["error","builder_start_failed","builder_lost","builder_unavailable"] as const)("labels %s as infrastructure error",outcome=>{const s=status();s.state="finished";s.outcome=outcome;const html=render(<FailureView status={s}/>);expect(html).toContain("Error");expect(html).not.toContain("No lane produced");});
it.each(["not_qualified","time_limit","spend_limit","cancelled"] as const)("explains %s without claiming delivery",outcome=>{const s=status();s.state="finished";s.outcome=outcome;expect(render(<FailureView status={s}/>)).not.toBe("");});
it("does not show failure for delivered or active jobs",()=>{expect(render(<FailureView status={status()}/>)).toBe("");expect(render(<FailureView status={delivered()}/>)).toBe("");});
it("hides artifacts until delivered even when metadata is present",()=>{const s=delivered();s.outcome=null;s.state="building";expect(render(<CertificateView status={s} onValidate={noop} disabled={false}/>)).toBe("");});
it("shows both certificate rounds, binding hashes, models and distinct downloads",()=>{const html=render(<CertificateView status={delivered()} onValidate={noop} disabled={false}/>);for(const text of ["Qualification","Confirmation",hash,"synthetic-designer","synthetic-model","Model-written","Agent bundle","Grader bundle","Certificate","120"])expect(html).toContain(text);expect(html.match(/download=/g)).toHaveLength(3);expect(html).not.toContain("Vercel Sandbox");});
it.each(["queued","running","failed","error","passed"] as const)("keeps validation %s explicit",state=>{const s=delivered();s.validation={validation_id:"00000000-0000-4000-8000-000000000002",state,cells:null,admission:null,started_at:s.created_at,finished_at:null,where:"RBW builder (Nebius VM)"};const html=render(<CertificateView status={s} onValidate={noop} disabled={false}/>);expect(html).toContain(`Validation: ${state}`);if(state!=="passed")expect(html).not.toContain("Validation: passed");if(state==="queued"||state==="running")expect(html).toContain("disabled");});
it("keeps catalog spend opt-in and readiness explicit",()=>{const props={onStart:noop,disabled:false,requestId:null,ready:false,message:null};const initial=render(<CatalogOffer {...props}/>);expect(initial).toContain("about $0.40");expect(initial).toContain("Start the closest catalog bug");expect(initial).not.toContain("Your catalog bug is ready");expect(render(<CatalogOffer {...props} requestId="synthetic-request"/>)).not.toContain("Your catalog bug is ready");expect(render(<CatalogOffer {...props} requestId="synthetic-request" ready/>)).toContain("Your catalog bug is ready");});

const NOV_3 = Date.UTC(2026, 10, 3, 12);
const passed: OtfAdmissionResult = { decisions: { adm_02: "pass", adm_03: "pass", adm_04: "pass", adm_05: "pass", adm_06: "pass" }, comparison: "blind_spot_demonstrated", alternative_fix: "pass" };
function host(change: Partial<OtfHostAvailability> = {}): OtfHostAvailability { return { host_id: "umami", label: "Umami", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 1, lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }, { lane_id: "lane-2", model_label: "Synthetic model" }], deadline_min: 60, typical: null, ...change }; }
function availability(umami: OtfHostAvailability): OtfAvailability { return { enabled: true, builder: "running", active_jobs: 0, queued_jobs: 0, max_queued: 4, behaviors: [], hosts: [{ ...umami, host_id: "task-report", label: "task-report service", lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }, { lane_id: "lane-2", model_label: "Synthetic model" }, { lane_id: "lane-3", model_label: "Synthetic model" }], max_active: 2, active_jobs: 0 }, umami], cold_start_min: null, spend_left_microusd: 1000000 }; }
function umamiStatus(): OtfJobStatus { const s = status(); s.host_id = "umami"; s.criterion_id = "date_time.time-zone-grouping"; s.lanes = []; return s; }
function umamiDelivered(): OtfJobStatus {
  const s = delivered(); const base = s.certificate; if (base?.host_id !== "task-report") throw new Error("Synthetic certificate missing");
  s.host_id = "umami"; s.criterion_id = "date_time.time-zone-grouping";
  s.certificate = { ...base, host_id: "umami", criterion: { ...base.criterion, criterion_id: "date_time.time-zone-grouping" }, qualification: { cells: EXPECTED_CELLS, confirmation_cells: null, admission: { decisions: { adm_02: "pass", adm_03: "pass", adm_04: "pass", adm_05: "pass", adm_06: "pass" }, comparison: "blind_spot_demonstrated", alternative_fix: "pass" }, result: "qualified" },
    harness: { tier: "admission", kit_sha256: hash, kit_image_id: "synthetic-umami-image", added_suite_sha256: hash, runtime_image_digest: `sha256:${hash}`, original_suite: { test_count: 10, sha256: hash }, copy_limits: "4 vCPU / 8192 MB", copies: { kit_check_clean: 5, observe_planted: 1, clean: 1, planted: 5, fixed: 5, partial: 1, stub: 1 }, repetitions: 20, evidence: ADMISSION_EVIDENCE, runner: "docker on the RBW builder (Nebius VM)", harness_sha256: hash } };
  return s;
}
const STRIP = ["Every copy ran every test", "Fixed copies pass the added checks", "Buggy copies fail as declared", "Repeated runs agree", "Partial and stub fixes are caught", "The original suite misses the bug", "A second, independent fix also passes"];

it("adds SPEC 1.1's admission strip to an Umami round and shows not_run as not run", () => {
  const umamiLane: LaneView = { ...lane, rounds: [{ iteration: 1, kind: "qualification", result: "not_qualified", cells: EXPECTED_CELLS, admission: { ...passed, decisions: { ...passed.decisions, adm_05: "not_run", adm_06: "reject" }, alternative_fix: "not_run" }, feedback: [], goose_ms: 1000, qualify_ms: 2000 }] };
  const html = render(<LaneCard lane={umamiLane}/>);
  for (const label of STRIP) expect(html).toContain(label);
  expect(html).toContain("Repeated runs agree: not run"); expect(html).toContain("Partial and stub fixes are caught: reject");
  expect(html).toContain("The original suite misses the bug: passed"); expect(html).toContain("A second, independent fix also passes: not run");
  expect(html.match(/expected/g)).toHaveLength(6);
  expect(render(<LaneCard lane={lane}/>)).not.toContain("Every copy ran every test");
});
it("counts lanes per host and adds the Umami placement note to the board", () => {
  const umamiBoard = render(<LaneBoard status={umamiStatus()} availability={availability(host())} onStop={noop} disabled={false}/>);
  expect(umamiBoard).toContain("Lanes for Umami: 2."); expect(umamiBoard).toContain("date-grouped reports");
  const taskBoard = render(<LaneBoard status={{ ...status(), lanes: [] }} availability={availability(host())} onStop={noop} disabled={false}/>);
  expect(taskBoard).toContain("Lanes for task-report service: 3."); expect(taskBoard).not.toContain("date-grouped");
});
it("words the queue from the job's own host", () => {
  const s = umamiStatus(); s.state = "queued"; s.queue_position = 2;
  const busy = render(<LaneBoard status={s} availability={availability(host({ active_jobs: 1, typical: { source: "otf_jobs", median_min: 9, p90_min: 21, samples: 6, measured_on: "2026-10-28" } }))} onStop={noop} disabled={false}/>);
  expect(busy).toContain("Another build is running. Yours is number 2 in line. Usually about 9 minutes;");
  const idle = render(<LaneBoard status={s} availability={availability(host())} onStop={noop} disabled={false}/>);
  expect(idle).not.toContain("Another build is running");
});
it("says a stop after a win still delivered the bug", () => {
  expect(render(<LaneBoard status={delivered()} availability={null} onStop={noop} disabled={false} stopRequested/>)).toContain("Stopped after a lane won; the bug was delivered.");
  expect(render(<LaneBoard status={delivered()} availability={null} onStop={noop} disabled={false}/>)).not.toContain("Stopped after a lane won");
});
it("keeps the polling board's Stop button enabled when only a poll is running", () => {
  expect(render(<LaneBoard status={status()} availability={null} onStop={noop} disabled={false}/>)).toMatch(/<button type="button">Stop custom build/);
});
it("shows an Umami certificate with its admission strip and evidence and without a confirmation row", () => {
  const html = render(<CertificateView status={umamiDelivered()} onValidate={noop} disabled={false}/>);
  for (const label of STRIP) expect(html).toContain(`${label}: passed`);
  expect(html).toContain(ADMISSION_EVIDENCE.replaceAll("'", "&#x27;")); expect(html).toContain("Development evidence, not an RBW release.");
  expect(html).toContain("Qualification cells"); expect(html).not.toContain("Confirmation cells");
  expect(html).toContain("re-runs the admission sequence on the RBW builder from the stored bundles");
  for (const word of ["admitted", "released", "on Vercel Sandbox", "confirmed in a second round"]) expect(html).not.toContain(word);
});
it("shows an Umami validation's admission result", () => {
  const s = umamiDelivered(); s.validation = { validation_id: "00000000-0000-4000-8000-000000000002", state: "passed", cells: EXPECTED_CELLS, admission: passed, started_at: s.created_at, finished_at: s.created_at, where: "RBW builder (Nebius VM)" };
  expect(render(<CertificateView status={s} onValidate={noop} disabled={false}/>)).toContain("Validation admission result");
});
it("keeps the task-report certificate's copy and both rounds", () => {
  const html = render(<CertificateView status={delivered()} onValidate={noop} disabled={false}/>);
  expect(html).toContain("then confirmed in a second round"); expect(html).toContain("Optional validation re-runs the six cells on the RBW builder.");
  expect(html).not.toContain("Every copy ran every test");
});
it("words a waiting Umami job stopped by the calendar as not started, with the open-again date", () => {
  const s = umamiStatus(); s.state = "finished"; s.outcome = "builder_unavailable"; s.reason = "Umami is unavailable on UTC days 2–5.";
  const html = render(<FailureView status={s} availability={availability(host({ offered: false, unavailable_reason: "calendar" }))} nowMs={NOV_3}/>);
  expect(html).toContain("This custom build did not start: Umami is unavailable on UTC days 2–5.");
  expect(html).toContain("They open again on November 6 (UTC).");
  expect(html).not.toContain("Error"); expect(html).not.toContain("lane board shows");
});
it("keeps the error copy for other builder_unavailable reasons and for a claimed job", () => {
  const s = umamiStatus(); s.state = "finished"; s.outcome = "builder_unavailable"; s.reason = "OTF was put on hold.";
  expect(render(<FailureView status={s} nowMs={NOV_3}/>)).toContain("Error: the builder became unavailable.");
  s.reason = "Umami is unavailable on UTC days 2–5."; s.deadline_at = "2026-11-02T01:00:00Z";
  expect(render(<FailureView status={s} nowMs={NOV_3}/>)).toContain("Error: the builder became unavailable.");
});
it("words not qualified by host", () => {
  const s = umamiStatus(); s.state = "finished"; s.outcome = "not_qualified";
  expect(render(<FailureView status={s}/>)).toContain("No lane produced a bug that passed the admission sequence in 3 rounds.");
  const t = status(); t.state = "finished"; t.outcome = "not_qualified";
  expect(render(<FailureView status={t}/>)).toContain("No lane produced a bug that passed all six cells in 3 rounds.");
});
it("says While this builds only while a custom job is pending, and names the fallback after a failure", () => {
  const props = { onStart: noop, disabled: false, requestId: null, ready: false, message: null };
  expect(render(<CatalogOffer {...props} building/>)).toContain("While this builds, start the closest pre-qualified catalog bug now");
  const idle = render(<CatalogOffer {...props}/>);
  expect(idle).not.toContain("While this builds"); expect(idle).toContain("start the closest pre-qualified catalog bug now (about 5 min, about $0.40 from the shared judge budget).");
  expect(render(<CatalogOffer {...props} fallback/>)).toContain("<h2>Start the closest catalog bug</h2>");
  expect(render(<CatalogOffer {...props} fallback ready/>)).toContain("<h2>Your catalog bug is ready</h2>");
});
