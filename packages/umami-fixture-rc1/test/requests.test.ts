import { describe, expect, it } from "vitest";
import { loginRequest, verifyBackupCodeRequest } from "../src/index.ts";

describe("request builders", () => {
  it("signs in with the admin login as a JSON body", () => {
    expect(loginRequest({ username: "synthetic-admin", password: "synthetic-password" })).toEqual({
      method: "POST",
      path: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: '{"username":"synthetic-admin","password":"synthetic-password"}',
    });
  });

  it("verifies a backup code with the partial token as the bearer and the code as the only body field", () => {
    expect(verifyBackupCodeRequest("synthetic-partial", "SYNTHETIC-RC1-CODE-10")).toEqual({
      method: "POST",
      path: "/api/2fa/verify",
      headers: { "content-type": "application/json", authorization: "Bearer synthetic-partial" },
      body: '{"backupCode":"SYNTHETIC-RC1-CODE-10"}',
    });
  });
});
