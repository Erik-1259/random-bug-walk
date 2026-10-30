import { describe, expect, it, vi } from "vitest";
import type { AssistClient, BugSpec } from "../../src/assist/client.ts";
import { OtfDraftController } from "../../src/components/otf/draft.ts";
import { specFromDesigner } from "../../src/components/otf/guided.tsx";
import { OTF_JOB_KEY, OtfClientError, OtfController, type OtfClient, type OtfIdentityLock } from "../../src/otf/client.ts";
import { ruleSha256, specSha256 } from "../../src/otf/canonical.ts";
import { OTF_ERROR_STATUS, OTF_OPEN_CRITERION_ID, type OtfAvailability, type OtfClassification, type OtfCreateJob, type OtfJobStatus, type OtfOpenRule } from "../../src/otf/contract.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const KEYS = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"] as const;
const RETRY_KEY = "00000000-0000-4000-8000-000000000004";
const TIME = "2026-10-30T00:00:00Z";
const availability: OtfAvailability = {
  enabled: true, builder: "running", active_jobs: 0, queued_jobs: 0, max_queued: 4, cold_start_min: null, spend_left_microusd: 8_000_000,
  hosts: [
    { host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [], deadline_min: 45, typical: null },
    { host_id: "umami", label: "Umami", offered: false, unavailable_reason: "calendar", active_jobs: 0, queued_jobs: 0, max_active: 1, lanes: [], deadline_min: 60, typical: null },
  ],
  behaviors: [{ criterion_id: OTF_OPEN_CRITERION_ID, host_id: "task-report", label: "Synthetic open behavior", measured: false, example_phrases: [] }],
};
const designs: readonly { card: BugSpec; sentence: string; classified: OtfOpenRule; edited: OtfOpenRule }[] = [
  {
    card: { title: "Synthetic title update", target_app: "task-report", where: "Task update route", change: "A saved task title disappears.", why_tests_miss: "Tests do not read after updates.", checks_to_add: ["Read the updated title."], fix: "Keep the updated title." },
    sentence: "A synthetic saved task title disappears after an update.",
    classified: { family: "data_handling", observable_failure: "GET /api/tasks/{id} returns an old title after a saved update.", failure_code: "synthetic_title_missing" },
    edited: { family: "data_handling", observable_failure: "GET /api/tasks/{id} returns the previous title after two saved updates.", failure_code: "synthetic_edited_title_missing" },
  },
  {
    card: { title: "Synthetic completion report", target_app: "task-report", where: "Daily completion report", change: "A completed task disappears from its day.", why_tests_miss: "Tests do not compare the report with completions.", checks_to_add: ["Read the daily completion count."], fix: "Keep each completion in its day." },
    sentence: "A synthetic completion disappears from the daily report.",
    classified: { family: "date_time", observable_failure: "GET /api/reports/completions/daily omits a saved task completion.", failure_code: "synthetic_completion_missing" },
    edited: { family: "date_time", observable_failure: "GET /api/reports/completions/daily omits the second saved task completion.", failure_code: "synthetic_edited_completion_missing" },
  },
];

function queued(body: OtfCreateJob): OtfJobStatus {
  return {
    job_id: JOB, created_at: TIME, state: "queued", host_id: body.host_id, queue_position: 1, builder: "running", outcome: null, reason: null,
    criterion_id: body.criterion_id, spec: structuredClone(body.spec), spec_sha256: body.spec_sha256, rule: structuredClone(body.rule), deadline_at: null,
    elapsed_ms: 0, lanes: [], events: [{ seq: 1, at: TIME, type: "job_queued", lane_id: null, data: { position: 1 } }], next_after: 1, poll_after_ms: 2000,
    spend: { model_microusd: 0, cap_microusd: 8_000_000, source: "builder proxy meter (upper bound)" },
    winner: null, artifacts: [], certificate: null, validation: null, catalog_request_id: null,
  };
}

