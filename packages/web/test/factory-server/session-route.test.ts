import { afterEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/factory/session/route.ts";
import * as factory from "../../src/factory-server/server.ts";
import { FACTORY_SESSION_COOKIE, FACTORY_SESSION_SECONDS } from "../../src/factory-server/session.ts";
import { contractBody, harness, PASSCODE, request } from "./support.ts";

const PATH = "/api/factory/session";

function signOut(input: Request): Response {
  const handler = Reflect.get(route, "DELETE") as ((request: Request) => Response) | undefined;
  expect(handler).toBeTypeOf("function");
  if (handler === undefined) throw new Error("The session route needs DELETE");
  return handler(input);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("factory session route sign-out", () => {
  it("expires the sign-in cookie with matching attributes and the next GET is signed out", async () => {
    const h = harness();
    const handle = vi.spyOn(factory, "handle").mockImplementation(run => Promise.resolve(run(h.server)));
    const signedIn = await route.POST(request(PATH, { body: { passcode: PASSCODE }, session: false }));
    expect(signedIn.status).toBe(204);
    const issued = signedIn.headers.get("set-cookie") ?? "";
    expect(issued).toContain(`Max-Age=${String(FACTORY_SESSION_SECONDS)}`);
    const sessionCookie = issued.split(";")[0] ?? "";
    expect(await contractBody("SessionStatus", await route.GET(request(PATH, { session: false, headers: { cookie: sessionCookie } })))).toEqual({ contract_version: "bug-request/1", signed_in: true });

    handle.mockClear();
    const cleared = signOut(request(PATH, { method: "DELETE", session: false, headers: { cookie: sessionCookie } }));
    expect(cleared.status).toBe(204);
    expect(await cleared.text()).toBe("");
    expect(cleared.headers.get("cache-control")).toBe("no-store");
    expect(cleared.headers.get("set-cookie")).toBe(`${FACTORY_SESSION_COOKIE}=; Path=/api/factory; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    expect(cleared.headers.get("set-cookie")?.split(";").slice(1)).toEqual(issued.split(";").slice(1).map(part => part.trimStart().startsWith("Max-Age=") ? " Max-Age=0" : part));
    expect(handle).not.toHaveBeenCalled();
    expect(h.ports.calls).toEqual([]);

    // A browser removes this name/path cookie on Max-Age=0; subsequent requests omit it.
    expect(await contractBody("SessionStatus", await route.GET(request(PATH, { session: false })))).toEqual({ contract_version: "bug-request/1", signed_in: false });
  });

  it.each(["missing", "invalid"])("clears a %s cookie repeatedly without a session check", async variant => {
    const handle = vi.spyOn(factory, "handle");
    const headers: Record<string, string> = variant === "invalid" ? { cookie: `${FACTORY_SESSION_COOKIE}=synthetic-invalid` } : {};
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = signOut(request(PATH, { method: "DELETE", session: false, headers }));
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("set-cookie")).toBe(`${FACTORY_SESSION_COOKIE}=; Path=/api/factory; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it("does not construct the factory server even when its handler would fail", () => {
    const handle = vi.spyOn(factory, "handle").mockRejectedValue(new Error("Synthetic factory setup failure"));
    expect(signOut(request(PATH, { method: "DELETE", session: false })).status).toBe(204);
    expect(handle).not.toHaveBeenCalled();
  });
});
