import { describe, expect, it, vi } from "vitest";
import type { AssistClient, BugSpec } from "../../src/assist/client.ts";
import { SHAPE_TITLE_MAX_CHARS } from "../../src/assist/limits.ts";
import { designSecurityTopic, securityTopic } from "../../src/assist/safety.ts";
import { OtfClientError, OtfController, type OtfClient } from "../../src/otf/client.ts";
import { ruleSha256 } from "../../src/otf/canonical.ts";
import { CLASSIFY_REVIEW_MESSAGE, OtfDraftController, SECURITY_TOPIC_REASON, designerSentence } from "../../src/components/otf/draft.ts";
import { specFromDesigner } from "../../src/components/otf/guided.tsx";
import { customBuildHandoff, startHandoff } from "../../src/components/otf/workspace.tsx";
import { OTF_ERROR_STATUS, OTF_OPEN_CRITERION_ID, OTF_OPEN_LABEL, type OtfAvailability, type OtfClassification, type OtfCriterionId, type OtfOpenRule, type OtfJobStatus } from "../../src/otf/contract.ts";

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

function specFromDraft(draft: OtfDraftController) {
  const card = draft.snapshot().spec; if (card === null) throw new Error("Synthetic draft has no card.");
  return card;
}

/** A job controller whose first create is refused busy; later creates are recorded only. */
async function refusingJobs() {
  const create = vi.fn<OtfClient["create"]>(() => Promise.reject(new OtfClientError("busy", "Synthetic refusal.", OTF_ERROR_STATUS.busy)));
  const api: OtfClient = { availability: () => Promise.resolve(availability), classify: () => Promise.resolve(open), create, status: vi.fn(), stop: vi.fn(), validate: vi.fn() };
  const saved = new Map<string, string>(); let key = 0;
  const jobs = new OtfController(api, { getItem: name => saved.get(name) ?? null, setItem: (name, value) => { saved.set(name, value); }, removeItem: name => { saved.delete(name); } },
    () => `00000000-0000-4000-8000-00000000001${String(key++)}`, operation => operation());
  await jobs.initialize();
  return { jobs, create };
}

/** Accept, a busy refusal, then "Edit custom design", as the workspace runs them. */
async function refuseThenEdit(draft: OtfDraftController, jobs: OtfController) {
  const input = draft.acceptedInput(availability, true); if (input === null) throw new Error("Synthetic draft unexpectedly refused");
  await jobs.create(input);
  const refused = jobs.snapshot().pendingRequest; expect(jobs.snapshot()).toMatchObject({ refusal: "busy", canNewDraft: true });
  await jobs.newDraft(); expect(jobs.snapshot().pendingRequest).toBeNull();
  draft.restore(refused, jobs.snapshot().availability);
}

