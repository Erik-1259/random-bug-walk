import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FactoryExample } from "../src/components/factory-example.tsx";
import { factoryClient } from "../src/factory/client.ts";

describe("factory example and disconnected client", () => {
  it("uses the selected published case route when the build contains that release", () => {
    const html = renderToStaticMarkup(<FactoryExample availableLocally />);
    expect(html).toContain('href="/cases/319f3100-9ecf-441d-b7af-a643af9ae4e5#cell-2"');
    expect(html).toContain('href="/cases/319f3100-9ecf-441d-b7af-a643af9ae4e5#cell-3"');
    expect(html).toContain("Compare original tests and added checks");
    expect(html).toContain("three non-UTC checks fail as expected while the UTC control passes");
    expect(html).toContain("not debugging-agent performance");
    expect(html).toContain("not new bug-case or validator-package downloads");
    expect(html).not.toContain("download=");
  });

  it("keeps approved evidence reachable without labeling a development fixture as published", () => {
    const html = renderToStaticMarkup(<FactoryExample availableLocally={false} />);
    expect(html).toContain('href="https://random-bug-walk.vercel.app/#cell-2"');
    expect(html).toContain('href="https://random-bug-walk.vercel.app/#cell-3"');
    expect(html).toContain("/blob/d79fc64123c8a95171c229b1062e3ac3f903936d/releases/319f3100-9ecf-441d-b7af-a643af9ae4e5/issue.json");
    expect(html).not.toContain('href="/cases/');
  });

  it("reports unavailable without starting a request when consulted repeatedly or after reload", async () => {
    for (let read = 0; read < 3; read += 1) {
      expect(await factoryClient.availability()).toEqual({
        state: "unavailable",
        message: "New requests are not available yet. You can explore the completed example and prepare a local draft. No work will be started.",
      });
    }
    expect(Object.keys(factoryClient)).toEqual(["availability"]);
  });
});
