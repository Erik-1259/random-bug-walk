import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseContract } from "@rbw/factory-contract/validate";
import { BRIEF_CREDIT, DeliveryBriefsView, NOVELTY_CAVEAT, type BriefEntry } from "../src/components/delivery-brief.tsx";
import { BRIEF } from "./support/assist-fixtures.ts";

const status = parseContract("RequestStatus", readFileSync(new URL("./fixtures/factory-v1/status-fulfilled.json", import.meta.url), "utf8"));
const first = status.cases[0];
if (first === undefined) throw new Error("fixture");
const render = (entries: Record<string, BriefEntry> = {}, signedIn = true) =>
  renderToStaticMarkup(<DeliveryBriefsView cases={status.cases} signedIn={signedIn} entries={entries} onExplain={() => undefined} />);

describe("what you received", () => {
  it("offers an explanation per delivered case, on demand", () => {
    const html = render();
    expect(html).toContain("What you received");
    expect(html).toContain(BRIEF_CREDIT);
    for (const item of status.cases) expect(html).toContain(item.title);
    expect(html.match(/>Explain what I received<\/button>/g)).toHaveLength(status.cases.length);
    expect(render({}, false)).toContain("Sign in first");
    expect(renderToStaticMarkup(<DeliveryBriefsView cases={[]} signedIn entries={{}} onExplain={() => undefined} />)).toBe("");
  });

  it("renders the brief, the dated novelty check and the caveat", () => {
    const html = render({ [first.case_id]: { state: "done", result: BRIEF } });
    expect(html).toContain(BRIEF.brief.what_it_is);
    expect(html).toContain(BRIEF.brief.how_to_run);
    expect(html).toContain(BRIEF.brief.how_to_validate);
    expect(html).toContain('dateTime="2026-10-28T19:05:00.000Z"');
    expect(html).toContain("“totals land on the wrong day”");
    expect(html).toContain("1 distinctive phrase from the report was searched on the public web.");
    expect(html).toContain("No public page matched these phrases.");
    expect(html).toContain(NOVELTY_CAVEAT);
    expect(html.match(/Random Bug Walk’s public catalog/g)).toHaveLength(1); // the service's identical caveat is not repeated
    expect(html.match(/>Explain what I received<\/button>/g)).toHaveLength(status.cases.length - 1);
    const matched = render({ [first.case_id]: { state: "done", result: { ...BRIEF, novelty: { ...BRIEF.novelty, public_matches: [{ phrase: "totals land on the wrong day", url: "https://example.org/post" }] } } } });
    expect(matched).toContain('href="https://example.org/post"');
  });

  it("fails soft: loading and unavailable keep the downloads untouched", () => {
    expect(render({ [first.case_id]: { state: "loading" } })).toMatch(/disabled="">Explain what I received/);
    const html = render({ [first.case_id]: { state: "failed", failure: { code: "unavailable", message: null, retryAfterS: null } } });
    expect(html).toContain("The explanation is unavailable right now.");
    expect(html).toContain("Try the explanation again");
  });
});