describe("the shape the picker sends to the designer", () => {
  const labeled: OtfAvailability = { ...availability, behaviors: availability.behaviors.map(option => option.criterion_id === OTF_OPEN_CRITERION_ID ? { ...option, label: OTF_OPEN_LABEL } : option) };
  async function sent(criterionId: OtfCriterionId, sentence: string) {
    const { draft, designer } = setup();
    draft.pick(criterionId); draft.setSentence(sentence);
    await draft.design(labeled, true);
    expect(designer.bugSpec).toHaveBeenCalledOnce();
    return vi.mocked(designer.bugSpec).mock.calls[0];
  }
  it("keeps the open behavior's label out of the request so the designer's input check passes", async () => {
    // The label names "non-security", which the designer's input check reads as a security topic.
    expect(securityTopic(OTF_OPEN_LABEL)).toBe(true);
    const call = await sent(OTF_OPEN_CRITERION_ID, "  Synthetic task updates lose a saved value.  ");
    expect(call).toEqual([{ title: "Synthetic task updates lose a saved value.", summary: "Synthetic task updates lose a saved value.", sources: [] }, "task-report"]);
    const shape = call?.[0]; if (shape === undefined) throw new Error("Synthetic designer call is missing.");
    expect(securityTopic(`${shape.title} ${shape.summary}`)).toBe(false);
    expect(designSecurityTopic(`${shape.title} ${shape.summary}`)).toBe(false);
  });
  it("trims a long sentence to the shape title limit", async () => {
    const sentence = `Synthetic task updates lose a saved value ${"after a retry ".repeat(15)}`.trim();
    const shape = (await sent(OTF_OPEN_CRITERION_ID, sentence))?.[0];
    expect(shape?.summary).toBe(sentence);
    expect(Array.from(shape?.title ?? "").length).toBeLessThanOrEqual(SHAPE_TITLE_MAX_CHARS);
    expect(sentence.startsWith(shape?.title ?? "missing")).toBe(true);
  });
  it("sends a proven option's label as the title, as before", async () => {
    expect(await sent(proven, "Synthetic task updates lose a saved value.")).toEqual([{ title: "Synthetic proven match", summary: "Synthetic task updates lose a saved value.", sources: [] }, "task-report"]);
  });
});

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
    expect(signedOut).toHaveBeenCalledOnce();
    expect(draft.snapshot().classifyError).toBe("Your judge sign-in has ended. Sign in again, then try again. No custom build has started.");
    expect(draft.snapshot().spec?.title).toBe(spec.title);
    expect(draft.acceptedInput(availability, true)).toBeNull();
  });
  it.each([
    ["network", new Error("Synthetic network failure."), "The classifier did not answer. No custom build has started. Try again in a moment."],
    ["timeout", new OtfClientError("unavailable", "The custom build service did not return a usable response. Saved job identity is retained.", 0, true), "The classifier did not answer. No custom build has started. Try again in a moment."],
    ["503 unavailable", new OtfClientError("unavailable", "Classification is unavailable right now.", 503, true), "The classifier did not answer. No custom build has started. Try again in a moment."],
    ["400 invalid_request", new OtfClientError("invalid_request", "Synthetic invalid request.", 400), "The classifier could not read this card and sentence. Review them, then try again. No custom build has started."],
    ["401 signed_out", new OtfClientError("signed_out", "Synthetic sign-in ended.", 401), "Your judge sign-in has ended. Sign in again, then try again. No custom build has started."],
  ])("explains a %s classify failure in plain language and tries the same card again", async (_kind, error, text) => {
    const { draft, classify } = setup();
    classify.mockRejectedValueOnce(error);
    await draft.handoff({ spec, query: "Synthetic handoff", hostId: "task-report" }, availability, true);
    const failed = draft.snapshot();
    expect(failed.classifyError).toBe(text); expect(failed.message).toBeNull();
    for (const raw of ["unavailable", "invalid_request", "signed_out", "Saved job identity is retained"]) expect(failed.classifyError).not.toContain(raw);
    expect(draft.acceptedInput(availability, true)).toBeNull();
    await draft.reclassify(availability, true);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0]).toEqual(classify.mock.calls[0]?.[0]);
    expect(draft.snapshot()).toMatchObject({ classifyError: null, classification: open, criterionId: OTF_OPEN_CRITERION_ID });
    expect(draft.acceptedInput(availability, true)?.rule).toEqual(rule);
  });
  it("shows a 422 refused_topic answer as a security refusal, like a model's security refusal", async () => {
    const { draft, classify } = setup();
    classify.mockRejectedValueOnce(new OtfClientError("refused_topic", "This request is outside the supported design topics.", 422));
    await draft.handoff({ spec, query: "Synthetic handoff", hostId: "task-report" }, availability, true);
    expect(draft.snapshot().classification?.refusal).toEqual({ kind: "security", reason: SECURITY_TOPIC_REASON });
    expect(draft.snapshot()).toMatchObject({ classifyError: null, message: null });
    expect(draft.acceptedInput(availability, true)).toBeNull();
  });
  it.each(["card", "sentence"] as const)("clears the classification and rule after a %s edit and classifies the edited card again", async edit => {
    const { draft, classify } = setup(); await draft.design(availability, true);
    expect(draft.acceptedInput(availability, true)).not.toBeNull();
    const changed = "A synthetic task loses a saved change after two updates.";
    if (edit === "card") draft.setSpec({ ...specFromDraft(draft), change: changed });
    else draft.setSentence("Synthetic edited sentence about saved values.");
    expect(draft.snapshot()).toMatchObject({ classification: null, rule: null, stale: true });
    expect(draft.snapshot().spec?.title).toBe(spec.title);
    expect(draft.acceptedInput(availability, true)).toBeNull();
    await draft.reclassify(availability, true);
    expect(classify).toHaveBeenCalledTimes(2);
    if (edit === "card") expect(classify.mock.calls[1]?.[0].spec.change).toBe(changed);
    else expect(classify.mock.calls[1]?.[0].sentence).toBe("Synthetic edited sentence about saved values.");
    expect(draft.snapshot().stale).toBe(false); expect(draft.acceptedInput(availability, true)).not.toBeNull();
  });
  it("recovers from a refusal by editing the card and classifying again", async () => {
    const refusal: OtfClassification = { ...open, family: null, rule: null, buildable: [], refusal: { kind: "out_of_scope", reason: "Synthetic behavior is outside this application." } };
    const { draft, classify } = setup(refusal); await draft.design(availability, true);
    draft.setSpec({ ...specFromDraft(draft), where: "Synthetic report route" });
    expect(draft.snapshot()).toMatchObject({ classification: null, stale: true });
    classify.mockResolvedValueOnce(open); await draft.reclassify(availability, true);
    expect(draft.acceptedInput(availability, true)?.criterion_id).toBe(OTF_OPEN_CRITERION_ID);
  });
  it("keeps the card, classification and rule edits when switching between the open option and the proven match", async () => {
    const { draft } = setup({ ...match, buildable: [...match.buildable, { host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }], rule });
    await draft.design(availability, true);
    expect(draft.snapshot().criterionId).toBe(proven);
    draft.pick(OTF_OPEN_CRITERION_ID);
    const edited = { ...rule, failure_code: "synthetic_switch_rule" }; draft.setRule(edited);
    draft.pick(proven);
    expect(draft.snapshot()).toMatchObject({ criterionId: proven, classification: { proven_criterion_id: proven } });
    expect(draft.snapshot().spec?.title).toBe(spec.title);
    expect(draft.acceptedInput(availability, true)).not.toHaveProperty("rule");
    draft.pick(OTF_OPEN_CRITERION_ID);
    expect(draft.snapshot().rule).toEqual(edited); expect(draft.acceptedInput(availability, true)?.rule).toEqual(edited);
  });
  it("keeps the handed-off card when a behavior is picked after a failed classification", async () => {
    const { draft, classify } = setup();
    classify.mockRejectedValueOnce(new Error("Synthetic network failure."));
    await draft.handoff({ spec, query: "Synthetic handoff", hostId: "task-report" }, availability, true);
    draft.pick(proven);
    expect(draft.snapshot().spec?.title).toBe(spec.title); expect(draft.snapshot().criterionId).toBe(proven);
  });
  it("asks for a review instead of classifying an invalid handed-off card, and offers the retry", async () => {
    const { draft, classify } = setup();
    await draft.handoff({ spec: { ...spec, fix: " " }, query: "Synthetic handoff", hostId: "task-report" }, availability, true);
    expect(classify).not.toHaveBeenCalled(); expect(draft.snapshot().classifyError).toBe(CLASSIFY_REVIEW_MESSAGE);
  });
  it("reveals the custom panel as soon as a handoff starts, while classify is still running", async () => {
    const { draft, classify } = setup(); let resolve!: (value: OtfClassification) => void;
    classify.mockImplementation(() => new Promise(done => { resolve = done; }));
    const reveal = vi.fn();
    const work = startHandoff(draft, { spec, query: "Synthetic handoff", hostId: "task-report" }, availability, true, reveal);
    expect(reveal).toHaveBeenCalledOnce(); expect(draft.snapshot()).toMatchObject({ busy: true, classification: null });
    expect(customBuildHandoff({ availability, signedIn: true, panelBusy: false, drafting: draft.snapshot().busy, classifying: draft.snapshot().spec !== null, jobSaved: false }))
      .toEqual({ offered: true, blocked: "The custom-build panel is classifying a card. Wait for it to finish." });
    resolve(open); await work;
    expect(reveal).toHaveBeenCalledOnce();
  });
  it("does not reveal the panel for a handoff that cannot start", async () => {
    const { draft } = setup(); const reveal = vi.fn();
    await startHandoff(draft, { spec, query: "Synthetic handoff", hostId: "task-report" }, { ...availability, behaviors: availability.behaviors.slice(0, 1) }, true, reveal);
    expect(reveal).not.toHaveBeenCalled();
  });
  it("offers no handoff while only proven behaviors are offered, and gives a reason for a held one", () => {
    const base = { availability, signedIn: true, panelBusy: false, drafting: false, classifying: false, jobSaved: false };
    expect(customBuildHandoff({ ...base, availability: { ...availability, behaviors: availability.behaviors.slice(0, 1) } })).toEqual({ offered: false, blocked: null });
    expect(customBuildHandoff({ ...base, availability: { ...availability, enabled: false } })).toEqual({ offered: false, blocked: null });
    expect(customBuildHandoff({ ...base, signedIn: false })).toEqual({ offered: false, blocked: null });
    expect(customBuildHandoff(base)).toEqual({ offered: true, blocked: null });
    expect(customBuildHandoff({ ...base, jobSaved: true }).blocked).toContain("A custom build is saved on this page.");
    expect(customBuildHandoff({ ...base, drafting: true }).blocked).toContain("writing a spec card");
  });
  it("keeps the proven-only designer's signed_out from re-checking the shared session", async () => {
    const signedOut = vi.fn();
    const draft = new OtfDraftController({ bugSpec: () => Promise.resolve({ ok: false as const, failure: { code: "signed_out" as const, message: null, retryAfterS: null } }) }, { classify: vi.fn() }, signedOut);
    draft.setSentence("Synthetic task updates lose a saved value.");
    const provenOnly = { ...availability, behaviors: availability.behaviors.slice(0, 1) };
    draft.pick(proven); await draft.design(provenOnly, true);
    expect(signedOut).not.toHaveBeenCalled(); expect(draft.snapshot().message).not.toBeNull();
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
    expect(draft.snapshot().classification).toBeNull(); expect(draft.snapshot().stale).toBe(true); expect(draft.acceptedInput(availability, true)).toBeNull();
  });
  it("re-sends the same rule and rule hash after a refused create and Edit custom design without edits", async () => {
    const { draft } = setup(); const { jobs, create } = await refusingJobs();
    await draft.handoff({ spec, query: "Synthetic handoff", hostId: "task-report" }, availability, true);
    const edited = { ...rule, failure_code: "synthetic_restored_rule" }; draft.setRule(edited);
    await refuseThenEdit(draft, jobs);
    expect(draft.snapshot()).toMatchObject({ classificationRequired: true, hostId: "task-report", classification: open, rule: edited, stale: false, criterionId: OTF_OPEN_CRITERION_ID });
    const again = draft.acceptedInput(availability, true); if (again === null) throw new Error("Synthetic restored draft unexpectedly refused");
    await jobs.create(again);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toMatchObject({ rule: edited, rule_sha256: await ruleSha256(edited), spec_sha256: create.mock.calls[0]?.[0].spec_sha256 });
  });
  it.each(["card", "sentence"] as const)("requires classifying again after a %s edit to a restored custom design", async edit => {
    const { draft, classify } = setup(); const { jobs } = await refusingJobs();
    await draft.handoff({ spec, query: "Synthetic handoff", hostId: "task-report" }, availability, true);
    await refuseThenEdit(draft, jobs);
    if (edit === "card") draft.setSpec({ ...specFromDraft(draft), where: "Synthetic edited route" });
    else draft.setSentence("Synthetic edited sentence about saved values.");
    expect(draft.snapshot()).toMatchObject({ classification: null, rule: null, stale: true, classificationRequired: true });
    expect(draft.acceptedInput(availability, true)).toBeNull();
    await draft.reclassify(availability, true);
    expect(classify).toHaveBeenCalledTimes(2); expect(classify.mock.calls[1]?.[0].host_id).toBe("task-report");
    expect(draft.acceptedInput(availability, true)?.rule).toEqual(rule);
  });
  it("asks to classify a restored open design again when its classification is no longer at hand", () => {
    const draft = new OtfDraftController({ bugSpec: vi.fn() }, { classify: vi.fn() });
    draft.restore({ client_key: "00000000-0000-4000-8000-000000000003", host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID, sentence: "Synthetic saved sentence.",
      spec: specFromDesigner(spec), spec_sha256: "0".repeat(64), rule, rule_sha256: "0".repeat(64) }, availability);
    expect(draft.snapshot()).toMatchObject({ classificationRequired: true, hostId: "task-report", classification: null, stale: true });
    expect(draft.acceptedInput(availability, true)).toBeNull();
  });
  it("keeps the proven-only flow's sentence edit clearing the card, as before the open behavior", async () => {
    const { draft } = setup(); const provenOnly = { ...availability, behaviors: availability.behaviors.slice(0, 1) };
    draft.pick(proven); await draft.design(provenOnly, true);
    draft.setSpec({ ...specFromDraft(draft), fix: "An edited synthetic fix." });
    expect(draft.snapshot().stale).toBe(false); expect(draft.acceptedInput(provenOnly, true)?.spec.fix).toBe("An edited synthetic fix.");
    draft.setSentence("A different synthetic sentence.");
    expect(draft.snapshot().spec).toBeNull();
  });
});
