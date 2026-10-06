import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotFrozen, recordingTransport, replayTransport } from "../../src/frozen.ts";
import { createGitHubClient } from "../../src/github.ts";
import { steppingClock, syntheticGitHub } from "../support/synthetic-github.ts";
import { FIXTURE_DIR } from "../support/generate-fixture.ts";

describe("frozen responses", () => {
  it("freezes each request with its times and a projected body without people's details or headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-frozen-"));
    const github = syntheticGitHub();
    const clock = steppingClock();
    const client = createGitHubClient({ fetch: github.fetch, token: "synthetic-token-value", now: clock.now });
    const transport = recordingTransport(client, dir, clock.date);
    const url = "/search/commits?q=syntheticRange+timezone+fix&per_page=30&page=1";
    const live = await transport.get(url);
    const files = readdirSync(join(dir, "responses"));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(dir, "responses", files[0] ?? ""), "utf8");
    const exchange = JSON.parse(text) as Record<string, unknown>;
    expect(exchange).toMatchObject({ schema_version: 1, request: { method: "GET", url }, response: { status: 200 } });
    expect(exchange.requested_at).toMatch(/^2026-10-01T00:00:\d\d\.000Z$/);
    expect(exchange.completed_at).toMatch(/^2026-10-01T00:00:\d\d\.000Z$/);
    expect(text).not.toContain("synthetic-person");
    expect(text).not.toContain("example.invalid");
    expect(text).not.toContain("synthetic-token-value");
    expect(text).not.toContain("authorization");
    expect(await replayTransport(dir).get(url)).toEqual(live);
  });

  it("refuses a request that was never frozen instead of reaching the network", async () => {
    await expect(replayTransport(FIXTURE_DIR).get("/repos/synthetic-org/not-frozen")).rejects.toBeInstanceOf(NotFrozen);
  });

  it("strips commit authors from frozen commit bodies in the committed fixture", () => {
    const dir = join(FIXTURE_DIR, "responses");
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/synthetic-person|example\.invalid|"author"|"user"/);
    }
  });
});
