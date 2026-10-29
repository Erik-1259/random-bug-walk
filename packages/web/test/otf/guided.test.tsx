import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BehaviorPickerView, SpecAcceptView, sentenceProblem, specProblem, specFromDesigner } from "../../src/components/otf/guided.tsx";
import { closestCatalogInput, startCatalogRequest } from "../../src/components/otf/catalog-start.tsx";
import { FactoryController, REQUEST_KEY, type Capabilities, type FactoryClient, type Interpretation, type RequestInput, type RequestStatus } from "../../src/factory/client.ts";
import type { OtfBehaviorOption, OtfSpecCard } from "../../src/otf/contract.ts";

const behavior: OtfBehaviorOption = { criterion_id: "concurrency.lost-acknowledged-change", label: "Synthetic overlapping edits", example_phrases: ["A synthetic edit disappears."] };
const spec: OtfSpecCard = { title: "Synthetic edit", where: "Synthetic save handler", change: "An overlapping edit is lost.", why_tests_miss: "Existing tests save one edit.", checks_to_add: ["Save two synthetic edits."], fix: "Keep both edits." };
const capabilities = JSON.parse(readFileSync(new URL("../fixtures/factory-v1/capabilities.json", import.meta.url), "utf8")) as Capabilities;
const noop = () => undefined;

describe("guided custom design", () => {
  it("renders offered behaviors and examples without starting work", () => {
    const design = vi.fn();
    const html = renderToStaticMarkup(<BehaviorPickerView behaviors={[behavior]} criterionId={behavior.criterion_id} sentence="Synthetic overlap" signedIn busy={false} onBehavior={noop} onSentence={noop} onDesign={design} />);
    expect(html).toContain(behavior.label);
    expect(html).toContain(behavior.example_phrases[0]);
    expect(html).toContain("task-report");
    expect(html).toContain("Write my spec card");
    expect(design).not.toHaveBeenCalled();
  });
  it("requires sign-in before invoking the designer", () => {
    const html = renderToStaticMarkup(<BehaviorPickerView behaviors={[behavior]} criterionId={behavior.criterion_id} sentence="Synthetic overlap" signedIn={false} busy={false} onBehavior={noop} onSentence={noop} onDesign={noop} />);
    expect(html).toContain("Sign in");
    expect(html).toMatch(/disabled=""[^>]*>Write my spec card/);
  });
  it("requires an offered selection", () => {
    const html = renderToStaticMarkup(<BehaviorPickerView behaviors={[behavior]} criterionId={null} sentence="Synthetic overlap" signedIn busy={false} onBehavior={noop} onSentence={noop} onDesign={noop} />);
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
    const html = renderToStaticMarkup(<SpecAcceptView spec={spec} busy={false} signedIn onChange={noop} onAccept={noop} />);
    for (const field of ["title", "where", "change", "why_tests_miss", "checks_to_add", "fix"]) expect(html).toContain(`id="otf-spec-${field}"`);
    expect(html).toContain("Spec card by Nemotron 3 Super");
    expect(html).toContain("Accept and build this custom bug");
    expect(html).not.toContain("Qualified by");
  });
  it("escapes edited text and keeps it as a design until accepted", () => {
    const html = renderToStaticMarkup(<SpecAcceptView spec={{ ...spec, title: "<synthetic>" }} busy={false} signedIn onChange={noop} onAccept={noop} />);
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
    const html = renderToStaticMarkup(<SpecAcceptView spec={spec} busy signedIn onChange={noop} onAccept={noop} />);
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toMatch(/disabled=""[^>]*>Accept and build this custom bug/);
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
    await expect(startCatalogRequest(controller, behavior.criterion_id)).rejects.toThrow("not yet confirmed");
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
