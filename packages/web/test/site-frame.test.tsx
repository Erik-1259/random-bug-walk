import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RootLayout, { metadata } from "../app/layout.tsx";
import { CODE_REPOSITORY, RESULTS_REPOSITORY } from "../src/components/case-page.tsx";

describe("the shared site frame", () => {
  const html = renderToStaticMarkup(<RootLayout><main><p>synthetic page body</p></main></RootLayout>);

  it("names the product in the header and links every page from the site navigation", () => {
    expect(html).toMatch(/<header class="site-header"><div class="site-frame"><a class="site-brand" href="\/">Random Bug Walk<\/a><nav aria-label="Site">/);
    for (const [href, label] of [["/factory", "Request bug cases"], ["/", "Example case"], ["/catalog", "Catalog"]] as const) expect(html).toContain(`<a href="${href}">${label}</a>`);
    expect(html).toContain("synthetic page body");
  });

  it("keeps the synthetic-bug statement in the footer, with the project's repositories", () => {
    expect(html).toContain("Random Bug Walk · Planted bugs are synthetic, made for testing.");
    expect(html).toContain(`href="${CODE_REPOSITORY}"`);
    expect(html).toContain(`href="${RESULTS_REPOSITORY}"`);
    expect(html).not.toContain("hackathon prototype");
  });

  it("titles every page after the product and describes what it does", () => {
    expect(metadata.title).toEqual({ default: "Random Bug Walk", template: "%s · Random Bug Walk" });
    expect(metadata.description).toContain("The planted bugs are synthetic.");
    expect(metadata.description).not.toContain("prototype");
  });

  it("scopes link styles to the header navigation and breaks only identifiers anywhere", () => {
    expect(html).toContain("header nav a {");
    expect(html).not.toMatch(/(^|\n)nav a \{/);
    expect(html).toContain("overflow-wrap: break-word;");
    expect(html).toMatch(/code, \.hash \{[^}]*overflow-wrap: anywhere;/);
    expect(html).toContain("thead th { white-space: nowrap; }");
  });
});
