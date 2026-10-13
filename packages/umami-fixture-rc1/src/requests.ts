import type { ApiRequest } from "./http.ts";

export interface Credentials {
  username: string;
  password: string;
}

const JSON_CONTENT = { "content-type": "application/json" } as const;

/** POST /api/auth/login with the disposable install's admin credentials. */
export function loginRequest(credentials: Credentials): ApiRequest {
  return {
    method: "POST",
    path: "/api/auth/login",
    headers: { ...JSON_CONTENT },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  };
}

/** POST /api/2fa/verify with a login's partial token and one backup code, the body's only field. */
export function verifyBackupCodeRequest(partialToken: string, backupCode: string): ApiRequest {
  return {
    method: "POST",
    path: "/api/2fa/verify",
    headers: { ...JSON_CONTENT, authorization: `Bearer ${partialToken}` },
    body: JSON.stringify({ backupCode }),
  };
}
