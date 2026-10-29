import { describe, expect, it, vi } from "vitest";
import type { AssistClient, BugSpec } from "../../src/assist/client.ts";
import { OtfClientError, OtfController, type OtfClient } from "../../src/otf/client.ts";
import { ruleSha256 } from "../../src/otf/canonical.ts";
import { OtfDraftController, designerSentence } from "../../src/components/otf/draft.ts";
import { OTF_OPEN_CRITERION_ID, type OtfAvailability, type OtfClassification, type OtfOpenRule, type OtfJobStatus } from "../../src/otf/contract.ts";

const proven = "concurrency.lost-acknowledged-change";
const spec: BugSpec = { title: "Synthetic task update", target_app: "task-report", where: "Task update route", change: "A saved synthetic change disappears.", why_tests_miss: "Tests save only one change.", checks_to_add: ["Read the saved change again."], fix: "Keep the stored change." };
const rule: OtfOpenRule = { family: "data_handling", observable_failure: "A saved synthetic task returns the previous value after an update.", failure_code: "synthetic_saved_value_lost" };
const availability: OtfAvailability = { enabled: true, builder: "stopped", active_jobs: 0, queued_jobs: 0, max_queued: 4, cold_start_min: null, spend_left_microusd: 1000000,
  hosts: [{ host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [], deadline_min: 45, typical: null }, { host_id: "umami", label: "Umami", offered: false, unavailable_reason: "calendar", active_jobs: 0, queued_jobs: 0, max_active: 1, lanes: [], deadline_min: 60, typical: null }],
  behaviors: [{ criterion_id: proven, host_id: "task-report", label: "Synthetic proven match", measured: true, example_phrases: [] }, { criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: "Synthetic open behavior", measured: false, example_phrases: [] }] };
const open: OtfClassification = { family: "data_handling", proven_criterion_id: null, buildable: [{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }], rule, refusal: null, model: "synthetic-classifier" };
const match: OtfClassification = { ...open, family: "concurrency", proven_criterion_id: proven, buildable: [{ host_id: "task-report", criterion_id: proven }], rule: null };
function setup(result: OtfClassification = open) {
  const designer: Pick<AssistClient, "bugSpec"> = { bugSpec: vi.fn(() => Promise.resolve({ ok: true as const, value: { spec, model: { provider: "nebius-token-factory" as const, model_id: "synthetic-designer", at: "2026-10-29T00:00:00Z" } } })) };
  const classify = vi.fn<OtfClient["classify"]>(() => Promise.resolve(structuredClone(result)));
  const signedOut = vi.fn();
  const draft = new OtfDraftController(designer, { classify }, signedOut);
  draft.pick(OTF_OPEN_CRITERION_ID); draft.setSentence("Synthetic task updates lose a saved value.");
  return { draft, designer, classify, signedOut };
}

