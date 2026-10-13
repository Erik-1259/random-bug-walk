// POST /api/judge/session { passcode }: a correct passcode sets the judge session cookie.
// GET /api/judge/session: 200 while that cookie is valid, 401 otherwise.
import { getSession, postSession } from "../../../../src/judge/handlers.ts";
import { judgeServer } from "../../../../src/judge/server.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return postSession(request, judgeServer());
}

export function GET(request: Request): Response {
  return getSession(request, judgeServer());
}
