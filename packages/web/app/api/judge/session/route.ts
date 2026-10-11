// POST /api/judge/session { passcode }: a correct passcode sets the judge session cookie.
import { postSession } from "../../../../src/judge/handlers.ts";
import { judgeServer } from "../../../../src/judge/server.ts";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return postSession(request, judgeServer());
}
