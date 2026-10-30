// POST /api/factory/session { passcode }: the factory session cookie; GET: { signed_in } (contract section 13).
import { getSession, postSession } from "../../../../src/factory-server/handlers.ts";
import { handle } from "../../../../src/factory-server/server.ts";
import { clearFactorySessionCookie } from "../../../../src/factory-server/session.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handle((server) => postSession(request, server));
}

export function GET(request: Request): Promise<Response> {
  return handle((server) => getSession(request, server));
}

/** Clearing the browser cookie needs no session or backend initialization. */
export function DELETE(): Response {
  return new Response(null, { status: 204, headers: { "set-cookie": clearFactorySessionCookie(), "cache-control": "no-store" } });
}
