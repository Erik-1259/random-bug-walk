import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BehaviorPickerView, SpecAcceptView, sentenceProblem, specProblem, specFromDesigner } from "../../src/components/otf/guided.tsx";
import { CatalogStartPending, closestCatalogInput, startCatalogRequest } from "../../src/components/otf/catalog-start.tsx";
import { hostQueueSentence, hostReasonLines, typicalSentence } from "../../src/components/otf/host-copy.tsx";
import { FactoryController, REQUEST_KEY, type Capabilities, type FactoryClient, type Interpretation, type RequestInput, type RequestStatus } from "../../src/factory/client.ts";
import type { OtfBehaviorOption, OtfHostAvailability, OtfSpecCard } from "../../src/otf/contract.ts";
import { UMAMI_CALENDAR_REASON } from "../../src/factory/format.ts";

const behavior: OtfBehaviorOption = { criterion_id: "concurrency.lost-acknowledged-change", host_id: "task-report", label: "Synthetic overlapping edits", example_phrases: ["A synthetic edit disappears."], measured: true };
const spec: OtfSpecCard = { title: "Synthetic edit", where: "Synthetic save handler", change: "An overlapping edit is lost.", why_tests_miss: "Existing tests save one edit.", checks_to_add: ["Save two synthetic edits."], fix: "Keep both edits." };
const capabilities = JSON.parse(readFileSync(new URL("../fixtures/factory-v1/capabilities.json", import.meta.url), "utf8")) as Capabilities;
const noop = () => undefined;
const umamiBehavior: OtfBehaviorOption = { criterion_id: "date_time.time-zone-grouping", host_id: "umami", label: "Synthetic time-zone grouping", example_phrases: ["A synthetic day lands in the wrong bucket."], measured: true };
const taskReport: OtfHostAvailability = { host_id: "task-report", label: "task-report service", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 2, lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], deadline_min: 45, typical: null };
const umami: OtfHostAvailability = { host_id: "umami", label: "Umami", offered: true, unavailable_reason: null, active_jobs: 0, queued_jobs: 0, max_active: 1, lanes: [{ lane_id: "lane-1", model_label: "Synthetic model" }], deadline_min: 60, typical: null };
const hosts = [taskReport, umami];
const NOW = Date.UTC(2026, 9, 29, 10);
const NOV_3 = Date.UTC(2026, 10, 3, 12);
const picker = { behaviors: [behavior, umamiBehavior], hosts, nowMs: NOW, criterionId: behavior.criterion_id, sentence: "Synthetic overlap", signedIn: true, busy: false, onBehavior: noop, onSentence: noop, onDesign: noop };

