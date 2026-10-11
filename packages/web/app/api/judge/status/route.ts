// GET /api/judge/status?request_id=<uuid>: one replay's state and progress, behind the passcode session.
import { getStatus } from "../../../../src/judge/handlers.ts";
import { judgeServer } from "../../../../src/judge/server.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return getStatus(request, judgeServer());
}
