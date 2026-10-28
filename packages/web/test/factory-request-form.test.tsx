import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Capabilities } from "../src/factory/client.ts";
import { FactoryRequestForm, prepareFactoryInput, usdToMicrousd, type FactoryDraftRow } from "../src/components/factory-request-form.tsx";

const capabilities = JSON.parse(readFileSync(new URL("./fixtures/factory-v1/capabilities.json", import.meta.url), "utf8")) as Capabilities;
const row = (item_key = "item-1"): FactoryDraftRow => ({ item_key, bug_type_id: "concurrency", quantity: "1", description: "", difficulty: "source_inferable_allowed" });
const callbacks = { onInterpret: () => undefined, onChange: () => undefined };

describe("contract-driven factory form", () => {
  it("disables unavailable capabilities without inventing options or limits", () => {
    const html = renderToStaticMarkup(<FactoryRequestForm capabilities={null} disabled={false} {...callbacks} />);
    expect(html).toContain("Requests are disabled");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders server capabilities, unavailable difficulty, and configured limits", () => {
    const html = renderToStaticMarkup(<FactoryRequestForm capabilities={capabilities} disabled={false} {...callbacks} />);
    for (const host of capabilities.hosts) expect(html).toContain(host.label);
    for (const type of capabilities.bug_types) expect(html).toContain(type.label);
    expect(html).toContain('max="3"');
    expect(html).not.toMatch(/maxlength=/i);
    expect(html).toContain('aria-describedby="factory-description-item-1-help"');
    expect(html).toContain("500 Unicode code points after trimming surrounding whitespace");
    expect(html).toContain('value="2.00"');
    expect(html).toContain("Allowed: $0.50 to $5.00.");
    expect(html).not.toContain("0.500000");
    expect(html).toContain("No concurrency catalog with implemented verification checks is declared for Umami yet.");
    expect(html).toContain('value="source_only_difficulty_required" disabled=""');
    expect(html).toContain("Reviewing is free and starts no work");
    for (const match of html.matchAll(/<label for="([^"]+)"/g)) expect(html).toContain(`id="${match[1] ?? ""}"`);
  });

  it("preserves independent item keys, quantities, and descriptions and permits the union of host sources", () => {
    const rows = [
      { ...row("item-1"), quantity: "2", description: "  lost update  " },
      { ...row("item-3"), bug_type_id: "date_time" as const, description: "daily totals use the wrong time zone" },
      { ...row("item-4"), description: "   " },
    ];
    const result = prepareFactoryInput(capabilities, ["umami", "task-report"], rows, "1.000001");
    expect(result.errors).toEqual([]);
    expect(result.input).toEqual({ hosts: ["umami", "task-report"], budget_microusd: 1000001, items: [
      { ...rows[0], quantity: 2, description: "lost update" },
      { ...rows[1], quantity: 1 },
      { ...rows[2], quantity: 1, description: null },
    ] });
    // Unsupported combinations and unmatched prose are sent to the free interpreter,
    // never discarded or silently substituted by the form.
    expect(prepareFactoryInput(capabilities, ["umami"], [{ ...row(), description: "unrecognized words" }], "2").input?.items[0]?.description).toBe("unrecognized words");
  });

  it("uses configured input limits and refuses unavailable difficulty without downgrade", () => {
    const validate = (rows: FactoryDraftRow[], budget = "2") => prepareFactoryInput(capabilities, ["umami"], rows, budget);
    expect(validate([{ ...row(), difficulty: "source_only_difficulty_required" }]).input).toBeNull();
    for (const quantity of ["", "0", "-1", "1.5", "4"]) expect(validate([{ ...row(), quantity }]).input).toBeNull();
    expect(validate([{ ...row(), description: "a".repeat(501) }]).input).toBeNull();
    expect(validate([row("item-1"), row("item-2"), row("item-3")].map((item) => ({ ...item, quantity: "3" }))).input).toBeNull();
    expect(validate(Array.from({ length: 6 }, (_, index) => row(`item-${String(index)}`))).input).toBeNull();
    expect(validate([], "2").input).toBeNull();
    expect(prepareFactoryInput(capabilities, [], [row()], "2").input).toBeNull();
    expect(validate([row()], "0.499999").input).toBeNull();
    expect(validate([row()], "5.000001").input).toBeNull();
  });

  it("counts trimmed descriptions by Unicode code points rather than UTF-16 or graphemes", () => {
    const limited = { ...capabilities, limits: { ...capabilities.limits, max_description_chars: 2 } };
    const validate = (description: string) => prepareFactoryInput(limited, ["umami"], [{ ...row(), description }], "2");
    expect(validate("😀😀").input?.items[0]?.description).toBe("😀😀");
    expect(validate(" \t😀😀\n ").input?.items[0]?.description).toBe("😀😀");
    expect(validate("😀😀😀").input).toBeNull();
    expect(validate("😀😀😀").fieldErrors["factory-description-item-1-error"]).toBe("Item 1: description exceeds 2 Unicode code points after trimming surrounding whitespace.");
    expect(validate("e\u0301").input?.items[0]?.description).toBe("e\u0301");
    expect(validate("e\u0301\u0301").input).toBeNull();
    expect(validate(" \t\n ").input?.items[0]?.description).toBeNull();
  });

  it("converts dollar input exactly without rounding fractional microdollars", () => {
    expect(usdToMicrousd("1.000001")).toBe(1000001);
    expect(usdToMicrousd("0.29")).toBe(290000);
    expect(usdToMicrousd("5")).toBe(5000000);
    for (const value of ["1.0000001", "1e2", "", "-1", "Infinity", "9007199254740992"]) expect(usdToMicrousd(value)).toBeNull();
  });

  it("associates invalid budget and quantity errors with their fields", () => {
    const invalid = prepareFactoryInput(capabilities, ["umami"], [{ ...row(), quantity: "0" }], "0");
    expect(invalid.fieldErrors["factory-quantity-item-1-error"]).toBe("Item 1: quantity must be between 1 and 3.");
    expect(invalid.fieldErrors["factory-budget-error"]).toContain("Enter a shared budget");
    const malformedBudget = { ...capabilities, limits: { ...capabilities.limits, default_budget_microusd: 0 } };
    const html = renderToStaticMarkup(<FactoryRequestForm capabilities={malformedBudget} disabled={false} {...callbacks} />);
    expect(html).toMatch(/id="factory-budget"[^>]*aria-invalid="true"/);
    expect(html).toContain('aria-describedby="factory-budget-help factory-budget-error"');
    expect(html).toContain('id="factory-budget-error"');
    expect(html).toContain('id="factory-budget-help"');
  });

  it("locks all controls while interpretation or execution is in flight", () => {
    const html = renderToStaticMarkup(<FactoryRequestForm capabilities={capabilities} disabled {...callbacks} />);
    expect(html).toContain('<fieldset disabled="">');
  });
});