describe("guided custom design", () => {
  it("renders offered behaviors and examples without starting work", () => {
    const design = vi.fn();
    const html = renderToStaticMarkup(<BehaviorPickerView behaviors={[behavior]} hosts={hosts} nowMs={NOW} criterionId={behavior.criterion_id} sentence="Synthetic overlap" signedIn busy={false} onBehavior={noop} onSentence={noop} onDesign={design} />);
    expect(html).toContain(behavior.label);
    expect(html).toContain(behavior.example_phrases[0]);
    expect(html).toContain("task-report");
    expect(html).toContain("Write my spec card");
    expect(design).not.toHaveBeenCalled();
  });
  it("separates examples from the label and skips an example that repeats it", () => {
    const repeated: OtfBehaviorOption = { ...behavior, example_phrases: ["synthetic overlapping edits", "A synthetic edit disappears."] };
    const html = renderToStaticMarkup(<BehaviorPickerView behaviors={[repeated]} hosts={hosts} nowMs={NOW} criterionId={null} sentence="" signedIn busy={false} onBehavior={noop} onSentence={noop} onDesign={noop} />);
    expect(html).toContain("<br/><small>For example: A synthetic edit disappears.</small>");
    expect(html).not.toContain("synthetic overlapping edits");
  });
  it("requires sign-in before invoking the designer", () => {
    const html = renderToStaticMarkup(<BehaviorPickerView behaviors={[behavior]} hosts={hosts} nowMs={NOW} criterionId={behavior.criterion_id} sentence="Synthetic overlap" signedIn={false} busy={false} onBehavior={noop} onSentence={noop} onDesign={noop} />);
    expect(html).toContain("Sign in");
    expect(html).toMatch(/disabled=""[^>]*>Write my spec card/);
  });
  it("requires an offered selection", () => {
    const html = renderToStaticMarkup(<BehaviorPickerView behaviors={[behavior]} hosts={hosts} nowMs={NOW} criterionId={null} sentence="Synthetic overlap" signedIn busy={false} onBehavior={noop} onSentence={noop} onDesign={noop} />);
    expect(html).toMatch(/disabled=""[^>]*>Write my spec card/);
  });
  it("validates the trimmed sentence length as Unicode code points", () => {
    expect(sentenceProblem("  ab  ")).not.toBeNull();
    expect(sentenceProblem("  synthetic  ")).toBeNull();
    expect(sentenceProblem("🙂".repeat(300))).toBeNull();
    expect(sentenceProblem("🙂".repeat(301))).not.toBeNull();
  });
  it("copies only the accepted contract fields from the existing designer", () => {
    expect(specFromDesigner({ ...spec, target_app: "task-report" })).toEqual(spec);
    expect(specFromDesigner({ ...spec, target_app: "task-report" }).checks_to_add).not.toBe(spec.checks_to_add);
  });
  it("shows all editable fields and the explicit accept action", () => {
    const html = renderToStaticMarkup(<SpecAcceptView spec={spec} host={taskReport} busy={false} signedIn onChange={noop} onAccept={noop} />);
    for (const field of ["title", "where", "change", "why_tests_miss", "checks_to_add", "fix"]) expect(html).toContain(`id="otf-spec-${field}"`);
    expect(html).toContain("Spec card by Nemotron 3 Super");
    expect(html).toContain("Accept and build this custom bug");
    expect(html).not.toContain("Qualified by");
  });
  it("escapes edited text and keeps it as a design until accepted", () => {
    const html = renderToStaticMarkup(<SpecAcceptView spec={{ ...spec, title: "<synthetic>" }} host={taskReport} busy={false} signedIn onChange={noop} onAccept={noop} />);
    expect(html).toContain("&lt;synthetic&gt;");
    expect(html).toContain("Design, not a built bug");
  });
  it("blocks an empty field or missing checks", () => {
    expect(specProblem({ ...spec, fix: " " })).not.toBeNull();
    expect(specProblem({ ...spec, checks_to_add: [] })).not.toBeNull();
    expect(specProblem({ ...spec, checks_to_add: [" "] })).not.toBeNull();
    expect(specProblem(spec)).toBeNull();
  });
  it("enforces the card limits and at most six checks", () => {
    for (const [field, limit] of [["title", 160], ["where", 800], ["change", 1500], ["why_tests_miss", 1200], ["fix", 1200]] as const) {
      expect(specProblem({ ...spec, [field]: "s".repeat(limit) })).toBeNull();
      expect(specProblem({ ...spec, [field]: "s".repeat(limit + 1) })).not.toBeNull();
    }
    expect(specProblem({ ...spec, checks_to_add: ["s".repeat(401)] })).not.toBeNull();
    expect(specProblem({ ...spec, checks_to_add: Array<string>(7).fill("Synthetic check") })).not.toBeNull();
  });
  it("locks card editing and acceptance while a request is being sent", () => {
    const html = renderToStaticMarkup(<SpecAcceptView spec={spec} host={taskReport} busy signedIn onChange={noop} onAccept={noop} />);
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toMatch(/disabled=""[^>]*>Accept and build this custom bug/);
  });
});