describe("open custom draft before Accept", () => {
  it("designs then classifies without creating a job", async () => {
    const { draft, designer, classify } = setup();
    expect(draft.acceptedInput(availability, true)).toBeNull();
    await draft.design(availability, true);
    expect(designer.bugSpec).toHaveBeenCalledOnce();
    expect(classify).toHaveBeenCalledWith({ sentence: "Synthetic task updates lose a saved value.", host_id: "task-report", spec: draft.snapshot().spec });
    expect(classify.mock.calls[0]?.[0]).not.toHaveProperty("spec.target_app");
    expect(draft.snapshot()).toMatchObject({ criterionId: OTF_OPEN_CRITERION_ID, rule, classification: open, busy: false });
    expect(draft.acceptedInput(availability, true)).toMatchObject({ criterion_id: OTF_OPEN_CRITERION_ID, rule });
  });
  it("creates only after explicit acceptance and hashes the edited handed-off rule", async () => {
    const { draft } = setup();
    const create = vi.fn<OtfClient["create"]>(body => {
      const status: OtfJobStatus = { job_id: "00000000-0000-4000-8000-000000000001", created_at: "2026-10-29T00:00:00Z", state: "queued", host_id: body.host_id, queue_position: 1, builder: "stopped", outcome: null, reason: null,
        criterion_id: body.criterion_id, spec: body.spec, spec_sha256: body.spec_sha256, rule: body.rule, deadline_at: null, elapsed_ms: 0, lanes: [], events: [], next_after: 0, poll_after_ms: 2000,
        spend: { model_microusd: 0, cap_microusd: 8000000, source: "builder proxy meter (upper bound)" }, winner: null, artifacts: [], certificate: null, validation: null, catalog_request_id: null };
      return Promise.resolve({ job_id: status.job_id, status });
    });
    const api: OtfClient = { availability: () => Promise.resolve(availability), classify: () => Promise.resolve(open), create, status: vi.fn(), stop: vi.fn(), validate: vi.fn() };
    const saved = new Map<string, string>();
    const jobs = new OtfController(api, { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: key => { saved.delete(key); } }, () => "00000000-0000-4000-8000-000000000002", operation => operation());
    await jobs.initialize();
    await draft.handoff({ spec, query: "Synthetic task update", hostId: "task-report" }, availability, true);
    const edited = { ...rule, failure_code: "synthetic_edited_rule" }; draft.setRule(edited);
    expect(create).not.toHaveBeenCalled(); expect(saved.size).toBe(0);
    const input = draft.acceptedInput(availability, true);
    expect(input).not.toBeNull(); if (input === null) throw new Error("Synthetic draft unexpectedly refused");
    await jobs.create(input);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ rule: edited, rule_sha256: await ruleSha256(edited) });
    expect(jobs.snapshot().jobId).toBe("00000000-0000-4000-8000-000000000001");
  });
  it("switches to a proven match and lets the customer switch back to an editable open rule", async () => {
    const { draft } = setup(match); await draft.design(availability, true);
    expect(draft.snapshot().criterionId).toBe(proven);
    expect(draft.acceptedInput(availability, true)).not.toHaveProperty("rule");
    draft.pick(OTF_OPEN_CRITERION_ID);
    expect(draft.snapshot().spec?.title).toBe(spec.title);
    expect(draft.acceptedInput(availability, true)).toBeNull();
    draft.setRule(rule);
    expect(draft.acceptedInput(availability, true)?.rule).toEqual(rule);
  });
  it("keeps a classifier refusal visible and cannot accept it as a build", async () => {
    const refusal: OtfClassification = { ...open, family: null, rule: null, buildable: [], refusal: { kind: "out_of_scope", reason: "Synthetic behavior is outside this application." } };
    const { draft } = setup(refusal); await draft.design(availability, true);
    expect(draft.snapshot().classification?.refusal?.reason).toBe(refusal.refusal?.reason);
    expect(draft.snapshot().spec?.title).toBe(spec.title);
    draft.pick(OTF_OPEN_CRITERION_ID);
    expect(draft.acceptedInput(availability, true)).toBeNull();
  });
  it("hands off a designer card and query through classify without rewriting the card", async () => {
    const { draft, designer, classify } = setup();
    await draft.handoff({ spec, query: "  Synthetic query  ", hostId: "task-report" }, availability, true);
    expect(designer.bugSpec).not.toHaveBeenCalled();
    expect(classify).toHaveBeenCalledWith({ host_id: "task-report", sentence: "Synthetic query", spec: draft.snapshot().spec });
    expect(draft.acceptedInput(availability, true)?.sentence).toBe("Synthetic query");
  });
  it("trims a handoff sentence in code points and falls back to the title", () => {
    expect(designerSentence("  " + "😀".repeat(301) + "  ", spec.title)).toBe("😀".repeat(300));
    expect(designerSentence("   ", spec.title)).toBe(spec.title);
  });
  it("blocks Accept until classification completes", async () => {
    const { draft, classify } = setup(); let resolve!: (value: OtfClassification) => void;
    classify.mockImplementation(() => new Promise(done => { resolve = done; }));
    const work = draft.handoff({ spec, query: "Synthetic query", hostId: "task-report" }, availability, true);
    expect(draft.snapshot().busy).toBe(true); expect(draft.acceptedInput(availability, true)).toBeNull();
    resolve(open); await work;
    expect(draft.acceptedInput(availability, true)?.criterion_id).toBe(OTF_OPEN_CRITERION_ID);
  });
  it("blocks a failed classification and restores the shared sign-in flow", async () => {
    const { draft, classify, signedOut } = setup();
    classify.mockRejectedValue(new OtfClientError("signed_out", "Sign in again.", 401));
    await draft.design(availability, true);
    expect(signedOut).toHaveBeenCalledOnce(); expect(draft.snapshot().message).toContain("signed_out");
    expect(draft.acceptedInput(availability, true)).toBeNull();
  });
  it("does not call either model while signed out or availability is disabled", async () => {
    const { draft, designer, classify } = setup();
    await draft.design(availability, false);
    await draft.handoff({ spec, query: "Synthetic query", hostId: "task-report" }, { ...availability, enabled: false }, true);
    expect(designer.bugSpec).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled();
  });
  it("refuses the new handoff while only proven behaviors are offered", async () => {
    const { draft, designer, classify } = setup();
    const provenOnly = { ...availability, behaviors: availability.behaviors.slice(0, 1) };
    await draft.handoff({ spec, query: "Synthetic handoff", hostId: "task-report" }, provenOnly, true);
    expect(classify).not.toHaveBeenCalled(); expect(designer.bugSpec).not.toHaveBeenCalled();
    expect(draft.snapshot().spec).toBeNull();
  });
  it("preserves the old proven flow while open behaviors are not offered", async () => {
    const { draft, classify } = setup(); const provenOnly = { ...availability, behaviors: availability.behaviors.slice(0, 1) };
    draft.pick(proven); await draft.design(provenOnly, true);
    expect(classify).not.toHaveBeenCalled(); expect(draft.acceptedInput(provenOnly, true)?.criterion_id).toBe(proven);
  });
  it("rechecks current host availability and sign-in on Accept", async () => {
    const { draft } = setup(); await draft.design(availability, true);
    expect(draft.acceptedInput(availability, false)).toBeNull();
    expect(draft.acceptedInput({ ...availability, hosts: [] }, true)).toBeNull();
    expect(draft.acceptedInput({ ...availability, behaviors: availability.behaviors.slice(0, 1) }, true)).toBeNull();
  });
  it("uses current edited rule bytes and refuses a reserved code", async () => {
    const { draft } = setup(); await draft.design(availability, true);
    draft.setRule({ ...rule, failure_code: "control_failed" }); expect(draft.acceptedInput(availability, true)).toBeNull();
    const edited = { ...rule, observable_failure: "An edited synthetic task loses its saved value after a second update." };
    draft.setRule(edited); expect(draft.acceptedInput(availability, true)?.rule).toEqual(edited);
  });
  it("does not choose a classifier match unavailable on the current host", async () => {
    const { draft } = setup({ ...match, proven_criterion_id: "date_time.time-zone-grouping", buildable: [{ host_id: "umami", criterion_id: "date_time.time-zone-grouping" }] });
    await draft.design(availability, true);
    expect(draft.snapshot().criterionId).toBeNull(); expect(draft.snapshot().message).toContain("not offered");
    expect(draft.acceptedInput(availability, true)).toBeNull();
  });
  it("clears stale classification when the sentence changes", async () => {
    const { draft } = setup(); await draft.design(availability, true);
    draft.setSentence("A different synthetic sentence.");
    expect(draft.snapshot().classification).toBeNull(); expect(draft.snapshot().spec).toBeNull(); expect(draft.acceptedInput(availability, true)).toBeNull();
  });
});
