import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FactoryProgress, type FactoryProgressSnapshot } from "../src/components/factory-progress.tsx";

const partial: FactoryProgressSnapshot = {
  source: "development-preview",
  outcomeLabel: "Stopped with partial results",
  summary: "The preview stopped with one completed case and two missing cases.",
  requested: 3,
  delivered: 1,
  missing: 2,
  candidatesExplored: 5,
  checksCompleted: 8,
  budgetLabel: "Synthetic budget exhausted",
  events: ["Synthetic candidate explored", "Synthetic package ready"],
  rejections: ["Synthetic candidate rejected: setup failed"],
  cases: [{
    id: "synthetic-completed-case",
    title: "Synthetic completed case",
    hostLabel: "Synthetic host",
    bugCaseReadiness: "Ready in fixture only",
    validatorReadiness: "Not ready in fixture",
    validationLabel: "Not started",
  }],
};

describe("factory progress presentation", () => {
  it("shows no fabricated progress or packages when no request is connected", () => {
    const html = renderToStaticMarkup(<FactoryProgress snapshot={null} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("No live request is connected");
    expect(html).not.toContain("Delivered");
    expect(html).not.toContain("Download");
    expect(html).not.toContain("Synthetic");
  });

  it("labels preview evidence and keeps completed cases visible for partial results", () => {
    const html = renderToStaticMarkup(<FactoryProgress snapshot={partial} />);
    expect(html).toContain("Development preview — not a live request or published result");
    expect(html).toContain("Stopped with partial results");
    expect(html).toContain("<dt>Requested</dt><dd>3</dd>");
    expect(html).toContain("<dt>Delivered</dt><dd>1</dd>");
    expect(html).toContain("<dt>Missing</dt><dd>2</dd>");
    expect(html).toContain("<dt>Candidates explored</dt><dd>5</dd>");
    expect(html).toContain("<dt>Checks completed</dt><dd>8</dd>");
    expect(html).toContain("Synthetic budget exhausted");
    expect(html).toContain("Synthetic candidate rejected: setup failed");
    expect(html).toContain("Retries, rejected candidates and incomplete cases are not delivered bugs.");
    expect(html).toContain("Synthetic completed case");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("%");
  });

  it.each(["Fulfilled", "Exhausted", "Cancelled", "Operational error"])("preserves supplied %s outcome without dropping completed cases", (outcomeLabel) => {
    const html = renderToStaticMarkup(<FactoryProgress snapshot={{ ...partial, outcomeLabel, summary: "Synthetic outcome description" }} />);
    expect(html).toContain(`<h3>${outcomeLabel}</h3>`);
    expect(html).toContain("Synthetic outcome description");
    expect(html).toContain("Synthetic completed case");
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps downloads and validation disabled regardless of preview readiness", () => {
    const html = renderToStaticMarkup(<FactoryProgress snapshot={partial} />);
    expect(html).toContain("Bug-case package: Ready in fixture only");
    expect(html).toContain("Validator package: Not ready in fixture");
    const buttons = [...html.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)];
    expect(buttons.map((match) => match[2])).toEqual(["Download bug case", "Download validator package", "Validate case"]);
    for (const button of buttons) {
      expect(button[1]).toContain('disabled=""');
      expect(button[1]).toContain('aria-describedby="factory-services-unavailable"');
    }
    expect(html).toContain("no validation has been started here");
    expect(html).toContain("Validation: Not started");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<form");
  });

  it("renders only allowed display metadata rather than arbitrary evaluator fields", () => {
    const completedCase = partial.cases[0];
    if (completedCase === undefined) throw new Error("Missing synthetic completed case");
    const item = { ...completedCase, referenceFix: "synthetic-private-fix", verificationTests: "synthetic-private-checks" };
    const html = renderToStaticMarkup(<FactoryProgress snapshot={{ ...partial, cases: [item] }} />);
    expect(html).toContain("Synthetic completed case");
    expect(html).not.toContain("synthetic-private-fix");
    expect(html).not.toContain("synthetic-private-checks");
  });
});
