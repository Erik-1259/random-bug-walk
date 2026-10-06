import { describe, expect, it } from "vitest";
import { createSandboxSdk } from "../../src/sandbox-sdk.ts";

const CREDENTIALS = { token: "synthetic-token-not-a-credential", teamId: "team_synthetic", projectId: "prj_synthetic" };

/** A transport that answers every request with one status and records what was sent. */
function answering(status: number) {
  const requests: { url: string; authorization: string | null }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input instanceof Request ? input.url : input), authorization: new Headers(init?.headers).get("authorization") });
    return Promise.resolve(new Response(JSON.stringify({ error: { code: "synthetic", message: "synthetic answer" } }), { status, headers: { "content-type": "application/json" } }));
  };
  return { requests, fetch };
}

describe("the Vercel Sandbox SDK adapter (the real @vercel/sandbox, with a local transport)", () => {
  it("reports a name no sandbox holds as null, sending the token only as a bearer header", async () => {
    const transport = answering(404);
    const sdk = createSandboxSdk(CREDENTIALS, { fetch: transport.fetch });
    await expect(sdk.get("rbw-synthetic-admission-clean-01")).resolves.toBeNull();
    expect(transport.requests.length).toBeGreaterThan(0);
    for (const request of transport.requests) {
      expect(request.url).toContain("/v2/sandboxes/rbw-synthetic-admission-clean-01");
      expect(request.url).not.toContain(CREDENTIALS.token);
      expect(request.authorization).toBe(`Bearer ${CREDENTIALS.token}`);
    }
  });

  it("passes any other failure of a lookup on to the caller", async () => {
    const sdk = createSandboxSdk(CREDENTIALS, { fetch: answering(403).fetch });
    await expect(sdk.get("rbw-synthetic-admission-clean-01")).rejects.toThrow();
  });
});