async function setup() {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  let queue = Promise.resolve();
  const lock: OtfIdentityLock = operation => {
    const next = queue.then(operation);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  let server: OtfJobStatus | null = null;
  const create = vi.fn<OtfClient["create"]>(body => {
    server = queued(body);
    return Promise.resolve({ job_id: JOB, status: structuredClone(server) });
  });
  const status = vi.fn<OtfClient["status"]>((id, after = 0) => {
    expect(id).toBe(JOB);
    if (server === null) throw new Error("Synthetic server has no accepted job.");
    return Promise.resolve(structuredClone({ ...server, events: server.events.filter(event => event.seq > after) }));
  });
  const api: OtfClient = { availability: () => Promise.resolve(availability), classify: vi.fn(), create, status, stop: vi.fn(), validate: vi.fn() };
  const tabs = await Promise.all(designs.map(async (design, index) => {
    const key = KEYS[index]; if (key === undefined) throw new Error("Synthetic tab key is missing.");
    const uuid = vi.fn<() => string>().mockReturnValueOnce(key).mockReturnValue(RETRY_KEY);
    const jobs = new OtfController(api, storage, uuid, lock);
    await jobs.initialize();
    const answer: OtfClassification = { family: design.classified.family, proven_criterion_id: null, buildable: [{ host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID }], rule: design.classified, refusal: null, model: "synthetic-classifier" };
    const classify = vi.fn<OtfClient["classify"]>(() => Promise.resolve(structuredClone(answer)));
    const designer: Pick<AssistClient, "bugSpec"> = { bugSpec: vi.fn() };
    const draft = new OtfDraftController(designer, { classify });
    await draft.handoff({ spec: structuredClone(design.card), query: design.sentence, hostId: "task-report" }, availability, true);
    expect(classify).toHaveBeenCalledExactlyOnceWith({ sentence: design.sentence, host_id: "task-report", spec: specFromDesigner(design.card) });
    draft.setRule(structuredClone(design.edited));
    const expected: OtfCreateJob & { rule: OtfOpenRule } = { client_key: key, host_id: "task-report", criterion_id: OTF_OPEN_CRITERION_ID, sentence: design.sentence,
      spec: specFromDesigner(design.card), spec_sha256: await specSha256(specFromDesigner(design.card)), rule: structuredClone(design.edited), rule_sha256: await ruleSha256(design.edited) };
    return { jobs, draft, uuid, classify, expected };
  }));
  expect(create).not.toHaveBeenCalled(); expect(memory.size).toBe(0);
  const first = tabs[0]; const second = tabs[1];
  if (first === undefined || second === undefined) throw new Error("Synthetic tabs are missing.");
  return { tabs: [first, second] as const, storage, lock, api, create, status };
}

function accepted(draft: OtfDraftController) {
  const input = draft.acceptedInput(availability, true);
  if (input === null) throw new Error("Synthetic classified draft unexpectedly refused.");
  return input;
}

describe("SPEC 8.3 open rules across browser tabs and reloads", () => {
  it.each([0, 1] as const)("preserves tab %s's entire accepted card and rule when both tabs accept", async firstIndex => {
    const c = await setup(); const first = c.tabs[firstIndex]; const other = c.tabs[firstIndex === 0 ? 1 : 0];
    const input = accepted(first.draft);
    const pending = first.jobs.create(input);
    const competing = other.jobs.create(accepted(other.draft));
    // Both controllers are waiting for the shared identity lock. Later edits cannot change either acceptance.
    input.spec.title = "Synthetic edit after Accept";
    if (input.rule === undefined) throw new Error("Synthetic open input has no rule.");
    input.rule.failure_code = "synthetic_changed_after_accept";
    first.draft.setRule({ ...other.expected.rule, failure_code: "synthetic_later_local_edit" });
    await Promise.all([pending, competing]);
    expect(c.create).toHaveBeenCalledExactlyOnceWith(first.expected);
    expect(JSON.parse(c.storage.getItem(OTF_JOB_KEY) ?? "null")).toEqual({ request: first.expected, job_id: JOB, catalog_request_id: null });
    expect(first.uuid).toHaveBeenCalledOnce(); expect(other.uuid).not.toHaveBeenCalled();
    for (const tab of c.tabs) {
      expect(tab.jobs.snapshot()).toMatchObject({ jobId: JOB, pendingRequest: first.expected, status: { spec: first.expected.spec, rule: first.expected.rule }, message: null });
    }
    expect(other.draft.snapshot().rule).toEqual(other.expected.rule);
    expect(first.expected.rule_sha256).not.toBe(other.expected.rule_sha256);
  });

  it.each(["reload", "second tab"] as const)("reads the accepted server rule on %s despite different local drafts", async readerKind => {
    const c = await setup(); const [first, other] = c.tabs;
    await first.jobs.create(accepted(first.draft));
    first.draft.setRule({ ...other.expected.rule, failure_code: "synthetic_local_rule_after_accept" });
    other.draft.setRule({ ...other.expected.rule, failure_code: "synthetic_other_tab_rule" });
    const uuid = vi.fn(() => RETRY_KEY);
    const reader = readerKind === "reload" ? new OtfController(c.api, c.storage, uuid, c.lock) : other.jobs;
    c.status.mockClear();
    await reader.initialize();
    expect(c.status).toHaveBeenCalledExactlyOnceWith(JOB, 0);
    expect(c.create).toHaveBeenCalledExactlyOnceWith(first.expected);
    expect(uuid).not.toHaveBeenCalled(); expect(other.uuid).not.toHaveBeenCalled();
    expect(reader.snapshot()).toMatchObject({ jobId: JOB, pendingRequest: first.expected, status: { spec: first.expected.spec, rule: first.expected.rule }, message: null });
    expect(reader.snapshot().status?.rule).not.toEqual(first.draft.snapshot().rule);
    expect(reader.snapshot().status?.rule).not.toEqual(other.draft.snapshot().rule);
    expect(JSON.parse(c.storage.getItem(OTF_JOB_KEY) ?? "null")).toMatchObject({ request: first.expected, job_id: JOB });
  });

  it.each([0, 1] as const)("restores tab %s's busy-refused rule through Edit custom design without adopting the other draft", async editingIndex => {
    const c = await setup(); const editing = c.tabs[editingIndex]; const other = c.tabs[editingIndex === 0 ? 1 : 0];
    c.create.mockRejectedValueOnce(new OtfClientError("busy", "Synthetic busy refusal.", OTF_ERROR_STATUS.busy));
    await editing.jobs.create(accepted(editing.draft));
    const refused = editing.jobs.snapshot().pendingRequest;
    expect(refused).toEqual(editing.expected);
    expect(editing.jobs.snapshot()).toMatchObject({ refusal: "busy", canNewDraft: true });
    // The other tab observes the shared refusal but still has its own different classified draft.
    await other.jobs.initialize();
    expect(other.jobs.snapshot().pendingRequest).toEqual(editing.expected);
    expect(other.draft.snapshot().rule).toEqual(other.expected.rule);
    await other.jobs.create(accepted(other.draft));
    expect(c.create).toHaveBeenCalledTimes(1);
    // These are the same public controller calls used by "Edit custom design" in the workspace.
    await editing.jobs.newDraft();
    expect(editing.jobs.snapshot().pendingRequest).toBeNull(); expect(c.storage.getItem(OTF_JOB_KEY)).toBeNull();
    editing.draft.restore(refused, editing.jobs.snapshot().availability);
    expect(editing.draft.snapshot()).toMatchObject({ spec: editing.expected.spec, rule: editing.expected.rule, stale: false });
    await editing.jobs.create(accepted(editing.draft));
    const restored = { ...editing.expected, client_key: RETRY_KEY };
    expect(c.create.mock.calls.map(([body]) => body)).toEqual([editing.expected, restored]);
    expect(editing.classify).toHaveBeenCalledOnce(); expect(other.classify).toHaveBeenCalledOnce();
    // A stale in-memory refusal in the other tab must adopt this new saved identity, not re-send either old draft.
    await other.jobs.create(accepted(other.draft));
    expect(c.create).toHaveBeenCalledTimes(2); expect(other.uuid).not.toHaveBeenCalled();
    expect(other.jobs.snapshot()).toMatchObject({ jobId: JOB, pendingRequest: restored, status: { spec: editing.expected.spec, rule: editing.expected.rule }, message: null });
  });
});
