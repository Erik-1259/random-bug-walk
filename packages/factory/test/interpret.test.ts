import { assertContract, validateContract } from "@rbw/factory-contract/validate";
import type { Capabilities, Interpretation, NormalizedRequestInput } from "@rbw/factory-contract";
import { describe, expect, it } from "vitest";
import { buildCapabilities } from "../src/capabilities.ts";
import { criteriaCatalogV1 } from "../src/criteria.ts";
import { canonicalStart, parseRequestInput } from "../src/input.ts";
import { interpret } from "../src/interpret.ts";
import { serviceFunctions } from "../src/service.ts";
import { FakeHostAdapter, TEST_PROFILE, fixtureRegistry, syntheticEntry } from "../src/testing/catalog.ts";
import { fixture, fixtureCatalog, interpretationFixture } from "./support.ts";

const NOW = new Date("2026-10-20T14:00:00.000Z");
const LIMITS = TEST_PROFILE.limits;

/** Problem messages and the hash are the service's own; the fixtures show illustrative values. */
function comparable(interpretation: Interpretation): unknown {
  const copy = structuredClone(interpretation) as Interpretation & Record<string, unknown>;
  copy.interpretation_sha256 = "";
  for (const problem of copy.problems) problem.message = "";
  for (const item of copy.items) for (const problem of item.problems) problem.message = "";
  return copy;
}

function run(input: NormalizedRequestInput, options: { registry?: FakeHostAdapter[]; now?: Date } = {}): Interpretation {
  return interpret({ input, registry: options.registry ?? fixtureRegistry(), catalog: fixtureCatalog(), profile: TEST_PROFILE, now: options.now ?? NOW });
}

describe("interpretation fixtures", () => {
  it.each(["interpretation-supported.json", "interpretation-unsupported.json", "interpretation-budget-below-minimum.json", "interpretation-budget-below-item.json"])("reproduces %s", (name) => {
    const expected = interpretationFixture(name);
    const actual = run(expected.input);
    expect(validateContract("Interpretation", actual)).toEqual([]);
    expect(comparable(actual)).toEqual(comparable(expected));
  });

  it("writes the fixture's warning texts for quantity_exceeds_source and the budget problems", () => {
    const unsupported = run(interpretationFixture("interpretation-unsupported.json").input);
    expect(unsupported.items[4]?.problems[0]?.message).toBe(
      "Only 1 distinct concurrency defect is eligible on the selected hosts, so at most 1 of the 2 concurrency cases that supported items ask for can be delivered.",
    );
    const minimum = run(interpretationFixture("interpretation-budget-below-minimum.json").input);
    expect(minimum.problems[0]?.message).toBe("A budget of $0.70 cannot cover the worker's worst case of $0.20 plus one candidate's worst case of $0.60 on Umami. Raise the budget to at least $0.80.");
  });
});