describe("hosts in the guided picker", () => {
  it("groups behaviors by host with a host-neutral intro", () => {
    const html = renderToStaticMarkup(<BehaviorPickerView {...picker} />);
    expect(html).not.toContain("on the task-report service");
    expect(html).toContain("Build a custom non-security bug.");
    expect(html.indexOf("<legend>task-report service</legend>")).toBeLessThan(html.indexOf(behavior.label));
    expect(html.indexOf("<legend>Umami</legend>")).toBeLessThan(html.indexOf(umamiBehavior.label));
    expect(html.indexOf(behavior.label)).toBeLessThan(html.indexOf("<legend>Umami</legend>"));
  });
  it("shows a calendar-closed host as a disabled group with one reason line and the open-again date", () => {
    const closed = { ...umami, offered: false, unavailable_reason: "calendar" as const };
    const html = renderToStaticMarkup(<BehaviorPickerView {...picker} behaviors={[behavior]} hosts={[taskReport, closed]} nowMs={NOV_3} />);
    expect(html).toContain("Umami is unavailable on UTC days 2–5. They open again on November 6 (UTC). Task-report builds and the catalog are still available.");
    expect(html).toMatch(/<fieldset disabled="" aria-label="Umami behaviors">/);
    expect(html).not.toContain(umamiBehavior.label);
    for (const word of ["upstream", "revenue", "test"]) expect(html.toLowerCase()).not.toContain(word);
  });
  it.each(["disabled", "builder_not_ready"] as const)("says only that builds are offline for %s", reason => {
    const html = renderToStaticMarkup(<BehaviorPickerView {...picker} behaviors={[behavior]} hosts={[taskReport, { ...umami, offered: false, unavailable_reason: reason }]} />);
    expect(html).toContain("Umami builds are offline right now.");
    expect(html).not.toContain("UTC days");
  });
  it("does not offer task-report builds in the calendar line when that host is closed too", () => {
    expect(hostReasonLines({ ...umami, offered: false, unavailable_reason: "calendar" }, [{ ...taskReport, offered: false, unavailable_reason: "disabled" }, umami], NOV_3)).toEqual(["Umami is unavailable on UTC days 2–5.", "They open again on November 6 (UTC).", "The catalog is still available."]);
  });
  it("does not accept a pick on a host that is not offered", () => {
    const html = renderToStaticMarkup(<BehaviorPickerView {...picker} criterionId={umamiBehavior.criterion_id} hosts={[taskReport, { ...umami, offered: false, unavailable_reason: "disabled" }]} />);
    expect(html).toMatch(/disabled=""[^>]*>Write my spec card/);
  });
  it("shows each host's own queue", () => {
    expect(hostQueueSentence(umami)).toBeNull();
    const html = renderToStaticMarkup(<BehaviorPickerView {...picker} hosts={[taskReport, { ...umami, active_jobs: 1, queued_jobs: 2 }]} />);
    expect(html).toContain("Umami builds now: 1 running, 2 waiting.");
    expect(html).not.toContain("Task-report builds now");
  });
  it("adds the placement note to an Umami spec card only", () => {
    const note = "The builder places the bug in one of Umami&#x27;s date-grouped reports that its harness supports, chosen to match your card where it can. It may differ from the report your card describes.";
    expect(renderToStaticMarkup(<SpecAcceptView spec={spec} host={umami} busy={false} signedIn onChange={noop} onAccept={noop} />)).toContain(note);
    expect(renderToStaticMarkup(<SpecAcceptView spec={spec} host={taskReport} busy={false} signedIn onChange={noop} onAccept={noop} />)).not.toContain("date-grouped");
  });
  it("words time copy from the host's typical and its source, with no fixed minutes", () => {
    expect(typicalSentence({ ...umami, typical: { source: "otf_jobs", median_min: 7, p90_min: 19, samples: 12, measured_on: "2026-10-28" } })).toBe("Usually about 7 minutes; 9 in 10 finished within 19 minutes (12 builds measured, last on 2026-10-28). Your bug may take longer or not qualify.");
    expect(typicalSentence({ ...taskReport, typical: { source: "development_attempts", median_min: 6.5, p90_min: 14, samples: 20, measured_on: "2026-10-27" } })).toBe("In development runs, a qualifying build attempt took about 6.5 minutes, and 9 in 10 took at most 14 minutes (20 attempts, measured 2026-10-27). Waiting, machine start-up and packaging add to that. Your bug may take longer or not qualify.");
    expect(typicalSentence(umami)).toBe("Build times for Umami are not measured yet. The board shows each step as it runs.");
    const html = renderToStaticMarkup(<SpecAcceptView spec={spec} host={taskReport} busy={false} signedIn onChange={noop} onAccept={noop} />);
    expect(html).toContain("Build times for task-report service are not measured yet.");
    expect(html).not.toMatch(/5–35|13 sample/);
  });
});

