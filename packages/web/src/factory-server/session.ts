// The factory session (contract sections 3 and 13): an HttpOnly, Secure, SameSite=Strict cookie
// scoped to /api/factory, holding an HMAC of the judges' passcode under a label of its own, so the
// judge cookie never opens a factory session and the other way around. The small logic is copied
// from the judge routes, which stay unchanged.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const FACTORY_SESSION_COOKIE = "rbw_factory_session";
const SESSION_LABEL = "rbw-factory-session:1";
/** A week, as the judge cookie; rotating the passcode ends every session before then. */
export const FACTORY_SESSION_SECONDS = 7 * 24 * 3600;

export function factorySessionToken(passcode: string): string {
  return createHmac("sha256", passcode).update(SESSION_LABEL).digest("base64url");
}

/** Constant-time comparison over SHA-256 digests, so lengths do not leak either. */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

export function hasFactorySession(request: Request, passcode: string | null): boolean {
  if (passcode === null) return false;
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${FACTORY_SESSION_COOKIE}=`));
  return cookie !== undefined && sameSecret(cookie.slice(FACTORY_SESSION_COOKIE.length + 1), factorySessionToken(passcode));
}

export function factorySessionCookie(passcode: string): string {
  return `${FACTORY_SESSION_COOKIE}=${factorySessionToken(passcode)}; Path=/api/factory; Max-Age=${String(FACTORY_SESSION_SECONDS)}; HttpOnly; Secure; SameSite=Strict`;
}

/** Remove the browser's cookie without a passcode or a factory server. */
export function clearFactorySessionCookie(): string {
  return `${FACTORY_SESSION_COOKIE}=; Path=/api/factory; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