describe("interpretation", () => {
  const supported = interpretationFixture("interpretation-supported.json").input;

  it("is deterministic and keeps the hash when only the clock moves", () => {
    const a = run(supported);
    expect(run(supported)).toEqual(a);
    expect(run(supported, { now: new Date("2026-10-20T15:00:00.000Z") }).interpretation_sha256).toBe(a.interpretation_sha256);
  });

  it("changes the hash with the input, the criteria catalog version, the profile and host availability", () => {
    const base = run(supported).interpretation_sha256;
    expect(run({ ...supported, budget_microusd: 1_900_000 }).interpretation_sha256).not.toBe(base);
    const v2 = { ...fixtureCatalog(), criteria_catalog_version: "2" };
    expect(interpret({ input: supported, registry: fixtureRegistry(), catalog: v2, profile: TEST_PROFILE, now: NOW }).interpretation_sha256).not.toBe(base);
    expect(interpret({ input: supported, registry: fixtureRegistry(), catalog: fixtureCatalog(), profile: { ...TEST_PROFILE, profile_sha256: "0".repeat(64) }, now: NOW }).interpretation_sha256).not.toBe(base);
    const registry = fixtureRegistry();
    const umami = registry[1];
    if (umami === undefined) throw new Error("no umami fake");
    const closed = new FakeHostAdapter({ host_id: "umami", entries: umami.entries, availability: () => ({ available: false, reason: "Synthetic: this entry cannot run in the planned span." }) });
    const unavailable = run(supported, { registry: [registry[0] ?? umami, closed] });
    expect(unavailable.interpretation_sha256).not.toBe(base);
    expect(unavailable.startable).toBe(false);
    expect(unavailable.items[1]?.problems.map((p) => p.code)).toEqual(["unsupported_combination"]);
  });

  it("matches the fixture's stale interpretation: a new catalog version gives a new hash", () => {
    const stale = fixture("error-interpretation-stale.json") as { error: { details: { interpretation: Interpretation } } };
    expect(stale.error.details.interpretation.interpreter.criteria_catalog_version).toBe("2");
  });

  it("counts distinct defects for quantity_exceeds_source, not entries", () => {
    const input: NormalizedRequestInput = { hosts: ["task-report"], items: [{ item_key: "c", bug_type_id: "concurrency", quantity: 2, description: null, difficulty: "source_inferable_allowed" }], budget_microusd: 1_500_000 };
    expect(run(input, { registry: fixtureRegistry({ duplicate_defect: true }) }).items[0]?.problems.map((p) => p.code)).toEqual(["quantity_exceeds_source"]);
    const distinct = [new FakeHostAdapter({ host_id: "task-report", entries: [1, 2].map((n) => syntheticEntry({ host_id: "task-report", bug_type_id: "concurrency", n, criteria: ["concurrency.lost-acknowledged-change"] })) })];
    expect(run(input, { registry: distinct }).items[0]?.problems).toEqual([]);
  });

  it("warns when two items need the same single defect, though the distinct count covers one", () => {
    const input: NormalizedRequestInput = {
      hosts: ["task-report"],
      items: [
        { item_key: "lost", bug_type_id: "concurrency", quantity: 1, description: "lost update", difficulty: "source_inferable_allowed" },
        { item_key: "any", bug_type_id: "concurrency", quantity: 1, description: null, difficulty: "source_inferable_allowed" },
      ],
      budget_microusd: 1_500_000,
    };
    const result = run(input);
    expect(result.items.map((item) => item.problems.map((p) => p.code))).toEqual([["quantity_exceeds_source"], ["quantity_exceeds_source"]]);
  });

  it("warns host_unused for a selected host that serves no item", () => {
    const input: NormalizedRequestInput = { hosts: ["umami", "task-report"], items: [{ item_key: "c", bug_type_id: "concurrency", quantity: 1, description: null, difficulty: "source_inferable_allowed" }], budget_microusd: 1_500_000 };
    const result = run(input);
    expect(result.problems).toEqual([{ code: "host_unused", severity: "warning", message: "Umami serves none of the items.", item_key: null }]);
    expect(result.hosts).toEqual([
      { host_id: "umami", used: false, reason: "No item of this request can use this host." },
      { host_id: "task-report", used: true, reason: null },
    ]);
    expect(result.startable).toBe(true);
  });

  it("treats a description of filler phrases only as no description", () => {
    const input: NormalizedRequestInput = { hosts: ["task-report"], items: [{ item_key: "c", bug_type_id: "concurrency", quantity: 1, description: "I need a bug where", difficulty: "source_inferable_allowed" }], budget_microusd: 1_500_000 };
    const item = run(input).items[0];
    expect(item).toMatchObject({ description: "I need a bug where", criteria: [], unmatched_text: [], status: "supported" });
    assertContract("Interpretation", run(input));
  });

  it("works with criteria catalog version 1", () => {
    const result = interpret({ input: supported, registry: fixtureRegistry(), catalog: criteriaCatalogV1(), profile: TEST_PROFILE, now: NOW });
    expect(result.startable).toBe(true);
    expect(result.items[0]?.criteria.map((c) => c.criterion_id)).toEqual(["concurrency.lost-acknowledged-change"]);
  });
});

describe("capabilities", () => {
  it("reproduces capabilities.json from the fakes, the fixture catalog and the test profile", () => {
    const capabilities = buildCapabilities({ registry: fixtureRegistry(), catalog: fixtureCatalog(), profile: TEST_PROFILE, now: NOW });
    expect(validateContract("Capabilities", capabilities)).toEqual([]);
    expect(capabilities).toEqual(fixture("capabilities.json") as Capabilities);
  });

  it("marks a combination unsupported, with the host's reason, while its entries cannot run in the planned span", () => {
    const registry = fixtureRegistry();
    const umami = registry[1];
    if (umami === undefined) throw new Error("no umami fake");
    const windows: [string, string][] = [];
    const calendar = new FakeHostAdapter({
      host_id: "umami",
      entries: umami.entries,
      availability: (_entry, from, until) => {
        windows.push([from, until]);
        // A synthetic rule: no span may cross midnight UTC.
        const crosses = new Date(from).getUTCDate() !== new Date(until).getUTCDate();
        return crosses ? { available: false, reason: "Synthetic: this entry cannot run in the planned span." } : { available: true, reason: null };
      },
    });
    const late = buildCapabilities({ registry: [registry[0] ?? calendar, calendar], catalog: fixtureCatalog(), profile: TEST_PROFILE, now: new Date("2026-11-01T23:30:00.000Z") });
    expect(windows[0]).toEqual(["2026-11-01T23:30:00.000Z", "2026-11-02T00:30:00.000Z"]);
    expect(late.combinations.find((c) => c.host_id === "umami" && c.bug_type_id === "date_time")).toMatchObject({ status: "unsupported", reason: "Synthetic: this entry cannot run in the planned span." });
    assertContract("Capabilities", late);
  });

  it("lists only hosts with an adapter", () => {
    const registry = fixtureRegistry().slice(0, 1);
    const capabilities = buildCapabilities({ registry, catalog: fixtureCatalog(), profile: TEST_PROFILE, now: NOW });
    expect(capabilities.hosts.map((host) => host.host_id)).toEqual(["task-report"]);
    expect(capabilities.combinations).toHaveLength(2);
  });
});