describe("one-click catalog fallback", () => {
  it("uses an actually offered criterion and the configured budget", () => {
    const input = closestCatalogInput(capabilities, behavior.criterion_id);
    expect(input).toEqual({ hosts: ["task-report"], items: [{ item_key: "otf-catalog", bug_type_id: "concurrency", quantity: 1, description: "an acknowledged change is lost when requests overlap", difficulty: "source_inferable_allowed" }], budget_microusd: capabilities.limits.default_budget_microusd });
  });
  it("offers the closest supported catalog behavior instead of sending an unsupported custom criterion", () => {
    expect(closestCatalogInput(capabilities, "concurrency.stale-success-response")?.items[0]?.description).toBe("an acknowledged change is lost when requests overlap");
  });
  it("prefers an exact catalog match on another offered host and skips a calendar-closed host", () => {
    expect(closestCatalogInput(capabilities, "date_time.time-zone-grouping")).toMatchObject({ hosts: ["umami"], items: [{ bug_type_id: "date_time" }] });
    const closed: Capabilities = { ...capabilities, combinations: capabilities.combinations.map(option => option.host_id === "umami" ? { ...option, reason: UMAMI_CALENDAR_REASON } : option) };
    expect(closestCatalogInput(closed, "date_time.time-zone-grouping")).toMatchObject({ hosts: ["task-report"], items: [{ bug_type_id: "concurrency" }] });
  });
  it("does not invent a catalog entry when none is available", () => {
    expect(closestCatalogInput(null, behavior.criterion_id)).toBeNull();
    expect(closestCatalogInput({ ...capabilities, combinations: [] }, behavior.criterion_id)).toBeNull();
  });
  it("uses the existing controller to interpret then explicitly start the same catalog input", async () => {
    const input = closestCatalogInput(capabilities, behavior.criterion_id);
    if (input === null) throw new Error("Synthetic catalog input missing");
    const start = vi.fn(() => Promise.reject(new Error("Synthetic lost response")));
    const interpret = vi.fn((value: RequestInput) => Promise.resolve({ input: value, startable: true, interpretation_sha256: "a".repeat(64) } as Interpretation));
    const client: FactoryClient = {
      capabilities: () => Promise.resolve(capabilities), session: () => Promise.resolve({ contract_version: "bug-request/1", signed_in: true }),
      signIn: () => Promise.resolve(), interpret,
      start, status: () => Promise.reject(new Error("Synthetic unreadable status")), stop: () => Promise.reject(new Error("unused")),
      validate: () => Promise.reject(new Error("unused")), validation: () => Promise.reject(new Error("unused")),
    };
    const values = new Map<string, string>();
    const controller = new FactoryController(client, { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, () => "00000000-0000-4000-8000-000000000001", Date.now, async action => { await action(); });
    await controller.initialize();
    const pending = startCatalogRequest(controller, behavior.criterion_id);
    await expect(pending).rejects.toThrow("not yet confirmed");
    await expect(pending).rejects.toBeInstanceOf(CatalogStartPending);
    await expect(pending).rejects.toMatchObject({ requestId: "00000000-0000-4000-8000-000000000001" });
    expect(interpret).toHaveBeenCalledWith(input);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]).toBeDefined();
    expect(controller.snapshot().requestId).toBe("00000000-0000-4000-8000-000000000001");
    await expect(startCatalogRequest(controller, behavior.criterion_id)).rejects.toThrow("already");
    expect(start).toHaveBeenCalledOnce();
  });
  it.each(["matching", "different", "unreadable"] as const)("checks the %s catalog request adopted from another tab", async mode => {
    const input = closestCatalogInput(capabilities, behavior.criterion_id);
    if (input === null) throw new Error("Synthetic catalog input missing");
    const status = JSON.parse(readFileSync(new URL("../fixtures/factory-v1/status-running.json", import.meta.url), "utf8")) as RequestStatus;
    if (mode === "matching") status.interpretation.input = input;
    const values = new Map<string, string>();
    const start = vi.fn(() => Promise.reject(new Error("Must adopt rather than create")));
    const client: FactoryClient = {
      capabilities: () => Promise.resolve(capabilities), session: () => Promise.resolve({ contract_version: "bug-request/1", signed_in: true }), signIn: () => Promise.resolve(),
      interpret: value => { values.set(REQUEST_KEY, status.request_id); return Promise.resolve({ ...status.interpretation, input: value, startable: true }); },
      start, status: () => mode === "unreadable" ? Promise.reject(new Error("Synthetic unreadable status")) : Promise.resolve(status),
      stop: () => Promise.reject(new Error("unused")), validate: () => Promise.reject(new Error("unused")), validation: () => Promise.reject(new Error("unused")),
    };
    const controller = new FactoryController(client, { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, () => "00000000-0000-4000-8000-000000000001", Date.now, async action => { await action(); });
    await controller.initialize();
    const result = startCatalogRequest(controller, behavior.criterion_id);
    if (mode === "matching") await expect(result).resolves.toBe(status.request_id);
    else await expect(result).rejects.toThrow(mode === "different" ? "different catalog request" : "not yet confirmed");
    expect(start).not.toHaveBeenCalled();
    expect(controller.snapshot().requestId).toBe(status.request_id);
  });
  it("refuses to start an unstartable interpretation", async () => {
    const start = vi.fn();
    const input = closestCatalogInput(capabilities, behavior.criterion_id);
    if (input === null) throw new Error("Synthetic catalog input missing");
    const snapshot = () => ({ signedIn: true, busy: false, requestId: null, capabilities, message: null, interpretation: { startable: false, input }, status: null as RequestStatus | null });
    await expect(startCatalogRequest({ snapshot, interpret: () => Promise.resolve(), start }, behavior.criterion_id)).rejects.toThrow("cannot be started");
    expect(start).not.toHaveBeenCalled();
  });
});
