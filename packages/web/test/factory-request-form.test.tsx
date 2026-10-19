import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FactoryRequestForm, factoryDraftErrors } from "../src/components/factory-request-form.tsx";

describe("local factory request draft", () => {
  it("keeps live submission disabled and makes missing capabilities explicit", () => {
    const html = renderToStaticMarkup(<FactoryRequestForm />);
    expect(html).toContain("Nothing is sent or saved; reloading clears this draft");
    expect(html).toContain("Awaiting supported bug types");
    expect(html).toMatch(/<select id="factory-type-1" disabled=""/);
    expect(html).toMatch(/<button class="factory-button" type="submit" disabled=""/);
    expect(html).toContain("Permitted limits and accounting are not available yet");
    expect(html).toContain("the request service has not interpreted or accepted");
    expect(html).toContain("Source-inferable bugs are allowed by default");
    expect(html).toContain("harder per-description option is unavailable");
    expect(html).not.toContain("action=");
  });

  it("labels fixture capabilities and filters unsupported host combinations", () => {
    const html = renderToStaticMarkup(<FactoryRequestForm previewOptions={[
      { id: "synthetic-time", label: "Synthetic time grouping", hosts: ["umami"] },
      { id: "synthetic-report", label: "Synthetic report ordering", hosts: ["custom"] },
    ]} />);
    expect(html).toContain("Development fixture options");
    expect(html).toContain("Synthetic time grouping (fixture)");
    expect(html).not.toContain("Synthetic report ordering (fixture)");
    expect(html).toMatch(/<button class="factory-button" type="submit" disabled=""/);
  });

  it("links visible labels to controls", () => {
    const html = renderToStaticMarkup(<FactoryRequestForm />);
    for (const match of html.matchAll(/<label for="([^"]+)"/g)) expect(html).toContain(`id="${match[1] ?? ""}"`);
    expect(html).toContain("<legend>Request item 1</legend>");
  });

  it("validates individual quantities without treating descriptions as a combined request", () => {
    const rows = [
      { id: 1, type: "", quantity: "2", specification: "First distinct description" },
      { id: 2, type: "", quantity: "1.5", specification: "Second distinct description" },
    ];
    expect(factoryDraftErrors(rows, "")).toEqual(["Item 2: enter a positive whole-number quantity."]);
    expect(rows.map((row) => row.specification)).toEqual(["First distinct description", "Second distinct description"]);
    for (const quantity of ["", "0", "-1", "Infinity", "9007199254740992"]) {
      expect(factoryDraftErrors([{ id: 1, type: "", quantity, specification: "" }], "")).toHaveLength(1);
    }
    expect(factoryDraftErrors([{ id: 1, type: "", quantity: "2", specification: "First distinct description" }], "10")).toEqual([]);
    expect(factoryDraftErrors([], "0")).toHaveLength(1);
    expect(factoryDraftErrors([], "Infinity")).toHaveLength(1);
  });
});