describe("service functions", () => {
  const service = serviceFunctions({ registry: fixtureRegistry(), catalog: fixtureCatalog(), profile: TEST_PROFILE });

  it("interprets a valid body, refuses an invalid one, and hashes a start that matches the interpretation", () => {
    const input = interpretationFixture("interpretation-supported.json").input;
    const answer = service.interpret(input, NOW);
    expect(answer.ok).toBe(true);
    expect(service.interpret({ ...input, budget_microusd: 1 }, NOW)).toMatchObject({ ok: false });
    if (!answer.ok) return;
    const start = service.canonicalStart({ request_id: "00000000-0000-4000-8000-000000000101", input, interpretation_sha256: answer.interpretation.interpretation_sha256 });
    expect(start).toMatchObject({ ok: true, start: { interpretation_sha256: answer.interpretation.interpretation_sha256 } });
    expect(service.capabilities(NOW, { state: "unavailable", code: "halted", message: "The ledger is halted." }).service.code).toBe("halted");
  });
});

describe("request input and start", () => {
  const body = { hosts: ["task-report"], items: [{ item_key: "c", bug_type_id: "concurrency", quantity: 1, description: "  lost update \n", difficulty: "source_inferable_allowed" }], budget_microusd: 1_000_000 };

  it("normalizes descriptions: trimmed, and null when nothing is left", () => {
    const parsed = parseRequestInput(body, LIMITS);
    expect(parsed).toEqual({ ok: true, value: { ...body, items: [{ ...body.items[0], description: "lost update" }] } });
    const empty = parseRequestInput({ ...body, items: [{ ...body.items[0], description: "   " }] }, LIMITS);
    expect(empty.ok && empty.value.items[0]?.description).toBeNull();
  });

  it.each([
    ["an unknown field", { ...body, extra: 1 }, /additionalProperties:extra/],
    ["a missing field", { hosts: body.hosts, items: body.items }, /required:budget_microusd/],
    ["too many items", { ...body, items: ["a", "b", "c", "d", "e", "f"].map((key) => ({ ...body.items[0], item_key: key })) }, /at most 5 items/],
    ["a quantity above the item limit", { ...body, items: [{ ...body.items[0], quantity: 4 }] }, /at most 3 cases/],
    ["a total above the limit", { ...body, items: ["a", "b", "c"].map((key) => ({ ...body.items[0], item_key: key, quantity: 3 })) }, /at most 6 cases in all/],
    ["a long description", { ...body, items: [{ ...body.items[0], description: "x".repeat(501) }] }, /at most 500 characters/],
    ["a budget below the minimum", { ...body, budget_microusd: 499_999 }, /budget must be from/],
    ["a repeated item key", { ...body, items: [body.items[0], body.items[0]] }, /used twice/],
  ])("refuses %s", (_name, value, message) => {
    const parsed = parseRequestInput(value, LIMITS);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(message);
  });

  it("counts a description's length after trimming", () => {
    expect(parseRequestInput({ ...body, items: [{ ...body.items[0], description: `  ${"x".repeat(500)}  ` }] }, LIMITS).ok).toBe(true);
  });

  it("hashes the canonical start body: the request ID, the normalized input and the interpretation hash", () => {
    const start = { request_id: "00000000-0000-4000-8000-000000000101", input: body, interpretation_sha256: "11".repeat(32) };
    const a = canonicalStart(start, LIMITS);
    const b = canonicalStart({ ...start, input: { ...body, items: [{ ...body.items[0], description: "lost update" }] } }, LIMITS);
    expect(a.ok && b.ok && a.sha256 === b.sha256).toBe(true);
    const other = canonicalStart({ ...start, request_id: "00000000-0000-4000-8000-000000000102" }, LIMITS);
    expect(a.ok && other.ok && a.sha256 !== other.sha256).toBe(true);
    if (a.ok) expect(a.start.input.items[0]?.description).toBe("lost update");
    expect(canonicalStart({ ...start, extra: true }, LIMITS)).toMatchObject({ ok: false });
    expect(canonicalStart({ request_id: start.request_id, input: body }, LIMITS)).toMatchObject({ ok: false });
  });
});
